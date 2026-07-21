package providercli

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestListGitHubIssuesFiltersPullRequests(t *testing.T) {
	dir, _ := githubWorkItemsCLI(t, false)
	withPath(t, dir)
	result := ListGitHubIssues(context.Background(), t.TempDir(), 20)
	if result.Error != nil || len(result.Items) != 1 || result.Items[0].Number != 8 {
		t.Fatalf("unexpected issue result: %+v", result)
	}
}

func TestListGitHubWorkItemsMergesByUpdatedAt(t *testing.T) {
	dir, _ := githubWorkItemsCLI(t, false)
	withPath(t, dir)
	result, err := ListGitHubWorkItems(context.Background(), t.TempDir(), 20, "", "")
	if err != nil || result.Errors != nil || len(result.Items) != 2 {
		t.Fatalf("unexpected work items: %+v err=%v", result, err)
	}
	if result.Items[0].Type != "issue" || result.Items[1].Type != "pr" || result.Sources.Issues == nil || result.Sources.Issues.Owner != "nebutra" {
		t.Fatalf("unexpected order or sources: %+v", result)
	}
}

func TestListGitHubWorkItemsKeepsPRsWhenIssuesFail(t *testing.T) {
	dir, _ := githubWorkItemsCLI(t, true)
	withPath(t, dir)
	result, err := ListGitHubWorkItems(context.Background(), t.TempDir(), 20, "", "")
	if err != nil || len(result.Items) != 1 || result.Items[0].Type != "pr" || result.Errors == nil || result.Errors.Issues == nil || result.Errors.Issues.Type != "permission_denied" {
		t.Fatalf("unexpected partial result: %+v err=%v", result, err)
	}
}

func TestGitHubWorkItemSearchAndExplicitLookup(t *testing.T) {
	dir, logPath := githubWorkItemsCLI(t, false)
	withPath(t, dir)
	_, err := ListGitHubWorkItems(context.Background(), t.TempDir(), 20, "is:issue label:bug", "2026-07-01T00:00:00Z")
	if err != nil {
		t.Fatal(err)
	}
	item := GetGitHubWorkItem(context.Background(), t.TempDir(), 8, "issue", "other", "repo")
	if item == nil || item.ID != "issue:8" || item.Type != "issue" {
		t.Fatalf("unexpected explicit item: %+v", item)
	}
	calls, _ := os.ReadFile(logPath)
	text := string(calls)
	if !strings.Contains(text, "--search is:issue label:bug updated:<2026-07-01T00:00:00Z") || !strings.Contains(text, "repos/other/repo/issues/8") {
		t.Fatalf("missing search or explicit lookup args:\n%s", text)
	}
}

func TestParseGitHubRemoteOwnerRepo(t *testing.T) {
	for _, test := range []struct {
		raw         string
		owner, repo string
	}{
		{"https://github.com/nebutra/pebble.git", "nebutra", "pebble"},
		{"git@github.com:nebutra/pebble.git", "nebutra", "pebble"},
		{"ssh://git@git.internal/acme/platform/pebble.git", "platform", "pebble"},
	} {
		owner, repo, ok := parseGitHubRemoteOwnerRepo(test.raw)
		if !ok || owner != test.owner || repo != test.repo {
			t.Fatalf("parse %q = %q/%q, %v", test.raw, owner, repo, ok)
		}
	}
}

func TestResolveGitHubWorkItemSourcesHonorsUpstreamPreference(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fake CLI stub uses a POSIX shell script")
	}
	dir := t.TempDir()
	script := `#!/bin/sh
case "$*" in
  "remote get-url origin") printf '%s' 'git@github.com:fork/pebble.git';;
  "remote get-url upstream") printf '%s' 'https://github.com/nebutra/pebble.git';;
  *) exit 1;;
esac
`
	if err := os.WriteFile(filepath.Join(dir, "git"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	withPath(t, dir)
	sources, err := ResolveGitHubWorkItemSources(context.Background(), t.TempDir(), "upstream")
	if err != nil {
		t.Fatal(err)
	}
	if sources.Issues == nil || sources.Issues.Owner != "nebutra" || sources.OriginCandidate == nil || sources.OriginCandidate.Owner != "fork" || sources.UpstreamCandidate == nil {
		t.Fatalf("unexpected sources: %+v", sources)
	}
}

func githubWorkItemsCLI(t *testing.T, failIssues bool) (string, string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("fake CLI stub uses a POSIX shell script")
	}
	dir := t.TempDir()
	logPath := filepath.Join(dir, "calls.log")
	fail := "0"
	if failIssues {
		fail = "1"
	}
	script := `#!/bin/sh
echo "$*" >> "` + logPath + `"
if [ "$1 $2" = "repo view" ]; then printf '%s' 'nebutra/pebble'; exit 0; fi
case "$*" in
  *"repos/other/repo/issues/8"*) printf '%s' '{"id":81,"number":8,"title":"Issue","state":"open","html_url":"https://gh/8","updated_at":"2026-07-15T00:00:00Z","labels":[{"name":"bug"}],"user":{"login":"octocat"}}';;
  *"/issues?"*) if [ "` + fail + `" = "1" ]; then echo 'HTTP 403 forbidden' >&2; exit 1; fi; printf '%s' '[{"id":81,"number":8,"title":"Issue","state":"open","html_url":"https://gh/8","updated_at":"2026-07-15T00:00:00Z","labels":[{"name":"bug"}],"user":{"login":"octocat"}},{"number":9,"title":"PR shadow","pull_request":{},"labels":[]}]';;
  *"/pulls?"*) printf '%s' '[{"number":7,"title":"PR","state":"open","html_url":"https://gh/pr/7","updated_at":"2026-07-14T00:00:00Z","labels":[],"user":{"login":"dev"},"head":{"ref":"feature","sha":"abc","repo":{"owner":{"login":"nebutra"}}},"base":{"ref":"main"}}]';;
  *"issue list"*) printf '%s' '[{"number":8,"title":"Issue","state":"OPEN","url":"https://gh/8","updatedAt":"2026-07-15T00:00:00Z","labels":[{"name":"bug"}],"author":{"login":"octocat"}}]';;
  *"pr list"*) printf '%s' '[{"number":7,"title":"PR","state":"OPEN","url":"https://gh/pr/7","updatedAt":"2026-07-14T00:00:00Z","labels":[],"author":{"login":"dev"},"headRefName":"feature","baseRefName":"main","headRefOid":"abc"}]';;
  *) printf '%s' '{}';;
esac
`
	if err := os.WriteFile(filepath.Join(dir, "gh"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return dir, logPath
}
