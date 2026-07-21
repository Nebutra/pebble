package providercli

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestGitLabIssueMutationAndLabelCommands(t *testing.T) {
	dir, logPath := gitLabIssueMutationCLI(t)
	withPath(t, dir)
	ctx := context.Background()
	workdir := t.TempDir()

	created := CreateGitLabIssue(ctx, workdir, " Ship it ", "Issue body")
	if !created.OK || created.Number != 42 || created.URL != "https://git.internal/g/p/-/issues/42" {
		t.Fatalf("unexpected create result: %+v", created)
	}
	title := "Renamed"
	body := "Updated body"
	updated := UpdateGitLabIssue(ctx, workdir, 42, GitLabIssueUpdate{
		State: "closed", Title: &title, Body: &body,
		AddLabels: []string{"bug"}, RemoveLabels: []string{"stale"},
		AddAssignees: []string{"tanuki"}, RemoveAssignees: []string{"former"},
	}, &GitLabProjectRef{Host: "git.internal", Path: "group/sub/project"})
	if !updated.OK {
		t.Fatalf("unexpected update result: %+v", updated)
	}
	commented := AddGitLabIssueComment(ctx, workdir, 42, "Looks good", &GitLabProjectRef{Host: "git.internal", Path: "group/sub/project"})
	if !commented.OK || commented.Comment == nil || commented.Comment.ID != 99 || commented.Comment.Author != "tanuki" {
		t.Fatalf("unexpected comment result: %+v", commented)
	}
	labels := ListGitLabLabels(ctx, workdir)
	if len(labels) != 2 || labels[0] != "bug" || labels[1] != "backend" {
		t.Fatalf("unexpected labels: %+v", labels)
	}

	calls, _ := os.ReadFile(logPath)
	text := string(calls)
	for _, expected := range []string{
		"--hostname git.internal -X POST projects/group%2Fsub%2Fproject/issues -f title=Ship it -f description=Issue body",
		"issue close 42 -R group/sub/project --hostname git.internal",
		"--hostname git.internal -X PUT projects/group%2Fsub%2Fproject/issues/42 -f description=Updated body",
		"issue update 42 -R group/sub/project --hostname git.internal --title Renamed --label bug --unlabel stale --assignee tanuki --unassignee former",
		"projects/group%2Fsub%2Fproject/issues/42/notes -f body=Looks good",
		"--paginate projects/group%2Fsub%2Fproject/labels --jq .[].name",
	} {
		if !strings.Contains(text, expected) {
			t.Fatalf("missing %q in glab calls:\n%s", expected, text)
		}
	}
}

func TestCreateGitLabIssueRejectsBlankTitleBeforeCLI(t *testing.T) {
	result := CreateGitLabIssue(context.Background(), t.TempDir(), "  ", "body")
	if result.OK || result.Error != "Title is required" {
		t.Fatalf("unexpected blank-title result: %+v", result)
	}
}

func gitLabIssueMutationCLI(t *testing.T) (string, string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("fake CLI stub uses a POSIX shell script")
	}
	dir := t.TempDir()
	logPath := filepath.Join(dir, "calls.log")
	script := `#!/bin/sh
echo "$*" >> "` + logPath + `"
if [ "$1 $2" = "repo view" ]; then
  printf '%s' '{"path_with_namespace":"group/sub/project","web_url":"https://git.internal/group/sub/project"}'
  exit 0
fi
case "$*" in
  *"/labels"*) printf 'bug\nbackend\n';;
  *"/notes"*) printf '%s' '{"id":99,"body":"Looks good","created_at":"2026-07-15T00:00:00Z","author":{"username":"tanuki","avatar_url":"https://img/t.png","state":"active"}}';;
  *"-X POST"*"/issues -f title="*) printf '%s' '{"iid":42,"web_url":"https://git.internal/g/p/-/issues/42"}';;
  *) printf '%s' '{}';;
esac
`
	if err := os.WriteFile(filepath.Join(dir, "glab"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return dir, logPath
}
