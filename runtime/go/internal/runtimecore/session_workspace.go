package runtimecore

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	pathpkg "path"
	"path/filepath"
	"runtime"
	"strings"
)

func (m *Manager) resolveSessionStartRequest(ctx context.Context, req StartSessionRequest) (StartSessionRequest, error) {
	if req.Ephemeral {
		return resolveEphemeralSessionStartRequest(req)
	}
	project, hasProject := m.sessionProject(req.ProjectID)
	if hasProject && project.LocationKind == "ssh" {
		return m.resolveSshSessionStartRequest(ctx, req, project)
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
	if runtime.GOOS == "windows" && hasProject && project.LocalWindowsRuntimePreference != nil && project.LocalWindowsRuntimePreference.Kind == "wsl" {
		return resolveWslSessionStartRequest(ctx, req, normalizedCwd, *project.LocalWindowsRuntimePreference)
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

func (m *Manager) resolveSshSessionStartRequest(ctx context.Context, req StartSessionRequest, project Project) (StartSessionRequest, error) {
	target, ok := m.GetSshTarget(project.HostID)
	if !ok {
		return StartSessionRequest{}, ErrNotFound
	}
	sshPath, found := findSystemSshBinary()
	if !found {
		return StartSessionRequest{}, errors.New("system ssh binary not found")
	}
	platform, err := m.probeRemoteRelayPlatform(ctx, sshPath, target.ID, target)
	if err != nil {
		// Why: an unknown remote OS cannot be quoted safely; failing here prevents
		// an SSH workspace from ever degrading into a local shell launch.
		return StartSessionRequest{}, fmt.Errorf("detect SSH session platform: %w", err)
	}
	return m.resolveSshSessionStartRequestForPlatform(req, project, target, sshPath, platform)
}

func (m *Manager) resolveSshSessionStartRequestForPlatform(req StartSessionRequest, project Project, target SshTarget, sshPath string, platform relayPlatform) (StartSessionRequest, error) {
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
	if !isAbsoluteRemoteSessionPath(remoteCwd, platform.goos) {
		return StartSessionRequest{}, errors.New("remote session cwd must be absolute")
	}
	remoteBase = cleanRemoteSessionPath(remoteBase, platform.goos)
	remoteCwd = cleanRemoteSessionPath(remoteCwd, platform.goos)
	if !remoteSessionPathInside(remoteBase, remoteCwd, platform.goos) {
		return StartSessionRequest{}, errors.New("remote session cwd escapes its workspace")
	}
	remoteCommand := remoteSessionCommand(remoteCwd, req.Command, platform.goos)
	req.ProjectID = project.ID
	req.WorktreeID = strings.TrimSpace(req.WorktreeID)
	req.Cwd = remoteCwd
	req.AgentKind = strings.TrimSpace(req.AgentKind)
	req.TabID = strings.TrimSpace(req.TabID)
	req.LeafID = strings.TrimSpace(req.LeafID)
	req.LaunchToken = strings.TrimSpace(req.LaunchToken)
	// Why: these sessions drive an interactive terminal; an explicit remote
	// command otherwise makes OpenSSH skip remote PTY allocation.
	interactiveArgs := append([]string{"-tt"}, sshCommandArgs(target, remoteCommand)...)
	req.launchCommand = append([]string{sshPath}, interactiveArgs...)
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

func remoteSessionCommand(cwd string, command []string, goos string) string {
	if goos == "windows" {
		script := "$ErrorActionPreference='Stop';Set-Location -LiteralPath " + quotePowerShellLiteral(cwd) + ";"
		if len(command) == 0 {
			script += "if($env:COMSPEC){& $env:COMSPEC}else{& 'cmd.exe'}"
		} else {
			script += "& " + quotePowerShellLiteral(command[0])
			for _, argument := range command[1:] {
				script += " " + quotePowerShellLiteral(argument)
			}
		}
		script += ";exit $LASTEXITCODE"
		return windowsPowerShellCommand(script)
	}
	return "cd -- " + quotePosixShell(cwd) + " && exec " + quoteRemoteSessionCommand(command)
}

func isAbsoluteRemoteSessionPath(value, goos string) bool {
	if goos == "windows" {
		return isWindowsAbsolutePath(value)
	}
	return strings.HasPrefix(value, "/")
}

func cleanRemoteSessionPath(value, goos string) string {
	if goos != "windows" {
		return pathpkg.Clean(value)
	}
	isUNC := strings.HasPrefix(value, `\\`)
	cleaned := pathpkg.Clean(strings.ReplaceAll(strings.TrimLeft(value, `\\`), `\`, "/"))
	cleaned = strings.ReplaceAll(cleaned, "/", `\`)
	if isUNC {
		// Why: path.Clean collapses a leading // on non-Windows hosts, but UNC
		// identity requires two leading separators even when tested on macOS.
		return `\\` + cleaned
	}
	return cleaned
}

func remoteSessionPathInside(base, cwd, goos string) bool {
	separator := "/"
	if goos == "windows" {
		base, cwd, separator = strings.ToLower(base), strings.ToLower(cwd), `\`
	}
	return cwd == base || strings.HasPrefix(cwd, strings.TrimSuffix(base, separator)+separator)
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
