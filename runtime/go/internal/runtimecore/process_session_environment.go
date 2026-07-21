package runtimecore

import (
	"os"
	"runtime"
	"strings"
)

func interactiveSessionEnvironment(extra []string) []string {
	environment := append([]string(nil), os.Environ()...)
	if runtime.GOOS != "windows" && terminalTypeNeedsUpgrade(environment) {
		environment = setSessionEnvironmentValue(environment, "TERM", "xterm-256color")
	}
	environment = setSessionEnvironmentValue(environment, "COLORTERM", "truecolor")
	environment = setSessionEnvironmentValue(environment, "TERM_PROGRAM", "Pebble")
	for _, entry := range extra {
		key, value, ok := strings.Cut(entry, "=")
		if !ok || key == "" {
			continue
		}
		environment = setSessionEnvironmentValue(environment, key, value)
	}
	return environment
}

func terminalTypeNeedsUpgrade(environment []string) bool {
	value, found := sessionEnvironmentValue(environment, "TERM")
	return !found || strings.EqualFold(strings.TrimSpace(value), "dumb")
}

func sessionEnvironmentValue(environment []string, key string) (string, bool) {
	for _, entry := range environment {
		entryKey, value, ok := strings.Cut(entry, "=")
		if ok && sessionEnvironmentKeysEqual(entryKey, key) {
			return value, true
		}
	}
	return "", false
}

func setSessionEnvironmentValue(environment []string, key string, value string) []string {
	replacement := key + "=" + value
	for index, entry := range environment {
		entryKey, _, ok := strings.Cut(entry, "=")
		if ok && sessionEnvironmentKeysEqual(entryKey, key) {
			environment[index] = replacement
			return environment
		}
	}
	return append(environment, replacement)
}

func sessionEnvironmentKeysEqual(left string, right string) bool {
	if runtime.GOOS == "windows" {
		return strings.EqualFold(left, right)
	}
	return left == right
}
