package runtimecore

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestAiVaultFirstUserPromptSurvivesThePreviewWindow(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "claude-long.jsonl")
	lines := []string{`{"sessionId":"claude-long","timestamp":"2026-07-12T10:00:00Z","type":"user","message":{"role":"user","content":"Port the updater readiness probe"}}`}
	for index := 0; index < 12; index++ {
		lines = append(lines, fmt.Sprintf(
			`{"sessionId":"claude-long","timestamp":"2026-07-12T10:%02d:00Z","type":"assistant","message":{"role":"assistant","content":"step %d"}}`,
			index+1, index))
	}
	session := parseFirstUserPromptFixture(t, path, strings.Join(lines, "\n")+"\n", "claude")

	if len(session.PreviewMessages) != 6 {
		t.Fatalf("expected the preview window to have slid, got %d messages", len(session.PreviewMessages))
	}
	if session.FirstUserPrompt == nil || *session.FirstUserPrompt != "Port the updater readiness probe" {
		t.Fatalf("unexpected first user prompt: %#v", session.FirstUserPrompt)
	}
}

func TestAiVaultFirstUserPromptIsNilWithoutAWrittenAsk(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "claude-agent-only.jsonl")
	transcript := `{"sessionId":"agent-only","timestamp":"2026-07-12T10:00:00Z","type":"assistant","message":{"role":"assistant","content":"Nothing was asked"}}
`
	session := parseFirstUserPromptFixture(t, path, transcript, "claude")

	if session.FirstUserPrompt != nil {
		t.Fatalf("expected no first user prompt, got %q", *session.FirstUserPrompt)
	}
}

func TestAiVaultFirstUserPromptSkipsHarnessInjectedTurns(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "claude-injected.jsonl")
	transcript := `{"sessionId":"injected","timestamp":"2026-07-12T10:00:00Z","type":"user","message":{"role":"user","content":"<system-reminder>context</system-reminder>"}}
{"sessionId":"injected","timestamp":"2026-07-12T10:01:00Z","type":"user","message":{"role":"user","content":"<command-name>/review</command-name>"}}
{"sessionId":"injected","timestamp":"2026-07-12T10:02:00Z","type":"user","message":{"role":"user","content":"Actually rename the pane"}}
`
	session := parseFirstUserPromptFixture(t, path, transcript, "claude")

	if session.FirstUserPrompt == nil || *session.FirstUserPrompt != "Actually rename the pane" {
		t.Fatalf("unexpected first user prompt: %#v", session.FirstUserPrompt)
	}
}

func TestAiVaultFirstUserPromptTruncatesAnOverlongAsk(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "claude-overlong.jsonl")
	ask := strings.Repeat("a", aiVaultFirstUserPromptLimit+500)
	transcript := fmt.Sprintf(
		`{"sessionId":"overlong","timestamp":"2026-07-12T10:00:00Z","type":"user","message":{"role":"user","content":%q}}`,
		ask) + "\n"
	session := parseFirstUserPromptFixture(t, path, transcript, "claude")

	if session.FirstUserPrompt == nil {
		t.Fatal("expected an over-long ask to still be captured")
	}
	if length := len([]rune(*session.FirstUserPrompt)); length > aiVaultFirstUserPromptLimit {
		t.Fatalf("expected the ask to be capped at %d runes, got %d", aiVaultFirstUserPromptLimit, length)
	}
}

func TestAiVaultFirstUserPromptKeepsASingleLineAskVerbatim(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "codex-single.jsonl")
	transcript := `{"timestamp":"2026-07-12T11:00:00Z","type":"session_meta","payload":{"id":"codex-single","cwd":"/work/pebble"}}
{"timestamp":"2026-07-12T11:01:00Z","type":"response_item","payload":{"role":"user","content":[{"type":"input_text","text":"Review this change"}]}}
`
	session := parseFirstUserPromptFixture(t, path, transcript, "codex")

	if session.FirstUserPrompt == nil || *session.FirstUserPrompt != "Review this change" {
		t.Fatalf("unexpected first user prompt: %#v", session.FirstUserPrompt)
	}
}

func parseFirstUserPromptFixture(t *testing.T, path, transcript, agent string) *AiVaultSession {
	t.Helper()
	if err := os.WriteFile(path, []byte(transcript), 0o600); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	session, err := parseAiVaultJSONL(aiVaultCandidate{agent: agent, path: path, info: info}, "/tmp/codex")
	if err != nil {
		t.Fatal(err)
	}
	if session == nil {
		t.Fatal("expected a parsed session")
	}
	return session
}
