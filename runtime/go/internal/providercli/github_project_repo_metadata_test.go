package providercli

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestGitHubProjectRepositoryMetadataUsesExplicitSlug(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fake CLI stub uses POSIX shell scripts")
	}
	dir := t.TempDir()
	script := `#!/bin/sh
case "$*" in
  *"repos/nebutra/pebble/labels"*) printf 'bug\nbackend\n';;
  *"repos/nebutra/pebble/assignees"*) printf '%s\n' '{"login":"octocat","avatar_url":"https://x/o"}';;
  *"api graphql"*) printf '%s' '{"data":{"repository":{"issueTypes":{"nodes":[{"id":"IT1","name":"Bug","color":"RED","description":"Defect"}]}}}}';;
  *) exit 1;;
esac
`
	if err := os.WriteFile(filepath.Join(dir, "gh"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	withPath(t, dir)
	ctx := context.Background()
	labels := ListGitHubLabelsBySlug(ctx, "nebutra", "pebble")
	users := ListGitHubAssignableUsersBySlug(ctx, "nebutra", "pebble")
	types := ListGitHubIssueTypesBySlug(ctx, "nebutra", "pebble")
	if !labels.OK || len(labels.Labels) != 2 || !users.OK || len(users.Users) != 1 || !types.OK || len(types.Types) != 1 || types.Types[0].Name != "Bug" {
		t.Fatalf("unexpected metadata: labels=%+v users=%+v types=%+v", labels, users, types)
	}
}

func TestGitHubProjectRepositoryMetadataRejectsInvalidSlug(t *testing.T) {
	result := ListGitHubLabelsBySlug(context.Background(), "bad/owner", "repo")
	if result.OK || result.Error == nil || result.Error.Type != "validation_error" {
		t.Fatalf("unexpected validation result: %+v", result)
	}
}
