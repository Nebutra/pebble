package runtimecore

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// ParseGitConflictKind maps porcelain unmerged XY codes to the renderer's
// conflict kinds. Returns "" for non-conflict codes.
func ParseGitConflictKind(xy string) string {
	switch xy {
	case "UU":
		return "both_modified"
	case "AA":
		return "both_added"
	case "DD":
		return "both_deleted"
	case "AU":
		return "added_by_us"
	case "UA":
		return "added_by_them"
	case "DU":
		return "deleted_by_us"
	case "UD":
		return "deleted_by_them"
	default:
		return ""
	}
}

// ConflictCompatibilityStatus mirrors the Electron reference: the `status`
// field on conflict rows is a rendering fallback, not a semantic claim. The
// fs-dependent kinds check the working tree because Git's behavior varies by
// merge strategy; an unreadable path falls back to "modified" so the row is
// never suppressed.
func ConflictCompatibilityStatus(worktreePath string, filePath string, conflictKind string) string {
	switch conflictKind {
	case "both_modified", "both_added":
		return "modified"
	case "both_deleted":
		return "deleted"
	}
	if strings.TrimSpace(worktreePath) == "" {
		return "modified"
	}
	if _, err := os.Lstat(filepath.Join(worktreePath, filepath.FromSlash(filePath))); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return "deleted"
		}
		return "modified"
	}
	return "modified"
}

// DetectGitConflictOperation labels the in-progress operation (merge vs rebase
// vs cherry-pick) from gitdir state files. Rebase detection uses the
// rebase-merge/rebase-apply directories rather than REBASE_HEAD because those
// persist for the whole rebase and never outlive it.
func DetectGitConflictOperation(worktreePath string) string {
	gitDir := resolveGitDirPath(worktreePath)
	if gitDir == "" {
		return "unknown"
	}
	if gitPathExists(filepath.Join(gitDir, "MERGE_HEAD")) {
		return "merge"
	}
	if gitPathExists(filepath.Join(gitDir, "rebase-merge")) || gitPathExists(filepath.Join(gitDir, "rebase-apply")) {
		return "rebase"
	}
	if gitPathExists(filepath.Join(gitDir, "CHERRY_PICK_HEAD")) {
		return "cherry-pick"
	}
	return "unknown"
}

// resolveGitDirPath resolves `.git` for both plain checkouts (directory) and
// linked worktrees (a file containing "gitdir: <path>").
func resolveGitDirPath(worktreePath string) string {
	if strings.TrimSpace(worktreePath) == "" {
		return ""
	}
	dotGit := filepath.Join(worktreePath, ".git")
	content, err := os.ReadFile(dotGit)
	if err != nil {
		return dotGit
	}
	for _, line := range strings.Split(string(content), "\n") {
		if !strings.HasPrefix(line, "gitdir:") {
			continue
		}
		target := strings.TrimSpace(strings.TrimPrefix(line, "gitdir:"))
		if target == "" {
			continue
		}
		if !filepath.IsAbs(target) {
			target = filepath.Join(worktreePath, target)
		}
		return target
	}
	return dotGit
}

func gitPathExists(path string) bool {
	_, err := os.Lstat(path)
	return err == nil
}

func normalizeGitConflictOperation(operation string) string {
	switch strings.TrimSpace(operation) {
	case "merge", "rebase", "cherry-pick":
		return strings.TrimSpace(operation)
	case "unknown":
		return "unknown"
	default:
		return ""
	}
}
