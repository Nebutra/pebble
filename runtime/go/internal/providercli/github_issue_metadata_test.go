package providercli

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestGitHubIssueMetadataAndCreateUseSelectedSource(t *testing.T) {
	dir, logPath := githubIssueMetadataCLI(t)
	withPath(t, dir)
	ctx := context.Background()

	created := CreateGitHubIssue(ctx, t.TempDir(), " Ship it ", "Body", []string{"bug"}, []string{"octocat"}, "upstream")
	if !created.OK || created.Number != 42 || created.URL != "https://github.com/nebutra/pebble/issues/42" {
		t.Fatalf("unexpected create result: %+v", created)
	}
	if count := CountGitHubWorkItems(ctx, t.TempDir(), "is:issue label:bug", "upstream"); count != 17 {
		t.Fatalf("unexpected count: %d", count)
	}
	labels := ListGitHubLabels(ctx, t.TempDir(), "upstream")
	if len(labels) != 2 || labels[0] != "bug" || labels[1] != "backend" {
		t.Fatalf("unexpected labels: %#v", labels)
	}
	users := ListGitHubAssignableUsers(ctx, t.TempDir(), "upstream")
	if len(users) != 2 || users[0].Login != "octocat" || users[0].Name != nil || users[0].AvatarURL != "https://x/octocat" {
		t.Fatalf("unexpected users: %#v", users)
	}
	calls, _ := os.ReadFile(logPath)
	text := string(calls)
	for _, expected := range []string{
		"repos/nebutra/pebble/issues --raw-field title=Ship it --raw-field body=Body --raw-field labels[]=bug --raw-field assignees[]=octocat",
		"q=repo:nebutra/pebble is:issue label:bug",
		"repos/nebutra/pebble/labels",
		"repos/nebutra/pebble/assignees?per_page=100",
	} {
		if !strings.Contains(text, expected) {
			t.Fatalf("missing %q in calls:\n%s", expected, text)
		}
	}
}

func TestCountGitHubWorkItemsRejectsOversizedQuery(t *testing.T) {
	if count := CountGitHubWorkItems(context.Background(), t.TempDir(), strings.Repeat("x", githubWorkItemsQueryMaxBytes+1), ""); count != 0 {
		t.Fatalf("oversized query returned %d", count)
	}
}

func githubIssueMetadataCLI(t *testing.T) (string, string) {
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
case "$*" in
  *"-X POST repos/nebutra/pebble/issues"*) printf '%s' '{"number":42,"html_url":"https://github.com/nebutra/pebble/issues/42"}';;
  *"search/issues"*) printf '%s' '17';;
  *"/labels"*) printf 'bug\nbackend\n';;
  *"/assignees?"*) printf '%s\n' '{"login":"octocat","avatar_url":"https://x/octocat"}' '{"login":"hubot","avatar_url":""}';;
  *) exit 1;;
esac
`
	for name, script := range map[string]string{"git": gitScript, "gh": ghScript} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(script), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	return dir, logPath
}
