// Shell probe + static web server for HarmonyOS HAP packaging smoke.
// Why NOT a product runtime: SELinux blocks Go exec; musl rejects Go c-shared.
// Decision: real brain stays Go pebble-runtime (hybrid/privileged host).
// See docs/reference/investigations/harmony-runtime-host.md
// Serves /v1/status (stub) and optional static product-core assets from staticRoot.

#include "gateway_stub.h"

#include <arpa/inet.h>
#include <atomic>
#include <cerrno>
#include <cstdio>
#include <cstring>
#include <fcntl.h>
#include <netinet/in.h>
#include <pthread.h>
#include <string>
#include <sys/socket.h>
#include <sys/stat.h>
#include <unistd.h>
#include <vector>

namespace {

std::atomic<bool> g_running{false};
std::atomic<int> g_listenFd{-1};
pthread_t g_thread{};
std::string g_token;
std::string g_staticRoot;
std::string g_lastError;

void SetError(const std::string &msg)
{
    g_lastError = msg;
}

bool ParseListen(const std::string &listen, std::string &host, uint16_t &port)
{
    auto colon = listen.rfind(':');
    if (colon == std::string::npos) {
        return false;
    }
    host = listen.substr(0, colon);
    int p = std::atoi(listen.substr(colon + 1).c_str());
    if (p <= 0 || p > 65535) {
        return false;
    }
    port = static_cast<uint16_t>(p);
    return true;
}

void WriteAll(int fd, const char *data, size_t len)
{
    size_t off = 0;
    while (off < len) {
        ssize_t n = write(fd, data + off, len - off);
        if (n < 0) {
            if (errno == EINTR) {
                continue;
            }
            return;
        }
        if (n == 0) {
            return;
        }
        off += static_cast<size_t>(n);
    }
}

void WriteResponse(int cfd, int code, const char *status, const char *ctype, const std::string &body,
    bool keepAlive, bool cacheable)
{
    // Why HTTP/1.1 keep-alive: product-core is many hashed chunks; HTTP/1.0
    // close + one accept thread made the terminal bundle feel like a hang.
    std::string resp = "HTTP/1.1 " + std::to_string(code) + " " + status + "\r\n"
        "Content-Type: " + ctype + "\r\n"
        "Content-Length: " + std::to_string(body.size()) + "\r\n"
        "Connection: " + std::string(keepAlive ? "keep-alive" : "close") + "\r\n";
    if (keepAlive) {
        resp += "Keep-Alive: timeout=5, max=64\r\n";
    }
    if (cacheable) {
        resp += "Cache-Control: public, max-age=86400\r\n";
    }
    resp += "\r\n" + body;
    WriteAll(cfd, resp.data(), resp.size());
}

const char *GuessContentType(const std::string &path)
{
    auto dot = path.rfind('.');
    if (dot == std::string::npos) {
        return "application/octet-stream";
    }
    std::string ext = path.substr(dot + 1);
    if (ext == "html" || ext == "htm") {
        return "text/html; charset=utf-8";
    }
    if (ext == "js" || ext == "mjs") {
        return "application/javascript; charset=utf-8";
    }
    if (ext == "css") {
        return "text/css; charset=utf-8";
    }
    if (ext == "json") {
        return "application/json";
    }
    if (ext == "svg") {
        return "image/svg+xml";
    }
    if (ext == "png") {
        return "image/png";
    }
    if (ext == "jpg" || ext == "jpeg") {
        return "image/jpeg";
    }
    if (ext == "woff2") {
        return "font/woff2";
    }
    if (ext == "woff") {
        return "font/woff";
    }
    if (ext == "map") {
        return "application/json";
    }
    return "application/octet-stream";
}

// Resolve URL path under staticRoot; reject traversal.
bool ResolveStaticPath(const std::string &urlPath, std::string &outPath)
{
    if (g_staticRoot.empty()) {
        return false;
    }
    std::string rel = urlPath;
    if (rel.empty() || rel == "/") {
        rel = "/web-index.html";
    }
    // Strip query.
    auto q = rel.find('?');
    if (q != std::string::npos) {
        rel = rel.substr(0, q);
    }
    if (rel.find("..") != std::string::npos) {
        return false;
    }
    if (!rel.empty() && rel[0] == '/') {
        rel = rel.substr(1);
    }
    outPath = g_staticRoot;
    if (!outPath.empty() && outPath.back() != '/') {
        outPath.push_back('/');
    }
    outPath += rel;
    return true;
}

bool TryServeStatic(int cfd, const std::string &urlPath, bool keepAlive)
{
    std::string filePath;
    if (!ResolveStaticPath(urlPath, filePath)) {
        return false;
    }
    struct stat st {};
    if (stat(filePath.c_str(), &st) != 0 || !S_ISREG(st.st_mode)) {
        // SPA fallback for client routes: only when path has no extension.
        if (urlPath.find('.') == std::string::npos) {
            filePath = g_staticRoot + "/web-index.html";
            if (stat(filePath.c_str(), &st) != 0 || !S_ISREG(st.st_mode)) {
                return false;
            }
        } else {
            return false;
        }
    }
    // Cap static size to avoid huge reads in the accept thread.
    if (st.st_size < 0 || st.st_size > 32 * 1024 * 1024) {
        WriteResponse(cfd, 413, "Payload Too Large", "text/plain", "file too large", keepAlive, false);
        return true;
    }
    int fd = open(filePath.c_str(), O_RDONLY | O_CLOEXEC);
    if (fd < 0) {
        return false;
    }
    std::string body;
    body.resize(static_cast<size_t>(st.st_size));
    size_t off = 0;
    while (off < body.size()) {
        ssize_t n = read(fd, &body[off], body.size() - off);
        if (n < 0) {
            if (errno == EINTR) {
                continue;
            }
            close(fd);
            WriteResponse(cfd, 500, "Internal Server Error", "text/plain", "read failed", keepAlive, false);
            return true;
        }
        if (n == 0) {
            break;
        }
        off += static_cast<size_t>(n);
    }
    close(fd);
    body.resize(off);
    const bool cacheable = filePath.find("/assets/") != std::string::npos;
    WriteResponse(cfd, 200, "OK", GuessContentType(filePath), body, keepAlive, cacheable);
    return true;
}

bool HeaderHasClose(const std::string &req)
{
    auto hdrEnd = req.find("\r\n\r\n");
    std::string headers = hdrEnd == std::string::npos ? req : req.substr(0, hdrEnd);
    for (char &ch : headers) {
        if (ch >= 'A' && ch <= 'Z') {
            ch = static_cast<char>(ch - 'A' + 'a');
        }
    }
    return headers.find("connection: close") != std::string::npos;
}

bool ReadHttpRequest(int cfd, std::string &req)
{
    req.clear();
    char buf[4096];
    while (req.find("\r\n\r\n") == std::string::npos && req.size() < 16 * 1024) {
        ssize_t n = read(cfd, buf, sizeof(buf));
        if (n < 0) {
            if (errno == EINTR) {
                continue;
            }
            return false;
        }
        if (n == 0) {
            return false;
        }
        req.append(buf, static_cast<size_t>(n));
    }
    return req.find("\r\n\r\n") != std::string::npos;
}

void HandleOneRequest(int cfd, const std::string &req, bool keepAlive)
{
    auto sp1 = req.find(' ');
    auto sp2 = sp1 == std::string::npos ? std::string::npos : req.find(' ', sp1 + 1);
    std::string method = sp1 == std::string::npos ? "" : req.substr(0, sp1);
    std::string path = (sp1 == std::string::npos || sp2 == std::string::npos)
        ? ""
        : req.substr(sp1 + 1, sp2 - sp1 - 1);

    bool isApi = path.rfind("/v1/", 0) == 0 || path == "/health" || path == "/healthz";
    bool authed = g_token.empty() || !isApi;
    if (isApi && !g_token.empty()) {
        std::string needle = "Bearer " + g_token;
        if (req.find(needle) != std::string::npos) {
            authed = true;
        }
    }

    if (method == "GET" && isApi) {
        if (!authed) {
            WriteResponse(cfd, 401, "Unauthorized", "application/json",
                "{\"error\":\"unauthorized\"}", keepAlive, false);
            return;
        }
        if (path == "/v1/status" || path == "/v1/status/") {
            WriteResponse(cfd, 200, "OK", "application/json",
                "{\"version\":\"harmony-shell-probe\",\"status\":\"ok\","
                "\"role\":\"shell-probe-not-runtime\","
                "\"note\":\"Use hybrid Go host (run-hybrid-runtime.sh); see harmony-runtime-host.md\"}",
                keepAlive, false);
            return;
        }
        if (path == "/health" || path == "/healthz") {
            WriteResponse(cfd, 200, "OK", "text/plain", "ok", keepAlive, false);
            return;
        }
        WriteResponse(cfd, 404, "Not Found", "application/json",
            "{\"error\":\"not found\",\"path\":\"" + path + "\"}", keepAlive, false);
        return;
    }

    if (method == "GET" && TryServeStatic(cfd, path, keepAlive)) {
        return;
    }

    WriteResponse(cfd, 404, "Not Found", "application/json",
        "{\"error\":\"not found\",\"path\":\"" + path + "\"}", keepAlive, false);
}

void HandleClient(int cfd)
{
    for (int n = 0; n < 64; ++n) {
        std::string req;
        if (!ReadHttpRequest(cfd, req)) {
            break;
        }
        bool http11 = req.find("HTTP/1.1") != std::string::npos;
        bool keepAlive = http11 && !HeaderHasClose(req) && n < 63;
        HandleOneRequest(cfd, req, keepAlive);
        if (!keepAlive) {
            break;
        }
    }
    close(cfd);
}

std::atomic<int> g_activeWorkers{0};

void *ClientThread(void *arg)
{
    int cfd = static_cast<int>(reinterpret_cast<intptr_t>(arg));
    HandleClient(cfd);
    g_activeWorkers.fetch_sub(1);
    return nullptr;
}

void *ServerThread(void *arg)
{
    (void)arg;
    const int maxWorkers = 8;
    while (g_running.load()) {
        int fd = g_listenFd.load();
        if (fd < 0) {
            break;
        }
        struct sockaddr_in peer {};
        socklen_t plen = sizeof(peer);
        int cfd = accept(fd, reinterpret_cast<struct sockaddr *>(&peer), &plen);
        if (cfd < 0) {
            if (!g_running.load()) {
                break;
            }
            if (errno == EINTR || errno == EAGAIN) {
                continue;
            }
            usleep(10 * 1000);
            continue;
        }
        while (g_activeWorkers.load() >= maxWorkers && g_running.load()) {
            usleep(1000);
        }
        if (!g_running.load()) {
            close(cfd);
            break;
        }
        g_activeWorkers.fetch_add(1);
        pthread_t worker {};
        if (pthread_create(&worker, nullptr, ClientThread,
                reinterpret_cast<void *>(static_cast<intptr_t>(cfd))) != 0) {
            g_activeWorkers.fetch_sub(1);
            HandleClient(cfd);
        } else {
            pthread_detach(worker);
        }
    }
    return nullptr;
}

} // namespace

extern "C" int GatewayStubStart(const char *listenAddr, const char *token, const char *staticRoot)
{
    if (g_running.load()) {
        return 0;
    }
    std::string host;
    uint16_t port = 0;
    if (listenAddr == nullptr || !ParseListen(listenAddr, host, port)) {
        SetError("invalid listen address");
        return 1;
    }

    int fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) {
        SetError(std::string("socket failed: ") + std::strerror(errno));
        return 2;
    }
    int yes = 1;
    setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof(yes));

    struct sockaddr_in addr {};
    addr.sin_family = AF_INET;
    addr.sin_port = htons(port);
    if (inet_pton(AF_INET, host.c_str(), &addr.sin_addr) != 1) {
        close(fd);
        SetError("inet_pton failed for host");
        return 3;
    }
    if (bind(fd, reinterpret_cast<struct sockaddr *>(&addr), sizeof(addr)) != 0) {
        SetError(std::string("bind failed: ") + std::strerror(errno));
        close(fd);
        return 4;
    }
    if (::listen(fd, 16) != 0) {
        SetError(std::string("listen failed: ") + std::strerror(errno));
        close(fd);
        return 5;
    }

    g_token = token != nullptr ? token : "";
    g_staticRoot = staticRoot != nullptr ? staticRoot : "";
    g_listenFd.store(fd);
    g_running.store(true);
    g_lastError.clear();

    if (pthread_create(&g_thread, nullptr, ServerThread, nullptr) != 0) {
        g_running.store(false);
        g_listenFd.store(-1);
        close(fd);
        SetError("pthread_create failed");
        return 6;
    }
    return 0;
}

extern "C" void GatewayStubStop(void)
{
    if (!g_running.exchange(false)) {
        return;
    }
    int fd = g_listenFd.exchange(-1);
    if (fd >= 0) {
        close(fd);
    }
    pthread_join(g_thread, nullptr);
}

extern "C" int GatewayStubIsRunning(void)
{
    return g_running.load() ? 1 : 0;
}

extern "C" const char *GatewayStubLastError(void)
{
    return g_lastError.c_str();
}
