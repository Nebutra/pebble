package runtimecore

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
)

func (m *Manager) resolveSessionStartRequest(req StartSessionRequest) (StartSessionRequest, error) {
	base, err := m.resolveWorkspacePath(req.ProjectID, req.WorktreeID)
	if err != nil {
		return StartSessionRequest{}, err
	}
	cwd := strings.TrimSpace(req.Cwd)
	if cwd == "" {
		cwd = base
	}
	normalizedCwd, err := normalizeLocalPath(cwd)
	if err != nil {
		return StartSessionRequest{}, err
	}
	if err := requireSessionCwdInsideWorkspace(base, normalizedCwd); err != nil {
		return StartSessionRequest{}, err
	}
	req.ProjectID = strings.TrimSpace(req.ProjectID)
	req.WorktreeID = strings.TrimSpace(req.WorktreeID)
	req.Cwd = normalizedCwd
	req.AgentKind = strings.TrimSpace(req.AgentKind)
	req.TabID = strings.TrimSpace(req.TabID)
	req.LeafID = strings.TrimSpace(req.LeafID)
	req.LaunchToken = strings.TrimSpace(req.LaunchToken)
	return req, nil
}

func requireSessionCwdInsideWorkspace(base string, cwd string) error {
	info, err := os.Stat(cwd)
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return errors.New("session cwd is not a directory")
	}
	resolvedBase, err := filepath.EvalSymlinks(base)
	if err != nil {
		return err
	}
	resolvedCwd, err := filepath.EvalSymlinks(cwd)
	if err != nil {
		return err
	}
	// Sessions can execute arbitrary commands, so cwd must stay inside its owning workspace.
	return requirePathInsideWorkspace(resolvedBase, resolvedCwd)
}
