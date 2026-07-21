package providercli

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestListGitLabIssuesMapsProjectScopedAPIResult(t *testing.T) {
	dir, logPath := gitLabIssueCLI(t, false)
	withPath(t, dir)
	result := ListGitLabIssues(context.Background(), t.TempDir(), "all", "@me", 25)
	if result.Error != nil || len(result.Items) != 1 {
		t.Fatalf("unexpected issue result: %+v", result)
	}
	item := result.Items[0]
	if item.Number != 8 || item.State != "opened" || item.Author == nil || *item.Author != "tanuki" || item.AuthorAvatarURL == nil {
		t.Fatalf("unexpected mapped issue: %+v", item)
	}
	if len(item.Labels) != 2 || item.Labels[1] != "backend" {
		t.Fatalf("unexpected labels: %+v", item.Labels)
	}
	calls, _ := os.ReadFile(logPath)
	callText := string(calls)
	if !strings.Contains(callText, "projects/group%2Fsub%2Fpebble/issues?") || !strings.Contains(callText, "scope=assigned_to_me") || strings.Contains(callText, "state=") {
		t.Fatalf("unexpected glab issue args: %s", callText)
	}
}

func TestListGitLabWorkItemsMergesAndSortsMRsAndIssues(t *testing.T) {
	dir, logPath := gitLabIssueCLI(t, false)
	withPath(t, dir)
	result := ListGitLabWorkItems(context.Background(), t.TempDir(), "all", 2, 20, "review me")
	if result.Error != nil || len(result.Items) != 2 {
		t.Fatalf("unexpected work-item result: %+v", result)
	}
	if result.Items[0].Type != "issue" || result.Items[1].Type != "mr" {
		t.Fatalf("expected issue newer than MR: %+v", result.Items)
	}
	for _, item := range result.Items {
		if item.ProjectRef == nil || item.ProjectRef.Host != "git.internal" || item.ProjectRef.Path != "group/sub/pebble" {
			t.Fatalf("missing exact project ref: %+v", item)
		}
	}
	calls, _ := os.ReadFile(logPath)
	callText := string(calls)
	if !strings.Contains(callText, "page=2") || !strings.Contains(callText, "search=review+me") || strings.Contains(callText, "state=all") {
		t.Fatalf("unexpected combined issue args: %s", callText)
	}
}

func TestListGitLabWorkItemsKeepsIssuesWhenMRReadFails(t *testing.T) {
	dir, _ := gitLabIssueCLI(t, true)
	withPath(t, dir)
	result := ListGitLabWorkItems(context.Background(), t.TempDir(), "opened", 1, 20, "")
	if len(result.Items) != 1 || result.Items[0].Type != "issue" || result.Error == nil {
		t.Fatalf("expected partial issue result plus MR error: %+v", result)
	}
}

func gitLabIssueCLI(t *testing.T, failMR bool) (string, string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("fake CLI stub uses a POSIX shell script")
	}
	dir := t.TempDir()
	logPath := filepath.Join(dir, "calls.log")
	mrExit := "0"
	if failMR {
		mrExit = "1"
	}
	script := `#!/bin/sh
echo "$*" >> "` + logPath + `"
if [ "$1 $2" = "repo view" ]; then
  printf '%s' '{"path_with_namespace":"group/sub/pebble","web_url":"https://git.internal/group/sub/pebble"}'
  exit 0
fi
if [ "$1 $2" = "mr list" ]; then
  if [ "` + mrExit + `" = "1" ]; then
    echo 'HTTP 403 forbidden' >&2
    exit 1
  fi
  printf '%s' '[{"id":41,"iid":4,"title":"MR","state":"opened","web_url":"https://git.internal/mr/4","updated_at":"2024-01-01T00:00:00Z","labels":[]}]'
  exit 0
fi
printf '%s' '[{"id":81,"iid":8,"title":"Issue","state":"opened","web_url":"https://git.internal/issues/8","updated_at":"2024-02-01T00:00:00Z","description":"body","author":{"username":"tanuki","avatar_url":"https://img/t.png"},"labels":["bug",{"name":"backend"}]}]'
`
	if err := os.WriteFile(filepath.Join(dir, "glab"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return dir, logPath
}
