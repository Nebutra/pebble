package runtimecore

import (
	"context"
	"errors"
	"os/exec"
	"strings"
)

// This file holds the host-side git mechanics of worktree removal. They are
// exported (not just Manager internals) because pebble-relay-worker runs the
// same code on an SSH-remote host and posts the outcome back to the runtime,
// so local and relay-backed deletions cannot drift in semantics.

// RemoveGitWorktreeOnHost detaches a worktree directory on the executing host,
// then cleans up its local branch. It mirrors the Electron main-process
// semantics: `git branch -d` (safe delete) refuses to drop a branch with
// commits not merged into its upstream or HEAD, so unpublished work is
// preserved and returned instead of discarded. forceBranchDelete opts into
// `-D` for failed-creation rollback.
//
// Why the git-local subset only: Electron additionally recovers squash-merged
// branches by diffing against provider base refs (remote/PR merge status). That
// machinery is not available in the Go runtime, so a branch whose changes only
// landed via squash merge is preserved here rather than auto-deleted; the caller
// can still force-delete it explicitly.
func RemoveGitWorktreeOnHost(
	ctx context.Context,
	repoPath string,
	worktreePath string,
	branch string,
	force bool,
	forceBranchDelete bool,
) (*PreservedWorktreeBranch, error) {
	repoPath = strings.TrimSpace(repoPath)
	worktreePath = strings.TrimSpace(worktreePath)
	if repoPath == "" || worktreePath == "" {
		return nil, errors.New("repository and worktree paths are required")
	}
	if repoPath == worktreePath {
		return nil, errors.New("refusing to remove the project root as a worktree")
	}
	branchName := normalizeLocalBranchRef(branch)
	// Capture the branch head before removal so a later force-delete can compare
	// against the exact commit that Git preserved.
	branchHead := gitBranchHead(ctx, repoPath, branchName)

	args := []string{"-C", repoPath, "worktree", "remove"}
	if force {
		args = append(args, "--force")
	}
	args = append(args, worktreePath)
	gitCtx, cancel := context.WithTimeout(ctx, gitWorktreeCommandLimit)
	defer cancel()
	if output, err := exec.CommandContext(gitCtx, "git", args...).CombinedOutput(); err != nil {
		message := strings.TrimSpace(string(output))
		if message == "" {
			message = err.Error()
		} else {
			message += ": " + err.Error()
		}
		return nil, errors.New(message)
	}

	if branchName == "" {
		return nil, nil
	}
	return deleteLocalBranchAfterWorktreeRemoval(ctx, repoPath, branchName, branchHead, forceBranchDelete), nil
}

// ForceDeleteGitBranchOnHost force-deletes a branch that a prior worktree
// removal preserved, on the executing host. It errors with ErrBranchNotFound
// when the branch is absent, and refuses when the branch is checked out or
// moved past expectedHead so a stale force-delete cannot discard newer commits
// (mirrors Electron's update-ref compare-and-swap).
func ForceDeleteGitBranchOnHost(
	ctx context.Context,
	repoPath string,
	branchName string,
	expectedHead string,
) (ForceDeletePreservedBranchResponse, error) {
	repoPath = strings.TrimSpace(repoPath)
	branchName = normalizeLocalBranchRef(branchName)
	if repoPath == "" {
		return ForceDeletePreservedBranchResponse{}, errors.New("repository path is required")
	}
	if branchName == "" || strings.ContainsRune(branchName, '\x00') {
		return ForceDeletePreservedBranchResponse{}, errors.New("invalid branch name")
	}
	if gitBranchHead(ctx, repoPath, branchName) == "" {
		return ForceDeletePreservedBranchResponse{}, ErrBranchNotFound
	}
	if gitBranchIsCheckedOut(ctx, repoPath, branchName) {
		return ForceDeletePreservedBranchResponse{}, errors.New("local branch is checked out in another worktree")
	}
	expectedHead = strings.TrimSpace(expectedHead)
	if expectedHead != "" {
		// Compare-and-swap: delete only if the ref still points at expectedHead so
		// a stale action cannot discard commits added after preservation.
		cmdCtx, cancel := context.WithTimeout(ctx, gitCommandTimeout)
		_, err := exec.CommandContext(cmdCtx, "git", "-C", repoPath, "update-ref", "-d", "refs/heads/"+branchName, expectedHead).CombinedOutput()
		cancel()
		if err != nil {
			return ForceDeletePreservedBranchResponse{}, errors.New("local branch changed after it was preserved; review it before deleting")
		}
		return ForceDeletePreservedBranchResponse{Deleted: true}, nil
	}
	cmdCtx, cancel := context.WithTimeout(ctx, gitCommandTimeout)
	defer cancel()
	if output, err := exec.CommandContext(cmdCtx, "git", "-C", repoPath, "branch", "-D", "--", branchName).CombinedOutput(); err != nil {
		message := strings.TrimSpace(string(output))
		if message == "" {
			message = err.Error()
		}
		return ForceDeletePreservedBranchResponse{}, errors.New(message)
	}
	return ForceDeletePreservedBranchResponse{Deleted: true}, nil
}

// deleteLocalBranchAfterWorktreeRemoval drops the worktree's local branch with
// the safe `-d` flag (or `-D` when forceBranchDelete). If Git refuses because the
// branch still holds unmerged commits, the branch is preserved and returned so
// the renderer can offer an explicit force-delete follow-up.
func deleteLocalBranchAfterWorktreeRemoval(
	ctx context.Context,
	repoPath string,
	branchName string,
	branchHead string,
	forceBranchDelete bool,
) *PreservedWorktreeBranch {
	deleteFlag := "-d"
	if forceBranchDelete {
		deleteFlag = "-D"
	}
	if runGitBranchDelete(ctx, repoPath, deleteFlag, branchName) == nil {
		return nil
	}
	// Why: `branch -d` is the cheap live-checkout guard. Only pay for
	// `worktree prune` when a stale admin record may still be blocking it.
	pruneCtx, cancelPrune := context.WithTimeout(ctx, gitCommandTimeout)
	_, _ = exec.CommandContext(pruneCtx, "git", "-C", repoPath, "worktree", "prune").CombinedOutput()
	cancelPrune()
	if runGitBranchDelete(ctx, repoPath, deleteFlag, branchName) == nil {
		return nil
	}
	// The branch still refuses safe deletion (unmerged/unpublished commits) or is
	// checked out elsewhere: keep it. Deleting a worktree must never silently
	// discard commits.
	preserved := &PreservedWorktreeBranch{BranchName: branchName}
	if branchHead != "" {
		preserved.Head = branchHead
	}
	return preserved
}

func runGitBranchDelete(ctx context.Context, repoPath, deleteFlag, branchName string) error {
	cmdCtx, cancel := context.WithTimeout(ctx, gitCommandTimeout)
	defer cancel()
	_, err := exec.CommandContext(cmdCtx, "git", "-C", repoPath, "branch", deleteFlag, "--", branchName).CombinedOutput()
	return err
}

// gitBranchHead resolves a local branch to its commit sha, or "" when the branch
// is missing or git errors.
func gitBranchHead(ctx context.Context, repoPath, branchName string) string {
	if branchName == "" {
		return ""
	}
	cmdCtx, cancel := context.WithTimeout(ctx, gitCommandTimeout)
	defer cancel()
	output, err := exec.CommandContext(cmdCtx, "git", "-C", repoPath, "rev-parse", "--verify", "--quiet", "refs/heads/"+branchName).Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(output))
}

func gitBranchIsCheckedOut(ctx context.Context, repoPath, branchName string) bool {
	cmdCtx, cancel := context.WithTimeout(ctx, gitCommandTimeout)
	defer cancel()
	output, err := exec.CommandContext(cmdCtx, "git", "-C", repoPath, "worktree", "list", "--porcelain").Output()
	if err != nil {
		return false
	}
	target := "branch refs/heads/" + branchName
	for _, line := range strings.Split(string(output), "\n") {
		if strings.TrimSpace(line) == target {
			return true
		}
	}
	return false
}

func normalizeLocalBranchRef(branch string) string {
	return strings.TrimPrefix(strings.TrimSpace(branch), "refs/heads/")
}
