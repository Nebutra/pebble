package runtimecore

import (
	"strings"
	"testing"
)

func TestCodexUsageParserUsesLastIncrementAndSkipsDuplicateTotals(t *testing.T) {
	lines := strings.Join([]string{
		`{"type":"session_meta","payload":{"id":"session-1","cwd":"/work/pebble"}}`,
		`{"type":"turn_context","payload":{"model":"gpt-5.4","cwd":"/work/pebble/src"}}`,
		`{"timestamp":"2026-01-01T00:00:00Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"cached_input_tokens":20,"output_tokens":10,"reasoning_output_tokens":3,"total_tokens":110},"last_token_usage":{"input_tokens":100,"cached_input_tokens":20,"output_tokens":10,"reasoning_output_tokens":3,"total_tokens":110}}}}`,
		`{"timestamp":"2026-01-01T00:01:00Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"cached_input_tokens":20,"output_tokens":10,"reasoning_output_tokens":3,"total_tokens":110},"last_token_usage":{"input_tokens":100,"cached_input_tokens":20,"output_tokens":10,"reasoning_output_tokens":3,"total_tokens":110}}}}`,
		`{"timestamp":"2026-01-01T00:02:00Z","type":"event_msg","payload":{"type":"token_count","info":null}}`,
	}, "\n")
	events, err := readCodexUsageEvents(strings.NewReader(lines), "fallback")
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 || events[0].SessionID != "session-1" || events[0].Model != "gpt-5.4" || events[0].CachedInputTokens != 20 || events[0].Cwd != "/work/pebble/src" {
		t.Fatalf("unexpected events: %#v", events)
	}
}

func TestCodexUsageParserTreatsNonMonotonicTotalAsNewBaseline(t *testing.T) {
	state := codexUsageContext{SessionID: "session"}
	first := parseCodexUsageLine(`{"timestamp":"2026-01-01T00:00:00Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"output_tokens":20}}}}`, &state)
	reset := parseCodexUsageLine(`{"timestamp":"2026-01-01T00:01:00Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":10,"output_tokens":2}}}}`, &state)
	if first == nil || reset != nil || state.Previous == nil || state.Previous.Input != 10 {
		t.Fatalf("baseline reset drifted: first=%#v reset=%#v state=%#v", first, reset, state)
	}
}
