package runtimecore

import (
	"context"
	"errors"
	"os/exec"
	"strings"
	"time"
)

const sparseCheckoutCommandLimit = 30 * time.Second

func (m *Manager) ConfigureWorktreeSparseCheckout(ctx context.Context, worktreeID string, directories []string, presetID string) (Worktree, error) {
	directories, err := normalizeSparsePresetDirectories(directories)
	if err != nil {
		return Worktree{}, err
	}
	if len(directories) == 0 {
		return Worktree{}, errors.New("sparse checkout requires at least one directory")
	}
	m.mu.RLock()
	worktree, found := m.worktrees[strings.TrimSpace(worktreeID)]
	project, projectFound := m.projects[worktree.ProjectID]
	m.mu.RUnlock()
	if !found || !projectFound {
		return Worktree{}, ErrNotFound
	}
	if project.LocationKind != "local" {
		return Worktree{}, ErrRemoteNeedsRelay
	}
	commandCtx, cancel := context.WithTimeout(ctx, sparseCheckoutCommandLimit)
	defer cancel()
	args := []string{"-C", worktree.Path, "sparse-checkout", "set", "--cone", "--"}
	args = append(args, directories...)
	if output, err := exec.CommandContext(commandCtx, "git", args...).CombinedOutput(); err != nil {
		message := strings.TrimSpace(string(output))
		if message == "" {
			message = err.Error()
		}
		return Worktree{}, errors.New("sparse checkout failed: " + message)
	}
	return m.UpdateWorktree(worktree.ID, UpdateWorktreeRequest{
		SparseDirectories: &directories, SparseBaseRef: &worktree.Base, SparsePresetID: &presetID,
	})
}
