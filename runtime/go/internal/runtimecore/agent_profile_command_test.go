package runtimecore

import (
	"errors"
	"os/exec"
	"strings"
	"testing"
)

func lookPathFound(resolved string) func(string) (string, error) {
	return func(string) (string, error) { return resolved, nil }
}

func lookPathMissing() func(string) (string, error) {
	return func(name string) (string, error) { return "", exec.ErrNotFound }
}

func TestRequireAgentProfileCommandAcceptsConfiguredCli(t *testing.T) {
	profile := AgentProfile{ID: "agent_1", Name: "Codex", Command: []string{"codex", "--yolo"}}
	if err := requireAgentProfileCommand(profile, true, lookPathFound("/usr/local/bin/codex")); err != nil {
		t.Fatalf("configured CLI should start: %v", err)
	}
}

func TestRequireAgentProfileCommandRejectsEmptyCommand(t *testing.T) {
	// A profile with no command previously reached startProcessSession, which
	// substitutes the login shell and reports it as a running agent.
	for name, profile := range map[string]AgentProfile{
		"nil command":        {ID: "agent_1", Name: "Codex"},
		"blank-only command": {ID: "agent_1", Name: "Codex", Command: []string{"  ", ""}},
	} {
		t.Run(name, func(t *testing.T) {
			err := requireAgentProfileCommand(profile, true, lookPathFound("/bin/zsh"))
			if !errors.Is(err, ErrAgentCommandMissing) {
				t.Fatalf("want ErrAgentCommandMissing, got %v", err)
			}
			if !strings.Contains(err.Error(), "Codex") {
				t.Fatalf("error must name the profile, got %q", err)
			}
		})
	}
}

func TestRequireAgentProfileCommandRejectsUnresolvableCli(t *testing.T) {
	profile := AgentProfile{ID: "agent_1", Name: "Codex", Command: []string{"codex-missing"}}
	err := requireAgentProfileCommand(profile, true, lookPathMissing())
	if !errors.Is(err, ErrAgentCommandNotFound) {
		t.Fatalf("want ErrAgentCommandNotFound, got %v", err)
	}
	if !strings.Contains(err.Error(), "codex-missing") {
		t.Fatalf("error must name the command so the user can fix it, got %q", err)
	}
}

func TestRequireAgentProfileCommandSkipsPathProbeForRemoteRuns(t *testing.T) {
	// SSH/WSL runs resolve the CLI on the remote host; a local PATH miss is not
	// evidence of misconfiguration.
	profile := AgentProfile{ID: "agent_1", Name: "Codex", Command: []string{"codex"}}
	if err := requireAgentProfileCommand(profile, false, lookPathMissing()); err != nil {
		t.Fatalf("remote run must not be blocked by local PATH: %v", err)
	}
}

func TestRequireAgentProfileCommandStillRequiresCommandForRemoteRuns(t *testing.T) {
	profile := AgentProfile{ID: "agent_1", Name: "Codex"}
	if err := requireAgentProfileCommand(profile, false, lookPathMissing()); !errors.Is(err, ErrAgentCommandMissing) {
		t.Fatalf("want ErrAgentCommandMissing, got %v", err)
	}
}

func TestBuildAgentCommandUsesConfiguredCliAsArgv0(t *testing.T) {
	profile := AgentProfile{
		ID:                  "agent_1",
		Name:                "Codex",
		Kind:                "codex",
		Command:             []string{"/opt/pebble/bin/codex", "exec"},
		PromptInjectionMode: PromptArgv,
	}
	command, stdinPrompt := buildAgentCommand(profile, "ship it")
	if command[0] != "/opt/pebble/bin/codex" {
		t.Fatalf("argv0 must be the configured CLI, got %q", command[0])
	}
	want := []string{"/opt/pebble/bin/codex", "exec", "ship it"}
	if strings.Join(command, "\x00") != strings.Join(want, "\x00") {
		t.Fatalf("spawn args = %v, want %v", command, want)
	}
	if stdinPrompt != "" {
		t.Fatalf("argv injection must not also write stdin, got %q", stdinPrompt)
	}
}
