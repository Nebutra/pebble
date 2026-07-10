package providercli

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// fakeCLIStub writes an executable named `name` on a fresh PATH that echoes
// `stdout` and exits with `exitCode`. It returns the temp bin dir so tests can
// point PATH at it, exercising the same LookPath + exec path production uses.
func fakeCLIStub(t *testing.T, name string, stdout string, exitCode int) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("fake CLI stub uses a POSIX shell script")
	}
	dir := t.TempDir()
	script := "#!/bin/sh\ncat <<'PEBBLE_EOF'\n" + stdout + "\nPEBBLE_EOF\n"
	if exitCode != 0 {
		script += "exit " + itoa(exitCode) + "\n"
	}
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
		t.Fatalf("write fake %s: %v", name, err)
	}
	return dir
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}

func withPath(t *testing.T, dir string) {
	t.Helper()
	// Prepend the stub dir so it shadows any real gh/glab, while keeping the
	// system PATH so the stub's own `cat`/`sh` builtins resolve.
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
}

// withEmptyPath points PATH at an empty dir so no gh/glab resolves, exercising
// the LookPath-miss branch. A minimal /usr/bin fallback stays so `sh` runs
// nothing here — the missing-CLI check happens before any exec.
func withEmptyPath(t *testing.T, dir string) {
	t.Helper()
	t.Setenv("PATH", dir)
}

const ghPRListJSON = `[
  {"number":42,"title":"Add feature","state":"OPEN","url":"https://github.com/o/r/pull/42","labels":[{"name":"enhancement"},{"name":"needs-review"}],"updatedAt":"2024-01-02T03:04:05Z","author":{"login":"octocat"},"isDraft":false,"headRefName":"feature","baseRefName":"main","headRefOid":"abc123","isCrossRepository":false},
  {"number":41,"title":"Draft work","state":"OPEN","url":"https://github.com/o/r/pull/41","labels":[],"updatedAt":"2024-01-01T00:00:00Z","author":{"login":"hubot"},"isDraft":true,"headRefName":"draft","baseRefName":"main","headRefOid":"def456","isCrossRepository":true}
]`

func TestListGitHubPRsHappyPath(t *testing.T) {
	dir := fakeCLIStub(t, "gh", ghPRListJSON, 0)
	withPath(t, dir)
	items, err := ListGitHubPRs(context.Background(), "", 24)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(items) != 2 {
		t.Fatalf("expected 2 items, got %d", len(items))
	}
	first := items[0]
	if first.ID != "pr:42" || first.Type != "pr" || first.Number != 42 {
		t.Fatalf("unexpected id/type/number: %+v", first)
	}
	if first.State != "open" {
		t.Fatalf("expected open state, got %q", first.State)
	}
	if first.Author == nil || *first.Author != "octocat" {
		t.Fatalf("expected author octocat, got %+v", first.Author)
	}
	if first.BranchName != "feature" || first.BaseRefName != "main" || first.HeadSha != "abc123" {
		t.Fatalf("unexpected branch/base/sha: %+v", first)
	}
	if len(first.Labels) != 2 || first.Labels[0] != "enhancement" {
		t.Fatalf("unexpected labels: %+v", first.Labels)
	}
	if items[1].State != "draft" {
		t.Fatalf("expected draft state for isDraft item, got %q", items[1].State)
	}
	if first.IsCrossRepository == nil || *first.IsCrossRepository {
		t.Fatalf("expected same-repo PR to report isCrossRepository=false, got %+v", first.IsCrossRepository)
	}
	if items[1].IsCrossRepository == nil || !*items[1].IsCrossRepository {
		t.Fatalf("expected fork PR to report isCrossRepository=true, got %+v", items[1].IsCrossRepository)
	}
}

func TestListGitHubPRsIsCrossRepositoryUnknownWhenFieldMissing(t *testing.T) {
	// Older gh responses (or callers without the field) omit isCrossRepository
	// entirely; the pointer must stay nil rather than default to false.
	json := `[{"number":7,"title":"No cross-repo field","state":"OPEN","url":"https://github.com/o/r/pull/7","labels":[],"updatedAt":"2024-01-01T00:00:00Z","author":{"login":"a"},"isDraft":false,"headRefName":"h","baseRefName":"main","headRefOid":"z"}]`
	dir := fakeCLIStub(t, "gh", json, 0)
	withPath(t, dir)
	items, err := ListGitHubPRs(context.Background(), "", 24)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(items) != 1 {
		t.Fatalf("expected 1 item, got %d", len(items))
	}
	if items[0].IsCrossRepository != nil {
		t.Fatalf("expected nil isCrossRepository when field is absent, got %+v", items[0].IsCrossRepository)
	}
}

func TestGetGitHubPRMergedState(t *testing.T) {
	dir := fakeCLIStub(t, "gh",
		`{"number":9,"title":"Done","state":"MERGED","url":"https://github.com/o/r/pull/9","labels":[],"updatedAt":"2024-01-01T00:00:00Z","author":{"login":"a"},"isDraft":false,"headRefName":"h","baseRefName":"main","headRefOid":"z"}`,
		0)
	withPath(t, dir)
	item, err := GetGitHubPR(context.Background(), "", 9)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if item.State != "merged" {
		t.Fatalf("expected merged state, got %q", item.State)
	}
}

func TestGetGitHubPRChecksMapsStates(t *testing.T) {
	dir := fakeCLIStub(t, "gh",
		`[{"name":"build","state":"SUCCESS","link":"https://github.com/o/r/runs/1"},{"name":"lint","state":"FAILURE","link":""},{"name":"deploy","state":"IN_PROGRESS","link":"https://x"}]`,
		0)
	withPath(t, dir)
	checks, err := GetGitHubPRChecks(context.Background(), "", 42)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(checks) != 3 {
		t.Fatalf("expected 3 checks, got %d", len(checks))
	}
	if checks[0].Status != "completed" || checks[0].Conclusion == nil || *checks[0].Conclusion != "success" {
		t.Fatalf("unexpected build check: %+v", checks[0])
	}
	if checks[0].URL == nil || *checks[0].URL != "https://github.com/o/r/runs/1" {
		t.Fatalf("expected build url, got %+v", checks[0].URL)
	}
	if checks[1].Conclusion == nil || *checks[1].Conclusion != "failure" {
		t.Fatalf("unexpected lint conclusion: %+v", checks[1].Conclusion)
	}
	if checks[1].URL != nil {
		t.Fatalf("expected nil url for empty link, got %+v", checks[1].URL)
	}
	if checks[2].Status != "in_progress" || checks[2].Conclusion == nil || *checks[2].Conclusion != "pending" {
		t.Fatalf("unexpected deploy check: %+v", checks[2])
	}
}

func TestGetGitHubPRChecksNoChecksReportedIsEmpty(t *testing.T) {
	// gh exits non-zero with "no checks reported" when a PR has no check runs;
	// treat as an empty optional section, not a load failure (matches Electron).
	dir := fakeCLIStub(t, "gh", "no checks reported on the 'feature' branch", 1)
	withPath(t, dir)
	checks, err := GetGitHubPRChecks(context.Background(), "", 42)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(checks) != 0 {
		t.Fatalf("expected 0 checks, got %d", len(checks))
	}
}

func TestListGitHubPRsMissingCLI(t *testing.T) {
	withEmptyPath(t, t.TempDir()) // empty dir, no gh on PATH
	_, err := ListGitHubPRs(context.Background(), "", 24)
	if !errors.Is(err, ErrCLIMissing) {
		t.Fatalf("expected ErrCLIMissing, got %v", err)
	}
}

func TestListGitHubPRsUnauthenticated(t *testing.T) {
	dir := fakeCLIStub(t, "gh", "gh auth login required: not authenticated", 1)
	withPath(t, dir)
	_, err := ListGitHubPRs(context.Background(), "", 24)
	if !errors.Is(err, ErrCLIUnauthenticated) {
		t.Fatalf("expected ErrCLIUnauthenticated, got %v", err)
	}
}

func TestListGitHubPRsMalformedJSON(t *testing.T) {
	dir := fakeCLIStub(t, "gh", "not json at all", 0)
	withPath(t, dir)
	_, err := ListGitHubPRs(context.Background(), "", 24)
	if err == nil {
		t.Fatal("expected parse error, got nil")
	}
	if errors.Is(err, ErrCLIMissing) || errors.Is(err, ErrCLIUnauthenticated) {
		t.Fatalf("malformed JSON should not classify as missing/unauth: %v", err)
	}
}
