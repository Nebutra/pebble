package runtimecore

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestParseGitConflictKindTable(t *testing.T) {
	cases := []struct {
		xy   string
		kind string
	}{
		{"UU", "both_modified"},
		{"AA", "both_added"},
		{"DD", "both_deleted"},
		{"AU", "added_by_us"},
		{"UA", "added_by_them"},
		{"DU", "deleted_by_us"},
		{"UD", "deleted_by_them"},
		{"MM", ""},
		{"A ", ""},
		{" M", ""},
		{"??", ""},
		{"", ""},
	}
	for _, testCase := range cases {
		if got := ParseGitConflictKind(testCase.xy); got != testCase.kind {
			t.Fatalf("ParseGitConflictKind(%q) = %q, want %q", testCase.xy, got, testCase.kind)
		}
	}
}

func TestParseGitChangeLineConflictRows(t *testing.T) {
	worktree := t.TempDir()
	if err := os.WriteFile(filepath.Join(worktree, "present.txt"), []byte("x\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		line   string
		kind   string
		status string
	}{
		{"UU present.txt", "both_modified", "modified"},
		{"AA present.txt", "both_added", "modified"},
		{"DD gone.txt", "both_deleted", "deleted"},
		// fs-dependent kinds: existing file reads modified, missing reads deleted
		{"DU present.txt", "deleted_by_us", "modified"},
		{"DU gone.txt", "deleted_by_us", "deleted"},
		{"UD gone.txt", "deleted_by_them", "deleted"},
		{"AU present.txt", "added_by_us", "modified"},
		{"UA gone.txt", "added_by_them", "deleted"},
	}
	for _, testCase := range cases {
		changes := parseGitChangeLine(testCase.line, worktree)
		if len(changes) != 1 {
			t.Fatalf("expected one conflict change for %q, got %#v", testCase.line, changes)
		}
		change := changes[0]
		if change.ConflictKind != testCase.kind || change.ConflictStatus != "unresolved" {
			t.Fatalf("line %q: unexpected conflict metadata %#v", testCase.line, change)
		}
		if change.Status != testCase.status || change.Area != "unstaged" {
			t.Fatalf("line %q: unexpected compatibility status %#v", testCase.line, change)
		}
	}
	// Non-conflict double-column rows keep the staged+unstaged split.
	if changes := parseGitChangeLine("MM both.ts", worktree); len(changes) != 2 {
		t.Fatalf("expected staged+unstaged rows for MM, got %#v", changes)
	}
}

func TestDetectGitConflictOperationFromGitDirState(t *testing.T) {
	worktree := t.TempDir()
	gitDir := filepath.Join(worktree, ".git")
	if err := os.MkdirAll(gitDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if got := DetectGitConflictOperation(worktree); got != "unknown" {
		t.Fatalf("clean gitdir should read unknown, got %q", got)
	}
	if err := os.WriteFile(filepath.Join(gitDir, "CHERRY_PICK_HEAD"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := DetectGitConflictOperation(worktree); got != "cherry-pick" {
		t.Fatalf("expected cherry-pick, got %q", got)
	}
	if err := os.MkdirAll(filepath.Join(gitDir, "rebase-merge"), 0o755); err != nil {
		t.Fatal(err)
	}
	if got := DetectGitConflictOperation(worktree); got != "rebase" {
		t.Fatalf("rebase dir should win over cherry-pick head, got %q", got)
	}
	if err := os.WriteFile(filepath.Join(gitDir, "MERGE_HEAD"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := DetectGitConflictOperation(worktree); got != "merge" {
		t.Fatalf("MERGE_HEAD should win, got %q", got)
	}

	// Linked-worktree layout: `.git` is a file pointing at the real gitdir.
	linked := t.TempDir()
	realGitDir := filepath.Join(t.TempDir(), "worktrees", "linked")
	if err := os.MkdirAll(realGitDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(linked, ".git"), []byte("gitdir: "+realGitDir+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(realGitDir, "MERGE_HEAD"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := DetectGitConflictOperation(linked); got != "merge" {
		t.Fatalf("expected merge through gitdir file, got %q", got)
	}
}

func TestSourceProjectionReportsMergeConflicts(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git executable is not available")
	}
	repo := t.TempDir()
	runGitCommand(t, repo, "init", "-b", "main")
	runGitCommand(t, repo, "config", "user.email", "dev@example.test")
	runGitCommand(t, repo, "config", "user.name", "Dev")
	writeParityFile(t, repo, "shared.txt", "base\n")
	runGitCommand(t, repo, "add", "shared.txt")
	runGitCommand(t, repo, "commit", "-m", "base")
	runGitCommand(t, repo, "checkout", "-b", "feature")
	writeParityFile(t, repo, "shared.txt", "feature\n")
	runGitCommand(t, repo, "commit", "-am", "feature edit")
	runGitCommand(t, repo, "checkout", "main")
	writeParityFile(t, repo, "shared.txt", "main\n")
	runGitCommand(t, repo, "commit", "-am", "main edit")
	// Merge must conflict; git exits non-zero, so run it without the helper.
	command := exec.Command("git", "-C", repo, "merge", "feature")
	command.Env = append(os.Environ(), "GIT_CONFIG_NOSYSTEM=1")
	_ = command.Run()

	projection := sourceProjectionFromGitStatus("github", "repo", "repo", repo, "", "none")
	if projection.ConflictOperation != "merge" {
		t.Fatalf("expected merge conflict operation, got %q", projection.ConflictOperation)
	}
	var conflict *SourceControlChange
	for index := range projection.Changes {
		if projection.Changes[index].Path == "shared.txt" {
			conflict = &projection.Changes[index]
		}
	}
	if conflict == nil || conflict.ConflictKind != "both_modified" || conflict.ConflictStatus != "unresolved" {
		t.Fatalf("expected both_modified conflict row, got %#v", projection.Changes)
	}
}

func TestGitFileDiffBinaryMetadata(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git executable is not available")
	}
	repo := t.TempDir()
	runGitCommand(t, repo, "init")
	runGitCommand(t, repo, "config", "user.email", "dev@example.test")
	runGitCommand(t, repo, "config", "user.name", "Dev")
	oldBytes := []byte{0x89, 'P', 'N', 'G', 0x00, 0x01}
	if err := os.WriteFile(filepath.Join(repo, "icon.png"), oldBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	runGitCommand(t, repo, "add", "icon.png")
	runGitCommand(t, repo, "commit", "-m", "add icon")
	newBytes := []byte{0x89, 'P', 'N', 'G', 0x00, 0x02, 0x03}
	if err := os.WriteFile(filepath.Join(repo, "icon.png"), newBytes, 0o600); err != nil {
		t.Fatal(err)
	}

	manager, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	project, err := manager.CreateProject(CreateProjectRequest{Name: "repo", Path: repo})
	if err != nil {
		t.Fatal(err)
	}
	diff, err := manager.GitFileDiff(context.Background(), GitFileDiffRequest{ProjectID: project.ID, FilePath: "icon.png"})
	if err != nil {
		t.Fatal(err)
	}
	if diff.Kind != "binary" || !diff.OriginalIsBinary || !diff.ModifiedIsBinary {
		t.Fatalf("expected binary diff, got %#v", diff)
	}
	if diff.OriginalByteSize != len(oldBytes) || diff.ModifiedByteSize != len(newBytes) {
		t.Fatalf("expected byte sizes %d/%d, got %d/%d", len(oldBytes), len(newBytes), diff.OriginalByteSize, diff.ModifiedByteSize)
	}
	if !diff.IsImage || diff.MimeType != "image/png" {
		t.Fatalf("expected previewable png metadata, got %#v", diff)
	}
}

func TestGitFileDiffTrustsNumstatBinaryMarkers(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git executable is not available")
	}
	repo := t.TempDir()
	runGitCommand(t, repo, "init")
	runGitCommand(t, repo, "config", "user.email", "dev@example.test")
	runGitCommand(t, repo, "config", "user.name", "Dev")
	// Text-looking payload larger than the NUL scan window, forced binary by
	// gitattributes — exactly the case numstat dash markers cover.
	writeParityFile(t, repo, ".gitattributes", "*.dat binary\n")
	oldContent := bytes.Repeat([]byte("a"), binaryScanWindowBytes+1000)
	if err := os.WriteFile(filepath.Join(repo, "blob.dat"), oldContent, 0o600); err != nil {
		t.Fatal(err)
	}
	runGitCommand(t, repo, "add", ".")
	runGitCommand(t, repo, "commit", "-m", "add blob")
	newContent := bytes.Repeat([]byte("b"), binaryScanWindowBytes+2000)
	if err := os.WriteFile(filepath.Join(repo, "blob.dat"), newContent, 0o600); err != nil {
		t.Fatal(err)
	}

	manager, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	project, err := manager.CreateProject(CreateProjectRequest{Name: "repo", Path: repo})
	if err != nil {
		t.Fatal(err)
	}
	diff, err := manager.GitFileDiff(context.Background(), GitFileDiffRequest{ProjectID: project.ID, FilePath: "blob.dat"})
	if err != nil {
		t.Fatal(err)
	}
	if diff.Kind != "binary" {
		t.Fatalf("expected numstat-corroborated binary diff, got kind %q", diff.Kind)
	}
	if diff.OriginalByteSize != len(oldContent) || diff.ModifiedByteSize != len(newContent) {
		t.Fatalf("expected byte sizes %d/%d, got %d/%d", len(oldContent), len(newContent), diff.OriginalByteSize, diff.ModifiedByteSize)
	}
}

func TestGitFileDiffSubmodulePointer(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git executable is not available")
	}
	child := t.TempDir()
	runGitCommand(t, child, "init", "-b", "main")
	runGitCommand(t, child, "config", "user.email", "dev@example.test")
	runGitCommand(t, child, "config", "user.name", "Dev")
	writeParityFile(t, child, "lib.txt", "v1\n")
	runGitCommand(t, child, "add", "lib.txt")
	runGitCommand(t, child, "commit", "-m", "v1")

	parent := t.TempDir()
	runGitCommand(t, parent, "init", "-b", "main")
	runGitCommand(t, parent, "config", "user.email", "dev@example.test")
	runGitCommand(t, parent, "config", "user.name", "Dev")
	runGitCommand(t, parent, "-c", "protocol.file.allow=always", "submodule", "add", filepath.ToSlash(child), "vendor/child")
	runGitCommand(t, parent, "commit", "-m", "add submodule")

	submoduleWorktree := filepath.Join(parent, "vendor", "child")
	oldSHA := strings.TrimSpace(readParityGitOutput(t, submoduleWorktree, "rev-parse", "HEAD"))
	runGitCommand(t, submoduleWorktree, "config", "user.email", "dev@example.test")
	runGitCommand(t, submoduleWorktree, "config", "user.name", "Dev")
	writeParityFile(t, submoduleWorktree, "lib.txt", "v2\n")
	runGitCommand(t, submoduleWorktree, "commit", "-am", "v2")
	newSHA := strings.TrimSpace(readParityGitOutput(t, submoduleWorktree, "rev-parse", "HEAD"))

	manager, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	project, err := manager.CreateProject(CreateProjectRequest{Name: "parent", Path: parent})
	if err != nil {
		t.Fatal(err)
	}
	diff, err := manager.GitFileDiff(context.Background(), GitFileDiffRequest{ProjectID: project.ID, FilePath: "vendor/child"})
	if err != nil {
		t.Fatal(err)
	}
	if diff.Kind != "text" || diff.Submodule == nil {
		t.Fatalf("expected synthesized submodule diff, got %#v", diff)
	}
	if diff.OriginalContent != "Subproject commit "+oldSHA+"\n" || diff.ModifiedContent != "Subproject commit "+newSHA+"\n" {
		t.Fatalf("unexpected subproject lines: %q -> %q", diff.OriginalContent, diff.ModifiedContent)
	}
	if diff.Submodule.OldSHA != oldSHA || diff.Submodule.NewSHA != newSHA || diff.Submodule.Dirty {
		t.Fatalf("unexpected submodule metadata: %#v", diff.Submodule)
	}

	// Uncommitted edits inside the submodule flip the dirty flag.
	writeParityFile(t, submoduleWorktree, "lib.txt", "v3-uncommitted\n")
	dirtyDiff, err := manager.GitFileDiff(context.Background(), GitFileDiffRequest{ProjectID: project.ID, FilePath: "vendor/child"})
	if err != nil {
		t.Fatal(err)
	}
	if dirtyDiff.Submodule == nil || !dirtyDiff.Submodule.Dirty {
		t.Fatalf("expected dirty submodule metadata, got %#v", dirtyDiff.Submodule)
	}

	// Staged route reads HEAD vs index gitlinks: stage the pointer move.
	runGitCommand(t, parent, "add", "vendor/child")
	stagedDiff, err := manager.GitFileDiff(context.Background(), GitFileDiffRequest{ProjectID: project.ID, FilePath: "vendor/child", Staged: true})
	if err != nil {
		t.Fatal(err)
	}
	if stagedDiff.Submodule == nil || stagedDiff.Submodule.OldSHA != oldSHA || stagedDiff.Submodule.NewSHA != newSHA {
		t.Fatalf("unexpected staged submodule metadata: %#v", stagedDiff.Submodule)
	}
}

func TestGitBaseStatusServesRelayReportedProjection(t *testing.T) {
	stateDir := t.TempDir()
	manager, err := NewManager(stateDir, nil)
	if err != nil {
		t.Fatal(err)
	}
	project, err := manager.CreateProject(CreateProjectRequest{
		Name:         "remote",
		Path:         "/remote/repo",
		LocationKind: "ssh",
		HostID:       "host-1",
	})
	if err != nil {
		t.Fatal(err)
	}

	// Before any relay report the endpoint answers an honest unknown.
	before, err := manager.GitBaseStatus(context.Background(), GitBaseStatusRequest{
		ProjectID:      project.ID,
		BaseRef:        "origin/main",
		CreatedBaseSHA: "abc123",
	})
	if err != nil {
		t.Fatal(err)
	}
	if before.Status != "unknown" || before.Base != "origin/main" {
		t.Fatalf("expected unknown pre-report base status, got %#v", before)
	}

	if _, err := manager.UpdateSourceControlProjection(UpdateSourceControlProjectionRequest{
		RepositoryID: project.ID,
		WorkspaceID:  project.ID,
		Branch:       "feature",
		SyncStatus:   "clean",
		BaseStatus: &SourceControlBaseStatus{
			Status:         "drift",
			Base:           "origin/main",
			Remote:         "origin",
			Behind:         3,
			RecentSubjects: []string{" newest ", "", "older"},
			Conflict:       &GitRemoteBranchConflict{Remote: "origin", BranchName: "feature"},
		},
	}); err != nil {
		t.Fatal(err)
	}

	after, err := manager.GitBaseStatus(context.Background(), GitBaseStatusRequest{
		ProjectID:      project.ID,
		BaseRef:        "origin/main",
		CreatedBaseSHA: "abc123",
	})
	if err != nil {
		t.Fatal(err)
	}
	if after.Status != "drift" || after.Behind != 3 || after.Remote != "origin" {
		t.Fatalf("expected relay-reported drift, got %#v", after)
	}
	if len(after.RecentSubjects) != 2 || after.RecentSubjects[0] != "newest" {
		t.Fatalf("expected trimmed recent subjects, got %#v", after.RecentSubjects)
	}
	if after.Conflict == nil || after.Conflict.BranchName != "feature" {
		t.Fatalf("expected remote branch conflict, got %#v", after.Conflict)
	}

	// Roundtrip: the report must survive a manager restart from disk.
	reloaded, err := NewManager(stateDir, nil)
	if err != nil {
		t.Fatal(err)
	}
	persisted, err := reloaded.GitBaseStatus(context.Background(), GitBaseStatusRequest{
		ProjectID:      project.ID,
		BaseRef:        "origin/main",
		CreatedBaseSHA: "abc123",
	})
	if err != nil {
		t.Fatal(err)
	}
	if persisted.Status != "drift" || persisted.Behind != 3 {
		t.Fatalf("expected persisted base status after reload, got %#v", persisted)
	}

	// Out-of-vocabulary relay statuses degrade to unknown instead of being trusted.
	if _, err := manager.UpdateSourceControlProjection(UpdateSourceControlProjectionRequest{
		RepositoryID: project.ID,
		WorkspaceID:  project.ID,
		Branch:       "feature",
		SyncStatus:   "clean",
		BaseStatus:   &SourceControlBaseStatus{Status: "exploded"},
	}); err != nil {
		t.Fatal(err)
	}
	degraded, err := manager.GitBaseStatus(context.Background(), GitBaseStatusRequest{
		ProjectID:      project.ID,
		BaseRef:        "origin/main",
		CreatedBaseSHA: "abc123",
	})
	if err != nil {
		t.Fatal(err)
	}
	if degraded.Status != "unknown" {
		t.Fatalf("expected normalized unknown status, got %#v", degraded)
	}
}

func writeParityFile(t *testing.T, dir string, name string, content string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, filepath.FromSlash(name)), []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

func readParityGitOutput(t *testing.T, path string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", path}, args...)...)
	cmd.Env = append(os.Environ(), "GIT_CONFIG_NOSYSTEM=1")
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v failed: %v\n%s", args, err, output)
	}
	return string(output)
}
