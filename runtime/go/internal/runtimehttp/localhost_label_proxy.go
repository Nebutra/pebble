package runtimehttp

import (
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"regexp"
	"strings"
	"sync"

	"github.com/nebutra/pebble/runtime/go/internal/runtimecore"
)

const localhostLabelSuffix = ".pebble.localhost"
const localhostLabelMaxLength = 48

var localhostLabelRun = regexp.MustCompile(`[^a-z0-9]+`)
var trailingMain = regexp.MustCompile(`(?i)(?:^|[-_\s/])main$`)

type localhostLabelProxy struct {
	mu        sync.RWMutex
	routes    map[string]*httputil.ReverseProxy
	routeKeys map[string]string
}

type localhostLabelRegisterRequest struct {
	TargetURL    string  `json:"targetUrl"`
	ProjectName  string  `json:"projectName"`
	WorktreeName string  `json:"worktreeName"`
	WorktreePath *string `json:"worktreePath,omitempty"`
	RepoID       *string `json:"repoId,omitempty"`
	WorktreeID   *string `json:"worktreeId,omitempty"`
	ConnectionID *string `json:"connectionId,omitempty"`
	RemoteHost   *string `json:"remoteHost,omitempty"`
	RemotePort   *int    `json:"remotePort,omitempty"`
}

type localhostLabelRegisterResult struct {
	URL   string `json:"url"`
	Label string `json:"label"`
}

func newLocalhostLabelProxy() *localhostLabelProxy {
	return &localhostLabelProxy{
		routes:    make(map[string]*httputil.ReverseProxy),
		routeKeys: make(map[string]string),
	}
}

func (proxy *localhostLabelProxy) serve(w http.ResponseWriter, r *http.Request) bool {
	host := strings.ToLower(r.Host)
	if parsedHost, _, err := net.SplitHostPort(host); err == nil {
		host = parsedHost
	}
	host = strings.Trim(host, "[]")
	if !strings.HasSuffix(host, localhostLabelSuffix) {
		return false
	}
	label := strings.TrimSuffix(host, localhostLabelSuffix)
	proxy.mu.RLock()
	registered := proxy.routes[label]
	proxy.mu.RUnlock()
	if registered == nil {
		http.Error(w, "Unknown Pebble localhost label.", http.StatusNotFound)
		return true
	}
	registered.ServeHTTP(w, r)
	return true
}

func (s *Server) handleLocalhostLabelRegister(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var req localhostLabelRegisterRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	target, err := parseLocalhostLabelTarget(req.TargetURL)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	proxyTarget := target
	upstreamHost := target.Host
	if req.ConnectionID != nil && strings.TrimSpace(*req.ConnectionID) != "" {
		if req.RemoteHost == nil || req.RemotePort == nil || s.manager == nil {
			writeError(w, http.StatusBadRequest, "remote localhost label route is incomplete")
			return
		}
		forward, forwardErr := s.manager.EnsureSshLocalhostLabelForward(
			r.Context(), strings.TrimSpace(*req.ConnectionID), *req.RemoteHost, *req.RemotePort,
		)
		if forwardErr != nil {
			writeError(w, http.StatusBadRequest, forwardErr.Error())
			return
		}
		forwarded := *target
		forwarded.Host = net.JoinHostPort("127.0.0.1", fmt.Sprint(forward.LocalPort))
		proxyTarget = &forwarded
	} else if !isLocalhostLabelLoopback(target.Hostname()) {
		if s.manager == nil || !targetMatchesWorkspacePorts(target, s.manager.ScanWorkspacePorts(r.Context(), "").Ports) {
			writeError(w, http.StatusBadRequest, "localhost label target is not an allowed workspace port")
			return
		}
	}
	result, err := s.localhostLabels.register(req, r.Host, proxyTarget, upstreamHost)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (proxy *localhostLabelProxy) register(req localhostLabelRegisterRequest, runtimeHost string, proxyTarget *url.URL, upstreamHost string) (localhostLabelRegisterResult, error) {
	target, err := parseLocalhostLabelTarget(req.TargetURL)
	if err != nil {
		return localhostLabelRegisterResult{}, err
	}
	if strings.TrimSpace(req.ProjectName) == "" || strings.TrimSpace(req.WorktreeName) == "" {
		return localhostLabelRegisterResult{}, errors.New("projectName and worktreeName are required")
	}
	baseLabel := localhostWorktreeLabel(req)
	routeKey := localhostLabelRouteKey(req)
	proxy.mu.Lock()
	label := proxy.routeKeys[routeKey]
	if label == "" {
		label = proxy.availableLabel(baseLabel)
		proxy.routeKeys[routeKey] = label
	}
	if proxyTarget == nil {
		proxyTarget = target
	}
	if upstreamHost == "" {
		upstreamHost = target.Host
	}
	proxy.routes[label] = newLocalhostReverseProxy(proxyTarget, upstreamHost, label)
	proxy.mu.Unlock()
	_, port, err := net.SplitHostPort(runtimeHost)
	if err != nil || port == "" {
		return localhostLabelRegisterResult{}, errors.New("runtime listener port is unavailable")
	}
	labeled := *target
	labeled.Host = net.JoinHostPort(label+localhostLabelSuffix, port)
	return localhostLabelRegisterResult{URL: labeled.String(), Label: label}, nil
}

func parseLocalhostLabelTarget(raw string) (*url.URL, error) {
	target, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || target.Scheme != "http" || target.Port() == "" {
		return nil, errors.New("localhost label target must be an HTTP URL with an explicit port")
	}
	host := strings.Trim(strings.ToLower(target.Hostname()), "[]")
	if host == "0.0.0.0" {
		target.Host = net.JoinHostPort("127.0.0.1", target.Port())
	} else if host == "::" {
		target.Host = net.JoinHostPort("::1", target.Port())
	}
	return target, nil
}

func isLocalhostLabelLoopback(host string) bool {
	host = strings.Trim(strings.ToLower(host), "[]")
	return host == "localhost" || host == "127.0.0.1" || host == "0.0.0.0" || host == "::1" || host == "::"
}

func targetMatchesWorkspacePorts(target *url.URL, ports []runtimecore.WorkspacePort) bool {
	targetHost := strings.Trim(strings.ToLower(target.Hostname()), "[]")
	for _, port := range ports {
		if port.Kind != "workspace" || fmt.Sprint(port.Port) != target.Port() {
			continue
		}
		connectHost := strings.Trim(strings.ToLower(port.ConnectHost), "[]")
		if connectHost == targetHost {
			return true
		}
	}
	return false
}

func newLocalhostReverseProxy(target *url.URL, upstreamHost, label string) *httputil.ReverseProxy {
	proxy := httputil.NewSingleHostReverseProxy(target)
	originalDirector := proxy.Director
	proxy.Director = func(req *http.Request) {
		incomingPath, incomingRawPath, incomingQuery := req.URL.Path, req.URL.RawPath, req.URL.RawQuery
		originalDirector(req)
		req.URL.Path, req.URL.RawPath, req.URL.RawQuery = incomingPath, incomingRawPath, incomingQuery
		// Why: dev servers use Host for origin checks; the label is presentation only.
		req.Host = upstreamHost
	}
	proxy.ErrorHandler = func(w http.ResponseWriter, _ *http.Request, err error) {
		http.Error(w, fmt.Sprintf("Proxy failed for %s: %s", label, err), http.StatusBadGateway)
	}
	return proxy
}

func localhostWorktreeLabel(req localhostLabelRegisterRequest) string {
	project := slugifyLocalhostLabel(req.ProjectName)
	worktreeSource := req.WorktreeName
	if req.WorktreePath != nil && strings.TrimSpace(*req.WorktreePath) != "" {
		worktreeSource = *req.WorktreePath
	}
	parts := strings.FieldsFunc(worktreeSource, func(char rune) bool { return char == '/' || char == '\\' })
	if len(parts) > 0 {
		worktreeSource = parts[len(parts)-1]
	}
	worktree := slugifyLocalhostLabel(worktreeSource)
	if worktree == "main" || trailingMain.MatchString(req.WorktreeName) {
		return slugifyLocalhostLabel(project + "-main")
	}
	return worktree
}

func slugifyLocalhostLabel(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	value = strings.ReplaceAll(strings.ReplaceAll(value, "'", ""), "\"", "")
	value = strings.Trim(localhostLabelRun.ReplaceAllString(value, "-"), "-")
	if len(value) > localhostLabelMaxLength {
		value = strings.TrimRight(value[:localhostLabelMaxLength], "-")
	}
	if value == "" {
		return "workspace"
	}
	return value
}

func localhostLabelRouteKey(req localhostLabelRegisterRequest) string {
	connection := ""
	if req.ConnectionID != nil {
		connection = strings.TrimSpace(*req.ConnectionID) + ":"
	}
	if req.WorktreeID != nil && strings.TrimSpace(*req.WorktreeID) != "" {
		return connection + "worktree:" + strings.TrimSpace(*req.WorktreeID) + ":" + req.TargetURL
	}
	if req.RepoID != nil && strings.TrimSpace(*req.RepoID) != "" {
		return connection + "repo:" + strings.TrimSpace(*req.RepoID) + ":" + req.WorktreeName + ":" + req.TargetURL
	}
	return connection + req.ProjectName + ":" + req.WorktreeName + ":" + req.TargetURL
}

func (proxy *localhostLabelProxy) availableLabel(base string) string {
	if proxy.routes[base] == nil {
		return base
	}
	for index := 2; index < 1000; index++ {
		candidate := fmt.Sprintf("%s-%d", base, index)
		if proxy.routes[candidate] == nil {
			return candidate
		}
	}
	return fmt.Sprintf("%s-1000", base)
}
