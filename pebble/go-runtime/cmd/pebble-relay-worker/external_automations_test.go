package main

import (
	"database/sql"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestExternalAutomationArgumentsMatchProviderCLIs(t *testing.T) {
	request := externalAutomationRequest{Operation: "create", Provider: "hermes", Name: "Daily", Prompt: "Review", Schedule: "0 9 * * *", Workdir: "/work"}
	arguments, err := externalAutomationArguments(request)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"cron", "create", "0 9 * * *", "Review", "--name", "Daily", "--deliver", "local", "--workdir", "/work"}
	if len(arguments) != len(want) {
		t.Fatalf("arguments = %#v", arguments)
	}
	for index := range want {
		if arguments[index] != want[index] {
			t.Fatalf("arguments[%d] = %q, want %q", index, arguments[index], want[index])
		}
	}

	request = externalAutomationRequest{Operation: "action", Provider: "openclaw", JobID: "job-1", Action: "delete"}
	arguments, err = externalAutomationArguments(request)
	if err != nil || len(arguments) != 3 || arguments[1] != "rm" {
		t.Fatalf("OpenClaw delete arguments = %#v, err = %v", arguments, err)
	}
}

func TestReadExternalAutomationRunsPagesNewestMarkdownFirst(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HERMES_HOME", home)
	directory := filepath.Join(home, "cron", "output", "job-1")
	if err := os.MkdirAll(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "2026-05-14_09-00-00.md"), []byte("## Response\n\nNewest result"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "2026-05-13_09-00-00.md"), []byte("# Cron Job: Daily (FAILED)\n\n## Error\n\nfailed"), 0o600); err != nil {
		t.Fatal(err)
	}
	result, err := readExternalAutomationRuns(externalAutomationRequest{Provider: "hermes", JobID: "job-1", Page: 1, PageSize: 1})
	if err != nil {
		t.Fatal(err)
	}
	if result["total"] != 2 {
		t.Fatalf("total = %#v", result["total"])
	}
	runs := result["runs"].([]any)
	if len(runs) != 1 || runs[0].(map[string]any)["status"] != "completed" {
		t.Fatalf("runs = %#v", runs)
	}
}

func TestReadExternalAutomationRunsMergesSQLiteTranscript(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HERMES_HOME", home)
	directory := filepath.Join(home, "cron", "output", "job-1")
	if err := os.MkdirAll(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "2026-05-14_09-00-10.md"), []byte("## Response\n\nDone"), 0o600); err != nil {
		t.Fatal(err)
	}
	database, err := sql.Open("sqlite", filepath.Join(home, "state.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	statements := []string{
		`CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, started_at REAL, ended_at REAL, model TEXT)`,
		`CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, timestamp REAL, role TEXT, content TEXT, tool_name TEXT, reasoning TEXT, reasoning_content TEXT)`,
		`INSERT INTO sessions VALUES ('cron_job-1_20260514_090000', 'Daily review', 1778749200, 1778749210, 'hermes-model')`,
		`INSERT INTO messages VALUES (1, 'cron_job-1_20260514_090000', 1, 'assistant', 'Transcript result', NULL, NULL, 'Checked repository')`,
	}
	for _, statement := range statements {
		if _, err := database.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}

	result, err := readExternalAutomationRuns(externalAutomationRequest{Provider: "hermes", JobID: "job-1", Page: 1, PageSize: 25})
	if err != nil {
		t.Fatal(err)
	}
	if result["total"] != 1 {
		t.Fatalf("expected merged total 1, got %#v", result["total"])
	}
	run := result["runs"].([]any)[0].(map[string]any)
	content, _ := run["output_content"].(string)
	if !strings.Contains(content, "## Full session log") || !strings.Contains(content, "Transcript result") || !strings.Contains(content, "Checked repository") {
		t.Fatalf("merged content = %q", content)
	}
}

func TestExternalAutomationArgumentsRejectUnsafeIDs(t *testing.T) {
	_, err := externalAutomationArguments(externalAutomationRequest{Operation: "action", Provider: "hermes", JobID: "../state.db", Action: "run"})
	if err == nil {
		t.Fatal("expected unsafe job id rejection")
	}
}
