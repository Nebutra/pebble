package providercli

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestUpdateGitHubIssueEncodesAllMutationGroups(t *testing.T) {
	dir, logPath := githubIssueMutationCLI(t, false)
	withPath(t, dir)
	title, body := "New title", "New body"
	result := UpdateGitHubIssue(context.Background(), t.TempDir(), 17, GitHubIssueUpdate{
		State: "closed", StateReason: "duplicate", DuplicateOf: 9, Title: &title, Body: &body,
		AddLabels: []string{"bug"}, RemoveLabels: []string{"old"}, AddAssignees: []string{"octocat"}, RemoveAssignees: []string{"hubot"},
	})
	if !result.OK || result.Error != "" {
		t.Fatalf("unexpected mutation result: %+v", result)
	}
	calls, _ := os.ReadFile(logPath)
	text := string(calls)
	for _, expected := range []string{
		"issue close 17 --repo fork/pebble --duplicate-of 9",
		"api -X PATCH repos/fork/pebble/issues/17 --raw-field body=New body",
		"issue edit 17 --repo fork/pebble --title New title --add-label bug --remove-label old --add-assignee octocat --remove-assignee hubot",
	} {
		if !strings.Contains(text, expected) {
			t.Fatalf("missing %q in calls:\n%s", expected, text)
		}
	}
}

func TestUpdateGitHubIssueAggregatesCommandErrors(t *testing.T) {
	dir, _ := githubIssueMutationCLI(t, true)
	withPath(t, dir)
	body := "Body"
	result := UpdateGitHubIssue(context.Background(), t.TempDir(), 3, GitHubIssueUpdate{State: "open", Body: &body})
	if result.OK || !strings.Contains(result.Error, "state failed") || !strings.Contains(result.Error, "body failed") {
		t.Fatalf("expected aggregated errors, got %+v", result)
	}
}

func githubIssueMutationCLI(t *testing.T, fail bool) (string, string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("fake CLI stub uses POSIX shell scripts")
	}
	dir := t.TempDir()
	logPath := filepath.Join(dir, "calls.log")
	gitScript := `#!/bin/sh
case "$*" in
  "remote get-url origin") printf '%s' 'git@github.com:fork/pebble.git';;
  "remote get-url upstream") printf '%s' 'https://github.com/nebutra/pebble.git';;
  *) exit 1;;
esac
`
	ghScript := `#!/bin/sh
echo "$*" >> "` + logPath + `"
exit 0
`
	if fail {
		ghScript = `#!/bin/sh
case "$*" in
  "issue reopen"*) printf '%s' 'state failed' >&2; exit 1;;
  "api -X PATCH"*) printf '%s' 'body failed' >&2; exit 1;;
esac
exit 0
`
	}
	for name, script := range map[string]string{"git": gitScript, "gh": ghScript} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(script), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	return dir, logPath
}
