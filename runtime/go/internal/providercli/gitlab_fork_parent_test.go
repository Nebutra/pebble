package providercli

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestGitLabMRForBranchUsesSelfHostedForkParent(t *testing.T) {
	dir, logPath := gitLabForkParentCLI(t)
	withPath(t, dir)

	review := GetGitLabMergeRequestForBranch(
		context.Background(),
		t.TempDir(),
		"refs/heads/feature/fork-parent",
		0,
	)
	if review == nil || review.Number != 17 || review.Title != "Contributor fix" {
		t.Fatalf("unexpected fork-parent MR: %+v", review)
	}
	commands, readErr := os.ReadFile(logPath)
	if readErr != nil {
		t.Fatal(readErr)
	}
	log := string(commands)
	if !strings.Contains(log, "--hostname git.internal projects/contributor%2Fpebble") ||
		!strings.Contains(log, "projects/group%2Fpebble/merge_requests?source_branch=feature%2Ffork-parent") {
		t.Fatalf("expected self-hosted parent discovery and MR lookup, got:\n%s", log)
	}
}

func TestGitLabLinkedMRFallsBackToForkParent(t *testing.T) {
	dir, _ := gitLabForkParentCLI(t)
	withPath(t, dir)

	review := GetGitLabMergeRequestForBranch(context.Background(), t.TempDir(), "", 23)
	if review == nil || review.Number != 23 || review.State != "merged" {
		t.Fatalf("unexpected linked fork-parent MR: %+v", review)
	}
}

func TestGitLabLinkedMRRejectsUnrelatedParentIID(t *testing.T) {
	dir, _ := gitLabForkParentCLI(t)
	withPath(t, dir)

	review := GetGitLabMergeRequestForBranch(context.Background(), t.TempDir(), "", 24)
	if review == nil || review.Number != 24 || review.Title != "Fork-local review" {
		t.Fatalf("expected fork-local MR after parent source mismatch, got %+v", review)
	}
}

func gitLabForkParentCLI(t *testing.T) (string, string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("fake CLI stub uses POSIX shell scripts")
	}
	dir := t.TempDir()
	logPath := filepath.Join(dir, "commands.log")
	script := `#!/bin/sh
printf '%s\n' "$*" >> "` + logPath + `"
case "$*" in
  "repo view --output json") printf '%s' '{"path_with_namespace":"contributor/pebble","web_url":"https://git.internal/contributor/pebble"}' ;;
  "api --hostname git.internal projects/contributor%2Fpebble") printf '%s' '{"id":11,"forked_from_project":{"id":5,"path_with_namespace":"group/pebble"}}' ;;
  *"projects/group%2Fpebble/merge_requests?source_branch=feature%2Ffork-parent"*) printf '%s' '[{"iid":16,"title":"Other fork","state":"opened","source_project_id":99},{"iid":17,"title":"Contributor fix","state":"opened","source_project_id":11,"web_url":"https://git.internal/group/pebble/-/merge_requests/17","target_branch":"main"}]' ;;
  *"projects/group%2Fpebble/merge_requests/23") printf '%s' '{"iid":23,"title":"Merged contribution","state":"merged","source_project_id":11,"web_url":"https://git.internal/group/pebble/-/merge_requests/23"}' ;;
  *"projects/group%2Fpebble/merge_requests/24") printf '%s' '{"iid":24,"title":"Unrelated parent MR","state":"opened","source_project_id":99}' ;;
  *"projects/contributor%2Fpebble/merge_requests/24") printf '%s' '{"iid":24,"title":"Fork-local review","state":"opened","source_project_id":11,"web_url":"https://git.internal/contributor/pebble/-/merge_requests/24"}' ;;
  *) exit 1 ;;
esac
`
	if err := os.WriteFile(filepath.Join(dir, "glab"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return dir, logPath
}
