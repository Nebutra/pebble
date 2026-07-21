package providercli

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestGitHubProjectSlugMutationsUseExplicitRepository(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fake CLI stub uses POSIX shell scripts")
	}
	dir, logPath := t.TempDir(), filepath.Join(t.TempDir(), "calls.log")
	script := `#!/bin/sh
echo "$*" >> "` + logPath + `"
case "$*" in
  *"issues/7/comments"*) printf '%s' '{"id":11,"body":"Hello","created_at":"2026-07-15T00:00:00Z","html_url":"u","user":{"login":"alice","avatar_url":"a","type":"User"}}';;
  *) exit 0;;
esac
`
	if err := os.WriteFile(filepath.Join(dir, "gh"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	withPath(t, dir)
	ctx := context.Background()
	title := "New"
	updated := UpdateGitHubIssueBySlug(ctx, "acme", "widgets", 7, GitHubIssueUpdate{Title: &title})
	added := AddGitHubIssueCommentBySlug(ctx, "acme", "widgets", 7, "Hello")
	edited := UpdateGitHubIssueCommentBySlug(ctx, "acme", "widgets", 11, "Edited")
	deleted := DeleteGitHubIssueCommentBySlug(ctx, "acme", "widgets", 11)
	if !updated.OK || !added.OK || !edited.OK || !deleted.OK {
		t.Fatalf("unexpected mutation results: %+v %+v %+v %+v", updated, added, edited, deleted)
	}
	calls, _ := os.ReadFile(logPath)
	text := string(calls)
	for _, expected := range []string{
		"issue edit 7 --repo acme/widgets --title New",
		"repos/acme/widgets/issues/7/comments --raw-field body=Hello",
		"repos/acme/widgets/issues/comments/11 --raw-field body=Edited",
		"-X DELETE repos/acme/widgets/issues/comments/11",
	} {
		if !strings.Contains(text, expected) {
			t.Fatalf("missing %q in calls:\n%s", expected, text)
		}
	}
}

func TestUpdateGitHubIssueBySlugRejectsMissingDuplicateTarget(t *testing.T) {
	result := UpdateGitHubIssueBySlug(context.Background(), "acme", "widgets", 7, GitHubIssueUpdate{State: "closed", StateReason: "duplicate"})
	if result.OK || !strings.Contains(result.Error, "Duplicate target") {
		t.Fatalf("unexpected duplicate validation: %+v", result)
	}
}
