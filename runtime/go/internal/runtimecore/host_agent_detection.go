package runtimecore

import (
	"os/exec"
	"sort"
)

type hostAgentProbe struct {
	ID       string
	Commands []string
}

var hostAgentProbes = []hostAgentProbe{
	{ID: "claude", Commands: []string{"claude"}},
	{ID: "claude-agent-teams", Commands: []string{"pebble", "pebble-dev", "pebble-ide"}},
	{ID: "openclaude", Commands: []string{"openclaude"}},
	{ID: "codex", Commands: []string{"codex"}},
	{ID: "autohand", Commands: []string{"autohand"}},
	{ID: "ante", Commands: []string{"ante"}},
	{ID: "opencode", Commands: []string{"opencode"}},
	{ID: "mimo-code", Commands: []string{"mimo"}},
	{ID: "pi", Commands: []string{"pi"}},
	{ID: "omp", Commands: []string{"omp"}},
	{ID: "gemini", Commands: []string{"gemini"}},
	{ID: "antigravity", Commands: []string{"agy"}},
	{ID: "aider", Commands: []string{"aider"}},
	{ID: "goose", Commands: []string{"goose"}},
	{ID: "amp", Commands: []string{"amp"}},
	{ID: "kilo", Commands: []string{"kilo"}},
	{ID: "kiro", Commands: []string{"kiro-cli"}},
	{ID: "crush", Commands: []string{"crush"}},
	{ID: "aug", Commands: []string{"auggie"}},
	{ID: "cline", Commands: []string{"cline"}},
	{ID: "codebuff", Commands: []string{"codebuff"}},
	{ID: "command-code", Commands: []string{"command-code"}},
	{ID: "continue", Commands: []string{"cn"}},
	{ID: "cursor", Commands: []string{"cursor-agent"}},
	{ID: "droid", Commands: []string{"droid"}},
	{ID: "kimi", Commands: []string{"kimi"}},
	{ID: "mistral-vibe", Commands: []string{"vibe", "mistral-vibe"}},
	{ID: "qwen-code", Commands: []string{"qwen"}},
	{ID: "rovo", Commands: []string{"rovo"}},
	{ID: "hermes", Commands: []string{"hermes"}},
	{ID: "openclaw", Commands: []string{"openclaw"}},
	{ID: "copilot", Commands: []string{"copilot"}},
	{ID: "grok", Commands: []string{"grok"}},
	{ID: "devin", Commands: []string{"devin"}},
}

func DetectHostAgents() []string {
	return detectHostAgents(exec.LookPath)
}

func detectHostAgents(lookPath func(string) (string, error)) []string {
	detected := make([]string, 0, len(hostAgentProbes))
	for _, probe := range hostAgentProbes {
		for _, command := range probe.Commands {
			if _, err := lookPath(command); err == nil {
				detected = append(detected, probe.ID)
				break
			}
		}
	}
	sort.Strings(detected)
	return detected
}
