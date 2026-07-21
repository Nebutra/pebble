package runtimecore

import (
	"bufio"
	"encoding/json"
	"io"
	"strings"
)

type codexRawUsage struct{ Input, Cached, Output, Reasoning, Total int64 }
type codexUsageContext struct {
	SessionID, SessionCwd, CurrentCwd, CurrentModel string
	Previous                                        *codexRawUsage
	BaselinePending                                 bool
}
type codexUsageEvent struct {
	SessionID, Timestamp, Cwd, Model                                                 string
	HasInferredPricing                                                               bool
	InputTokens, CachedInputTokens, OutputTokens, ReasoningOutputTokens, TotalTokens int64
}

func parseCodexUsageLine(line string, state *codexUsageContext) *codexUsageEvent {
	var source struct {
		Timestamp, Type string
		Payload         map[string]interface{}
	}
	if json.Unmarshal([]byte(line), &source) != nil || source.Payload == nil {
		return nil
	}
	switch source.Type {
	case "session_meta":
		if value := codexString(source.Payload["id"]); value != "" {
			state.SessionID = value
		}
		state.SessionCwd = codexString(source.Payload["cwd"])
		if state.CurrentCwd == "" {
			state.CurrentCwd = state.SessionCwd
		}
		return nil
	case "turn_context":
		if value := codexString(source.Payload["cwd"]); value != "" {
			state.CurrentCwd = value
		}
		if value := codexModel(source.Payload); value != "" {
			state.CurrentModel = value
		}
		return nil
	case "event_msg":
		if codexString(source.Payload["type"]) != "token_count" || source.Timestamp == "" {
			return nil
		}
	default:
		return nil
	}
	info, ok := source.Payload["info"].(map[string]interface{})
	if !ok {
		return nil
	}
	total := normalizeCodexRawUsage(info["total_token_usage"])
	last := normalizeCodexRawUsage(info["last_token_usage"])
	if state.BaselinePending {
		state.BaselinePending = false
		if total != nil && last == nil && state.Previous == nil {
			state.Previous = total
			return nil
		}
	}
	delta, next, event := resolveCodexUsageDelta(total, last, state.Previous)
	state.Previous = next
	if !event || delta == nil {
		return nil
	}
	if delta.Cached > delta.Input {
		delta.Cached = delta.Input
	}
	if delta.Input+delta.Cached+delta.Output+delta.Reasoning+delta.Total == 0 {
		return nil
	}
	model := codexModel(source.Payload)
	if model == "" {
		model = state.CurrentModel
	}
	return &codexUsageEvent{SessionID: state.SessionID, Timestamp: source.Timestamp, Cwd: firstNonempty(state.CurrentCwd, state.SessionCwd), Model: model, HasInferredPricing: model == "", InputTokens: delta.Input, CachedInputTokens: delta.Cached, OutputTokens: delta.Output, ReasoningOutputTokens: delta.Reasoning, TotalTokens: delta.Total}
}

func readCodexUsageEvents(reader io.Reader, fallbackSessionID string) ([]codexUsageEvent, error) {
	state := codexUsageContext{SessionID: fallbackSessionID}
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 64*1024), 16*1024*1024)
	events := []codexUsageEvent{}
	for scanner.Scan() {
		if event := parseCodexUsageLine(scanner.Text(), &state); event != nil {
			events = append(events, *event)
		}
	}
	return events, scanner.Err()
}

func normalizeCodexRawUsage(value interface{}) *codexRawUsage {
	record, ok := value.(map[string]interface{})
	if !ok {
		return nil
	}
	result := &codexRawUsage{Input: codexNumber(record["input_tokens"]), Cached: codexNumber(firstValue(record["cached_input_tokens"], record["cache_read_input_tokens"])), Output: codexNumber(record["output_tokens"]), Reasoning: codexNumber(record["reasoning_output_tokens"]), Total: codexNumber(record["total_tokens"])}
	if result.Total <= 0 {
		result.Total = result.Input + result.Output
	}
	return result
}
func resolveCodexUsageDelta(total, last, previous *codexRawUsage) (*codexRawUsage, *codexRawUsage, bool) {
	if total != nil && last != nil && previous != nil {
		if codexUsageEqual(total, previous) || (!codexUsageMonotonic(total, previous) && codexStaleRegression(total, previous, last)) {
			return nil, previous, false
		}
		return last, total, true
	}
	if total != nil && last != nil {
		return last, total, true
	}
	if total != nil && previous != nil {
		if codexUsageEqual(total, previous) {
			return nil, previous, false
		}
		if !codexUsageMonotonic(total, previous) {
			return nil, total, false
		}
		return codexUsageSubtract(total, previous), total, true
	}
	if total != nil {
		return total, total, true
	}
	if last != nil && previous != nil {
		return last, codexUsageAdd(previous, last), true
	}
	if last != nil {
		return last, nil, true
	}
	return nil, previous, false
}
func codexUsageSubtract(a, b *codexRawUsage) *codexRawUsage {
	return &codexRawUsage{Input: max(a.Input-b.Input, 0), Cached: max(a.Cached-b.Cached, 0), Output: max(a.Output-b.Output, 0), Reasoning: max(a.Reasoning-b.Reasoning, 0), Total: max(a.Total-b.Total, 0)}
}
func codexUsageAdd(a, b *codexRawUsage) *codexRawUsage {
	return &codexRawUsage{Input: a.Input + b.Input, Cached: a.Cached + b.Cached, Output: a.Output + b.Output, Reasoning: a.Reasoning + b.Reasoning, Total: a.Total + b.Total}
}
func codexUsageEqual(a, b *codexRawUsage) bool {
	return a.Input == b.Input && a.Cached == b.Cached && a.Output == b.Output && a.Reasoning == b.Reasoning
}
func codexUsageMonotonic(a, b *codexRawUsage) bool {
	return a.Input >= b.Input && a.Cached >= b.Cached && a.Output >= b.Output && a.Reasoning >= b.Reasoning
}
func codexMagnitude(a *codexRawUsage) int64 { return a.Input + a.Cached + a.Output + a.Reasoning }
func codexStaleRegression(current, previous, last *codexRawUsage) bool {
	p, c, l := codexMagnitude(previous), codexMagnitude(current), codexMagnitude(last)
	return p > 0 && c > 0 && l > 0 && (c*100 >= p*98 || c+l*2 >= p)
}
func codexString(value interface{}) string { text, _ := value.(string); return strings.TrimSpace(text) }
func codexNumber(value interface{}) int64 {
	number, _ := value.(float64)
	if number < 0 {
		return 0
	}
	return int64(number)
}
func firstValue(values ...interface{}) interface{} {
	for _, value := range values {
		if value != nil {
			return value
		}
	}
	return nil
}
func firstNonempty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}
func codexModel(value interface{}) string {
	record, ok := value.(map[string]interface{})
	if !ok {
		return ""
	}
	for _, key := range []string{"model", "model_name"} {
		if text := codexString(record[key]); text != "" {
			return text
		}
	}
	for _, key := range []string{"info", "metadata"} {
		if nested, ok := record[key].(map[string]interface{}); ok {
			if model := codexModel(nested); model != "" {
				return model
			}
		}
	}
	return ""
}
