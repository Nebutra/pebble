package runtimecore

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestScanClaudeUsageFileAttributesLongestContainingWorktree(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "session.jsonl")
	cwd := filepath.Join(dir, "repo", "nested", "src")
	line := `{"type":"assistant","sessionId":"session-1","timestamp":"2026-01-02T03:04:05Z","cwd":` + quotedJSON(cwd) + `,"message":{"model":"claude-sonnet","usage":{"input_tokens":3,"output_tokens":2}}}`
	if err := os.WriteFile(path, []byte(line), 0o600); err != nil {
		t.Fatal(err)
	}
	refs := []usageWorktreeRef{
		{RepoID: "repo-parent", WorktreeID: "parent", Path: comparableUsagePath(filepath.Join(dir, "repo")), DisplayName: "Parent"},
		{RepoID: "repo-nested", WorktreeID: "nested", Path: comparableUsagePath(filepath.Join(dir, "repo", "nested")), DisplayName: "Nested"},
	}
	turns, err := scanClaudeUsageFile(path, refs)
	if err != nil {
		t.Fatal(err)
	}
	if len(turns) != 1 || turns[0].WorktreeID != "nested" || turns[0].RepoID != "repo-nested" || turns[0].ProjectLabel != "Nested" {
		t.Fatalf("nested worktree attribution drifted: %#v", turns)
	}
}

func TestExternalUsageLocationUsesLastTwoSegments(t *testing.T) {
	key, label, repoID, worktreeID := externalUsageLocation(filepath.Join("tmp", "outside", "project"))
	if key == "" || label != "outside/project" || repoID != "" || worktreeID != "" {
		t.Fatalf("unexpected external attribution: %q %q %q %q", key, label, repoID, worktreeID)
	}
}

func quotedJSON(value string) string {
	encoded, _ := json.Marshal(value)
	return string(encoded)
}
