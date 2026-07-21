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

func TestParseAzureDevOpsRepoRef(t *testing.T) {
	cases := []struct {
		remote     string
		repository string
		apiBaseURL string
	}{
		{"https://dev.azure.com/org/proj/_git/repo", "repo", "https://dev.azure.com/org/proj"},
		{"https://user@dev.azure.com/org/proj/_git/repo", "repo", "https://dev.azure.com/org/proj"},
		{"git@ssh.dev.azure.com:v3/org/proj/repo", "repo", "https://dev.azure.com/org/proj"},
		{"https://org.visualstudio.com/proj/_git/repo", "repo", "https://dev.azure.com/org/proj"},
		{"https://tfs.corp.example/tfs/Collection/proj/_git/repo", "repo", "https://tfs.corp.example/tfs/Collection/proj"},
	}
	for _, tc := range cases {
		ref := parseAzureDevOpsRepoRef(tc.remote)
		if ref == nil || ref.Repository != tc.repository || ref.APIBaseURL != tc.apiBaseURL {
			t.Errorf("parseAzureDevOpsRepoRef(%q) = %+v, want repo=%s api=%s", tc.remote, ref, tc.repository, tc.apiBaseURL)
		}
	}
	for _, remote := range []string{"git@github.com:o/r.git", "https://gitea.example/o/r.git"} {
		if ref := parseAzureDevOpsRepoRef(remote); ref != nil {
			t.Errorf("parseAzureDevOpsRepoRef(%q) = %+v, want nil", remote, ref)
		}
	}
}

func TestListAzureDevOpsPRsMapsWorkItems(t *testing.T) {
	var gotPath, gotAuth, gotQuery string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		gotQuery = r.URL.RawQuery
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"value": []map[string]interface{}{
				{
					"pullRequestId": 42,
					"title":         "Add feature",
					"status":        "active",
					"isDraft":       true,
					"creationDate":  "2026-01-01T00:00:00Z",
					"sourceRefName": "refs/heads/feature",
					"targetRefName": "refs/heads/main",
					"createdBy":     map[string]interface{}{"uniqueName": "dev@example.com"},
					"lastMergeSourceCommit": map[string]interface{}{
						"commitId": "abc123",
					},
					"labels":     []map[string]interface{}{{"name": "bug"}},
					"forkSource": map[string]interface{}{"repository": map[string]interface{}{"id": "x"}},
				},
				{
					"pullRequestId": 43,
					"title":         "Done",
					"status":        "completed",
					"creationDate":  "2026-01-01T00:00:00Z",
					"closedDate":    "2026-01-02T00:00:00Z",
					"sourceRefName": "refs/heads/other",
					"targetRefName": "refs/heads/main",
				},
			},
		})
	}))
	defer server.Close()

	config := AzureDevOpsConfig{APIBaseURL: server.URL, PAT: "pat", Username: "u"}
	items, err := ListAzureDevOpsPRs(context.Background(), server.Client(), config,
		"https://dev.azure.com/org/proj/_git/repo", "all", 10)
	if err != nil {
		t.Fatal(err)
	}
	if gotPath != "/_apis/git/repositories/repo/pullrequests" {
		t.Errorf("unexpected path %q", gotPath)
	}
	if !strings.HasPrefix(gotAuth, "Basic ") {
		t.Errorf("expected basic auth, got %q", gotAuth)
	}
	if !strings.Contains(gotQuery, "searchCriteria.status=all") || !strings.Contains(gotQuery, "api-version=7.1") {
		t.Errorf("unexpected query %q", gotQuery)
	}
	if len(items) != 2 {
		t.Fatalf("expected 2 items, got %d", len(items))
	}
	draft := items[0]
	if draft.ID != "azure-devops-pr-42" || draft.State != "draft" || draft.BranchName != "feature" ||
		draft.BaseRefName != "main" || draft.HeadSha != "abc123" ||
		draft.Author == nil || *draft.Author != "dev@example.com" ||
		len(draft.Labels) != 1 || draft.Labels[0] != "bug" {
		t.Errorf("unexpected draft item: %+v", draft)
	}
	if draft.IsCrossRepository == nil || !*draft.IsCrossRepository {
		t.Errorf("expected fork PR cross-repository true, got %v", draft.IsCrossRepository)
	}
	merged := items[1]
	if merged.State != "merged" || merged.UpdatedAt != "2026-01-02T00:00:00Z" {
		t.Errorf("unexpected merged item: %+v", merged)
	}
	if merged.IsCrossRepository == nil || *merged.IsCrossRepository {
		t.Errorf("expected same-repo PR cross-repository false, got %v", merged.IsCrossRepository)
	}
	// URL falls back to webBaseUrl/pullrequest/<id> when _links is absent.
	if merged.URL != "https://dev.azure.com/org/proj/_git/repo/pullrequest/43" {
		t.Errorf("unexpected fallback URL %q", merged.URL)
	}
}

func TestListAzureDevOpsPRsUnauthenticated(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
	}))
	defer server.Close()
	_, err := ListAzureDevOpsPRs(context.Background(), server.Client(),
		AzureDevOpsConfig{APIBaseURL: server.URL},
		"git@ssh.dev.azure.com:v3/org/proj/repo", "opened", 5)
	if !errors.Is(err, ErrUnauthenticated) {
		t.Fatalf("expected ErrUnauthenticated, got %v", err)
	}
}

func TestNormalizeAzureDevOpsAPIBaseURL(t *testing.T) {
	if got := normalizeAzureDevOpsAPIBaseURL("https://dev.azure.com/org/proj/_apis/"); got != "https://dev.azure.com/org/proj" {
		t.Errorf("unexpected normalized base: %q", got)
	}
}

func TestCreateAzureDevOpsPRPostsAndMapsCreated(t *testing.T) {
	var gotMethod, gotPath string
	var gotBody map[string]interface{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod = r.Method
		gotPath = r.URL.Path
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"pullRequestId": 55,
			"title":         "Add feature",
			"status":        "active",
			"sourceRefName": "refs/heads/feature",
			"targetRefName": "refs/heads/main",
			"creationDate":  "2026-01-01T00:00:00Z",
			"_links":        map[string]interface{}{"web": map[string]interface{}{"href": "https://dev.azure.com/org/proj/_git/repo/pullrequest/55"}},
		})
	}))
	defer server.Close()

	config := AzureDevOpsConfig{APIBaseURL: server.URL, PAT: "pat", Username: "u"}
	result := CreateAzureDevOpsPR(context.Background(), server.Client(), config, "https://dev.azure.com/org/proj/_git/repo", CreateReviewInput{
		Base: "main", Head: "feature", Title: "Add feature", Draft: true,
	})
	if !result.OK || result.Number != 55 || result.URL != "https://dev.azure.com/org/proj/_git/repo/pullrequest/55" {
		t.Fatalf("unexpected create result: %+v", result)
	}
	if gotMethod != http.MethodPost || gotPath != "/_apis/git/repositories/repo/pullrequests" {
		t.Errorf("unexpected request %s %s", gotMethod, gotPath)
	}
	if gotBody["sourceRefName"] != "refs/heads/feature" || gotBody["targetRefName"] != "refs/heads/main" || gotBody["isDraft"] != true {
		t.Errorf("unexpected request body: %+v", gotBody)
	}
}

func TestCreateAzureDevOpsPRValidatesInput(t *testing.T) {
	result := CreateAzureDevOpsPR(context.Background(), nil, AzureDevOpsConfig{}, "https://dev.azure.com/org/proj/_git/repo", CreateReviewInput{
		Base: "main", Head: "main", Title: "x",
	})
	if result.OK || result.Code != "validation" {
		t.Fatalf("expected validation result for equal base/head, got %+v", result)
	}
}

func TestUpdateAzureDevOpsPRPatchesStatusAndReviewers(t *testing.T) {
	var calls []string
	var lastPatchBody map[string]interface{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls = append(calls, r.Method+" "+r.URL.Path)
		if r.Method == http.MethodPatch {
			_ = json.NewDecoder(r.Body).Decode(&lastPatchBody)
		}
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]interface{}{})
	}))
	defer server.Close()

	config := AzureDevOpsConfig{APIBaseURL: server.URL, PAT: "pat", Username: "u"}
	title := "Updated title"
	result := UpdateAzureDevOpsPR(context.Background(), server.Client(), config, "https://dev.azure.com/org/proj/_git/repo", 12, UpdateReviewInput{
		Title:        &title,
		State:        "closed",
		AddReviewers: []string{"reviewer-id"},
	})
	if !result.OK {
		t.Fatalf("expected update to succeed, got %+v", result)
	}
	if lastPatchBody["status"] != "abandoned" || lastPatchBody["title"] != "Updated title" {
		t.Errorf("unexpected PATCH body: %+v", lastPatchBody)
	}
	foundReviewerPut := false
	for _, call := range calls {
		if call == "PUT /_apis/git/repositories/repo/pullrequests/12/reviewers/reviewer-id" {
			foundReviewerPut = true
		}
	}
	if !foundReviewerPut {
		t.Errorf("expected reviewer PUT call, got calls: %v", calls)
	}
}

func TestUpdateAzureDevOpsPROpenMapsToActiveStatus(t *testing.T) {
	var lastPatchBody map[string]interface{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&lastPatchBody)
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]interface{}{})
	}))
	defer server.Close()

	config := AzureDevOpsConfig{APIBaseURL: server.URL, PAT: "pat", Username: "u"}
	result := UpdateAzureDevOpsPR(context.Background(), server.Client(), config, "https://dev.azure.com/org/proj/_git/repo", 12, UpdateReviewInput{
		State: "open",
	})
	if !result.OK || lastPatchBody["status"] != "active" {
		t.Fatalf("expected reopen to map to active status, got result=%+v body=%+v", result, lastPatchBody)
	}
}

func TestUpdateAzureDevOpsPRValidatesNumber(t *testing.T) {
	result := UpdateAzureDevOpsPR(context.Background(), nil, AzureDevOpsConfig{APIBaseURL: "http://unused"}, "https://dev.azure.com/org/proj/_git/repo", 0, UpdateReviewInput{})
	if result.OK || result.Code != "validation" {
		t.Fatalf("expected validation for missing number, got %+v", result)
	}
}
