package runtimecore

import (
	"slices"
	"strings"
	"testing"
)

func TestBuildWslSessionUsesSelectedDistroAndKeepsSecretsOutOfArgv(t *testing.T) {
	t.Setenv("WSLENV", "EXISTING")
	request := buildWslSessionStartRequest(StartSessionRequest{
		Command:     []string{"codex", "--resume", "session-1"},
		Environment: []string{"OPENAI_API_KEY=do-not-leak", "TERM=xterm-256color"},
		hookEnv:     []string{"PEBBLE_HOOK_ENDPOINT=http://127.0.0.1:17777"},
	}, `C:\repo`, "/mnt/c/repo", LocalWindowsRuntimePreference{Kind: "wsl", Distro: "Ubuntu-24.04"})

	wantPrefix := []string{"wsl.exe", "--distribution", "Ubuntu-24.04", "--cd", "/mnt/c/repo", "--exec"}
	if !slices.Equal(request.launchCommand[:len(wantPrefix)], wantPrefix) {
		t.Fatalf("WSL launch prefix = %#v", request.launchCommand)
	}
	if strings.Contains(strings.Join(request.launchCommand, " "), "do-not-leak") {
		t.Fatal("session secret leaked into WSL argv")
	}
	if !slices.Contains(request.hookEnv, "WSLENV=EXISTING:OPENAI_API_KEY:TERM:PEBBLE_HOOK_ENDPOINT") {
		t.Fatalf("WSLENV does not preserve session environment names: %#v", request.hookEnv)
	}
}

func TestBuildWslLoginShellUsesLinuxCwd(t *testing.T) {
	request := buildWslSessionStartRequest(StartSessionRequest{}, `C:\repo`, "/work/repo", LocalWindowsRuntimePreference{Kind: "wsl", Distro: "Ubuntu"})
	if request.Cwd != `C:\repo` || !slices.Contains(request.launchCommand, "/work/repo") {
		t.Fatalf("WSL cwd contract = %#v", request)
	}
	if request.launchCommand[len(request.launchCommand)-3] != "/bin/sh" {
		t.Fatalf("WSL login shell = %#v", request.launchCommand)
	}
}

func TestSessionEnvironmentNamesRejectsUnsafeAndDuplicateNames(t *testing.T) {
	if got := sessionEnvironmentNames([]string{"SAFE=1", "SAFE=2", "lowercase=3", "1BAD=4", "bad-name=5", "ALSO_SAFE=x"}); !slices.Equal(got, []string{"SAFE", "lowercase", "ALSO_SAFE"}) {
		t.Fatalf("environment names = %#v", got)
	}
}

func TestRefreshWslEnvironmentIncludesLateHookCredentials(t *testing.T) {
	t.Setenv("WSLENV", "")
	request := buildWslSessionStartRequest(StartSessionRequest{Environment: []string{"TERM=xterm"}}, `C:\repo`, "/mnt/c/repo", LocalWindowsRuntimePreference{Kind: "wsl", Distro: "Ubuntu"})
	request.hookEnv = []string{"PEBBLE_AGENT_HOOK_PORT=17777", "PEBBLE_AGENT_HOOK_TOKEN=secret"}
	refreshWslSessionEnvironment(&request)
	if !slices.Contains(request.hookEnv, "WSLENV=TERM:PEBBLE_AGENT_HOOK_PORT:PEBBLE_AGENT_HOOK_TOKEN") {
		t.Fatalf("late hook credentials are not forwarded by name: %#v", request.hookEnv)
	}
}
