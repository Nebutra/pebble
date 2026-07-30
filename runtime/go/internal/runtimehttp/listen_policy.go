package runtimehttp

import (
	"net"
	"net/http"
	"strings"
)

// Why: when LAN shared-control is opted in, the runtime may bind a non-loopback
// (or wildcard) address so pairing URLs work, but the empty-bearer control plane
// and localhost-label reverse proxy must stay unreachable from off-host clients.

func requestFromLoopback(r *http.Request) bool {
	if r == nil {
		return false
	}
	host, _, err := net.SplitHostPort(strings.TrimSpace(r.RemoteAddr))
	if err != nil {
		host = strings.TrimSpace(r.RemoteAddr)
	}
	return isLoopbackHost(host)
}

func isLoopbackHost(host string) bool {
	host = strings.Trim(strings.TrimSpace(host), "[]")
	if host == "" {
		return false
	}
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func isWildcardHost(host string) bool {
	host = strings.Trim(strings.TrimSpace(host), "[]")
	return host == "0.0.0.0" || host == "::" || host == ""
}

// isNonLoopbackSharedControlPath is the only surface allowed for non-loopback
// clients when LAN shared-control is enabled. Pairing material is minted over
// the loopback control plane; remote peers only need the authenticated WS.
func isNonLoopbackSharedControlPath(r *http.Request) bool {
	if r == nil {
		return false
	}
	path := r.URL.Path
	if path == "/v1/shared-control" && isWebSocketUpgrade(r) {
		return true
	}
	return false
}

// resolveListenAddress keeps today's loopback bind when LAN shared-control is
// off. When on, a loopback listen string is widened to the IPv4 wildcard so the
// selected advertise address can reach the shared-control socket on the same
// port; non-loopback remotes are still filtered in ServeHTTP.
func resolveListenAddress(listen string, allowNonLoopbackSharedControl bool) string {
	listen = strings.TrimSpace(listen)
	if !allowNonLoopbackSharedControl || listen == "" {
		return listen
	}
	host, port, err := net.SplitHostPort(listen)
	if err != nil {
		return listen
	}
	if isLoopbackHost(host) {
		return net.JoinHostPort("0.0.0.0", port)
	}
	return listen
}
