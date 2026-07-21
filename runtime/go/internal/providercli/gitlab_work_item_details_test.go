package providercli

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestListGitLabTodosAndExplicitPathLookup(t *testing.T) {
	dir := gitLabDetailsCLI(t)
	withPath(t, dir)
	items := ListGitLabTodos(context.Background(), t.TempDir())
	if len(items) != 1 || items[0].TargetIID == nil || *items[0].TargetIID != 8 || items[0].ProjectPath != "group/sub/project" {
		t.Fatalf("unexpected todos: %+v", items)
	}
	item := GetGitLabWorkItemByPath(context.Background(), t.TempDir(), GitLabProjectRef{Host: "git.internal", Path: "group/sub/project"}, 8, "issue")
	if item == nil || item.ID != "gitlab-issue-81" || item.ProjectRef == nil || item.ProjectRef.Host != "git.internal" {
		t.Fatalf("unexpected explicit work item: %+v", item)
	}
}

func TestGetGitLabIssueDetailsIncludesConversationAndAssignees(t *testing.T) {
	dir := gitLabDetailsCLI(t)
	withPath(t, dir)
	details := GetGitLabWorkItemDetails(context.Background(), t.TempDir(), 8, "issue", &GitLabProjectRef{Host: "git.internal", Path: "group/sub/project"})
	if details == nil || details.Body != "Issue body" || len(details.Comments) != 1 || len(details.Assignees) != 1 || details.Assignees[0] != "owner" {
		t.Fatalf("unexpected issue details: %+v", details)
	}
	if details.Comments[0].ThreadID != "discussion-1" || details.Comments[0].Author != "tanuki" {
		t.Fatalf("unexpected issue comment: %+v", details.Comments)
	}
}

func TestGetGitLabMRDetailsIncludesPipelineReviewAndFiles(t *testing.T) {
	dir := gitLabDetailsCLI(t)
	withPath(t, dir)
	details := GetGitLabWorkItemDetails(context.Background(), t.TempDir(), 9, "mr", &GitLabProjectRef{Host: "git.internal", Path: "group/sub/project"})
	if details == nil || details.Body != "MR body" || details.HeadSHA != "head" || details.BaseSHA != "base" || details.StartSHA != "start" {
		t.Fatalf("unexpected MR details: %+v", details)
	}
	if len(details.Comments) != 1 || len(details.PipelineJobs) != 1 || details.PipelineJobs[0].PipelineID == nil || *details.PipelineJobs[0].PipelineID != 77 {
		t.Fatalf("missing conversation or pipeline: %+v", details)
	}
	if len(details.Reviewers) != 1 || details.Reviewers[0].Username != "reviewer" || details.ApprovalState == nil || len(details.ApprovalState.Rules) != 1 {
		t.Fatalf("missing review metadata: %+v", details)
	}
	if len(details.Files) != 1 || details.Files[0].Additions != 1 || details.Files[0].Deletions != 1 || details.Files[0].Status != "renamed" {
		t.Fatalf("unexpected files: %+v", details.Files)
	}
}

func gitLabDetailsCLI(t *testing.T) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("fake CLI stub uses a POSIX shell script")
	}
	dir := t.TempDir()
	script := `#!/bin/sh
if [ "$1 $2" = "repo view" ]; then
  printf '%s' '{"path_with_namespace":"group/sub/project","web_url":"https://git.internal/group/sub/project"}'
  exit 0
fi
case "$*" in
  *"todos?"*) printf '%s' '[{"id":1,"action_name":"assigned","target_type":"Issue","target":{"iid":8,"title":"Issue","web_url":"https://gl/8"},"project":{"path_with_namespace":"group/sub/project"},"author":{"username":"tanuki","avatar_url":"https://img/t.png"},"updated_at":"2026-07-15T00:00:00Z","state":"pending"}]';;
  *"issues/8/discussions"*) printf '%s' '[{"id":"discussion-1","notes":[{"id":101,"body":"Hello","created_at":"2026-07-15T00:00:00Z","system":false,"author":{"username":"tanuki","avatar_url":"https://img/t.png","state":"active"}}]}]';;
  *"issues/8"*) printf '%s' '{"id":81,"iid":8,"title":"Issue","state":"opened","web_url":"https://gl/8","updated_at":"2026-07-15T00:00:00Z","description":"Issue body","labels":["bug"],"author":{"username":"tanuki"},"assignees":[{"username":"owner"}]}';;
  *"merge_requests/9/discussions"*) printf '%s' '[{"id":"discussion-9","notes":[{"id":201,"body":"Review","created_at":"2026-07-15T00:00:00Z","system":false,"resolvable":true,"resolved":false,"author":{"username":"reviewer","state":"active"},"position":{"new_path":"src/new.ts","new_line":2}}]}]';;
  *"merge_requests/9/reviewers"*) printf '%s' '[{"user":{"id":5,"username":"reviewer","name":"Reviewer","avatar_url":"https://img/r.png","state":"active"}}]';;
  *"merge_requests/9/approval_state"*) printf '%s' '{"rules":[{"id":2,"name":"Maintainers","approvals_required":1,"approved":true}]}';;
  *"merge_requests/9/approvals"*) printf '%s' '{"approvals_required":1,"approvals_left":0,"approved_by":[{"user":{"id":5,"username":"reviewer"}}]}';;
  *"merge_requests/9/diffs"*) printf '%s' '[{"new_path":"src/new.ts","old_path":"src/old.ts","diff":"--- a/src/old.ts\n+++ b/src/new.ts\n-old\n+new","renamed_file":true}]';;
  *"pipelines/77/jobs"*) printf '%s' '[{"id":701,"name":"test","stage":"verify","status":"success","web_url":"https://gl/jobs/701","duration":12.5}]';;
  *"merge_requests/9"*) printf '%s' '{"id":91,"iid":9,"title":"MR","state":"opened","web_url":"https://gl/mr/9","updated_at":"2026-07-15T00:00:00Z","description":"MR body","sha":"head","diff_refs":{"base_sha":"base","head_sha":"head","start_sha":"start"},"head_pipeline":{"id":77},"source_branch":"feature","target_branch":"main","labels":[]}';;
  *) printf '%s' '{}';;
esac
`
	if err := os.WriteFile(filepath.Join(dir, "glab"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return dir
}
