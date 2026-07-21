package runtimecore

import (
	"database/sql"
	"path/filepath"
	"testing"
)

func TestReadOpenCodeUsageEventsPrefersSessionTotals(t *testing.T) {
	database := openCodeUsageTestDatabase(t)
	if _, err := database.Exec(`
CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT);
CREATE TABLE session (
  id TEXT PRIMARY KEY, project_id TEXT, directory TEXT, model TEXT,
  time_created INTEGER, time_updated INTEGER, cost REAL,
  tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER, tokens_cache_read INTEGER
);
INSERT INTO project VALUES ('project-1', '/repo/fallback');
INSERT INTO session VALUES ('session-1', 'project-1', '/repo/pebble', '{"providerID":"openai","id":"gpt-5.4"}', 1777634000000, 1777634060000, 0.25, 100, 20, 5, 40);
`); err != nil {
		t.Fatal(err)
	}

	events, err := readOpenCodeUsageEvents(database)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 {
		t.Fatalf("expected one aggregate event, got %#v", events)
	}
	event := events[0]
	if event.SessionID != "session-1" || event.Cwd != "/repo/pebble" || event.Model != "openai/gpt-5.4" || event.CachedInputTokens != 40 || event.TotalTokens != 125 || event.EstimatedCostUSD == nil || *event.EstimatedCostUSD != 0.25 {
		t.Fatalf("unexpected aggregate event: %#v", event)
	}
}

func TestReadOpenCodeUsageEventsSupportsLegacyMessageJson(t *testing.T) {
	database := openCodeUsageTestDatabase(t)
	if _, err := database.Exec(`
CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, time_created INTEGER);
CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
INSERT INTO session VALUES ('legacy-1', '/repo/legacy', 1777634000000);
INSERT INTO message VALUES ('user-1', 'legacy-1', 1777634000000, 0, '{"role":"user","tokens":{"input":999}}');
INSERT INTO message VALUES ('assistant-1', 'legacy-1', 1777634000000, 1777634060000, '{"role":"assistant","providerID":"anthropic","modelID":"claude-sonnet","path":{"cwd":"/repo/message-cwd"},"cost":0.01,"tokens":{"input":10,"output":4,"reasoning":2,"total":16,"cache":{"read":3}}}');
`); err != nil {
		t.Fatal(err)
	}

	events, err := readOpenCodeUsageEvents(database)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 || events[0].Model != "anthropic/claude-sonnet" || events[0].Cwd != "/repo/message-cwd" || events[0].InputTokens != 10 || events[0].CachedInputTokens != 3 || events[0].ReasoningOutputTokens != 2 {
		t.Fatalf("legacy message parsing drifted: %#v", events)
	}
}

func openCodeUsageTestDatabase(t *testing.T) *sql.DB {
	t.Helper()
	path := filepath.Join(t.TempDir(), "opencode.db")
	database, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	return database
}
