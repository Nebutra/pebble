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

func TestParseBitbucketRepoRef(t *testing.T) {
	cases := []struct {
		remote    string
		workspace string
		repoSlug  string
	}{
		{"https://bitbucket.org/team/app.git", "team", "app"},
		{"git@bitbucket.org:team/app.git", "team", "app"},
		{"git@bitbucket.org:team/app", "team", "app"},
		{"https://user@bitbucket.org/team/app", "team", "app"},
	}
	for _, tc := range cases {
		ref := parseBitbucketRepoRef(tc.remote)
		if ref == nil || ref.Workspace != tc.workspace || ref.RepoSlug != tc.repoSlug {
			t.Errorf("parseBitbucketRepoRef(%q) = %+v, want %s/%s", tc.remote, ref, tc.workspace, tc.repoSlug)
		}
	}
	for _, remote := range []string{"git@github.com:o/r.git", "https://gitlab.com/o/r", "not a remote"} {
		if ref := parseBitbucketRepoRef(remote); ref != nil {
			t.Errorf("parseBitbucketRepoRef(%q) = %+v, want nil", remote, ref)
		}
	}
}

func TestListBitbucketPRsMapsWorkItems(t *testing.T) {
	var gotPath, gotAuth, gotQuery string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		gotQuery = r.URL.RawQuery
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"values": []map[string]interface{}{{
				"id":         7,
				"title":      "Fix crash",
				"state":      "OPEN",
				"updated_on": "2026-01-02T03:04:05Z",
				"links":      map[string]interface{}{"html": map[string]interface{}{"href": "https://bitbucket.org/team/app/pull-requests/7"}},
				"author":     map[string]interface{}{"nickname": "dev"},
				"source": map[string]interface{}{
					"branch":     map[string]interface{}{"name": "feature"},
					"commit":     map[string]interface{}{"hash": "abc123"},
					"repository": map[string]interface{}{"full_name": "fork/app"},
				},
				"destination": map[string]interface{}{
					"branch":     map[string]interface{}{"name": "main"},
					"repository": map[string]interface{}{"full_name": "team/app"},
				},
			}},
		})
	}))
	defer server.Close()

	config := BitbucketConfig{APIBaseURL: server.URL, AccessToken: "tok"}
	items, err := ListBitbucketPRs(context.Background(), server.Client(), config,
		"git@bitbucket.org:team/app.git", "opened", 10)
	if err != nil {
		t.Fatal(err)
	}
	if gotPath != "/repositories/team/app/pullrequests" {
		t.Errorf("unexpected path %q", gotPath)
	}
	if gotAuth != "Bearer tok" {
		t.Errorf("unexpected auth %q", gotAuth)
	}
	if gotQuery == "" || !strings.Contains(gotQuery, "state=OPEN") || !strings.Contains(gotQuery, "pagelen=10") {
		t.Errorf("unexpected query %q", gotQuery)
	}
	if len(items) != 1 {
		t.Fatalf("expected 1 item, got %d", len(items))
	}
	item := items[0]
	if item.ID != "bitbucket-pr-7" || item.Type != "pr" || item.Number != 7 ||
		item.State != "open" || item.BranchName != "feature" || item.BaseRefName != "main" ||
		item.HeadSha != "abc123" || item.Author == nil || *item.Author != "dev" {
		t.Errorf("unexpected item: %+v", item)
	}
	if item.IsCrossRepository == nil || !*item.IsCrossRepository {
		t.Errorf("expected cross-repository true, got %v", item.IsCrossRepository)
	}
	if item.Labels == nil || len(item.Labels) != 0 {
		t.Errorf("expected empty labels, got %v", item.Labels)
	}
}

func TestListBitbucketPRsBasicAuthAndUnauthenticated(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer server.Close()

	config := BitbucketConfig{APIBaseURL: server.URL, Email: "a@b.c", APIToken: "t"}
	if config.authHeaders()["Authorization"] != "Basic YUBiLmM6dA==" {
		t.Errorf("unexpected basic auth header: %v", config.authHeaders())
	}
	_, err := ListBitbucketPRs(context.Background(), server.Client(), config,
		"https://bitbucket.org/team/app", "opened", 5)
	if !errors.Is(err, ErrUnauthenticated) {
		t.Fatalf("expected ErrUnauthenticated, got %v", err)
	}
}

func TestListBitbucketPRsRemoteMismatch(t *testing.T) {
	_, err := ListBitbucketPRs(context.Background(), nil, BitbucketConfig{APIBaseURL: "http://unused"},
		"git@github.com:o/r.git", "opened", 5)
	if !errors.Is(err, ErrRemoteMismatch) {
		t.Fatalf("expected ErrRemoteMismatch, got %v", err)
	}
}

func TestBitbucketListStates(t *testing.T) {
	if got := bitbucketListStates("closed"); len(got) != 2 || got[0] != "DECLINED" {
		t.Errorf("closed states: %v", got)
	}
	if got := bitbucketListStates(""); len(got) != 1 || got[0] != "OPEN" {
		t.Errorf("default states: %v", got)
	}
}

func TestCreateBitbucketPRPostsAndMapsCreated(t *testing.T) {
	var gotMethod, gotPath string
	var gotBody map[string]interface{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod = r.Method
		gotPath = r.URL.Path
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"id":    9,
			"title": "Add feature",
			"state": "OPEN",
			"links": map[string]interface{}{"html": map[string]interface{}{"href": "https://bitbucket.org/team/app/pull-requests/9"}},
			"source": map[string]interface{}{
				"branch": map[string]interface{}{"name": "feature"},
			},
			"destination": map[string]interface{}{
				"branch": map[string]interface{}{"name": "main"},
			},
		})
	}))
	defer server.Close()

	config := BitbucketConfig{APIBaseURL: server.URL, AccessToken: "tok"}
	result := CreateBitbucketPR(context.Background(), server.Client(), config, "git@bitbucket.org:team/app.git", CreateReviewInput{
		Base: "main", Head: "feature", Title: "Add feature", Body: "Body",
	})
	if !result.OK || result.Number != 9 || result.URL != "https://bitbucket.org/team/app/pull-requests/9" {
		t.Fatalf("unexpected create result: %+v", result)
	}
	if gotMethod != http.MethodPost || gotPath != "/repositories/team/app/pullrequests" {
		t.Errorf("unexpected request %s %s", gotMethod, gotPath)
	}
	source, _ := gotBody["source"].(map[string]interface{})
	sourceBranch, _ := source["branch"].(map[string]interface{})
	if sourceBranch["name"] != "feature" {
		t.Errorf("unexpected request body: %+v", gotBody)
	}
}

func TestCreateBitbucketPRValidatesInput(t *testing.T) {
	result := CreateBitbucketPR(context.Background(), nil, BitbucketConfig{}, "git@bitbucket.org:team/app.git", CreateReviewInput{
		Base: "main", Head: "main", Title: "x",
	})
	if result.OK || result.Code != "validation" {
		t.Fatalf("expected validation result for equal base/head, got %+v", result)
	}
}

func TestCreateBitbucketPRRemoteMismatch(t *testing.T) {
	result := CreateBitbucketPR(context.Background(), nil, BitbucketConfig{}, "git@github.com:o/r.git", CreateReviewInput{
		Base: "main", Head: "feature", Title: "x",
	})
	if result.OK || result.Code != "unsupported_provider" {
		t.Fatalf("expected unsupported_provider for non-bitbucket remote, got %+v", result)
	}
}

func TestUpdateBitbucketPRTitleAndDeclineState(t *testing.T) {
	var calls []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls = append(calls, r.Method+" "+r.URL.Path)
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]interface{}{})
	}))
	defer server.Close()

	title := "New title"
	config := BitbucketConfig{APIBaseURL: server.URL, AccessToken: "tok"}
	result := UpdateBitbucketPR(context.Background(), server.Client(), config, "git@bitbucket.org:team/app.git", 7, UpdateReviewInput{
		Title: &title,
		State: "closed",
	})
	if !result.OK {
		t.Fatalf("expected update to succeed, got %+v", result)
	}
	wantCalls := []string{
		"PUT /repositories/team/app/pullrequests/7",
		"POST /repositories/team/app/pullrequests/7/decline",
	}
	if len(calls) != len(wantCalls) || calls[0] != wantCalls[0] || calls[1] != wantCalls[1] {
		t.Errorf("unexpected calls: %v", calls)
	}
}

func TestUpdateBitbucketPRReopenIsUnsupported(t *testing.T) {
	result := UpdateBitbucketPR(context.Background(), nil, BitbucketConfig{APIBaseURL: "http://unused"}, "git@bitbucket.org:team/app.git", 7, UpdateReviewInput{
		State: "open",
	})
	if result.OK || result.Code != "unsupported_provider" {
		t.Fatalf("expected reopen to be an explicit unsupported gap, got %+v", result)
	}
}

func TestUpdateBitbucketPRIncrementalReviewersIsUnsupported(t *testing.T) {
	result := UpdateBitbucketPR(context.Background(), nil, BitbucketConfig{APIBaseURL: "http://unused"}, "git@bitbucket.org:team/app.git", 7, UpdateReviewInput{
		AddReviewers: []string{"dev"},
	})
	if result.OK || result.Code != "unsupported_provider" {
		t.Fatalf("expected incremental reviewer add/remove to be unsupported, got %+v", result)
	}
}

func TestUpdateBitbucketPRValidatesNumber(t *testing.T) {
	result := UpdateBitbucketPR(context.Background(), nil, BitbucketConfig{APIBaseURL: "http://unused"}, "git@bitbucket.org:team/app.git", 0, UpdateReviewInput{})
	if result.OK || result.Code != "validation" {
		t.Fatalf("expected validation for missing number, got %+v", result)
	}
}
