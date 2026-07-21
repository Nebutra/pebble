package providercli

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestGitLabLocalMetadataPreservesNativeDetailSemantics(t *testing.T) {
	dir, logPath := gitLabLocalMetadataCLI(t)
	withPath(t, dir)
	ctx := context.Background()
	workdir := t.TempDir()

	project := GetGitLabProjectRef(ctx, workdir)
	if project == nil || project.Host != "git.internal" || project.Path != "group/sub/pebble" {
		t.Fatalf("unexpected project ref: %+v", project)
	}
	mr := GetGitLabMergeRequestForBranch(ctx, workdir, "refs/heads/feature/fix", 0)
	if mr == nil || mr.Number != 7 || mr.PipelineStatus != "pending" || mr.Mergeable != "MERGEABLE" || mr.BaseRefName != "main" {
		t.Fatalf("unexpected branch MR: %+v", mr)
	}
	linked := GetGitLabMergeRequestForBranch(ctx, workdir, "renamed-local", 9)
	if linked == nil || linked.Number != 9 || linked.State != "merged" || linked.PipelineStatus != "success" {
		t.Fatalf("unexpected linked MR fallback: %+v", linked)
	}
	issue := GetGitLabIssue(ctx, workdir, 8)
	if issue == nil || issue.Number != 8 || issue.Description == nil || *issue.Description != "Issue body" {
		t.Fatalf("unexpected issue: %+v", issue)
	}
	users := ListGitLabAssignableUsers(ctx, workdir)
	if len(users) != 2 || users[0].Username != "one" || users[1].Username != "two" {
		t.Fatalf("unexpected inherited members: %+v", users)
	}
	calls, _ := os.ReadFile(logPath)
	if !strings.Contains(string(calls), "--hostname git.internal") || !strings.Contains(string(calls), "--paginate projects/group%2Fsub%2Fpebble/members/all") {
		t.Fatalf("self-hosted/pagination args missing: %s", calls)
	}
}

func gitLabLocalMetadataCLI(t *testing.T) (string, string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("fake CLI stub uses a POSIX shell script")
	}
	dir := t.TempDir()
	logPath := filepath.Join(dir, "calls.log")
	script := `#!/bin/sh
echo "$*" >> "` + logPath + `"
if [ "$1 $2" = "repo view" ]; then
  printf '%s' '{"path_with_namespace":"group/sub/pebble","web_url":"https://git.internal/group/sub/pebble"}'
  exit 0
fi
case "$*" in
  *"source_branch=feature%2Ffix"*) printf '%s' '[{"iid":7,"title":"Fix","state":"opened","web_url":"https://git.internal/mr/7","updated_at":"2026-07-15T00:00:00Z","sha":"head7","target_branch":"main","detailed_merge_status":"mergeable","head_pipeline":{"status":"running"},"author":{"username":"tanuki","avatar_url":"https://img/t.png"}}]' ;;
  *"source_branch=renamed-local"*) printf '%s' '[]' ;;
  *"merge_requests/9"*) printf '%s' '{"iid":9,"title":"Merged","state":"merged","web_url":"https://git.internal/mr/9","updated_at":"2026-07-14T00:00:00Z","detailed_merge_status":"checking","pipeline":{"status":"success"}}' ;;
  *"issues/8"*) printf '%s' '{"id":81,"iid":8,"title":"Issue","state":"opened","web_url":"https://git.internal/issues/8","description":"Issue body","labels":[]}' ;;
  *"members/all"*) printf '%s' '[{"id":1,"username":"one","name":"One","avatar_url":"a"}][{"id":2,"username":"two","name":"Two","avatar_url":"b"}]' ;;
  *) exit 1 ;;
esac
`
	if err := os.WriteFile(filepath.Join(dir, "glab"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return dir, logPath
}
