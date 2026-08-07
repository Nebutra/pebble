package runtimecore

import (
	"errors"
	"fmt"
	"runtime"
	"strings"
)

var (
	// ErrAgentCommandMissing reports a profile that names no CLI at all.
	ErrAgentCommandMissing = errors.New("agent profile has no configured CLI command")
	// ErrAgentCommandNotFound reports a configured CLI that does not resolve on this host.
	ErrAgentCommandNotFound = errors.New("configured agent CLI was not found")
)

// requireAgentProfileCommand verifies a profile names a runnable CLI before an
// agent run starts. Why: startProcessSession falls back to the login shell on an
// empty command, so a profile that skipped CreateAgentProfile validation (older
// store file, hand-edited state) would silently run a plain shell that the UI
// still reports as a running agent.
//
// localExecution is false for SSH and WSL projects, where the CLI resolves on the
// remote host and a local PATH probe would reject a correct configuration.
func requireAgentProfileCommand(profile AgentProfile, localExecution bool, lookPath func(string) (string, error)) error {
	command := trimStringSlice(profile.Command)
	if len(command) == 0 {
		return fmt.Errorf("%w: %s", ErrAgentCommandMissing, agentProfileLabel(profile))
	}
	if !localExecution {
		return nil
	}
	// exec.LookPath tries a path containing a separator directly and consults
	// PATH only for bare names, so both configuration styles work here.
	if _, err := lookPath(command[0]); err != nil {
		return fmt.Errorf("%w: %q for %s", ErrAgentCommandNotFound, command[0], agentProfileLabel(profile))
	}
	return nil
}

// agentRunExecutesLocally mirrors resolveSessionStartRequest's transport choice:
// SSH projects and WSL-backed Windows projects spawn the CLI off-host.
func (m *Manager) agentRunExecutesLocally(projectID string) bool {
	project, ok := m.sessionProject(projectID)
	if !ok {
		return true
	}
	if project.LocationKind == "ssh" {
		return false
	}
	if runtime.GOOS == "windows" && project.LocalWindowsRuntimePreference != nil &&
		project.LocalWindowsRuntimePreference.Kind == "wsl" {
		return false
	}
	return true
}

func agentProfileLabel(profile AgentProfile) string {
	name := strings.TrimSpace(profile.Name)
	if name == "" {
		name = strings.TrimSpace(profile.ID)
	}
	if name == "" {
		return "agent profile"
	}
	return "agent " + name
}
