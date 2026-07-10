package runtimehttp

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"testing"

	"github.com/tsekaluk/pebble/go-runtime/internal/providerrest"
	"github.com/tsekaluk/pebble/go-runtime/internal/runtimecore"
)

// localProjectWithRemote creates a local project whose repo has `remoteURL` as
// origin, so the REST-backed provider routes can derive the provider repo ref.
func localProjectWithRemote(t *testing.T, manager *runtimecore.Manager, remoteURL string) string {
	t.Helper()
	repo := t.TempDir()
	for _, args := range [][]string{
		{"init"},
		{"remote", "add", "origin", remoteURL},
	} {
		command := exec.Command("git", append([]string{"-C", repo}, args...)...)
		if output, err := command.CombinedOutput(); err != nil {
			t.Fatalf("git %v failed: %v: %s", args, err, output)
		}
	}
	project, err := manager.CreateProject(runtimecore.CreateProjectRequest{
		Name: "repo", Path: repo, LocationKind: "local",
	})
	if err != nil {
		t.Fatalf("create project: %v", err)
	}
	return project.ID
}

func getReviewWorkItems(t *testing.T, server *Server, path string) (int, []providerrest.ReviewWorkItem, string) {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	rec := httptest.NewRecorder()
	server.ServeHTTP(rec, req)
	var body struct {
		Items []providerrest.ReviewWorkItem `json:"items"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	return rec.Code, body.Items, rec.Body.String()
}

func TestProviderGiteaPullsRoute(t *testing.T) {
	fake := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/repos/owner/repo/pulls" {
			t.Errorf("unexpected path %q", r.URL.Path)
		}
		if r.Header.Get("Authorization") != "token tok" {
			t.Errorf("unexpected auth %q", r.Header.Get("Authorization"))
		}
		_, _ = w.Write([]byte(`[{"number":3,"title":"docs","state":"open","html_url":"https://x/3","updated_at":"2026-01-01T00:00:00Z","user":{"login":"u"},"labels":[]}]`))
	}))
	defer fake.Close()
	t.Setenv("PEBBLE_GITEA_API_BASE_URL", fake.URL)
	t.Setenv("PEBBLE_GITEA_TOKEN", "tok")

	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	projectID := localProjectWithRemote(t, manager, "git@git.example.com:owner/repo.git")
	server := NewServer(manager)

	code, items, body := getReviewWorkItems(t, server, "/v1/providers/gitea/pulls?projectId="+projectID)
	if code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", code, body)
	}
	if len(items) != 1 || items[0].ID != "gitea-pr-3" || items[0].State != "open" {
		t.Fatalf("unexpected items: %+v", items)
	}
}

func TestProviderBitbucketPullsRoute(t *testing.T) {
	fake := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/repositories/team/app/pullrequests" {
			t.Errorf("unexpected path %q", r.URL.Path)
		}
		_, _ = w.Write([]byte(`{"values":[{"id":7,"title":"fix","state":"MERGED","updated_on":"2026-01-01T00:00:00Z","links":{"html":{"href":"https://bb/7"}},"source":{"branch":{"name":"f"}},"destination":{"branch":{"name":"main"}}}]}`))
	}))
	defer fake.Close()
	t.Setenv("PEBBLE_BITBUCKET_API_BASE_URL", fake.URL)

	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	projectID := localProjectWithRemote(t, manager, "git@bitbucket.org:team/app.git")
	server := NewServer(manager)

	code, items, body := getReviewWorkItems(t, server,
		"/v1/providers/bitbucket/pulls?projectId="+projectID+"&state=merged&limit=5")
	if code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", code, body)
	}
	if len(items) != 1 || items[0].ID != "bitbucket-pr-7" || items[0].State != "merged" {
		t.Fatalf("unexpected items: %+v", items)
	}
}

func TestProviderAzureDevOpsPullsRoute(t *testing.T) {
	fake := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/_apis/git/repositories/repo/pullrequests" {
			t.Errorf("unexpected path %q", r.URL.Path)
		}
		_, _ = w.Write([]byte(`{"value":[{"pullRequestId":42,"title":"t","status":"active","creationDate":"2026-01-01T00:00:00Z","sourceRefName":"refs/heads/f","targetRefName":"refs/heads/main"}]}`))
	}))
	defer fake.Close()
	t.Setenv("PEBBLE_AZURE_DEVOPS_API_BASE_URL", fake.URL)

	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	projectID := localProjectWithRemote(t, manager, "https://dev.azure.com/org/proj/_git/repo")
	server := NewServer(manager)

	code, items, body := getReviewWorkItems(t, server, "/v1/providers/azure-devops/pulls?projectId="+projectID)
	if code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", code, body)
	}
	if len(items) != 1 || items[0].ID != "azure-devops-pr-42" || items[0].BranchName != "f" {
		t.Fatalf("unexpected items: %+v", items)
	}
}

func TestProviderReviewWorkItemsRemoteMismatchReturns400(t *testing.T) {
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	projectID := localProjectWithRemote(t, manager, "git@github.com:o/r.git")
	server := NewServer(manager)

	code, _, body := getReviewWorkItems(t, server, "/v1/providers/bitbucket/pulls?projectId="+projectID)
	if code != http.StatusBadRequest {
		t.Fatalf("expected 400 for mismatched remote, got %d: %s", code, body)
	}
}

func TestProviderReviewWorkItemsUnauthenticatedReturns401(t *testing.T) {
	fake := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer fake.Close()
	t.Setenv("PEBBLE_GITEA_API_BASE_URL", fake.URL)

	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	projectID := localProjectWithRemote(t, manager, "git@git.example.com:owner/repo.git")
	server := NewServer(manager)

	code, _, body := getReviewWorkItems(t, server, "/v1/providers/gitea/pulls?projectId="+projectID)
	if code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d: %s", code, body)
	}
}
