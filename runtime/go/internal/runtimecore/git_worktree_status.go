package runtimecore

import (
	"context"
	"strings"
)

// GitWorktreeStatusRequest asks for the working-tree status of one worktree.
// Unlike GitStatus, which reports raw lines for a project root, this answers the
// structured shape the source-control UI renders.
type GitWorktreeStatusRequest struct {
	ProjectID      string `json:"projectId"`
	WorktreeID     string `json:"worktreeId,omitempty"`
	Area           string `json:"area,omitempty"`
	IncludeIgnored bool   `json:"includeIgnored,omitempty"`
}

func (m *Manager) GitWorktreeStatus(ctx context.Context, req GitWorktreeStatusRequest) (GitStatusResult, error) {
	base, err := m.resolveWorkspacePath(req.ProjectID, req.WorktreeID)
	if err != nil {
		return GitStatusResult{}, err
	}
	args := []string{"status", "--short"}
	if req.IncludeIgnored {
		// Why: the caller wants ignored paths alongside the changes, and asking
		// git once is cheaper than a second subprocess over the same tree.
		args = append(args, "--ignored=matching")
	}
	output, err := readGitOutputRaw(ctx, base, args...)
	if err != nil {
		return GitStatusResult{}, err
	}
	changed, ignored := splitGitIgnoredStatusRows(output)
	return GitStatusResult{
		Entries:           parseGitStatusEntries(changed, strings.TrimSpace(req.Area), base),
		ConflictOperation: DetectGitConflictOperation(base),
		IgnoredPaths:      ignored,
	}, nil
}

// splitGitIgnoredStatusRows separates the `!!` rows `--ignored` adds from the
// change rows, because the entry parser has no status of its own for them and
// would otherwise report every ignored path as a change.
func splitGitIgnoredStatusRows(output string) (string, []string) {
	if !strings.Contains(output, "!! ") {
		return output, nil
	}
	changed := make([]string, 0)
	ignored := make([]string, 0)
	for _, line := range strings.Split(strings.TrimRight(output, "\n"), "\n") {
		if strings.HasPrefix(line, "!! ") {
			path := strings.TrimSpace(strings.TrimPrefix(line, "!!"))
			if path != "" {
				ignored = append(ignored, path)
			}
			continue
		}
		changed = append(changed, line)
	}
	return strings.Join(changed, "\n"), ignored
}
