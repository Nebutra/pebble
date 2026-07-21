package providercli

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestGetGitHubIssueWorkItemDetails(t *testing.T) {
	dir := githubWorkItemDetailsCLI(t)
	withPath(t, dir)
	details, err := GetGitHubWorkItemDetails(context.Background(), t.TempDir(), 8, "issue", "upstream")
	if err != nil || details == nil {
		t.Fatalf("details failed: %+v err=%v", details, err)
	}
	if details.Item.Type != "issue" || details.Body != "Issue body" || len(details.Comments) != 1 || len(details.Assignees) != 1 || details.Assignees[0] != "assignee" {
		t.Fatalf("unexpected issue details: %+v", details)
	}
	if len(details.TimelineItems) != 2 || details.TimelineItems[0].Event != "assigned" || details.TimelineItems[1].Source == nil || details.TimelineItems[1].Source.Type != "pr" {
		t.Fatalf("unexpected timeline: %+v", details.TimelineItems)
	}
	if len(details.Participants) != 3 {
		t.Fatalf("unexpected participants: %+v", details.Participants)
	}
	if details.Participants[0].Name == nil || details.Participants[0].AvatarURL == "" {
		t.Fatalf("expected participant profiles to be hydrated: %+v", details.Participants)
	}
}

func TestGetGitHubPRWorkItemDetails(t *testing.T) {
	dir := githubWorkItemDetailsCLI(t)
	withPath(t, dir)
	details, err := GetGitHubWorkItemDetails(context.Background(), t.TempDir(), 7, "pr", "upstream")
	if err != nil || details == nil {
		t.Fatalf("details failed: %+v err=%v", details, err)
	}
	if details.Item.Type != "pr" || details.Body != "PR body" || details.HeadSHA != "head-sha" || details.BaseSHA != "base-sha" || details.PullRequestID != "PR_node" {
		t.Fatalf("unexpected PR details: %+v", details)
	}
	if len(details.Checks) != 1 || details.Checks[0].Name != "ci" || len(details.Files) != 2 || !details.Files[1].IsBinary {
		t.Fatalf("unexpected PR checks/files: %+v %+v", details.Checks, details.Files)
	}
}

func githubWorkItemDetailsCLI(t *testing.T) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("fake CLI stub uses POSIX shell scripts")
	}
	dir := t.TempDir()
	gitScript := `#!/bin/sh
case "$*" in
  "remote get-url origin") printf '%s' 'git@github.com:fork/pebble.git';;
  "remote get-url upstream") printf '%s' 'https://github.com/nebutra/pebble.git';;
  *) exit 1;;
esac
`
	ghScript := `#!/bin/sh
case "$*" in
  *"repos/nebutra/pebble/issues/8/comments"*) printf '%s' '[{"id":10,"body":"Comment","created_at":"2026-07-15T01:00:00Z","html_url":"https://gh/comment/10","user":{"login":"commenter","avatar_url":"https://x/commenter","type":"User"}}]';;
  *"repos/nebutra/pebble/issues/8/timeline"*) printf '%s' '[{"id":1,"event":"assigned","created_at":"2026-07-15T01:00:00Z","actor":{"login":"actor","avatar_url":"https://x/actor"},"assignee":{"login":"assignee"}},{"id":2,"event":"cross-referenced","created_at":"2026-07-15T02:00:00Z","actor":{"login":"actor"},"source":{"issue":{"number":7,"title":"PR","html_url":"https://gh/pr/7","pull_request":{},"repository":{"name":"pebble","owner":{"login":"nebutra"}}}}}]';;
  *"repos/nebutra/pebble/issues/8"*) printf '%s' '{"id":81,"number":8,"title":"Issue","state":"open","html_url":"https://gh/8","updated_at":"2026-07-15T00:00:00Z","body":"Issue body","labels":[{"name":"bug"}],"user":{"login":"author"},"assignees":[{"login":"assignee"}]}';;
  *"repos/nebutra/pebble/issues/7/comments"*) printf '%s' '[{"id":11,"body":"PR comment","created_at":"2026-07-15T01:00:00Z","html_url":"https://gh/comment/11","user":{"login":"reviewer","type":"User"}}]';;
  *"repos/nebutra/pebble/pulls/7/files"*) printf '%s' '[{"filename":"src/a.ts","status":"modified","additions":3,"deletions":1,"patch":"@@"},{"filename":"asset.png","status":"added","additions":0,"deletions":0}]';;
  *"repos/nebutra/pebble/pulls/7"*) printf '%s' '{"number":7,"title":"PR","state":"open","html_url":"https://gh/pr/7","updated_at":"2026-07-14T00:00:00Z","body":"PR body","node_id":"PR_node","labels":[],"user":{"login":"dev"},"head":{"ref":"feature","sha":"head-sha","repo":{"owner":{"login":"nebutra"}}},"base":{"ref":"main","sha":"base-sha"}}';;
  "pr checks 7 --json name,state,link") printf '%s' '[{"name":"ci","state":"SUCCESS","link":"https://gh/actions/runs/1"}]';;
  "api graphql"*) printf '%s' '{"data":{"u0":{"login":"assignee","name":"Assigned User","avatarUrl":"https://x/assignee"},"u1":{"login":"author","name":"Author User","avatarUrl":"https://x/author"},"u2":{"login":"commenter","name":"Comment User","avatarUrl":"https://x/commenter"},"u3":{"login":"dev","name":"Developer","avatarUrl":"https://x/dev"},"u4":{"login":"reviewer","name":"Reviewer","avatarUrl":"https://x/reviewer"}}}';;
  *) exit 1;;
esac
`
	for name, script := range map[string]string{"git": gitScript, "gh": ghScript} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(script), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}
