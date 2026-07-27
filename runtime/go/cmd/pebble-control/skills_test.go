package main

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

func TestRunSkillsReturnsBundledGuide(t *testing.T) {
	var output bytes.Buffer
	if err := runSkills([]string{"get", "pebble-cli"}, &output); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output.String(), "# Pebble CLI") {
		t.Fatalf("unexpected guide: %s", output.String())
	}
}

func TestRunSkillsReportsVersionFallbackInJSON(t *testing.T) {
	var output bytes.Buffer
	if err := runSkills([]string{"get", "--app-version", "9.9.9", "--json", "computer-use"}, &output); err != nil {
		t.Fatal(err)
	}
	var result skillGuideResult
	if err := json.Unmarshal(output.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.RequestedAppVersion != "9.9.9" || result.FallbackReason == "" || result.Content == "" {
		t.Fatalf("unexpected result: %+v", result)
	}
}

func TestRunSkillsRejectsUnknownSkill(t *testing.T) {
	var output bytes.Buffer
	err := runSkills([]string{"get", "missing"}, &output)
	if err == nil || !strings.Contains(err.Error(), "available skills") {
		t.Fatalf("unexpected error: %v", err)
	}
}
