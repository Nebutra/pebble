package runtimecore

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"strings"
	"time"
)

func resolveWslSessionStartRequest(ctx context.Context, req StartSessionRequest, windowsCwd string, preference LocalWindowsRuntimePreference) (StartSessionRequest, error) {
	conversionCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	output, err := exec.CommandContext(
		conversionCtx,
		"wsl.exe",
		"--distribution",
		preference.Distro,
		"--exec",
		"wslpath",
		"-a",
		"-u",
		windowsCwd,
	).Output()
	if err != nil {
		return StartSessionRequest{}, errors.New("convert Windows workspace path through selected WSL distro")
	}
	linuxCwd := strings.TrimSpace(string(output))
	if linuxCwd == "" || !strings.HasPrefix(linuxCwd, "/") || len(linuxCwd) > 4096 {
		return StartSessionRequest{}, errors.New("selected WSL distro returned an invalid workspace path")
	}
	return buildWslSessionStartRequest(req, windowsCwd, linuxCwd, preference), nil
}

func buildWslSessionStartRequest(req StartSessionRequest, windowsCwd, linuxCwd string, preference LocalWindowsRuntimePreference) StartSessionRequest {
	launch := []string{"wsl.exe", "--distribution", preference.Distro, "--cd", linuxCwd, "--exec"}
	if len(req.Command) == 0 {
		launch = append(launch, "/bin/sh", "-lc", `exec "${SHELL:-/bin/sh}" -l`)
	} else {
		launch = append(launch, req.Command...)
	}
	req.Cwd = windowsCwd
	req.launchCwd = ""
	req.launchCommand = launch
	req.wslDistro = preference.Distro
	refreshWslSessionEnvironment(&req)
	return req
}

func refreshWslSessionEnvironment(req *StartSessionRequest) {
	filteredHookEnv := req.hookEnv[:0]
	for _, entry := range req.hookEnv {
		if !strings.HasPrefix(entry, "WSLENV=") {
			filteredHookEnv = append(filteredHookEnv, entry)
		}
	}
	req.hookEnv = filteredHookEnv
	environmentNames := sessionEnvironmentNames(append(append([]string{}, req.Environment...), req.hookEnv...))
	if existing := strings.TrimSpace(os.Getenv("WSLENV")); existing != "" {
		environmentNames = append([]string{existing}, environmentNames...)
	}
	if len(environmentNames) > 0 {
		req.hookEnv = append(req.hookEnv, "WSLENV="+strings.Join(environmentNames, ":"))
	}
}

func sessionEnvironmentNames(environment []string) []string {
	seen := make(map[string]struct{}, len(environment))
	names := make([]string, 0, len(environment))
	for _, entry := range environment {
		name, _, found := strings.Cut(entry, "=")
		if !found || !isPortableEnvironmentName(name) {
			continue
		}
		if _, duplicate := seen[name]; duplicate {
			continue
		}
		seen[name] = struct{}{}
		names = append(names, name)
	}
	return names
}

func isPortableEnvironmentName(value string) bool {
	if value == "" || len(value) > 128 {
		return false
	}
	for index, char := range value {
		if !(char == '_' || char >= 'A' && char <= 'Z' || char >= 'a' && char <= 'z' || index > 0 && char >= '0' && char <= '9') {
			return false
		}
	}
	return true
}
