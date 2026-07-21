package runtimehttp

import "testing"

func TestBuiltinAgentLaunchCatalogMatchesCanonicalCommandExceptions(t *testing.T) {
	want := map[string]string{
		"codex": "codex", "claude-agent-teams": "pebble claude-teams",
		"kiro": "kiro-cli chat --tui", "command-code": "command-code --trust",
		"continue": "cn", "mistral-vibe": "vibe", "hermes": "hermes --tui",
	}
	for agent, expected := range want {
		if command, found := builtinAgentLaunchCommand(agent); !found || command != expected {
			t.Fatalf("%s command = %q found=%v, want %q", agent, command, found, expected)
		}
	}
	if _, found := builtinAgentLaunchCommand("not-an-agent"); found {
		t.Fatal("unknown agents must not resolve to shell input")
	}
}

func TestBuiltinAgentStartupCommandMatchesCanonicalPromptModes(t *testing.T) {
	quoted := quoteBuiltinAgentPrompt("fix tests")
	tests := map[string]string{
		"codex":    "codex " + quoted,
		"opencode": "opencode --prompt " + quoted,
		"gemini":   "gemini --prompt-interactive " + quoted,
		"copilot":  "copilot -i " + quoted,
		"aider":    "aider\nfix tests",
	}
	for agent, expected := range tests {
		command, found := builtinAgentStartupCommand(agent, "fix tests")
		if !found || command != expected {
			t.Fatalf("%s startup = %q found=%v, want %q", agent, command, found, expected)
		}
	}
}

func TestBuiltinAgentDraftStartupPreservesReviewBeforeSend(t *testing.T) {
	claude, found := builtinAgentDraftStartup("claude", "review this")
	if !found || claude.Command != "claude --prefill "+quoteBuiltinAgentPrompt("review this") || claude.PasteAfterReady {
		t.Fatalf("unexpected Claude draft plan: %#v", claude)
	}
	pi, found := builtinAgentDraftStartup("pi", "review this")
	if !found || pi.Environment["PEBBLE_PI_PREFILL"] != "review this" || pi.PasteAfterReady {
		t.Fatalf("unexpected Pi draft plan: %#v", pi)
	}
	codex, found := builtinAgentDraftStartup("codex", "review this")
	if !found || codex.Command != "codex" || !codex.PasteAfterReady || codex.ReadySignal != "codex-composer-prompt" {
		t.Fatalf("unexpected Codex draft plan: %#v", codex)
	}
	opencode, found := builtinAgentDraftStartup("opencode", "review this")
	if !found || opencode.ReadySignal != "render-cursor-after-bracketed-paste" {
		t.Fatalf("unexpected OpenCode draft plan: %#v", opencode)
	}
}
