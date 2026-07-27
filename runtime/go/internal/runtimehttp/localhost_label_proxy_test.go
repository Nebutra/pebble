package runtimehttp

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/nebutra/pebble/runtime/go/internal/runtimecore"
)

func TestLocalhostLabelProxyRegistersAndForwards(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{
			"host":  r.Host,
			"path":  r.URL.Path,
			"query": r.URL.RawQuery,
		})
	}))
	defer backend.Close()

	server := &Server{
		mux:             http.NewServeMux(),
		bearerToken:     "secret",
		localhostLabels: newLocalhostLabelProxy(),
	}
	server.mux.HandleFunc("/v1/localhost-worktree-labels/register", server.handleLocalhostLabelRegister)
	body := `{"targetUrl":"` + backend.URL + `/base","projectName":"Pebble","worktreeName":"feature/fast-terminal","worktreeId":"wt-1"}`
	register := httptest.NewRequest(http.MethodPost, "/v1/localhost-worktree-labels/register", strings.NewReader(body))
	register.Host = "127.0.0.1:17777"
	register.Header.Set("Authorization", "Bearer secret")
	registered := httptest.NewRecorder()
	server.ServeHTTP(registered, register)
	if registered.Code != http.StatusOK {
		t.Fatalf("register failed: %d %s", registered.Code, registered.Body.String())
	}
	var result localhostLabelRegisterResult
	if err := json.Unmarshal(registered.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.Label != "fast-terminal" || !strings.Contains(result.URL, "fast-terminal.pebble.localhost:17777") {
		t.Fatalf("unexpected label result: %#v", result)
	}

	request := httptest.NewRequest(http.MethodGet, "http://fast-terminal.pebble.localhost:17777/hello?x=1", nil)
	response := httptest.NewRecorder()
	server.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("proxy failed: %d %s", response.Code, response.Body.String())
	}
	var forwarded map[string]string
	if err := json.Unmarshal(response.Body.Bytes(), &forwarded); err != nil {
		t.Fatal(err)
	}
	if forwarded["path"] != "/hello" || forwarded["query"] != "x=1" {
		t.Fatalf("incoming route was not preserved: %#v", forwarded)
	}
	if forwarded["host"] != strings.TrimPrefix(backend.URL, "http://") {
		t.Fatalf("backend host was not restored: %#v", forwarded)
	}
}

func TestLocalhostLabelTargetRequiresMatchingWorkspacePort(t *testing.T) {
	target, err := parseLocalhostLabelTarget("http://192.168.1.8:8080")
	if err != nil {
		t.Fatal(err)
	}
	ports := []runtimecore.WorkspacePort{{ConnectHost: "192.168.1.8", Port: 8080, Kind: "workspace"}}
	if !targetMatchesWorkspacePorts(target, ports) {
		t.Fatal("expected matching workspace port")
	}
	ports[0].Kind = "external"
	if targetMatchesWorkspacePorts(target, ports) {
		t.Fatal("external ports must not enter the proxy allowlist")
	}
}

func TestLocalhostLabelRouteKeysAreIsolatedBySshConnection(t *testing.T) {
	first, second := "ssh-1", "ssh-2"
	base := localhostLabelRegisterRequest{
		TargetURL: "http://127.0.0.1:4173", ProjectName: "Pebble", WorktreeName: "Feature",
	}
	base.ConnectionID = &first
	firstKey := localhostLabelRouteKey(base)
	base.ConnectionID = &second
	if secondKey := localhostLabelRouteKey(base); firstKey == secondKey {
		t.Fatalf("SSH route keys collided: %q", firstKey)
	}
}

func TestLocalhostLabelProxyUnregistersWorktreeRoutes(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	}))
	defer backend.Close()

	server := &Server{
		mux:             http.NewServeMux(),
		bearerToken:     "secret",
		localhostLabels: newLocalhostLabelProxy(),
	}
	server.mux.HandleFunc("/v1/localhost-worktree-labels/register", server.handleLocalhostLabelRegister)

	register := func(worktreeID, worktreeName string) localhostLabelRegisterResult {
		t.Helper()
		body := `{"targetUrl":"` + backend.URL + `/","projectName":"Pebble","worktreeName":"` + worktreeName + `","worktreeId":"` + worktreeID + `"}`
		req := httptest.NewRequest(http.MethodPost, "/v1/localhost-worktree-labels/register", strings.NewReader(body))
		req.Host = "127.0.0.1:17777"
		req.Header.Set("Authorization", "Bearer secret")
		rec := httptest.NewRecorder()
		server.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("register %s failed: %d %s", worktreeID, rec.Code, rec.Body.String())
		}
		var result localhostLabelRegisterResult
		if err := json.Unmarshal(rec.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		return result
	}

	a := register("wt-a", "feature-a")
	b := register("wt-b", "feature-b")

	proxyOK := func(label string) int {
		t.Helper()
		req := httptest.NewRequest(http.MethodGet, "http://"+label+".pebble.localhost:17777/", nil)
		rec := httptest.NewRecorder()
		server.ServeHTTP(rec, req)
		return rec.Code
	}
	if code := proxyOK(a.Label); code != http.StatusOK {
		t.Fatalf("expected a 200, got %d", code)
	}
	if code := proxyOK(b.Label); code != http.StatusOK {
		t.Fatalf("expected b 200, got %d", code)
	}

	server.localhostLabels.unregisterWorktree("wt-a")

	if code := proxyOK(a.Label); code != http.StatusNotFound {
		t.Fatalf("removed worktree label should 404, got %d", code)
	}
	if code := proxyOK(b.Label); code != http.StatusOK {
		t.Fatalf("sibling worktree label should remain 200, got %d", code)
	}
}
