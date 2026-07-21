package runtimecore

import (
	"database/sql"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

func TestParseAiVaultClaudeAndCodexJSONL(t *testing.T) {
	dir := t.TempDir()
	claudePath := filepath.Join(dir, "claude-session.jsonl")
	claude := `{"sessionId":"claude-1","timestamp":"2026-07-12T10:00:00Z","cwd":"/work/pebble","type":"user","message":{"role":"user","content":"Fix the terminal"}}
{"sessionId":"claude-1","timestamp":"2026-07-12T10:01:00Z","type":"assistant","message":{"role":"assistant","model":"claude-sonnet","content":"Done","usage":{"input_tokens":10,"output_tokens":4}}}
`
	if err := os.WriteFile(claudePath, []byte(claude), 0o600); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(claudePath)
	if err != nil {
		t.Fatal(err)
	}
	session, err := parseAiVaultJSONL(aiVaultCandidate{agent: "claude", path: claudePath, info: info}, "/tmp/codex")
	if err != nil {
		t.Fatal(err)
	}
	if session == nil || session.SessionID != "claude-1" || session.Title != "Fix the terminal" || session.MessageCount != 2 || session.TotalTokens != 14 {
		t.Fatalf("unexpected Claude session: %#v", session)
	}

	codexPath := filepath.Join(dir, "rollout-codex-1.jsonl")
	codex := `{"timestamp":"2026-07-12T11:00:00Z","type":"session_meta","payload":{"id":"codex-1","cwd":"/work/pebble"}}
{"timestamp":"2026-07-12T11:01:00Z","type":"response_item","payload":{"role":"user","content":[{"type":"input_text","text":"Review this change"}]}}
`
	if err := os.WriteFile(codexPath, []byte(codex), 0o600); err != nil {
		t.Fatal(err)
	}
	info, err = os.Stat(codexPath)
	if err != nil {
		t.Fatal(err)
	}
	session, err = parseAiVaultJSONL(aiVaultCandidate{agent: "codex", path: codexPath, info: info}, "/tmp/codex")
	if err != nil {
		t.Fatal(err)
	}
	if session == nil || session.SessionID != "codex-1" || session.Cwd == nil || session.ResumeCommand != "cd '/work/pebble' && codex resume 'codex-1'" {
		t.Fatalf("unexpected Codex session: %#v", session)
	}
}

func TestClaudeWorkerTranscriptsAreExcluded(t *testing.T) {
	root := t.TempDir()
	mainPath := filepath.Join(root, "main.jsonl")
	workerPath := filepath.Join(root, "session", "subagents", "agent-worker.jsonl")
	if err := os.MkdirAll(filepath.Dir(workerPath), 0o700); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{mainPath, workerPath} {
		if err := os.WriteFile(path, []byte("{}\n"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	files, issues := discoverAiVaultFiles(aiVaultRoot{agent: "claude", path: root, extensions: []string{".jsonl"}}, 10)
	if len(issues) != 0 {
		t.Fatalf("unexpected discovery issues: %#v", issues)
	}
	if len(files) != 1 || files[0].path != mainPath {
		t.Fatalf("unexpected Claude discovery: %#v", files)
	}
}

func TestCursorDiscoveryOnlyIncludesAgentTranscripts(t *testing.T) {
	root := t.TempDir()
	transcriptPath := filepath.Join(root, "project", "agent-transcripts", "session.jsonl")
	cachePath := filepath.Join(root, "project", "cache", "session.jsonl")
	for _, path := range []string{transcriptPath, cachePath} {
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("{}\n"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	files, issues := discoverAiVaultFiles(aiVaultRoot{
		agent:      "cursor",
		path:       root,
		extensions: []string{".jsonl"},
		fileMatch: func(path string) bool {
			return pathContainsSegment(path, "agent-transcripts")
		},
	}, 10)
	if len(issues) != 0 {
		t.Fatalf("unexpected discovery issues: %#v", issues)
	}
	if len(files) != 1 || files[0].path != transcriptPath {
		t.Fatalf("unexpected Cursor discovery: %#v", files)
	}
}

func TestAiVaultDiscoverySkipsMissingRootWithoutIssue(t *testing.T) {
	root := filepath.Join(t.TempDir(), "missing")
	files, issues := discoverAiVaultFiles(aiVaultRoot{
		agent:      "codex",
		path:       root,
		extensions: []string{".jsonl"},
	}, 10)
	if len(files) != 0 || len(issues) != 0 {
		t.Fatalf("missing optional root should be silent: files=%#v issues=%#v", files, issues)
	}
}

func TestAiVaultDiscoveryContinuesPastUnreadableDirectory(t *testing.T) {
	if os.Geteuid() == 0 || runtime.GOOS == "windows" {
		t.Skip("permission-denied directory semantics require an unprivileged Unix host")
	}
	root := t.TempDir()
	readablePath := filepath.Join(root, "readable", "session.jsonl")
	if err := os.MkdirAll(filepath.Dir(readablePath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(readablePath, []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	protectedPath := filepath.Join(root, "protected")
	if err := os.Mkdir(protectedPath, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(protectedPath, 0); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(protectedPath, 0o700) })

	files, issues := discoverAiVaultFiles(aiVaultRoot{
		agent:      "codex",
		path:       root,
		extensions: []string{".jsonl"},
	}, 10)
	if len(files) != 1 || files[0].path != readablePath {
		t.Fatalf("readable sibling was lost: %#v", files)
	}
	if len(issues) != 1 || issues[0].path != protectedPath {
		t.Fatalf("unexpected protected-directory issues: %#v", issues)
	}
}

func TestParseAiVaultStructuredJSONAgents(t *testing.T) {
	dir := t.TempDir()
	testCases := []struct {
		agent   string
		path    string
		content string
		wantID  string
		wantCmd string
	}{
		{
			agent:   "gemini",
			path:    filepath.Join(dir, "gemini.json"),
			content: `{"sessionId":"gemini-1","startTime":"2026-07-12T10:00:00Z","messages":[{"type":"user","content":"Fix Gemini"},{"type":"gemini","content":"Done","model":"gemini-2.5","tokens":{"input":3,"output":2}}]}`,
			wantID:  "gemini-1",
			wantCmd: "gemini --resume 'gemini-1'",
		},
		{
			agent:   "hermes",
			path:    filepath.Join(dir, "session_hermes.json"),
			content: `{"session_id":"hermes-1","cwd":"/work/hermes","messages":[{"role":"user","content":"Fix Hermes"},{"role":"assistant","content":"Done"}]}`,
			wantID:  "hermes-1",
			wantCmd: "cd '/work/hermes' && hermes --resume 'hermes-1'",
		},
	}
	for _, testCase := range testCases {
		if err := os.WriteFile(testCase.path, []byte(testCase.content), 0o600); err != nil {
			t.Fatal(err)
		}
		info, err := os.Stat(testCase.path)
		if err != nil {
			t.Fatal(err)
		}
		session, err := parseAiVaultJSON(aiVaultCandidate{agent: testCase.agent, path: testCase.path, info: info})
		if err != nil {
			t.Fatal(err)
		}
		if session.SessionID != testCase.wantID || session.ResumeCommand != testCase.wantCmd || session.MessageCount != 2 {
			t.Fatalf("unexpected %s session: %#v", testCase.agent, session)
		}
		if testCase.agent == "gemini" && session.TotalTokens != 5 {
			t.Fatalf("unexpected Gemini token total: %#v", session)
		}
	}
}

func TestParseAiVaultRovoAndGrokCompanionFiles(t *testing.T) {
	dir := t.TempDir()
	rovoDir := filepath.Join(dir, "rovo-1")
	if err := os.MkdirAll(rovoDir, 0o700); err != nil {
		t.Fatal(err)
	}
	rovoPath := filepath.Join(rovoDir, "metadata.json")
	if err := os.WriteFile(rovoPath, []byte(`{"title":"Rovo title","workspace_path":"/work/rovo"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(rovoDir, "session_context.json"), []byte(`{"messages":[{"role":"user","content":"Rovo prompt"},{"role":"assistant","content":"Rovo reply"}]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	rovoInfo, _ := os.Stat(rovoPath)
	rovo, err := parseAiVaultJSON(aiVaultCandidate{agent: "rovo", path: rovoPath, info: rovoInfo})
	if err != nil || rovo.SessionID != "rovo-1" || rovo.ResumeCommand != "cd '/work/rovo' && acli rovodev run --restore 'rovo-1'" {
		t.Fatalf("unexpected Rovo session: %#v, %v", rovo, err)
	}

	grokDir := filepath.Join(dir, "grok-1")
	if err := os.MkdirAll(grokDir, 0o700); err != nil {
		t.Fatal(err)
	}
	grokPath := filepath.Join(grokDir, "summary.json")
	if err := os.WriteFile(grokPath, []byte(`{"info":{"id":"grok-1","cwd":"/work/grok"},"num_chat_messages":2,"current_model_id":"grok-build"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(grokDir, "chat_history.jsonl"), []byte("{\"type\":\"user\",\"content\":\"Grok prompt\"}\n{\"type\":\"assistant\",\"content\":\"Grok reply\"}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	grokInfo, _ := os.Stat(grokPath)
	grok, err := parseAiVaultJSON(aiVaultCandidate{agent: "grok", path: grokPath, info: grokInfo})
	if err != nil || grok.SessionID != "grok-1" || grok.ResumeCommand != "cd '/work/grok' && grok --resume 'grok-1'" {
		t.Fatalf("unexpected Grok session: %#v, %v", grok, err)
	}
}

func TestAiVaultAgentResumeCommands(t *testing.T) {
	dir := t.TempDir()
	for _, testCase := range []struct {
		agent string
		want  string
	}{
		{agent: "copilot", want: "copilot --resume='session-1'"},
		{agent: "cursor", want: "cursor-agent --resume 'session-1'"},
		{agent: "pi", want: "pi --session 'session-1'"},
	} {
		path := filepath.Join(dir, testCase.agent+".jsonl")
		content := `{"sessionId":"session-1","timestamp":"2026-07-12T10:00:00Z","role":"user","content":"Continue the work"}` + "\n"
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
		info, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		session, err := parseAiVaultJSONL(aiVaultCandidate{agent: testCase.agent, path: path, info: info}, "")
		if err != nil {
			t.Fatal(err)
		}
		if session == nil || session.ResumeCommand != testCase.want {
			t.Fatalf("unexpected %s resume command: %#v", testCase.agent, session)
		}
	}
}

func TestAiVaultCandidateSelectionReservesEachDiscoveredAgent(t *testing.T) {
	dir := t.TempDir()
	candidates := make([]aiVaultCandidate, 0, 32)
	for index := 0; index < 30; index++ {
		path := filepath.Join(dir, "claude-"+string(rune('a'+index))+".jsonl")
		if err := os.WriteFile(path, []byte("{}\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		stamp := time.Now().Add(time.Duration(-index) * time.Second)
		if err := os.Chtimes(path, stamp, stamp); err != nil {
			t.Fatal(err)
		}
		info, _ := os.Stat(path)
		candidates = append(candidates, aiVaultCandidate{agent: "claude", path: path, info: info})
	}
	for _, agent := range []string{"cursor", "gemini"} {
		path := filepath.Join(dir, agent+".jsonl")
		if err := os.WriteFile(path, []byte("{}\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		stamp := time.Now().Add(-time.Hour)
		if err := os.Chtimes(path, stamp, stamp); err != nil {
			t.Fatal(err)
		}
		info, _ := os.Stat(path)
		candidates = append(candidates, aiVaultCandidate{agent: agent, path: path, info: info})
	}
	sortAiVaultCandidates(candidates)
	selected := selectAiVaultCandidates(candidates, 10)
	agents := map[string]bool{}
	for _, candidate := range selected {
		agents[candidate.agent] = true
	}
	if !agents["claude"] || !agents["cursor"] || !agents["gemini"] {
		t.Fatalf("expected every discovered agent in bounded selection: %#v", selected)
	}
}

func TestNormalizeAiVaultTranscriptTextExtractsVisibleUserQuery(t *testing.T) {
	value := "<timestamp>Saturday, Jul 4, 2026</timestamp> <user_query> 我现在有多少额度 </user_query>"
	if got := compactAiVaultText(value, 96); got != "我现在有多少额度" {
		t.Fatalf("unexpected normalized transcript text: %q", got)
	}
}

func TestParseAiVaultOpenClawAndDroidStreams(t *testing.T) {
	dir := t.TempDir()
	testCases := []struct {
		agent   string
		content string
		wantID  string
		wantCmd string
	}{
		{
			agent: "openclaw",
			content: "{\"type\":\"session\",\"id\":\"openclaw-1\",\"cwd\":\"/work/openclaw\"}\n" +
				"{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":\"OpenClaw prompt\"}}\n" +
				"{\"type\":\"message\",\"message\":{\"role\":\"assistant\",\"content\":\"Done\",\"model\":\"claw-model\",\"usage\":{\"input\":2,\"output\":3}}}\n",
			wantID:  "openclaw-1",
			wantCmd: "cd '/work/openclaw' && openclaw --resume 'openclaw-1'",
		},
		{
			agent: "droid",
			content: "{\"type\":\"session_start\",\"id\":\"droid-1\",\"cwd\":\"/work/droid\"}\n" +
				"{\"type\":\"message\",\"session_id\":\"droid-1\",\"role\":\"user\",\"text\":\"Droid prompt\"}\n" +
				"{\"type\":\"completion\",\"session_id\":\"droid-1\",\"finalText\":\"Done\",\"usage\":{\"input\":2,\"output\":3}}\n",
			wantID:  "droid-1",
			wantCmd: "cd '/work/droid' && droid --resume 'droid-1'",
		},
	}
	for _, testCase := range testCases {
		path := filepath.Join(dir, testCase.agent+".jsonl")
		if err := os.WriteFile(path, []byte(testCase.content), 0o600); err != nil {
			t.Fatal(err)
		}
		info, _ := os.Stat(path)
		candidate := aiVaultCandidate{agent: testCase.agent, path: path, info: info}
		var session *AiVaultSession
		var err error
		if testCase.agent == "openclaw" {
			session, err = parseOpenClawAiVaultSession(candidate)
		} else {
			session, err = parseDroidAiVaultSession(candidate)
		}
		if err != nil || session.SessionID != testCase.wantID || session.ResumeCommand != testCase.wantCmd || session.MessageCount != 2 || session.TotalTokens != 5 {
			t.Fatalf("unexpected %s session: %#v, %v", testCase.agent, session, err)
		}
	}
}

func TestParseAiVaultDevinAndKimiStructuredSessions(t *testing.T) {
	dir := t.TempDir()
	devinPath := filepath.Join(dir, "devin.json")
	devinContent := `{"session_id":"devin-1","working_directory":"/work/devin","steps":[{"metadata":{"is_user_input":true,"created_at":"2026-07-12T10:00:00Z","input_tokens":2},"text":"Devin prompt"},{"role":"assistant","metadata":{"output_tokens":3},"text":"Done"}]}`
	if err := os.WriteFile(devinPath, []byte(devinContent), 0o600); err != nil {
		t.Fatal(err)
	}
	devinInfo, _ := os.Stat(devinPath)
	devin, err := parseAiVaultJSON(aiVaultCandidate{agent: "devin", path: devinPath, info: devinInfo})
	if err != nil || devin.ResumeCommand != "cd '/work/devin' && devin --resume 'devin-1'" || devin.TotalTokens != 5 {
		t.Fatalf("unexpected Devin session: %#v, %v", devin, err)
	}

	home := filepath.Join(dir, "kimi-home")
	sessionDir := filepath.Join(home, "sessions", "wd_repo_hash", "session_kimi-1")
	if err := os.MkdirAll(filepath.Join(sessionDir, "agents", "primary"), 0o700); err != nil {
		t.Fatal(err)
	}
	statePath := filepath.Join(sessionDir, "state.json")
	if err := os.WriteFile(statePath, []byte(`{"title":"Kimi title","agents":{"primary":{"type":"main"}}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "session_index.jsonl"), []byte("{\"sessionId\":\"session_kimi-1\",\"workDir\":\"/work/kimi\"}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	wire := "{\"type\":\"config.update\",\"modelAlias\":\"kimi-k2\"}\n" +
		"{\"type\":\"context.append_message\",\"message\":{\"role\":\"user\",\"origin\":{\"kind\":\"user\"},\"content\":\"Kimi prompt\"}}\n" +
		"{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"content.part\",\"part\":{\"type\":\"text\",\"text\":\"Ki\"}}}\n" +
		"{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"content.part\",\"part\":{\"type\":\"text\",\"text\":\"mi\"}}}\n" +
		"{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"step.end\"}}\n" +
		"{\"type\":\"usage.record\",\"usage\":{\"inputOther\":2,\"output\":3}}\n"
	if err := os.WriteFile(filepath.Join(sessionDir, "agents", "primary", "wire.jsonl"), []byte(wire), 0o600); err != nil {
		t.Fatal(err)
	}
	kimiInfo, _ := os.Stat(statePath)
	kimi, err := parseAiVaultJSON(aiVaultCandidate{agent: "kimi", path: statePath, info: kimiInfo})
	if err != nil || kimi.ResumeCommand != "cd '/work/kimi' && kimi --session 'session_kimi-1'" || kimi.MessageCount != 2 || kimi.TotalTokens != 5 {
		t.Fatalf("unexpected Kimi session: %#v, %v", kimi, err)
	}
}

func TestParseOpenCodeLegacyAndSQLiteSessions(t *testing.T) {
	dir := t.TempDir()
	storage := filepath.Join(dir, "storage")
	legacyDir := filepath.Join(storage, "session", "project-1")
	messageDir := filepath.Join(storage, "message", "legacy-1")
	if err := os.MkdirAll(legacyDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(messageDir, 0o700); err != nil {
		t.Fatal(err)
	}
	legacyPath := filepath.Join(legacyDir, "legacy-1.json")
	if err := os.WriteFile(legacyPath, []byte(`{"id":"legacy-1","directory":"/work/legacy","time":{"created":1777634000000,"updated":1777634001000}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(messageDir, "message-1.json"), []byte(`{"role":"user","content":"Legacy prompt","time":{"created":1777634000000},"tokens":{"input":2}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	legacyInfo, _ := os.Stat(legacyPath)
	legacy, err := parseOpenCodeLegacySession(aiVaultCandidate{agent: "opencode", path: legacyPath, info: legacyInfo})
	if err != nil || legacy.Title != "Legacy prompt" || legacy.ResumeCommand != "cd '/work/legacy' && opencode --session 'legacy-1'" {
		t.Fatalf("unexpected OpenCode legacy session: %#v, %v", legacy, err)
	}

	dbPath := filepath.Join(dir, "opencode.db")
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`
		CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT, title TEXT, model TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER, tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER);
		CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT);
		CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, time_created INTEGER, data TEXT);
		INSERT INTO session VALUES ('sqlite-1', NULL, '/work/sqlite', 'SQLite title', '{"id":"glm-5"}', 1777634000000, 1777634001000, NULL, 10, 5, 2);
		INSERT INTO session VALUES ('child-1', 'sqlite-1', '/work/sqlite', 'Child', NULL, 1777634000000, 1777634002000, NULL, 0, 0, 0);
		INSERT INTO message VALUES ('m1', 'sqlite-1', '{"role":"user"}');
		INSERT INTO message VALUES ('m2', 'sqlite-1', '{"role":"assistant"}');
		INSERT INTO part VALUES ('p1', 'm1', 1777634000000, '{"type":"text","text":"SQLite prompt"}');
		INSERT INTO part VALUES ('p2', 'm2', 1777634001000, '{"type":"text","text":"SQLite reply"}');
	`)
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	candidates, issues := discoverOpenCodeSQLiteCandidates(dir, 10)
	if len(issues) != 0 || len(candidates) != 1 {
		t.Fatalf("unexpected OpenCode SQLite discovery: %#v, %#v", candidates, issues)
	}
	sqliteSession, err := parseOpenCodeSQLiteSession(dbPath, "sqlite-1", candidates[0].info)
	if err != nil || sqliteSession.Model == nil || *sqliteSession.Model != "glm-5" || sqliteSession.MessageCount != 2 || sqliteSession.TotalTokens != 17 || sqliteSession.ResumeCommand != "cd '/work/sqlite' && opencode --session 'sqlite-1'" {
		t.Fatalf("unexpected OpenCode SQLite session: %#v, %v", sqliteSession, err)
	}
}

func TestAiVaultScopeIncludesNestedCwdAndRejectsSibling(t *testing.T) {
	scope := filepath.Join(string(filepath.Separator), "work", "pebble")
	nested := filepath.Join(scope, "packages", "desktop")
	sibling := filepath.Join(string(filepath.Separator), "work", "pebble-other")

	if !aiVaultSessionInScope(AiVaultSession{Cwd: &nested}, []string{scope}) {
		t.Fatal("expected nested cwd to be in scope")
	}
	if aiVaultSessionInScope(AiVaultSession{Cwd: &sibling}, []string{scope}) {
		t.Fatal("expected sibling cwd to remain out of scope")
	}
}

func TestAiVaultScopedSessionsBypassGlobalLimit(t *testing.T) {
	newer := "2026-07-13T10:00:00Z"
	older := "2026-07-12T10:00:00Z"
	global := AiVaultSession{ID: "global", SessionID: "global", UpdatedAt: &newer}
	scoped := AiVaultSession{ID: "scoped", SessionID: "scoped", UpdatedAt: &older}

	merged := mergeAiVaultSessionsWithoutLimit([]AiVaultSession{global}, []AiVaultSession{scoped})
	if len(merged) != 2 || merged[0].ID != "global" || merged[1].ID != "scoped" {
		t.Fatalf("unexpected scoped merge: %#v", merged)
	}
}
