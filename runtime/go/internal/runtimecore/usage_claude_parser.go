package runtimecore

import (
	"bufio"
	"encoding/json"
	"io"
	"strings"
)

type claudeUsageTurn struct {
	SessionID        string
	Timestamp        string
	Model            string
	Cwd              string
	GitBranch        string
	DedupeKey        string
	InputTokens      int64
	OutputTokens     int64
	CacheReadTokens  int64
	CacheWriteTokens int64
}

type claudeUsageSourceRecord struct {
	Type      string `json:"type"`
	SessionID string `json:"sessionId"`
	Timestamp string `json:"timestamp"`
	Cwd       string `json:"cwd"`
	GitBranch string `json:"gitBranch"`
	RequestID string `json:"requestId"`
	Message   struct {
		ID    string `json:"id"`
		Model string `json:"model"`
		Usage struct {
			InputTokens      int64 `json:"input_tokens"`
			OutputTokens     int64 `json:"output_tokens"`
			CacheReadTokens  int64 `json:"cache_read_input_tokens"`
			CacheWriteTokens int64 `json:"cache_creation_input_tokens"`
		} `json:"usage"`
	} `json:"message"`
}

func parseClaudeUsageLine(line, fallbackSessionID string) *claudeUsageTurn {
	var source claudeUsageSourceRecord
	if json.Unmarshal([]byte(line), &source) != nil || source.Type != "assistant" {
		return nil
	}
	sessionID := strings.TrimSpace(source.SessionID)
	if sessionID == "" {
		sessionID = strings.TrimSpace(fallbackSessionID)
	}
	if sessionID == "" || strings.TrimSpace(source.Timestamp) == "" {
		return nil
	}
	usage := source.Message.Usage
	if usage.InputTokens+usage.OutputTokens+usage.CacheReadTokens+usage.CacheWriteTokens <= 0 {
		return nil
	}
	dedupeKey := ""
	if source.Message.ID != "" && source.RequestID != "" {
		dedupeKey = source.Message.ID + ":" + source.RequestID
	}
	return &claudeUsageTurn{
		SessionID: sessionID, Timestamp: source.Timestamp, Model: source.Message.Model,
		Cwd: source.Cwd, GitBranch: source.GitBranch, DedupeKey: dedupeKey,
		InputTokens: usage.InputTokens, OutputTokens: usage.OutputTokens,
		CacheReadTokens: usage.CacheReadTokens, CacheWriteTokens: usage.CacheWriteTokens,
	}
}

func readClaudeUsageTurns(reader io.Reader, fallbackSessionID string) ([]claudeUsageTurn, error) {
	scanner := bufio.NewScanner(reader)
	// Claude tool payloads can make individual JSONL rows much larger than Scanner's default 64 KiB.
	scanner.Buffer(make([]byte, 64*1024), 16*1024*1024)
	turns := make([]claudeUsageTurn, 0)
	dedupe := make(map[string]int)
	for scanner.Scan() {
		turn := parseClaudeUsageLine(scanner.Text(), fallbackSessionID)
		if turn == nil {
			continue
		}
		if turn.DedupeKey != "" {
			if index, ok := dedupe[turn.DedupeKey]; ok {
				existing := &turns[index]
				existing.InputTokens = max(existing.InputTokens, turn.InputTokens)
				existing.OutputTokens = max(existing.OutputTokens, turn.OutputTokens)
				existing.CacheReadTokens = max(existing.CacheReadTokens, turn.CacheReadTokens)
				existing.CacheWriteTokens = max(existing.CacheWriteTokens, turn.CacheWriteTokens)
				continue
			}
		}
		turns = append(turns, *turn)
		if turn.DedupeKey != "" {
			dedupe[turn.DedupeKey] = len(turns) - 1
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	return turns, nil
}
