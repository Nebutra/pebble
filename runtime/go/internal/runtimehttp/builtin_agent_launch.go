package runtimehttp

import (
	"runtime"
	"strings"
)

type builtinAgentLaunch struct {
	Command string
	Mode    string
}

type builtinAgentDraftLaunch struct {
	Command         string
	Environment     map[string]string
	PasteAfterReady bool
	ReadySignal     string
}

var builtinAgentLaunchCommands = map[string]builtinAgentLaunch{
	"claude": {"claude", "argv"}, "claude-agent-teams": {"pebble claude-teams", "stdin"},
	"openclaude": {"openclaude", "argv"}, "codex": {"codex", "argv"},
	"autohand": {"autohand", "stdin"}, "ante": {"ante", "stdin"},
	"opencode": {"opencode", "flag-prompt"}, "mimo-code": {"mimo", "flag-prompt"},
	"pi": {"pi", "argv"}, "omp": {"omp", "argv"},
	"gemini": {"gemini", "flag-prompt-interactive"}, "antigravity": {"agy", "flag-prompt-interactive"},
	"aider": {"aider", "stdin"}, "goose": {"goose", "stdin"}, "amp": {"amp", "stdin"},
	"kilo": {"kilo", "stdin"}, "kiro": {"kiro-cli chat --tui", "stdin"},
	"crush": {"crush", "stdin"}, "aug": {"auggie", "stdin"}, "cline": {"cline", "stdin"},
	"codebuff": {"codebuff", "stdin"}, "command-code": {"command-code --trust", "argv"},
	"continue": {"cn", "stdin"}, "cursor": {"cursor-agent", "argv"},
	"droid": {"droid", "argv"}, "kimi": {"kimi", "stdin"},
	"mistral-vibe": {"vibe", "stdin"}, "qwen-code": {"qwen", "stdin"},
	"rovo": {"rovo", "stdin"}, "hermes": {"hermes --tui", "stdin"},
	"openclaw": {"openclaw", "stdin"}, "copilot": {"copilot", "flag-interactive"},
	"grok": {"grok", "stdin"}, "devin": {"devin", "stdin"},
}

func builtinAgentLaunchCommand(agent string) (string, bool) {
	launch, found := builtinAgentLaunchCommands[strings.TrimSpace(agent)]
	return launch.Command, found
}

func builtinAgentStartupCommand(agent, prompt string) (string, bool) {
	launch, found := builtinAgentLaunchCommands[strings.TrimSpace(agent)]
	if !found {
		return "", false
	}
	prompt = strings.TrimSpace(prompt)
	if prompt == "" {
		return launch.Command, true
	}
	quoted := quoteBuiltinAgentPrompt(prompt)
	switch launch.Mode {
	case "argv":
		return launch.Command + " " + quoted, true
	case "flag-prompt":
		return launch.Command + " --prompt " + quoted, true
	case "flag-prompt-interactive":
		return launch.Command + " --prompt-interactive " + quoted, true
	case "flag-interactive":
		return launch.Command + " -i " + quoted, true
	default:
		return launch.Command + "\n" + prompt, true
	}
}

func builtinAgentDraftStartup(agent, draft string) (builtinAgentDraftLaunch, bool) {
	launch, found := builtinAgentLaunchCommands[strings.TrimSpace(agent)]
	draft = strings.TrimSpace(draft)
	if !found || draft == "" {
		return builtinAgentDraftLaunch{}, false
	}
	switch agent {
	case "claude", "openclaude":
		return builtinAgentDraftLaunch{Command: launch.Command + " --prefill " + quoteBuiltinAgentPrompt(draft)}, true
	case "pi":
		return builtinAgentDraftLaunch{Command: launch.Command, Environment: map[string]string{"PEBBLE_PI_PREFILL": draft}}, true
	case "omp":
		return builtinAgentDraftLaunch{Command: launch.Command, Environment: map[string]string{"PEBBLE_OMP_PREFILL": draft}}, true
	}
	signal := "render-quiet-after-bracketed-paste"
	if agent == "codex" {
		signal = "codex-composer-prompt"
	} else if agent == "opencode" || agent == "mimo-code" {
		signal = "render-cursor-after-bracketed-paste"
	}
	return builtinAgentDraftLaunch{Command: launch.Command, PasteAfterReady: true, ReadySignal: signal}, true
}

func quoteBuiltinAgentPrompt(value string) string {
	if runtime.GOOS == "windows" {
		return `"` + strings.ReplaceAll(value, `"`, `""`) + `"`
	}
	return `'` + strings.ReplaceAll(value, `'`, `'"'"'`) + `'`
}
