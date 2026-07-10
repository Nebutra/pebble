package providerrest

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestParseGiteaRepoRef(t *testing.T) {
	cases := []struct {
		remote     string
		owner      string
		repo       string
		apiBaseURL string
	}{
		{"https://git.example.com/owner/repo.git", "owner", "repo", "https://git.example.com/api/v1"},
		{"git@git.example.com:owner/repo.git", "owner", "repo", "https://git.example.com/api/v1"},
		{"http://git.example.com:3000/owner/repo", "owner", "repo", "http://git.example.com:3000/api/v1"},
		// Subpath-hosted instance: base path carried in the repo path.
		{"git@git.example.com:forge/owner/repo.git", "owner", "repo", "https://git.example.com/forge/api/v1"},
	}
	for _, tc := range cases {
		ref := parseGiteaRepoRef(tc.remote)
		if ref == nil || ref.Owner != tc.owner || ref.Repo != tc.repo || ref.APIBaseURL != tc.apiBaseURL {
			t.Errorf("parseGiteaRepoRef(%q) = %+v, want %s/%s api=%s", tc.remote, ref, tc.owner, tc.repo, tc.apiBaseURL)
		}
	}
	// Gitea is the self-hosted fallback: the majors never parse as Gitea.
	for _, remote := range []string{
		"git@github.com:o/r.git",
		"https://gitlab.com/o/r.git",
		"https://bitbucket.org/o/r",
		"https://dev.azure.com/org/proj/_git/repo",
		"https://org.visualstudio.com/proj/_git/repo",
	} {
		if ref := parseGiteaRepoRef(remote); ref != nil {
			t.Errorf("parseGiteaRepoRef(%q) = %+v, want nil", remote, ref)
		}
	}
}

func TestListGiteaPRsMapsWorkItems(t *testing.T) {
	var gotPath, gotAuth, gotQuery string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		gotQuery = r.URL.RawQuery
		_ = json.NewEncoder(w).Encode([]map[string]interface{}{{
			"number":     3,
			"title":      "Improve docs",
			"state":      "open",
			"draft":      false,
			"html_url":   "https://git.example.com/owner/repo/pulls/3",
			"updated_at": "2026-02-03T04:05:06Z",
			"user":       map[string]interface{}{"login": "writer"},
			"labels":     []map[string]interface{}{{"name": "docs"}},
			"head": map[string]interface{}{
				"ref": "docs", "sha": "fff000",
				"repo": map[string]interface{}{"id": 2},
			},
			"base": map[string]interface{}{
				"ref": "main",
				"repo": map[string]interface{}{
					"id": 1,
				},
			},
		}})
	}))
	defer server.Close()

	config := GiteaConfig{APIBaseURL: normalizeGiteaAPIBaseURL(server.URL), Token: "tok"}
	items, err := ListGiteaPRs(context.Background(), server.Client(), config,
		"git@git.example.com:owner/repo.git", "opened", 15)
	if err != nil {
		t.Fatal(err)
	}
	if gotPath != "/api/v1/repos/owner/repo/pulls" {
		t.Errorf("unexpected path %q", gotPath)
	}
	if gotAuth != "token tok" {
		t.Errorf("unexpected auth %q", gotAuth)
	}
	if !strings.Contains(gotQuery, "state=open") || !strings.Contains(gotQuery, "limit=15") {
		t.Errorf("unexpected query %q", gotQuery)
	}
	if len(items) != 1 {
		t.Fatalf("expected 1 item, got %d", len(items))
	}
	item := items[0]
	if item.ID != "gitea-pr-3" || item.Type != "pr" || item.Number != 3 || item.State != "open" ||
		item.BranchName != "docs" || item.BaseRefName != "main" || item.HeadSha != "fff000" ||
		item.Author == nil || *item.Author != "writer" ||
		len(item.Labels) != 1 || item.Labels[0] != "docs" {
		t.Errorf("unexpected item: %+v", item)
	}
	if item.IsCrossRepository == nil || !*item.IsCrossRepository {
		t.Errorf("expected cross-repository true, got %v", item.IsCrossRepository)
	}
}

func TestListGiteaPRsMergedFilter(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.URL.Query().Get("state"); got != "closed" {
			t.Errorf("expected state=closed for merged filter, got %q", got)
		}
		_ = json.NewEncoder(w).Encode([]map[string]interface{}{
			{"number": 1, "title": "merged", "state": "closed", "merged": true, "html_url": "https://x/1"},
			{"number": 2, "title": "declined", "state": "closed", "merged": false, "html_url": "https://x/2"},
		})
	}))
	defer server.Close()

	config := GiteaConfig{APIBaseURL: normalizeGiteaAPIBaseURL(server.URL)}
	items, err := ListGiteaPRs(context.Background(), server.Client(), config,
		"https://git.example.com/owner/repo.git", "merged", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 || items[0].State != "merged" || items[0].Number != 1 {
		t.Errorf("expected only the merged PR, got %+v", items)
	}
}

func TestListGiteaPRsUnauthenticatedAndMismatch(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer server.Close()
	config := GiteaConfig{APIBaseURL: normalizeGiteaAPIBaseURL(server.URL)}
	_, err := ListGiteaPRs(context.Background(), server.Client(), config,
		"https://git.example.com/owner/repo.git", "opened", 5)
	if !errors.Is(err, ErrUnauthenticated) {
		t.Fatalf("expected ErrUnauthenticated, got %v", err)
	}
	_, err = ListGiteaPRs(context.Background(), server.Client(), config,
		"git@github.com:o/r.git", "opened", 5)
	if !errors.Is(err, ErrRemoteMismatch) {
		t.Fatalf("expected ErrRemoteMismatch, got %v", err)
	}
}

func TestNormalizeGiteaAPIBaseURL(t *testing.T) {
	if got := normalizeGiteaAPIBaseURL("https://git.example.com/"); got != "https://git.example.com/api/v1" {
		t.Errorf("unexpected normalized base: %q", got)
	}
	if got := normalizeGiteaAPIBaseURL("https://git.example.com/api/v1"); got != "https://git.example.com/api/v1" {
		t.Errorf("normalization should be idempotent, got %q", got)
	}
}
