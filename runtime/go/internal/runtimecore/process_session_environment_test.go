package runtimecore

import "testing"

func TestInteractiveSessionEnvironmentUpgradesDumbTerminal(t *testing.T) {
	environment := []string{"TERM=dumb", "PATH=/usr/bin"}
	if !terminalTypeNeedsUpgrade(environment) {
		t.Fatal("expected TERM=dumb to require an interactive terminal type")
	}
	environment = setSessionEnvironmentValue(environment, "TERM", "xterm-256color")
	value, found := sessionEnvironmentValue(environment, "TERM")
	if !found || value != "xterm-256color" {
		t.Fatalf("TERM = %q, found=%v", value, found)
	}
}

func TestSessionEnvironmentValuePreservesUnrelatedEntries(t *testing.T) {
	environment := setSessionEnvironmentValue([]string{"PATH=/usr/bin"}, "TERM_PROGRAM", "Pebble")
	if value, found := sessionEnvironmentValue(environment, "PATH"); !found || value != "/usr/bin" {
		t.Fatalf("PATH = %q, found=%v", value, found)
	}
	if value, found := sessionEnvironmentValue(environment, "TERM_PROGRAM"); !found || value != "Pebble" {
		t.Fatalf("TERM_PROGRAM = %q, found=%v", value, found)
	}
}
