package runtimecore

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestWorkspaceSpaceScanCountsFilesWithoutFollowingSymlinks(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "src"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "src", "app.ts"), []byte("pebble"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(root, "src"), filepath.Join(root, "link")); err != nil {
		t.Fatal(err)
	}
	row := scanWorkspaceSpaceWorktree(context.Background(), Project{ID: "repo", Name: "Pebble", Path: root}, Worktree{ID: "wt", ProjectID: "repo", Path: root, DisplayName: "Main"}, true)
	if row.Status != "ok" || row.SizeBytes < 6 || row.ReclaimableBytes != 0 {
		t.Fatalf("unexpected row: %#v", row)
	}
	if len(row.TopLevelItems) != 2 {
		t.Fatalf("expected directory and symlink, got %#v", row.TopLevelItems)
	}
}

func TestWorkspaceSpaceMarksRemotePathsUnavailable(t *testing.T) {
	row := scanWorkspaceSpaceWorktree(context.Background(), Project{ID: "repo", Name: "Remote", Path: "/remote", LocationKind: "ssh"}, Worktree{ID: "repo", Path: "/remote"}, true)
	if row.Status != "unavailable" || !row.IsRemote || row.Error == nil {
		t.Fatalf("unexpected remote row: %#v", row)
	}
}
