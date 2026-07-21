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

	"github.com/nebutra/pebble/runtime/go/internal/providercli"
	"github.com/nebutra/pebble/runtime/go/internal/runtimecore"
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

func fakeGitHubWorkItemProviderCLI(t *testing.T) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("fake provider CLI uses a POSIX shell script")
	}
	dir := t.TempDir()
	script := `#!/bin/sh
if [ "$1 $2" = "repo view" ]; then
  printf '%s' 'nebutra/pebble'
  exit 0
fi
case "$*" in
  *"repos/other/repo/issues/8"*) printf '%s' '{"id":81,"number":8,"title":"Explicit issue","state":"open","html_url":"https://gh/other/8","updated_at":"2026-07-15T00:00:00Z","labels":[{"name":"bug"}],"user":{"login":"octocat"}}';;
  *"repos/nebutra/pebble/issues/8/comments"*) printf '%s' '[{"id":10,"body":"Comment","created_at":"2026-07-15T01:00:00Z","html_url":"https://gh/comment/10","user":{"login":"commenter","type":"User"}}]';;
  *"repos/nebutra/pebble/issues/8/timeline"*) printf '%s' '[]';;
  *"repos/nebutra/pebble/issues/8"*) printf '%s' '{"id":81,"number":8,"title":"Issue","state":"open","html_url":"https://gh/8","updated_at":"2026-07-15T00:00:00Z","body":"Issue body","labels":[{"name":"bug"}],"user":{"login":"octocat"},"assignees":[]}';;
  *"-X POST repos/nebutra/pebble/issues"*) printf '%s' '{"number":42,"html_url":"https://github.com/nebutra/pebble/issues/42"}';;
  *"search/issues"*) printf '%s' '17';;
  *"/labels"*) printf 'bug\nbackend\n';;
  *"/assignees?"*) printf '%s\n' '{"login":"octocat","avatar_url":"https://x/octocat"}';;
  *"/issues?"*) printf '%s' '[{"id":81,"number":8,"title":"Issue","state":"open","html_url":"https://gh/8","updated_at":"2026-07-15T00:00:00Z","labels":[{"name":"bug"}],"user":{"login":"octocat"}},{"number":9,"title":"PR shadow","pull_request":{},"labels":[]}]';;
  *"/pulls?"*) printf '%s' '[{"number":7,"title":"PR","state":"open","html_url":"https://gh/pr/7","updated_at":"2026-07-14T00:00:00Z","labels":[],"user":{"login":"dev"},"head":{"ref":"feature","sha":"abc","repo":{"owner":{"login":"nebutra"}}},"base":{"ref":"main"}}]';;
  *) printf '%s' '{}';;
esac
`
	if err := os.WriteFile(filepath.Join(dir, "gh"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
}

func fakeGitLabIssueProviderCLI(t *testing.T) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("fake provider CLI uses a POSIX shell script")
	}
	dir := t.TempDir()
	script := `#!/bin/sh
if [ "$1 $2" = "repo view" ]; then
  printf '%s' '{"path_with_namespace":"g/p","web_url":"https://gitlab.com/g/p"}'
  exit 0
fi
if [ "$1 $2" = "mr list" ]; then
  printf '%s' '[{"id":10,"iid":3,"title":"mr","state":"opened","web_url":"https://gl/3","updated_at":"2024-01-01T00:00:00Z","labels":[]}]'
  exit 0
fi
printf '%s' '[{"id":11,"iid":4,"title":"issue","state":"opened","web_url":"https://gl/4","updated_at":"2024-02-01T00:00:00Z","labels":["bug"]}]'
`
	if err := os.WriteFile(filepath.Join(dir, "glab"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
}

func fakeGitLabIssueMutationProviderCLI(t *testing.T) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("fake provider CLI uses a POSIX shell script")
	}
	dir := t.TempDir()
	script := `#!/bin/sh
if [ "$1 $2" = "repo view" ]; then
  printf '%s' '{"path_with_namespace":"g/p","web_url":"https://gitlab.com/g/p"}'
  exit 0
fi
case "$*" in
  *"/labels"*) printf 'bug\nbackend\n';;
  *"/notes"*) printf '%s' '{"id":99,"body":"Done","created_at":"2026-07-15T00:00:00Z","author":{"username":"tanuki"}}';;
  *"-X POST"*"/issues -f title="*) printf '%s' '{"iid":42,"web_url":"https://gitlab.com/g/p/-/issues/42"}';;
  *) printf '%s' '{}';;
esac
`
	if err := os.WriteFile(filepath.Join(dir, "glab"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
}

func fakeGitLabDetailProviderCLI(t *testing.T) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("fake provider CLI uses a POSIX shell script")
	}
	dir := t.TempDir()
	script := `#!/bin/sh
if [ "$1 $2" = "repo view" ]; then
  printf '%s' '{"path_with_namespace":"g/p","web_url":"https://git.internal/g/p"}'
  exit 0
fi
case "$*" in
  *"todos?"*) printf '%s' '[{"id":1,"action_name":"assigned","target_type":"Issue","target":{"iid":8,"title":"Issue"},"state":"pending"}]';;
  *"issues/8/discussions"*) printf '%s' '[]';;
  *"issues/8"*) printf '%s' '{"id":81,"iid":8,"title":"Issue","state":"opened","web_url":"https://gl/8","description":"Body","labels":[]}';;
  *) printf '%s' '{}';;
esac
`
	if err := os.WriteFile(filepath.Join(dir, "glab"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
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

func TestProviderGitHubIssueAndWorkItemRoutes(t *testing.T) {
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	projectID := localProject(t, manager)
	fakeGitHubWorkItemProviderCLI(t)
	server := NewServer(manager)

	t.Run("issues filter pull request shadows", func(t *testing.T) {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/v1/providers/github/issues?projectId="+projectID, nil)
		server.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
		}
		var result providercli.GitHubIssueListResult
		if err := json.Unmarshal(rec.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		if len(result.Items) != 1 || result.Items[0].Number != 8 {
			t.Fatalf("unexpected issue result: %+v", result)
		}
	})

	t.Run("work items merge by update time and retain source", func(t *testing.T) {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/v1/providers/github/work-items?projectId="+projectID, nil)
		server.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
		}
		var result providercli.GitHubWorkItemsResult
		if err := json.Unmarshal(rec.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		if len(result.Items) != 2 || result.Items[0].Type != "issue" || result.Items[1].Type != "pr" {
			t.Fatalf("unexpected merged items: %+v", result.Items)
		}
		if result.Sources.Issues == nil || result.Sources.Issues.Owner != "nebutra" || result.Sources.Issues.Repo != "pebble" {
			t.Fatalf("unexpected sources: %+v", result.Sources)
		}
	})

	t.Run("explicit owner repo item", func(t *testing.T) {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/v1/providers/github/work-item?projectId="+projectID+"&number=8&type=issue&owner=other&repo=repo", nil)
		server.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
		}
		var item providercli.GitHubWorkItem
		if err := json.Unmarshal(rec.Body.Bytes(), &item); err != nil {
			t.Fatal(err)
		}
		if item.ID != "issue:8" || item.Title != "Explicit issue" || item.URL != "https://gh/other/8" {
			t.Fatalf("unexpected item: %+v", item)
		}
	})
}

func TestProviderGitHubWorkItemRouteRejectsInvalidSelector(t *testing.T) {
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	server := NewServer(manager)
	for _, path := range []string{
		"/v1/providers/github/work-item?number=0&type=issue",
		"/v1/providers/github/work-item?number=8&type=discussion",
	} {
		rec := httptest.NewRecorder()
		server.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("expected 400 for %s, got %d: %s", path, rec.Code, rec.Body.String())
		}
	}
}

func TestProviderGitHubIssueMetadataRoutes(t *testing.T) {
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	projectID := localProject(t, manager)
	fakeGitHubWorkItemProviderCLI(t)
	server := NewServer(manager)

	for path, validate := range map[string]func(*testing.T, []byte){
		"/v1/providers/github/work-items/count?projectId=" + projectID + "&query=is%3Aissue": func(t *testing.T, body []byte) {
			var result struct {
				Count int `json:"count"`
			}
			if json.Unmarshal(body, &result) != nil || result.Count != 17 {
				t.Fatalf("unexpected count body: %s", body)
			}
		},
		"/v1/providers/github/labels?projectId=" + projectID: func(t *testing.T, body []byte) {
			var result struct {
				Labels []string `json:"labels"`
			}
			if json.Unmarshal(body, &result) != nil || len(result.Labels) != 2 {
				t.Fatalf("unexpected labels body: %s", body)
			}
		},
		"/v1/providers/github/assignable-users?projectId=" + projectID: func(t *testing.T, body []byte) {
			var result struct {
				Users []providercli.GitHubAssignableUser `json:"users"`
			}
			if json.Unmarshal(body, &result) != nil || len(result.Users) != 1 || result.Users[0].Login != "octocat" {
				t.Fatalf("unexpected users body: %s", body)
			}
		},
	} {
		t.Run(path, func(t *testing.T) {
			rec := httptest.NewRecorder()
			server.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
			if rec.Code != http.StatusOK {
				t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
			}
			validate(t, rec.Body.Bytes())
		})
	}

	body := `{"projectId":"` + projectID + `","title":"Ship it","body":"Body","labels":["bug"],"assignees":["octocat"]}`
	rec := httptest.NewRecorder()
	server.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/v1/providers/github/issues/create", strings.NewReader(body)))
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var created providercli.GitHubIssueCreateResult
	if json.Unmarshal(rec.Body.Bytes(), &created) != nil || !created.OK || created.Number != 42 {
		t.Fatalf("unexpected create body: %s", rec.Body.String())
	}

	updateBody := `{"projectId":"` + projectID + `","number":42,"updates":{"state":"closed","stateReason":"completed","addLabels":["bug"]}}`
	rec = httptest.NewRecorder()
	server.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/v1/providers/github/issues/update", strings.NewReader(updateBody)))
	if rec.Code != http.StatusOK {
		t.Fatalf("expected update 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var updated providercli.GitHubIssueMutationResult
	if json.Unmarshal(rec.Body.Bytes(), &updated) != nil || !updated.OK {
		t.Fatalf("unexpected update body: %s", rec.Body.String())
	}
}

func TestProviderGitHubIssueCreateRejectsMissingTitle(t *testing.T) {
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	server := NewServer(manager)
	rec := httptest.NewRecorder()
	server.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/v1/providers/github/issues/create", strings.NewReader(`{"projectId":"repo","title":" "}`)))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestProviderGitHubWorkItemDetailsRoute(t *testing.T) {
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	projectID := localProject(t, manager)
	fakeGitHubWorkItemProviderCLI(t)
	server := NewServer(manager)
	rec := httptest.NewRecorder()
	route := "/v1/providers/github/work-item-details?projectId=" + projectID + "&number=8&type=issue"
	server.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, route, nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var details providercli.GitHubWorkItemDetails
	if json.Unmarshal(rec.Body.Bytes(), &details) != nil || details.Item.Type != "issue" || details.Body != "Issue body" || len(details.Comments) != 1 {
		t.Fatalf("unexpected details body: %s", rec.Body.String())
	}
}

func TestProviderGitHubRateLimitRoute(t *testing.T) {
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	fakeProviderCLI(t, "gh", `{"resources":{"core":{"limit":5000,"remaining":4999,"reset":1780000000}}}`, 0)
	server := NewServer(manager)
	req := httptest.NewRequest(http.MethodGet, "/v1/providers/github/rate-limit?force=true", nil)
	rec := httptest.NewRecorder()
	server.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var result providercli.GitHubRateLimitResult
	if err := json.Unmarshal(rec.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if !result.OK || result.Snapshot == nil || result.Snapshot.Core.Remaining != 4999 {
		t.Fatalf("unexpected rate-limit result: %+v", result)
	}
}

func TestProviderGitLabRateLimitRejectsURLHost(t *testing.T) {
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	server := NewServer(manager)
	req := httptest.NewRequest(http.MethodGet, "/v1/providers/gitlab/rate-limit?host=https%3A%2F%2Fgit.internal", nil)
	rec := httptest.NewRecorder()
	server.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestProviderViewerAndAuthDiagnosticRoutes(t *testing.T) {
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	server := NewServer(manager)
	tests := []struct {
		cli  string
		path string
		out  string
	}{
		{"gh", "/v1/providers/github/viewer", `{"login":"octocat","email":null}`},
		{"gh", "/v1/providers/github/auth-diagnostic", "github.com\n  Logged in to github.com account octocat\n  - Active account: true\n  - Token scopes: 'project', 'read:org', 'repo'"},
		{"glab", "/v1/providers/gitlab/viewer", `{"username":"tanuki","email":null}`},
		{"glab", "/v1/providers/gitlab/auth-diagnostic", "gitlab.com\n  Logged in to gitlab.com as tanuki\n  Token: configured"},
	}
	for _, test := range tests {
		t.Run(test.path, func(t *testing.T) {
			fakeProviderCLI(t, test.cli, test.out, 0)
			req := httptest.NewRequest(http.MethodGet, test.path, nil)
			rec := httptest.NewRecorder()
			server.ServeHTTP(rec, req)
			if rec.Code != http.StatusOK || strings.TrimSpace(rec.Body.String()) == "null" {
				t.Fatalf("unexpected response %d: %s", rec.Code, rec.Body.String())
			}
		})
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

func TestProviderGitLabLocalMetadataRoutes(t *testing.T) {
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	projectID := localProject(t, manager)
	fakeGitLabLocalMetadataProviderCLI(t)
	server := NewServer(manager)
	tests := []struct {
		path string
		want string
	}{
		{"/v1/providers/gitlab/project-ref?projectId=" + projectID, `"path":"g/p"`},
		{"/v1/providers/gitlab/merge-request-for-branch?projectId=" + projectID + "&branch=feature", `"number":7`},
		{"/v1/providers/gitlab/merge-request?projectId=" + projectID + "&iid=7", `"pipelineStatus":"success"`},
		{"/v1/providers/gitlab/issue?projectId=" + projectID + "&iid=8", `"number":8`},
		{"/v1/providers/gitlab/assignable-users?projectId=" + projectID, `"username":"tanuki"`},
	}
	for _, test := range tests {
		req := httptest.NewRequest(http.MethodGet, test.path, nil)
		rec := httptest.NewRecorder()
		server.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), test.want) {
			t.Fatalf("unexpected %s response %d: %s", test.path, rec.Code, rec.Body.String())
		}
	}
}

func fakeGitLabLocalMetadataProviderCLI(t *testing.T) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("fake provider CLI uses a POSIX shell script")
	}
	dir := t.TempDir()
	script := `#!/bin/sh
if [ "$1 $2" = "repo view" ]; then
  printf '%s' '{"path_with_namespace":"g/p","web_url":"https://gitlab.com/g/p"}'
  exit 0
fi
case "$*" in
  *"merge_requests?source_branch=feature"*) printf '%s' '[{"iid":7,"title":"MR","state":"opened","web_url":"https://gl/7","detailed_merge_status":"mergeable","head_pipeline":{"status":"success"}}]' ;;
  *"merge_requests/7"*) printf '%s' '{"iid":7,"title":"MR","state":"opened","web_url":"https://gl/7","detailed_merge_status":"mergeable","head_pipeline":{"status":"success"}}' ;;
  *"issues/8"*) printf '%s' '{"id":8,"iid":8,"title":"Issue","state":"opened","web_url":"https://gl/8","labels":[]}' ;;
  *"members/all"*) printf '%s' '[{"id":1,"username":"tanuki","name":"Tanuki","avatar_url":"https://img"}]' ;;
  *) exit 1 ;;
esac
`
	if err := os.WriteFile(filepath.Join(dir, "glab"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
}

func TestProviderGitLabIssueAndWorkItemRoutes(t *testing.T) {
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	projectID := localProject(t, manager)
	fakeGitLabIssueProviderCLI(t)
	server := NewServer(manager)

	issueReq := httptest.NewRequest(http.MethodGet,
		"/v1/providers/gitlab/issues?projectId="+projectID+"&state=opened&limit=15", nil)
	issueRec := httptest.NewRecorder()
	server.ServeHTTP(issueRec, issueReq)
	if issueRec.Code != http.StatusOK {
		t.Fatalf("expected issue 200, got %d: %s", issueRec.Code, issueRec.Body.String())
	}
	var issues providercli.GitLabIssueListResult
	if err := json.Unmarshal(issueRec.Body.Bytes(), &issues); err != nil {
		t.Fatal(err)
	}
	if len(issues.Items) != 1 || issues.Items[0].Number != 4 {
		t.Fatalf("unexpected issues: %+v", issues)
	}

	workReq := httptest.NewRequest(http.MethodGet,
		"/v1/providers/gitlab/work-items?projectId="+projectID+"&state=opened&page=1&perPage=20", nil)
	workRec := httptest.NewRecorder()
	server.ServeHTTP(workRec, workReq)
	if workRec.Code != http.StatusOK {
		t.Fatalf("expected work-item 200, got %d: %s", workRec.Code, workRec.Body.String())
	}
	var workItems providercli.GitLabWorkItemsResult
	if err := json.Unmarshal(workRec.Body.Bytes(), &workItems); err != nil {
		t.Fatal(err)
	}
	if len(workItems.Items) != 2 || workItems.Items[0].Type != "issue" || workItems.Items[1].Type != "mr" {
		t.Fatalf("unexpected work items: %+v", workItems)
	}
}

func TestProviderGitLabIssueMutationAndLabelRoutes(t *testing.T) {
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	projectID := localProject(t, manager)
	fakeGitLabIssueMutationProviderCLI(t)
	server := NewServer(manager)

	labelsReq := httptest.NewRequest(http.MethodGet, "/v1/providers/gitlab/labels?projectId="+projectID, nil)
	labelsRec := httptest.NewRecorder()
	server.ServeHTTP(labelsRec, labelsReq)
	if labelsRec.Code != http.StatusOK || !strings.Contains(labelsRec.Body.String(), "backend") {
		t.Fatalf("unexpected labels response %d: %s", labelsRec.Code, labelsRec.Body.String())
	}

	tests := []struct {
		path string
		body string
		want string
	}{
		{"/v1/providers/gitlab/issues/create", `{"projectId":"` + projectID + `","title":"Ship","body":"Body"}`, `"number":42`},
		{"/v1/providers/gitlab/issues/update", `{"projectId":"` + projectID + `","number":42,"updates":{"state":"closed","title":"Renamed"}}`, `"ok":true`},
		{"/v1/providers/gitlab/issues/comment", `{"projectId":"` + projectID + `","number":42,"body":"Done"}`, `"id":99`},
	}
	for _, test := range tests {
		req := httptest.NewRequest(http.MethodPost, test.path, strings.NewReader(test.body))
		rec := httptest.NewRecorder()
		server.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), test.want) {
			t.Fatalf("unexpected %s response %d: %s", test.path, rec.Code, rec.Body.String())
		}
	}
}

func TestProviderGitLabTodoAndDetailRoutes(t *testing.T) {
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	projectID := localProject(t, manager)
	fakeGitLabDetailProviderCLI(t)
	server := NewServer(manager)
	tests := []struct {
		path string
		want string
	}{
		{"/v1/providers/gitlab/todos?projectId=" + projectID, `"id":1`},
		{"/v1/providers/gitlab/work-item-details?projectId=" + projectID + "&iid=8&type=issue&host=git.internal&path=g%2Fp", `"body":"Body"`},
		{"/v1/providers/gitlab/work-item-by-path?projectId=" + projectID + "&iid=8&type=issue&host=git.internal&path=g%2Fp", `"id":"gitlab-issue-81"`},
	}
	for _, test := range tests {
		req := httptest.NewRequest(http.MethodGet, test.path, nil)
		rec := httptest.NewRecorder()
		server.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), test.want) {
			t.Fatalf("unexpected %s response %d: %s", test.path, rec.Code, rec.Body.String())
		}
	}

	bad := httptest.NewRequest(http.MethodGet,
		"/v1/providers/gitlab/work-item-by-path?projectId="+projectID+"&iid=8&type=issue&host=https%3A%2F%2Fgit.internal&path=g%2Fp", nil)
	badRec := httptest.NewRecorder()
	server.ServeHTTP(badRec, bad)
	if badRec.Code != http.StatusBadRequest {
		t.Fatalf("expected invalid host 400, got %d: %s", badRec.Code, badRec.Body.String())
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

func TestProviderReviewUpdateRoute(t *testing.T) {
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	projectID := localProject(t, manager)
	fakeProviderCLI(t, "gh", "", 0)
	server := NewServer(manager)

	body := strings.NewReader(`{
		"projectId":"` + projectID + `",
		"provider":"github",
		"number":42,
		"title":"New title",
		"body":"New body"
	}`)
	req := httptest.NewRequest(http.MethodPost, "/v1/providers/reviews/update", body)
	rec := httptest.NewRecorder()
	server.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var result providercli.UpdateReviewResult
	if err := json.Unmarshal(rec.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if !result.OK {
		t.Fatalf("unexpected update result: %+v", result)
	}
}

func TestProviderReviewUpdateRouteUnknownProvider(t *testing.T) {
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	projectID := localProject(t, manager)
	server := NewServer(manager)

	body := strings.NewReader(`{
		"projectId":"` + projectID + `",
		"provider":"unknown-provider",
		"number":1,
		"title":"New title"
	}`)
	req := httptest.NewRequest(http.MethodPost, "/v1/providers/reviews/update", body)
	rec := httptest.NewRecorder()
	server.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var result providercli.UpdateReviewResult
	if err := json.Unmarshal(rec.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.OK || result.Code != "unsupported_provider" {
		t.Fatalf("expected unsupported_provider gap, got %+v", result)
	}
}

func TestProviderReviewUpdateRoutePreservesEmptyGitLabReviewerList(t *testing.T) {
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	projectID := localProject(t, manager)
	fakeProviderCLI(t, "glab", `{"reviewers":[]}`, 0)
	server := NewServer(manager)

	body := strings.NewReader(`{
		"projectId":"` + projectID + `",
		"provider":"gitlab",
		"number":7,
		"reviewerIds":[]
	}`)
	req := httptest.NewRequest(http.MethodPost, "/v1/providers/reviews/update", body)
	rec := httptest.NewRecorder()
	server.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var result providercli.UpdateReviewResult
	if err := json.Unmarshal(rec.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if !result.OK || len(result.Reviewers) != 0 {
		t.Fatalf("expected reviewer clear to succeed, got %+v", result)
	}
}

func TestProviderReviewUpdateRouteRejectsRetargetForRESTProvider(t *testing.T) {
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	projectID := localProject(t, manager)
	server := NewServer(manager)
	body := strings.NewReader(`{
		"projectId":"` + projectID + `",
		"provider":"bitbucket",
		"number":7,
		"base":"release/next"
	}`)
	req := httptest.NewRequest(http.MethodPost, "/v1/providers/reviews/update", body)
	rec := httptest.NewRecorder()
	server.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var result providercli.UpdateReviewResult
	if err := json.Unmarshal(rec.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.OK || result.Code != "unsupported_provider" || !strings.Contains(result.Error, "GitHub and GitLab") {
		t.Fatalf("expected explicit provider-specific retarget gap, got %+v", result)
	}
}

func TestProviderReviewMergeRoute(t *testing.T) {
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	projectID := localProject(t, manager)
	fakeProviderCLI(t, "gh", "", 0)
	server := NewServer(manager)
	body := strings.NewReader(`{"projectId":"` + projectID + `","provider":"github","number":42,"method":"squash"}`)
	req := httptest.NewRequest(http.MethodPost, "/v1/providers/reviews/merge", body)
	rec := httptest.NewRecorder()
	server.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var result providercli.UpdateReviewResult
	if err := json.Unmarshal(rec.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if !result.OK {
		t.Fatalf("expected merge to succeed, got %+v", result)
	}
}

func TestProviderReviewAutoMergeDisableRoute(t *testing.T) {
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	projectID := localProject(t, manager)
	fakeProviderCLI(t, "gh", "", 0)
	server := NewServer(manager)
	body := strings.NewReader(`{"projectId":"` + projectID + `","number":42,"enabled":false,"method":"squash"}`)
	req := httptest.NewRequest(http.MethodPost, "/v1/providers/reviews/auto-merge", body)
	rec := httptest.NewRecorder()
	server.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var result providercli.UpdateReviewResult
	if err := json.Unmarshal(rec.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if !result.OK {
		t.Fatalf("expected disable to succeed, got %+v", result)
	}
}

func TestProviderReviewCommentRoute(t *testing.T) {
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	projectID := localProject(t, manager)
	fakeProviderCLI(t, "gh", `{"id":123,"user":{"login":"octocat","avatar_url":"","type":"User"},"body":"Ship it","created_at":"2026-01-02T03:04:05Z","html_url":"https://github/comment/123"}`, 0)
	server := NewServer(manager)
	body := strings.NewReader(`{"projectId":"` + projectID + `","provider":"github","number":42,"body":"Ship it","owner":"nebutra","repo":"pebble"}`)
	req := httptest.NewRequest(http.MethodPost, "/v1/providers/reviews/comments", body)
	rec := httptest.NewRecorder()
	server.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var result providercli.AddReviewCommentResult
	if err := json.Unmarshal(rec.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if !result.OK || result.Comment == nil || result.Comment.ID != 123 || result.Comment.URL == "" {
		t.Fatalf("unexpected comment result: %+v", result)
	}
}

func TestProviderInlineReviewCommentRoute(t *testing.T) {
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	projectID := localProject(t, manager)
	fakeProviderCLI(t, "glab", `{"id":"discussion-1","notes":[{"id":790,"author":{"username":"tanuki"},"body":"Fix","position":{"new_path":"app.ts","new_line":2}}]}`, 0)
	server := NewServer(manager)
	body := strings.NewReader(`{"projectId":"` + projectID + `","provider":"gitlab","number":2,"body":"Fix","path":"app.ts","line":2,"baseSha":"base","startSha":"start","headSha":"head"}`)
	req := httptest.NewRequest(http.MethodPost, "/v1/providers/reviews/inline-comments", body)
	rec := httptest.NewRecorder()
	server.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var result providercli.AddReviewCommentResult
	if err := json.Unmarshal(rec.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if !result.OK || result.Comment == nil || result.Comment.ThreadID != "discussion-1" {
		t.Fatalf("unexpected result: %+v", result)
	}
}

// bitbucketRemoteRepo creates a local git repo with a Bitbucket-shaped origin
// remote, mirroring the git setup TestProviderReviewCapabilitiesRoute uses.
func bitbucketRemoteRepo(t *testing.T) string {
	t.Helper()
	repo := t.TempDir()
	for _, args := range [][]string{
		{"init"},
		{"remote", "add", "origin", "git@bitbucket.org:team/app.git"},
	} {
		command := exec.Command("git", append([]string{"-C", repo}, args...)...)
		if output, err := command.CombinedOutput(); err != nil {
			t.Fatalf("git %v failed: %v: %s", args, err, output)
		}
	}
	return repo
}

// TestProviderReviewCreateAndUpdateRouteBitbucket exercises the REST-backed
// provider dispatch end to end (HTTP route -> manager -> providerrest),
// confirming Bitbucket create/update is wired the same way github/gitlab is.
func TestProviderReviewCreateAndUpdateRouteBitbucket(t *testing.T) {
	var lastMethod, lastPath string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		lastMethod = r.Method
		lastPath = r.URL.Path
		if r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/pullrequests") {
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"id":    3,
				"title": "Open PR",
				"state": "OPEN",
				"links": map[string]interface{}{"html": map[string]interface{}{"href": "https://bitbucket.org/team/app/pull-requests/3"}},
				"source": map[string]interface{}{
					"branch": map[string]interface{}{"name": "feature"},
				},
				"destination": map[string]interface{}{
					"branch": map[string]interface{}{"name": "main"},
				},
			})
			return
		}
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]interface{}{})
	}))
	defer upstream.Close()
	t.Setenv("PEBBLE_BITBUCKET_API_BASE_URL", upstream.URL)
	t.Setenv("PEBBLE_BITBUCKET_ACCESS_TOKEN", "tok")

	repo := bitbucketRemoteRepo(t)
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
	server := NewServer(manager)

	createBody := strings.NewReader(`{
		"projectId":"` + project.ID + `",
		"provider":"bitbucket",
		"base":"main",
		"head":"feature",
		"title":"Open PR"
	}`)
	createReq := httptest.NewRequest(http.MethodPost, "/v1/providers/reviews", createBody)
	createRec := httptest.NewRecorder()
	server.ServeHTTP(createRec, createReq)
	if createRec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", createRec.Code, createRec.Body.String())
	}
	var createResult providercli.CreateReviewResult
	if err := json.Unmarshal(createRec.Body.Bytes(), &createResult); err != nil {
		t.Fatal(err)
	}
	if !createResult.OK || createResult.Number != 3 || createResult.URL != "https://bitbucket.org/team/app/pull-requests/3" {
		t.Fatalf("unexpected create result: %+v", createResult)
	}
	if lastMethod != http.MethodPost || lastPath != "/repositories/team/app/pullrequests" {
		t.Errorf("unexpected create request: %s %s", lastMethod, lastPath)
	}

	updateBody := strings.NewReader(`{
		"projectId":"` + project.ID + `",
		"provider":"bitbucket",
		"number":3,
		"title":"New title"
	}`)
	updateReq := httptest.NewRequest(http.MethodPost, "/v1/providers/reviews/update", updateBody)
	updateRec := httptest.NewRecorder()
	server.ServeHTTP(updateRec, updateReq)
	if updateRec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", updateRec.Code, updateRec.Body.String())
	}
	var updateResult providercli.UpdateReviewResult
	if err := json.Unmarshal(updateRec.Body.Bytes(), &updateResult); err != nil {
		t.Fatal(err)
	}
	if !updateResult.OK {
		t.Fatalf("unexpected update result: %+v", updateResult)
	}
	if lastMethod != http.MethodPut || lastPath != "/repositories/team/app/pullrequests/3" {
		t.Errorf("unexpected update request: %s %s", lastMethod, lastPath)
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

func TestProviderReviewCapabilitiesRouteForRESTProviders(t *testing.T) {
	t.Setenv("PEBBLE_BITBUCKET_ACCESS_TOKEN", "bitbucket-token")
	t.Setenv("PEBBLE_AZURE_DEVOPS_TOKEN", "azure-token")
	t.Setenv("PEBBLE_GITEA_TOKEN", "gitea-token")
	tests := []struct {
		name     string
		remote   string
		provider string
	}{
		{name: "bitbucket", remote: "git@bitbucket.org:team/repo.git", provider: "bitbucket"},
		{name: "azure devops", remote: "git@ssh.dev.azure.com:v3/org/project/repo", provider: "azure-devops"},
		{name: "gitea", remote: "git@git.example.com:owner/repo.git", provider: "gitea"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			repo := t.TempDir()
			for _, args := range [][]string{
				{"init"},
				{"remote", "add", "origin", test.remote},
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
			if result.Provider != test.provider || !result.Authenticated ||
				result.CurrentBranch != "feature/review" || result.DefaultBaseRef != "main" {
				t.Fatalf("unexpected capabilities: %+v", result)
			}
		})
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

func TestProviderRouteRemoteProjectUsesRelayWorker(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fake SSH fixture uses a POSIX shell script")
	}
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	target, err := manager.CreateSshTarget(runtimecore.SshTargetInput{Host: "relay.example"})
	if err != nil {
		t.Fatal(err)
	}
	project, err := manager.CreateProject(runtimecore.CreateProjectRequest{
		Name: "remote", Path: "/remote/path", LocationKind: "ssh", HostID: target.ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	sshPath := filepath.Join(t.TempDir(), "ssh")
	script := `#!/bin/sh
last=''
for arg in "$@"; do last=$arg; done
case "$last" in
  *'uname -s && uname -m'*) printf 'Linux\nx86_64\n' ;;
  *'provider-http-json'*) cat >/dev/null; printf '%s' '{"status":200,"headers":{"Content-Type":"application/json"},"body":"eyJyZWxheWVkIjp0cnVlfQ=="}' ;;
  *) exit 1 ;;
esac
`
	if err := os.WriteFile(sshPath, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PEBBLE_SYSTEM_SSH_PATH", sshPath)
	server := NewServer(manager)
	recorder := httptest.NewRecorder()
	server.ServeHTTP(recorder, httptest.NewRequest(
		http.MethodGet,
		"/v1/providers/github/pulls?projectId="+project.ID,
		nil,
	))
	if recorder.Code != http.StatusOK || strings.TrimSpace(recorder.Body.String()) != `{"relayed":true}` {
		t.Fatalf("unexpected relayed response %d: %s", recorder.Code, recorder.Body.String())
	}
}
