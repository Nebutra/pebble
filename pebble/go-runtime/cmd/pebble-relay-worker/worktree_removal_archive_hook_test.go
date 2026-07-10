package main

import (
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/tsekaluk/pebble/go-runtime/internal/runtimecore"
)

func writeArchiveHookYaml(t *testing.T, repo string, script string) {
	t.Helper()
	content := "scripts:\n  archive: " + script + "\n"
	if err := os.WriteFile(filepath.Join(repo, "pebble.yaml"), []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestRunWorktreeRemoveRunsArchiveHookBeforeRemoval(t *testing.T) {
	repo := initTestRepo(t)
	markerScript := `test -f README.md && printf '%s' "$PEBBLE_WORKTREE_PATH" > "$PEBBLE_ROOT_PATH/archive-ran.txt"`
	if runtime.GOOS == "windows" {
		markerScript = "if exist README.md echo %PEBBLE_WORKTREE_PATH%> \"%PEBBLE_ROOT_PATH%\\archive-ran.txt\""
	}
	writeArchiveHookYaml(t, repo, "'"+strings.ReplaceAll(markerScript, "'", "''")+"'")
	worktreePath := filepath.Join(t.TempDir(), "hooked-worktree")
	runRepoGit(t, repo, "worktree", "add", "-b", "feature/hooked", worktreePath, "HEAD")

	var posted atomic.Bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		posted.Store(true)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer server.Close()

	err := run([]string{
		"worktree-remove",
		"--endpoint", server.URL,
		"--project", "proj_remote",
		"--worktree", "wt_remote",
		"--repo", repo,
		"--path", worktreePath,
		"--branch", "feature/hooked",
	}, server.Client(), io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	marker, err := os.ReadFile(filepath.Join(repo, "archive-ran.txt"))
	if err != nil {
		t.Fatalf("archive hook marker was not written: %v", err)
	}
	if got := strings.TrimSpace(string(marker)); got != worktreePath {
		t.Fatalf("PEBBLE_WORKTREE_PATH = %q, want %q", got, worktreePath)
	}
	if _, err := os.Stat(worktreePath); !os.IsNotExist(err) {
		t.Fatalf("expected worktree directory to be removed, got %v", err)
	}
	if !posted.Load() {
		t.Fatal("expected completion to be posted after removal")
	}
}

func TestRunWorktreeRemoveArchiveHookFailureAborts(t *testing.T) {
	repo := initTestRepo(t)
	writeArchiveHookYaml(t, repo, "'echo remote-veto && exit 7'")
	worktreePath := filepath.Join(t.TempDir(), "vetoed-worktree")
	runRepoGit(t, repo, "worktree", "add", "-b", "feature/vetoed", worktreePath, "HEAD")

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("no completion must be posted when the archive hook vetoes removal")
	}))
	defer server.Close()

	err := run([]string{
		"worktree-remove",
		"--endpoint", server.URL,
		"--project", "proj_remote",
		"--worktree", "wt_remote",
		"--repo", repo,
		"--path", worktreePath,
		"--branch", "feature/vetoed",
	}, server.Client(), io.Discard)
	if !errors.Is(err, runtimecore.ErrArchiveHookFailed) {
		t.Fatalf("expected ErrArchiveHookFailed, got %v", err)
	}
	if !strings.Contains(err.Error(), "remote-veto") {
		t.Fatalf("expected captured hook output in error, got %q", err.Error())
	}
	if _, err := os.Stat(worktreePath); err != nil {
		t.Fatalf("expected worktree directory to survive the veto: %v", err)
	}
}

func TestRunWorktreeRemoveSkipArchiveHookFlag(t *testing.T) {
	repo := initTestRepo(t)
	writeArchiveHookYaml(t, repo, "exit 7")
	worktreePath := filepath.Join(t.TempDir(), "skipped-hook-worktree")
	runRepoGit(t, repo, "worktree", "add", "-b", "feature/skipped", worktreePath, "HEAD")

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer server.Close()

	err := run([]string{
		"worktree-remove",
		"--endpoint", server.URL,
		"--project", "proj_remote",
		"--worktree", "wt_remote",
		"--repo", repo,
		"--path", worktreePath,
		"--branch", "feature/skipped",
		"--skip-archive-hook",
	}, server.Client(), io.Discard)
	if err != nil {
		t.Fatalf("expected --skip-archive-hook to bypass the failing hook: %v", err)
	}
	if _, err := os.Stat(worktreePath); !os.IsNotExist(err) {
		t.Fatalf("expected worktree directory to be removed, got %v", err)
	}
}
