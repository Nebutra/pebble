package main

import (
	"context"
	"errors"
	"flag"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/tsekaluk/pebble/go-runtime/internal/runtimecore"
)

// worktreeRemoveTimeout bounds the remote archive hook (2 min, its own
// internal limit) plus `git worktree remove` and branch cleanup; matches the
// runtime's gitWorktreeCommandLimit ceiling with headroom for the hook and the
// follow-up branch delete/prune calls.
const worktreeRemoveTimeout = 5 * time.Minute

// runWorktreeRemove executes the shared host-side worktree removal on the
// remote host, then posts the completion to the runtime gateway so the
// worktree metadata record is retired with the same preserved-branch contract
// as local deletions.
func runWorktreeRemove(args []string, client *http.Client, output io.Writer) error {
	fs := flag.NewFlagSet("worktree-remove", flag.ExitOnError)
	endpoint := fs.String("endpoint", "http://127.0.0.1:17777", "runtime endpoint")
	token := fs.String("token", os.Getenv("PEBBLE_RUNTIME_TOKEN"), "runtime bearer token")
	projectID := fs.String("project", "", "runtime project id")
	worktreeID := fs.String("worktree", "", "runtime worktree id")
	repo := fs.String("repo", "", "remote repository root")
	path := fs.String("path", "", "remote worktree path")
	branch := fs.String("branch", "", "worktree branch to clean up")
	force := fs.Bool("force", false, "pass --force to git worktree remove")
	forceBranchDelete := fs.Bool("force-branch-delete", false, "delete the branch with -D instead of the safe -d")
	skipArchiveHook := fs.Bool("skip-archive-hook", false, "skip the pebble.yaml archive hook before removal")
	_ = fs.Parse(args)
	repoPath, worktreePath, err := normalizeRemovalPaths(*repo, *path)
	if err != nil {
		return err
	}
	if strings.TrimSpace(*projectID) == "" || strings.TrimSpace(*worktreeID) == "" {
		return errors.New("project and worktree are required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), worktreeRemoveTimeout)
	defer cancel()
	// Electron parity: the archive teardown hook runs on the host that owns the
	// worktree while the directory is intact, and a failure vetoes the removal
	// (the worker exits non-zero without posting a completion).
	if !*skipArchiveHook {
		if err := runtimecore.RunWorktreeArchiveHookOnHost(ctx, repoPath, worktreePath); err != nil {
			return err
		}
	}
	preserved, err := runtimecore.RemoveGitWorktreeOnHost(ctx, repoPath, worktreePath, *branch, *force, *forceBranchDelete)
	if err != nil {
		return err
	}
	payload := runtimecore.CompleteRemoteWorktreeRemovalRequest{
		ProjectID:       *projectID,
		WorktreeID:      *worktreeID,
		PreservedBranch: preserved,
	}
	return postJSON(client, output, *endpoint, *token, "/v1/worktrees/remote-removals", payload)
}

// runBranchDelete force-deletes a preserved branch on the remote host with the
// shared compare-and-swap guards, then reports the outcome to the runtime.
func runBranchDelete(args []string, client *http.Client, output io.Writer) error {
	fs := flag.NewFlagSet("branch-delete", flag.ExitOnError)
	endpoint := fs.String("endpoint", "http://127.0.0.1:17777", "runtime endpoint")
	token := fs.String("token", os.Getenv("PEBBLE_RUNTIME_TOKEN"), "runtime bearer token")
	projectID := fs.String("project", "", "runtime project id")
	repo := fs.String("repo", "", "remote repository root")
	branch := fs.String("branch", "", "branch to force-delete")
	expectedHead := fs.String("expected-head", "", "refuse when the branch moved past this commit")
	_ = fs.Parse(args)
	repoPath := strings.TrimSpace(*repo)
	if repoPath == "" {
		return errors.New("repo is required")
	}
	if strings.TrimSpace(*projectID) == "" {
		return errors.New("project is required")
	}
	repoAbs, err := filepath.Abs(repoPath)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), worktreeRemoveTimeout)
	defer cancel()
	result, err := runtimecore.ForceDeleteGitBranchOnHost(ctx, repoAbs, *branch, *expectedHead)
	if err != nil {
		return err
	}
	if !result.Deleted {
		return errors.New("branch was not deleted")
	}
	payload := runtimecore.CompleteRemotePreservedBranchRemovalRequest{
		ProjectID:  *projectID,
		BranchName: *branch,
	}
	return postJSON(client, output, *endpoint, *token, "/v1/worktrees/branches/remote-removals", payload)
}

func normalizeRemovalPaths(repo string, worktreePath string) (string, string, error) {
	repo = strings.TrimSpace(repo)
	worktreePath = strings.TrimSpace(worktreePath)
	if repo == "" || worktreePath == "" {
		return "", "", errors.New("repo and path are required")
	}
	repoAbs, err := filepath.Abs(repo)
	if err != nil {
		return "", "", err
	}
	worktreeAbs, err := filepath.Abs(worktreePath)
	if err != nil {
		return "", "", err
	}
	return repoAbs, worktreeAbs, nil
}
