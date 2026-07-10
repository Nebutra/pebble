package runtimehttp

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/tsekaluk/pebble/go-runtime/internal/providercli"
	"github.com/tsekaluk/pebble/go-runtime/internal/runtimecore"
)

// fakeProviderCLI writes an executable named `name` that emits `stdout` and
// exits `exitCode`, prepended to PATH so it shadows any real gh/glab.
func fakeProviderCLI(t *testing.T, name string, stdout string, exitCode int) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("fake provider CLI uses a POSIX shell script")
	}
	dir := t.TempDir()
	script := "#!/bin/sh\ncat <<'PEBBLE_EOF'\n" + stdout + "\nPEBBLE_EOF\n"
	if exitCode != 0 {
		script += "exit 1\n"
	}
	if err := os.WriteFile(filepath.Join(dir, name), []byte(script), 0o755); err != nil {
		t.Fatalf("write fake %s: %v", name, err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
}

func localProject(t *testing.T, manager *runtimecore.Manager) string {
	t.Helper()
	project, err := manager.CreateProject(runtimecore.CreateProjectRequest{
		Name: "repo", Path: t.TempDir(), LocationKind: "local",
	})
	if err != nil {
		t.Fatalf("create project: %v", err)
	}
	return project.ID
}

func TestProviderGitHubPRsRoute(t *testing.T) {
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	projectID := localProject(t, manager)
	fakeProviderCLI(t, "gh",
		`[{"number":5,"title":"t","state":"OPEN","url":"https://x/5","labels":[],"updatedAt":"2024-01-01T00:00:00Z","author":{"login":"me"},"isDraft":false,"headRefName":"h","baseRefName":"main","headRefOid":"sha"}]`,
		0)
	server := NewServer(manager)

	req := httptest.NewRequest(http.MethodGet, "/v1/providers/github/pulls?projectId="+projectID, nil)
	rec := httptest.NewRecorder()
	server.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var body struct {
		Items []providercli.GitHubWorkItem `json:"items"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if len(body.Items) != 1 || body.Items[0].Number != 5 || body.Items[0].URL != "https://x/5" {
		t.Fatalf("unexpected items: %+v", body.Items)
	}
}

func TestProviderGitHubPRChecksRoute(t *testing.T) {
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	projectID := localProject(t, manager)
	fakeProviderCLI(t, "gh", `[{"name":"ci","state":"SUCCESS","link":"https://x"}]`, 0)
	server := NewServer(manager)

	req := httptest.NewRequest(http.MethodGet,
		"/v1/providers/github/pulls/checks?projectId="+projectID+"&number=5", nil)
	rec := httptest.NewRecorder()
	server.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var body struct {
		Checks []providercli.PRCheckDetail `json:"checks"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if len(body.Checks) != 1 || body.Checks[0].Name != "ci" {
		t.Fatalf("unexpected checks: %+v", body.Checks)
	}
}

func TestProviderGitLabMRsRoute(t *testing.T) {
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	projectID := localProject(t, manager)
	fakeProviderCLI(t, "glab",
		`[{"id":10,"iid":3,"title":"mr","state":"opened","web_url":"https://gl/3","updated_at":"2024-01-01T00:00:00Z","author":{"username":"u"},"labels":[],"draft":false,"source_branch":"s","target_branch":"main"}]`,
		0)
	server := NewServer(manager)

	req := httptest.NewRequest(http.MethodGet,
		"/v1/providers/gitlab/merge-requests?projectId="+projectID, nil)
	rec := httptest.NewRecorder()
	server.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var body struct {
		Items []providercli.GitLabWorkItem `json:"items"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if len(body.Items) != 1 || body.Items[0].Number != 3 || body.Items[0].ID != "gitlab-mr-10" {
		t.Fatalf("unexpected items: %+v", body.Items)
	}
}

func TestProviderReviewCreateRoute(t *testing.T) {
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	projectID := localProject(t, manager)
	fakeProviderCLI(t, "gh", `https://github.com/nebutra/pebble/pull/42`, 0)
	server := NewServer(manager)

	body := strings.NewReader(`{
		"projectId":"` + projectID + `",
		"provider":"github",
		"base":"main",
		"head":"feature/review",
		"title":"Open PR",
		"body":"Body"
	}`)
	req := httptest.NewRequest(http.MethodPost, "/v1/providers/reviews", body)
	rec := httptest.NewRecorder()
	server.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var result providercli.CreateReviewResult
	if err := json.Unmarshal(rec.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if !result.OK || result.Number != 42 || result.URL != "https://github.com/nebutra/pebble/pull/42" {
		t.Fatalf("unexpected create result: %+v", result)
	}
}

func TestProviderReviewCapabilitiesRoute(t *testing.T) {
	repo := t.TempDir()
	for _, args := range [][]string{
		{"init"},
		{"remote", "add", "origin", "git@github.com:nebutra/pebble.git"},
		{"symbolic-ref", "HEAD", "refs/heads/feature/review"},
		{"symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"},
	} {
		command := exec.Command("git", append([]string{"-C", repo}, args...)...)
		if output, err := command.CombinedOutput(); err != nil {
			t.Fatalf("git %v failed: %v: %s", args, err, output)
		}
	}
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	project, err := manager.CreateProject(runtimecore.CreateProjectRequest{
		Name: "repo", Path: repo, LocationKind: "local",
	})
	if err != nil {
		t.Fatal(err)
	}
	fakeProviderCLI(t, "gh", "", 0)
	server := NewServer(manager)

	req := httptest.NewRequest(
		http.MethodGet,
		"/v1/providers/review-capabilities?projectId="+project.ID,
		nil,
	)
	rec := httptest.NewRecorder()
	server.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var result runtimecore.HostedReviewCapabilities
	if err := json.Unmarshal(rec.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.Provider != "github" || !result.Authenticated || result.CurrentBranch != "feature/review" || result.DefaultBaseRef != "main" {
		t.Fatalf("unexpected capabilities: %+v", result)
	}
}

func TestProviderRouteMissingCLIReturns501(t *testing.T) {
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	projectID := localProject(t, manager)
	t.Setenv("PATH", t.TempDir()) // no gh on PATH
	server := NewServer(manager)

	req := httptest.NewRequest(http.MethodGet, "/v1/providers/github/pulls?projectId="+projectID, nil)
	rec := httptest.NewRecorder()
	server.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotImplemented {
		t.Fatalf("expected 501 for missing gh, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestProviderRouteUnknownProjectReturns404(t *testing.T) {
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	server := NewServer(manager)

	req := httptest.NewRequest(http.MethodGet, "/v1/providers/github/pulls?projectId=nope", nil)
	rec := httptest.NewRecorder()
	server.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404 for unknown project, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestProviderRouteRemoteProjectReturns409(t *testing.T) {
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	project, err := manager.CreateProject(runtimecore.CreateProjectRequest{
		Name: "remote", Path: "/remote/path", LocationKind: "ssh", HostID: "host-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	server := NewServer(manager)

	req := httptest.NewRequest(http.MethodGet, "/v1/providers/github/pulls?projectId="+project.ID, nil)
	rec := httptest.NewRecorder()
	server.ServeHTTP(rec, req)
	if rec.Code != http.StatusConflict {
		t.Fatalf("expected 409 for remote project, got %d: %s", rec.Code, rec.Body.String())
	}
}
