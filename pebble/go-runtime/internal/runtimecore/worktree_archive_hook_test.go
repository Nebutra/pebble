package runtimecore

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestParsePebbleYamlArchiveScript(t *testing.T) {
	cases := []struct {
		name    string
		content string
		want    string
	}{
		{
			name:    "inline scalar",
			content: "scripts:\n  setup: npm install\n  archive: ./teardown.sh\n",
			want:    "./teardown.sh",
		},
		{
			name:    "double quoted",
			content: "scripts:\n  archive: \"echo \\\"bye\\\"\"\n",
			want:    `echo "bye"`,
		},
		{
			name:    "single quoted",
			content: "scripts:\n  archive: 'echo it''s done'\n",
			want:    "echo it's done",
		},
		{
			name:    "plain scalar trailing comment",
			content: "scripts:\n  archive: make clean # tidy up\n",
			want:    "make clean",
		},
		{
			name:    "literal block scalar",
			content: "scripts:\n  archive: |\n    echo one\n    echo two\nissueCommand: gh issue view\n",
			want:    "echo one\necho two",
		},
		{
			name:    "strip block scalar",
			content: "scripts:\n  archive: |-\n    echo only\n",
			want:    "echo only",
		},
		{
			name:    "no archive key",
			content: "scripts:\n  setup: npm install\n",
			want:    "",
		},
		{
			name:    "no scripts block",
			content: "issueCommand: gh issue view\n",
			want:    "",
		},
		{
			name:    "archive outside scripts block",
			content: "scripts:\n  setup: npm install\nother:\n  archive: echo nope\n",
			want:    "",
		},
		{
			name:    "comments and blank lines inside scripts",
			content: "scripts:\n\n  # teardown\n  archive: echo hi\n",
			want:    "echo hi",
		},
		{
			name:    "crlf content",
			content: "scripts:\r\n  archive: echo crlf\r\n",
			want:    "echo crlf",
		},
		{
			name:    "empty file",
			content: "",
			want:    "",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := parsePebbleYamlArchiveScript(tc.content); got != tc.want {
				t.Fatalf("parsePebbleYamlArchiveScript() = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestLoadWorktreeArchiveHookScriptMissingFile(t *testing.T) {
	if got := LoadWorktreeArchiveHookScript(t.TempDir()); got != "" {
		t.Fatalf("expected empty script for repo without pebble.yaml, got %q", got)
	}
}

// archiveMarkerHookScript writes $PEBBLE_WORKTREE_PATH into the repo root only
// when the worktree's checked-out README is still present, proving the hook
// ran with the correct env and cwd before `git worktree remove`.
func archiveMarkerHookScript() string {
	if runtime.GOOS == "windows" {
		return "if exist README.md echo %PEBBLE_WORKTREE_PATH%> \"%PEBBLE_ROOT_PATH%\\archive-ran.txt\""
	}
	return `test -f README.md && printf '%s' "$PEBBLE_WORKTREE_PATH" > "$PEBBLE_ROOT_PATH/archive-ran.txt"`
}

func writePebbleYamlArchiveHook(t *testing.T, repo string, script string) {
	t.Helper()
	content := "scripts:\n  archive: " + script + "\n"
	if err := os.WriteFile(filepath.Join(repo, "pebble.yaml"), []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

func createHookTestWorktree(t *testing.T, manager *Manager, project Project) (Worktree, string) {
	t.Helper()
	worktreePath := filepath.Join(t.TempDir(), "hook-worktree")
	worktree, err := manager.CreateWorktree(context.Background(), CreateWorktreeRequest{
		ProjectID:  project.ID,
		Path:       worktreePath,
		Branch:     "feature/archive-hook",
		Base:       "HEAD",
		ExecuteGit: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	return worktree, worktreePath
}

func TestDeleteWorktreeRunsArchiveHookBeforeRemoval(t *testing.T) {
	manager, project, repo := newGitBackedProject(t)
	writePebbleYamlArchiveHook(t, repo, "'"+strings.ReplaceAll(archiveMarkerHookScript(), "'", "''")+"'")
	worktree, worktreePath := createHookTestWorktree(t, manager, project)

	if _, err := manager.DeleteWorktree(context.Background(), worktree.ID, DeleteWorktreeRequest{ExecuteGit: true}); err != nil {
		t.Fatalf("DeleteWorktree failed: %v", err)
	}
	marker, err := os.ReadFile(filepath.Join(repo, "archive-ran.txt"))
	if err != nil {
		t.Fatalf("archive hook marker was not written: %v", err)
	}
	if got := strings.TrimSpace(string(marker)); got != worktreePath {
		t.Fatalf("PEBBLE_WORKTREE_PATH = %q, want %q", got, worktreePath)
	}
	if _, err := os.Stat(worktreePath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("expected worktree directory to be removed, got %v", err)
	}
}

func TestDeleteWorktreeArchiveHookFailureAbortsRemoval(t *testing.T) {
	manager, project, repo := newGitBackedProject(t)
	writePebbleYamlArchiveHook(t, repo, "exit 3")
	worktree, worktreePath := createHookTestWorktree(t, manager, project)

	_, err := manager.DeleteWorktree(context.Background(), worktree.ID, DeleteWorktreeRequest{ExecuteGit: true})
	if !errors.Is(err, ErrArchiveHookFailed) {
		t.Fatalf("expected ErrArchiveHookFailed, got %v", err)
	}
	// The veto must leave both the directory and the runtime record intact.
	if _, err := os.Stat(worktreePath); err != nil {
		t.Fatalf("expected worktree directory to survive the veto: %v", err)
	}
	if got := manager.ListWorktrees(project.ID); len(got) != 1 {
		t.Fatalf("expected worktree record to survive the veto, got %#v", got)
	}
}

func TestDeleteWorktreeArchiveHookFailureCapturesOutput(t *testing.T) {
	manager, project, repo := newGitBackedProject(t)
	writePebbleYamlArchiveHook(t, repo, "'echo hook-veto-reason && exit 1'")
	worktree, _ := createHookTestWorktree(t, manager, project)

	_, err := manager.DeleteWorktree(context.Background(), worktree.ID, DeleteWorktreeRequest{ExecuteGit: true})
	var hookErr *ArchiveHookError
	if !errors.As(err, &hookErr) {
		t.Fatalf("expected *ArchiveHookError, got %v", err)
	}
	if !strings.Contains(hookErr.Output, "hook-veto-reason") {
		t.Fatalf("expected captured hook output, got %q", hookErr.Output)
	}
}

func TestDeleteWorktreeSkipArchiveHook(t *testing.T) {
	manager, project, repo := newGitBackedProject(t)
	writePebbleYamlArchiveHook(t, repo, "exit 3")
	worktree, worktreePath := createHookTestWorktree(t, manager, project)

	if _, err := manager.DeleteWorktree(context.Background(), worktree.ID, DeleteWorktreeRequest{
		ExecuteGit:      true,
		SkipArchiveHook: true,
	}); err != nil {
		t.Fatalf("expected skipArchiveHook to bypass the failing hook: %v", err)
	}
	if _, err := os.Stat(worktreePath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("expected worktree directory to be removed, got %v", err)
	}
}

func TestDeleteWorktreeWithoutHookConfiguredProceeds(t *testing.T) {
	manager, project, repo := newGitBackedProject(t)
	// pebble.yaml exists but has no archive script: removal must not be blocked.
	writePebbleYamlArchiveHook(t, repo, "")
	worktree, worktreePath := createHookTestWorktree(t, manager, project)

	if _, err := manager.DeleteWorktree(context.Background(), worktree.ID, DeleteWorktreeRequest{ExecuteGit: true}); err != nil {
		t.Fatalf("DeleteWorktree failed: %v", err)
	}
	if _, err := os.Stat(worktreePath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("expected worktree directory to be removed, got %v", err)
	}
}

func TestRunWorktreeArchiveHookMissingWorktreeDirIsNoop(t *testing.T) {
	repo := t.TempDir()
	writePebbleYamlArchiveHook(t, repo, "exit 3")
	missing := filepath.Join(t.TempDir(), "already-gone")
	if err := RunWorktreeArchiveHookOnHost(context.Background(), repo, missing); err != nil {
		t.Fatalf("expected missing worktree dir to skip the hook, got %v", err)
	}
}

func TestArchiveHookTimeoutKillsHook(t *testing.T) {
	script := "sleep 30"
	if runtime.GOOS == "windows" {
		script = "ping -n 31 127.0.0.1 >nul"
	}
	repo := t.TempDir()
	start := time.Now()
	err := runWorktreeArchiveHookScript(context.Background(), repo, repo, script, 200*time.Millisecond)
	elapsed := time.Since(start)
	var hookErr *ArchiveHookError
	if !errors.As(err, &hookErr) {
		t.Fatalf("expected *ArchiveHookError, got %v", err)
	}
	if !hookErr.TimedOut {
		t.Fatalf("expected TimedOut, got %#v", hookErr)
	}
	if elapsed > 10*time.Second {
		t.Fatalf("hook was not killed promptly, took %s", elapsed)
	}
}
