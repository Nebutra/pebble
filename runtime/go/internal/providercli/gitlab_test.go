package providercli

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

const glabMRListJSON = `[
  {"id":1001,"iid":7,"title":"Ship it","state":"opened","web_url":"https://gitlab.com/g/p/-/merge_requests/7","updated_at":"2024-02-03T04:05:06Z","author":{"username":"tanuki"},"labels":["backend","frontend"],"draft":false,"source_branch":"topic","target_branch":"main","source_project_id":5,"target_project_id":5},
  {"id":1002,"iid":6,"title":"Draft: WIP thing","state":"opened","web_url":"https://gitlab.com/g/p/-/merge_requests/6","updated_at":"2024-02-02T00:00:00Z","author":{"username":"dev"},"labels":[{"name":"chore"}],"draft":false,"source_branch":"wip","target_branch":"main","source_project_id":9,"target_project_id":5}
]`

func TestGetGitLabRateLimitParsesSelfHostedHeaders(t *testing.T) {
	gitlabRateLimitCache.Lock()
	gitlabRateLimitCache.snapshots = nil
	gitlabRateLimitCache.Unlock()
	dir := fakeCLIStub(t, "glab", "HTTP/2 200\r\nRateLimit-Limit: 2000\r\nRateLimit-Remaining: 1997\r\nRateLimit-Reset: 1780000000\r\n\r\n{}", 0)
	withPath(t, dir)
	result := GetGitLabRateLimit(context.Background(), true, "git.internal")
	if !result.OK || result.Snapshot == nil || result.Snapshot.Rest == nil {
		t.Fatalf("unexpected rate-limit result: %+v", result)
	}
	if result.Snapshot.Host == nil || *result.Snapshot.Host != "git.internal" || result.Snapshot.Rest.Limit != 2000 || result.Snapshot.Rest.Remaining != 1997 || result.Snapshot.Rest.ResetAt == nil || *result.Snapshot.Rest.ResetAt != 1780000000 {
		t.Fatalf("unexpected rate-limit mapping: %+v", result.Snapshot)
	}
}

func TestParseGitLabRateLimitSnapshotAllowsMissingHeaders(t *testing.T) {
	snapshot := parseGitLabRateLimitSnapshot([]byte("HTTP/2 200\r\nContent-Type: application/json\r\n\r\n{}"), "", 123)
	if snapshot.Rest != nil || snapshot.Host != nil || snapshot.FetchedAt != 123 {
		t.Fatalf("expected an explicit unavailable bucket: %+v", snapshot)
	}
}

func TestGetGitLabViewerMapsIdentity(t *testing.T) {
	dir := fakeCLIStub(t, "glab", `{"username":"tanuki","email":"tanuki@example.com"}`, 0)
	withPath(t, dir)
	viewer := GetGitLabViewer(context.Background())
	if viewer == nil || viewer.Username != "tanuki" || viewer.Email == nil || *viewer.Email != "tanuki@example.com" {
		t.Fatalf("unexpected viewer: %+v", viewer)
	}
}

func TestDiagnoseGitLabAuthParsesHost(t *testing.T) {
	dir := fakeCLIStub(t, "glab", "git.internal\n  Logged in to git.internal as tanuki\n  Token: configured", 0)
	withPath(t, dir)
	t.Setenv("GITLAB_TOKEN", "")
	t.Setenv("GLAB_TOKEN", "secret")
	diagnostic := DiagnoseGitLabAuth(context.Background())
	if !diagnostic.GlabAvailable || !diagnostic.Authenticated || diagnostic.ActiveHost == nil || *diagnostic.ActiveHost != "git.internal" {
		t.Fatalf("unexpected auth diagnostic: %+v", diagnostic)
	}
	if diagnostic.EnvTokenInProcess == nil || *diagnostic.EnvTokenInProcess != "GLAB_TOKEN" {
		t.Fatalf("unexpected env token: %+v", diagnostic)
	}
}

func TestDiagnoseGitLabAuthDoesNotTreatNegativeMessageAsAuthenticated(t *testing.T) {
	dir := fakeCLIStub(t, "glab", "X git.internal has not been authenticated with glab", 1)
	withPath(t, dir)
	diagnostic := DiagnoseGitLabAuth(context.Background())
	if diagnostic.Authenticated || !diagnostic.GlabAvailable || diagnostic.Error == nil {
		t.Fatalf("unexpected negative auth diagnostic: %+v", diagnostic)
	}
}

func TestListGitLabMRsHappyPath(t *testing.T) {
	dir := fakeCLIStub(t, "glab", glabMRListJSON, 0)
	withPath(t, dir)
	items, err := ListGitLabMRs(context.Background(), "", "opened", 20, "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(items) != 2 {
		t.Fatalf("expected 2 items, got %d", len(items))
	}
	first := items[0]
	if first.ID != "gitlab-mr-1001" || first.Type != "mr" || first.Number != 7 {
		t.Fatalf("unexpected id/type/number: %+v", first)
	}
	if first.State != "opened" {
		t.Fatalf("expected opened state, got %q", first.State)
	}
	if first.URL != "https://gitlab.com/g/p/-/merge_requests/7" {
		t.Fatalf("unexpected url: %q", first.URL)
	}
	if first.Author == nil || *first.Author != "tanuki" {
		t.Fatalf("expected author tanuki, got %+v", first.Author)
	}
	if first.BranchName != "topic" || first.BaseRefName != "main" {
		t.Fatalf("unexpected branches: %+v", first)
	}
	if len(first.Labels) != 2 || first.Labels[0] != "backend" {
		t.Fatalf("unexpected labels: %+v", first.Labels)
	}
	// First item's source/target project ids match (5==5): same-repo MR.
	if first.IsCrossRepository == nil || *first.IsCrossRepository {
		t.Fatalf("expected same-repo MR to report isCrossRepository=false, got %+v", first.IsCrossRepository)
	}
	// Second item's title carries a Draft:/WIP: prefix, which maps to draft
	// state even though the draft boolean is false (mirrors mapMRState).
	if items[1].State != "draft" {
		t.Fatalf("expected draft state from title prefix, got %q", items[1].State)
	}
	if len(items[1].Labels) != 1 || items[1].Labels[0] != "chore" {
		t.Fatalf("expected object-form label to coerce to name: %+v", items[1].Labels)
	}
	// Second item's source (9) and target (5) project ids differ: fork MR.
	if items[1].IsCrossRepository == nil || !*items[1].IsCrossRepository {
		t.Fatalf("expected fork MR to report isCrossRepository=true, got %+v", items[1].IsCrossRepository)
	}
}

func TestListGitLabMRsIsCrossRepositoryUnknownWhenProjectIDsMissing(t *testing.T) {
	json := `[{"id":2001,"iid":3,"title":"No project ids","state":"opened","web_url":"https://gitlab.com/g/p/-/merge_requests/3","updated_at":"2024-02-03T04:05:06Z","author":{"username":"tanuki"},"labels":[],"draft":false,"source_branch":"topic","target_branch":"main"}]`
	dir := fakeCLIStub(t, "glab", json, 0)
	withPath(t, dir)
	items, err := ListGitLabMRs(context.Background(), "", "opened", 20, "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(items) != 1 {
		t.Fatalf("expected 1 item, got %d", len(items))
	}
	if items[0].IsCrossRepository != nil {
		t.Fatalf("expected nil isCrossRepository when project ids are absent, got %+v", items[0].IsCrossRepository)
	}
}

func TestListGitLabMRsMissingCLI(t *testing.T) {
	withEmptyPath(t, t.TempDir())
	_, err := ListGitLabMRs(context.Background(), "", "opened", 20, "")
	if !errors.Is(err, ErrCLIMissing) {
		t.Fatalf("expected ErrCLIMissing, got %v", err)
	}
}

func TestListGitLabMRsUnauthenticated(t *testing.T) {
	dir := fakeCLIStub(t, "glab", "error: run `glab auth login` to authenticate", 1)
	withPath(t, dir)
	_, err := ListGitLabMRs(context.Background(), "", "opened", 20, "")
	if !errors.Is(err, ErrCLIUnauthenticated) {
		t.Fatalf("expected ErrCLIUnauthenticated, got %v", err)
	}
}

func TestListGitLabMRsMalformedJSON(t *testing.T) {
	dir := fakeCLIStub(t, "glab", "<<not json>>", 0)
	withPath(t, dir)
	_, err := ListGitLabMRs(context.Background(), "", "opened", 20, "")
	if err == nil {
		t.Fatal("expected parse error, got nil")
	}
	if errors.Is(err, ErrCLIMissing) || errors.Is(err, ErrCLIUnauthenticated) {
		t.Fatalf("malformed JSON should not classify as missing/unauth: %v", err)
	}
}

func TestGetGitLabJobTraceUsesSelfHostedProjectRef(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fake CLI stub uses a POSIX shell script")
	}
	dir := t.TempDir()
	logPath := filepath.Join(dir, "calls.log")
	script := "#!/bin/sh\necho \"$*\" >> \"" + logPath + "\"\nprintf 'line one\\nline two\\n'\n"
	if err := os.WriteFile(filepath.Join(dir, "glab"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	withPath(t, dir)
	result := GetGitLabJobTrace(context.Background(), "", 99, &GitLabProjectRef{Host: "git.internal", Path: "group/sub/project"})
	if !result.OK || !strings.Contains(result.Trace, "line two") {
		t.Fatalf("unexpected trace result: %+v", result)
	}
	calls, _ := os.ReadFile(logPath)
	if !strings.Contains(string(calls), "--hostname git.internal") || !strings.Contains(string(calls), "projects/group%2Fsub%2Fproject/jobs/99/trace") {
		t.Fatalf("unexpected glab args: %s", calls)
	}
}

func TestRetryGitLabJobMapsReplacementJob(t *testing.T) {
	dir := fakeCLIStub(t, "glab", `{"id":100,"pipeline":{"id":50},"name":"test","stage":"verify","status":"pending","web_url":"https://git.internal/g/p/-/jobs/100","duration":null}`, 0)
	withPath(t, dir)
	result := RetryGitLabJob(context.Background(), "", 99, &GitLabProjectRef{Host: "git.internal", Path: "g/p"})
	if !result.OK || result.Job == nil || result.Job.ID != 100 || result.Job.PipelineID == nil || *result.Job.PipelineID != 50 || result.Job.Duration != nil {
		t.Fatalf("unexpected retry result: %+v", result)
	}
}
