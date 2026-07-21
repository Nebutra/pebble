package runtimecore

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"time"
)

type openCodeUsageEvent struct {
	SessionID             string   `json:"sessionId"`
	Timestamp             string   `json:"timestamp"`
	Cwd                   string   `json:"cwd,omitempty"`
	Model                 string   `json:"model,omitempty"`
	EstimatedCostUSD      *float64 `json:"estimatedCostUsd"`
	InputTokens           int64    `json:"inputTokens"`
	CachedInputTokens     int64    `json:"cachedInputTokens"`
	OutputTokens          int64    `json:"outputTokens"`
	ReasoningOutputTokens int64    `json:"reasoningOutputTokens"`
	TotalTokens           int64    `json:"totalTokens"`
}

type openCodeSessionMetadata struct {
	directory string
	worktree  string
	model     string
}

func readOpenCodeUsageEvents(database *sql.DB) ([]openCodeUsageEvent, error) {
	sessionColumns, err := sqliteTableColumns(database, "session")
	if err != nil || len(sessionColumns) == 0 {
		return nil, err
	}
	metadata, err := readOpenCodeSessionMetadata(database, sessionColumns)
	if err != nil {
		return nil, err
	}
	if hasOpenCodeSessionTotals(sessionColumns) {
		events, totalsErr := readOpenCodeSessionTotals(database, sessionColumns, metadata)
		if totalsErr != nil || len(events) > 0 {
			return events, totalsErr
		}
	}
	if columns, _ := sqliteTableColumns(database, "session_message"); len(columns) > 0 {
		events, messageErr := readOpenCodeMessageTable(database, "session_message", columns, metadata, true)
		if messageErr != nil || len(events) > 0 {
			return events, messageErr
		}
	}
	columns, _ := sqliteTableColumns(database, "message")
	return readOpenCodeMessageTable(database, "message", columns, metadata, false)
}

func readOpenCodeSessionMetadata(database *sql.DB, columns map[string]bool) (map[string]openCodeSessionMetadata, error) {
	directory := openCodeColumnExpression(columns, "directory", "''")
	model := openCodeColumnExpression(columns, "model", "''")
	projectID := openCodeColumnExpression(columns, "project_id", "''")
	rows, err := database.Query("SELECT id, " + directory + ", " + model + ", " + projectID + " FROM session")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	projects, _ := readOpenCodeProjectWorktrees(database)
	result := make(map[string]openCodeSessionMetadata)
	for rows.Next() {
		var id, directoryValue, modelValue, project string
		if err := rows.Scan(&id, &directoryValue, &modelValue, &project); err != nil {
			return nil, err
		}
		result[id] = openCodeSessionMetadata{directory: directoryValue, worktree: projects[project], model: modelValue}
	}
	return result, rows.Err()
}

func readOpenCodeProjectWorktrees(database *sql.DB) (map[string]string, error) {
	columns, err := sqliteTableColumns(database, "project")
	if err != nil || !columns["id"] || !columns["worktree"] {
		return map[string]string{}, err
	}
	rows, err := database.Query("SELECT id, COALESCE(worktree, '') FROM project")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make(map[string]string)
	for rows.Next() {
		var id, worktree string
		if err := rows.Scan(&id, &worktree); err != nil {
			return nil, err
		}
		result[id] = worktree
	}
	return result, rows.Err()
}

func hasOpenCodeSessionTotals(columns map[string]bool) bool {
	for _, column := range []string{"cost", "tokens_input", "tokens_output", "tokens_reasoning", "tokens_cache_read"} {
		if !columns[column] {
			return false
		}
	}
	return true
}

func readOpenCodeSessionTotals(database *sql.DB, columns map[string]bool, metadata map[string]openCodeSessionMetadata) ([]openCodeUsageEvent, error) {
	created := openCodeColumnExpression(columns, "time_created", "0")
	updated := openCodeColumnExpression(columns, "time_updated", "0")
	rows, err := database.Query(fmt.Sprintf(`SELECT id, %s, %s, COALESCE(cost, 0), COALESCE(tokens_input, 0), COALESCE(tokens_output, 0), COALESCE(tokens_reasoning, 0), COALESCE(tokens_cache_read, 0) FROM session WHERE COALESCE(tokens_input, 0) + COALESCE(tokens_output, 0) + COALESCE(tokens_reasoning, 0) + COALESCE(tokens_cache_read, 0) > 0 ORDER BY %s, id`, created, updated, created))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]openCodeUsageEvent, 0)
	for rows.Next() {
		var id string
		var createdValue, updatedValue, cost float64
		var input, output, reasoning, cached int64
		if err := rows.Scan(&id, &createdValue, &updatedValue, &cost, &input, &output, &reasoning, &cached); err != nil {
			return nil, err
		}
		meta := metadata[id]
		model := openCodeModelLabel(map[string]interface{}{}, meta.model)
		result = append(result, buildOpenCodeUsageEvent(id, updatedValue, createdValue, meta, model, cost, input, output, reasoning, cached))
	}
	return result, rows.Err()
}

func readOpenCodeMessageTable(database *sql.DB, table string, columns map[string]bool, metadata map[string]openCodeSessionMetadata, sessionMessage bool) ([]openCodeUsageEvent, error) {
	if !columns["session_id"] || !columns["data"] {
		return []openCodeUsageEvent{}, nil
	}
	created := openCodeColumnExpression(columns, "time_created", "0")
	updated := openCodeColumnExpression(columns, "time_updated", "0")
	messageType := openCodeColumnExpression(columns, "type", "''")
	rows, err := database.Query(fmt.Sprintf("SELECT session_id, %s, %s, data, %s FROM %s ORDER BY %s", created, updated, messageType, table, created))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]openCodeUsageEvent, 0)
	for rows.Next() {
		var sessionID, data, rowType string
		var createdValue, updatedValue float64
		if err := rows.Scan(&sessionID, &createdValue, &updatedValue, &data, &rowType); err != nil {
			return nil, err
		}
		var payload map[string]interface{}
		if json.Unmarshal([]byte(data), &payload) != nil {
			continue
		}
		if !sessionMessage && stringValue(payload["role"]) != "assistant" {
			continue
		}
		if sessionMessage && columns["type"] && rowType != "assistant" {
			continue
		}
		tokens := openCodeObjectValue(payload["tokens"])
		if tokens == nil {
			continue
		}
		cache := openCodeObjectValue(tokens["cache"])
		input := int64Value(tokens["input"])
		output := int64Value(tokens["output"])
		reasoning := int64Value(tokens["reasoning"])
		cached := min(int64Value(cache["read"]), input)
		total := int64Value(tokens["total"])
		if total <= 0 {
			total = input + output + reasoning
		}
		if input+output+reasoning+cached+total <= 0 {
			continue
		}
		meta := metadata[sessionID]
		if pathPayload := openCodeObjectValue(payload["path"]); pathPayload != nil {
			if cwd := stringValue(pathPayload["cwd"]); cwd != "" {
				meta.directory = cwd
			}
		}
		model := openCodeModelLabel(payload, meta.model)
		cost := float64Value(payload["cost"])
		event := buildOpenCodeUsageEvent(sessionID, openCodePayloadTimestamp(payload, updatedValue), createdValue, meta, model, cost, input, output, reasoning, cached)
		event.TotalTokens = total
		result = append(result, event)
	}
	return result, rows.Err()
}

func buildOpenCodeUsageEvent(sessionID string, preferredMillis, fallbackMillis float64, metadata openCodeSessionMetadata, model string, cost float64, input, output, reasoning, cached int64) openCodeUsageEvent {
	millis := preferredMillis
	if millis <= 0 {
		millis = fallbackMillis
	}
	if millis < 10_000_000_000 {
		millis *= 1000
	}
	cwd := metadata.directory
	if cwd == "" {
		cwd = metadata.worktree
	}
	var estimated *float64
	if cost > 0 {
		estimated = &cost
	}
	return openCodeUsageEvent{SessionID: sessionID, Timestamp: time.UnixMilli(int64(millis)).UTC().Format(time.RFC3339Nano), Cwd: cwd, Model: model, EstimatedCostUSD: estimated, InputTokens: input, CachedInputTokens: min(cached, input), OutputTokens: output, ReasoningOutputTokens: reasoning, TotalTokens: input + output + reasoning}
}

func openCodeColumnExpression(columns map[string]bool, column, fallback string) string {
	if columns[column] {
		return "COALESCE(" + column + ", " + fallback + ")"
	}
	return fallback
}

func openCodePayloadTimestamp(payload map[string]interface{}, fallback float64) float64 {
	timePayload := openCodeObjectValue(payload["time"])
	if completed := float64Value(timePayload["completed"]); completed > 0 {
		return completed
	}
	if created := float64Value(timePayload["created"]); created > 0 {
		return created
	}
	return fallback
}

func openCodeModelLabel(payload map[string]interface{}, sessionModel string) string {
	modelID := firstOpenCodeString(payload["modelID"], payload["modelId"])
	providerID := firstOpenCodeString(payload["providerID"], payload["providerId"])
	if modelID != "" {
		if providerID != "" {
			return providerID + "/" + modelID
		}
		return modelID
	}
	model := openCodeObjectValue(payload["model"])
	if model == nil && sessionModel != "" {
		_ = json.Unmarshal([]byte(sessionModel), &model)
	}
	modelID = firstOpenCodeString(model["modelID"], model["id"])
	providerID = stringValue(model["providerID"])
	if providerID != "" && modelID != "" {
		return providerID + "/" + modelID
	}
	return modelID
}

func openCodeObjectValue(value interface{}) map[string]interface{} {
	object, _ := value.(map[string]interface{})
	return object
}

func firstOpenCodeString(values ...interface{}) string {
	for _, value := range values {
		if text := stringValue(value); text != "" {
			return text
		}
	}
	return ""
}

func float64Value(value interface{}) float64 {
	switch typed := value.(type) {
	case float64:
		if !math.IsNaN(typed) && !math.IsInf(typed, 0) {
			return typed
		}
	case json.Number:
		result, _ := typed.Float64()
		return result
	case string:
		result, _ := strconv.ParseFloat(typed, 64)
		return result
	}
	return 0
}

func int64Value(value interface{}) int64 {
	return int64(float64Value(value))
}
