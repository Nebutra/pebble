package runtimecore

import (
	"errors"
	"os"
	"os/exec"
	pathpkg "path"
	"path/filepath"
	"strings"
)

func (m *Manager) resolveSessionStartRequest(req StartSessionRequest) (StartSessionRequest, error) {
	if req.Ephemeral {
		return resolveEphemeralSessionStartRequest(req)
	}
	if project, ok := m.sessionProject(req.ProjectID); ok && project.LocationKind == "ssh" {
		return m.resolveSshSessionStartRequest(req, project)
	}
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

func (m *Manager) sessionProject(projectID string) (Project, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	project, ok := m.projects[strings.TrimSpace(projectID)]
	return project, ok
}

func (m *Manager) resolveSshSessionStartRequest(req StartSessionRequest, project Project) (StartSessionRequest, error) {
	target, ok := m.GetSshTarget(project.HostID)
	if !ok {
		return StartSessionRequest{}, ErrNotFound
	}
	remoteBase := project.Path
	if worktreeID := strings.TrimSpace(req.WorktreeID); worktreeID != "" {
		m.mu.RLock()
		worktree, found := m.worktrees[worktreeID]
		m.mu.RUnlock()
		if !found || worktree.ProjectID != project.ID {
			return StartSessionRequest{}, ErrNotFound
		}
		remoteBase = worktree.Path
	}
	remoteCwd := strings.TrimSpace(req.Cwd)
	if remoteCwd == "" {
		remoteCwd = remoteBase
	}
	if !isAbsoluteRemoteSessionPath(remoteCwd) {
		return StartSessionRequest{}, errors.New("remote session cwd must be absolute")
	}
	remoteBase = pathpkg.Clean(remoteBase)
	remoteCwd = pathpkg.Clean(remoteCwd)
	if remoteCwd != remoteBase && !strings.HasPrefix(remoteCwd, strings.TrimSuffix(remoteBase, "/")+"/") {
		return StartSessionRequest{}, errors.New("remote session cwd escapes its workspace")
	}
	sshPath, found := findSystemSshBinary()
	if !found {
		return StartSessionRequest{}, errors.New("system ssh binary not found")
	}
	remoteCommand := "cd -- " + quotePosixShell(remoteCwd) + " && exec " + quoteRemoteSessionCommand(req.Command)
	req.ProjectID = project.ID
	req.WorktreeID = strings.TrimSpace(req.WorktreeID)
	req.Cwd = remoteCwd
	req.AgentKind = strings.TrimSpace(req.AgentKind)
	req.TabID = strings.TrimSpace(req.TabID)
	req.LeafID = strings.TrimSpace(req.LeafID)
	req.LaunchToken = strings.TrimSpace(req.LaunchToken)
	req.launchCommand = append([]string{sshPath}, sshCommandArgs(target, remoteCommand)...)
	targetID := target.ID
	req.configureCommand = func(command *exec.Cmd) (func(), error) {
		return configureSshAskpass(command, m, targetID)
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return StartSessionRequest{}, err
	}
	// The local ssh process only needs a valid host cwd; the visible session cwd remains remote.
	req.hookEnv = append(req.hookEnv, "PEBBLE_REMOTE_SESSION=1")
	req.launchCwd = home
	return req, nil
}

func quoteRemoteSessionCommand(command []string) string {
	if len(command) == 0 {
		return `"${SHELL:-/bin/sh}" -l`
	}
	quoted := make([]string, 0, len(command))
	for _, argument := range command {
		quoted = append(quoted, quotePosixShell(argument))
	}
	return strings.Join(quoted, " ")
}

func isAbsoluteRemoteSessionPath(value string) bool {
	return strings.HasPrefix(value, "/")
}

func resolveEphemeralSessionStartRequest(req StartSessionRequest) (StartSessionRequest, error) {
	if strings.TrimSpace(req.ProjectID) != "" || strings.TrimSpace(req.WorktreeID) != "" {
		return StartSessionRequest{}, errors.New("ephemeral sessions cannot bind a project or worktree")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return StartSessionRequest{}, err
	}
	normalizedHome, err := normalizeLocalPath(home)
	if err != nil {
		return StartSessionRequest{}, err
	}
	cwd := strings.TrimSpace(req.Cwd)
	if cwd == "" {
		cwd = normalizedHome
	}
	normalizedCwd, err := normalizeLocalPath(cwd)
	if err != nil {
		return StartSessionRequest{}, err
	}
	if err := requireSessionCwdInsideWorkspace(normalizedHome, normalizedCwd); err != nil {
		return StartSessionRequest{}, err
	}
	req.ProjectID = ""
	req.WorktreeID = ""
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
