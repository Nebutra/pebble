package main

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

type externalAutomationRunRef struct {
	id         string
	runAt      string
	runKey     string
	outputPath string
	sessionID  string
}

func externalAutomationOutputRefs(home, jobID string) ([]externalAutomationRunRef, error) {
	directory := filepath.Join(home, "cron", "output", jobID)
	entries, err := os.ReadDir(directory)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	pattern := regexp.MustCompile(`^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})\.md$`)
	refs := make([]externalAutomationRunRef, 0, len(entries))
	for _, entry := range entries {
		captures := pattern.FindStringSubmatch(entry.Name())
		if entry.IsDir() || captures == nil {
			continue
		}
		refs = append(refs, externalAutomationRunRef{
			id:         jobID + ":" + entry.Name(),
			runAt:      fmt.Sprintf("%s-%s-%sT%s:%s:%s", captures[1], captures[2], captures[3], captures[4], captures[5], captures[6]),
			runKey:     fmt.Sprintf("%s%s%s_%s%s%s", captures[1], captures[2], captures[3], captures[4], captures[5], captures[6]),
			outputPath: filepath.Join(directory, entry.Name()),
		})
	}
	return refs, nil
}

func externalAutomationSessionRefs(home, jobID string) []externalAutomationRunRef {
	database, err := sql.Open("sqlite", "file:"+filepath.ToSlash(filepath.Join(home, "state.db"))+"?mode=ro")
	if err != nil {
		return nil
	}
	defer database.Close()
	rows, err := database.Query(`SELECT id, started_at FROM sessions WHERE id LIKE ? ESCAPE '\' ORDER BY started_at DESC`, "cron\\_"+escapeExternalAutomationLike(jobID)+"\\_%")
	if err != nil {
		return nil
	}
	defer rows.Close()
	refs := []externalAutomationRunRef{}
	for rows.Next() {
		var id string
		var startedAt sql.NullFloat64
		if rows.Scan(&id, &startedAt) != nil {
			continue
		}
		runAt := ""
		if startedAt.Valid {
			runAt = time.Unix(int64(startedAt.Float64), 0).UTC().Format(time.RFC3339)
		}
		refs = append(refs, externalAutomationRunRef{id: id, runAt: runAt, runKey: strings.TrimPrefix(id, "cron_"+jobID+"_"), sessionID: id})
	}
	return refs
}

func mergeExternalAutomationSessionRefs(outputs, sessions []externalAutomationRunRef) []externalAutomationRunRef {
	for _, session := range sessions {
		match := -1
		bestGap := 24*time.Hour + 1
		for index := range outputs {
			if outputs[index].runKey == session.runKey {
				match = index
				break
			}
			outputTime, outputError := time.Parse("20060102_150405", outputs[index].runKey)
			sessionTime, sessionError := time.Parse("20060102_150405", session.runKey)
			gap := outputTime.Sub(sessionTime)
			if outputError == nil && sessionError == nil && gap >= 0 && gap <= 24*time.Hour && gap < bestGap {
				match, bestGap = index, gap
			}
		}
		if match >= 0 {
			outputs[match].sessionID = session.sessionID
		} else {
			outputs = append(outputs, session)
		}
	}
	return outputs
}

func hydrateExternalAutomationSession(home, jobID string, ref externalAutomationRunRef) map[string]any {
	run := map[string]any{"id": ref.id, "job_id": jobID, "run_at": ref.runAt, "run_key": ref.runKey, "output_path": ref.outputPath}
	if ref.sessionID == "" {
		return run
	}
	database, err := sql.Open("sqlite", "file:"+filepath.ToSlash(filepath.Join(home, "state.db"))+"?mode=ro")
	if err != nil {
		return run
	}
	defer database.Close()
	var startedAt, endedAt sql.NullFloat64
	var title, model sql.NullString
	if database.QueryRow(`SELECT started_at, ended_at, title, model FROM sessions WHERE id = ?`, ref.sessionID).Scan(&startedAt, &endedAt, &title, &model) != nil {
		return run
	}
	rows, err := database.Query(`SELECT role, content, tool_name, reasoning, reasoning_content FROM messages WHERE session_id = ? ORDER BY timestamp, id`, ref.sessionID)
	if err != nil {
		return run
	}
	defer rows.Close()
	messages := []string{}
	for rows.Next() {
		var role, content, tool, reasoning, reasoningContent sql.NullString
		if rows.Scan(&role, &content, &tool, &reasoning, &reasoningContent) != nil {
			continue
		}
		heading := role.String
		if heading == "" {
			heading = "message"
		}
		if tool.String != "" {
			heading += " / " + tool.String
		}
		thought := reasoningContent.String
		if thought == "" {
			thought = reasoning.String
		}
		body := content.String
		if body == "" {
			body = "(empty)"
		}
		if thought != "" {
			body = "### Reasoning\n\n" + thought + "\n\n" + body
		}
		messages = append(messages, "## "+heading+"\n\n"+body)
	}
	preview := strings.Join(filterExternalAutomationStrings([]string{title.String, prefixedExternalAutomationValue("Model: ", model.String)}), " · ")
	run["status"], run["output_preview"], run["output_content"] = map[bool]string{true: "completed", false: "unknown"}[endedAt.Valid], preview, strings.Join(messages, "\n\n---\n\n")
	run["output_path"] = filepath.Join(home, "state.db")
	return run
}

func escapeExternalAutomationLike(value string) string {
	return strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(value)
}

func prefixedExternalAutomationValue(prefix, value string) string {
	if strings.TrimSpace(value) == "" {
		return ""
	}
	return prefix + value
}

func filterExternalAutomationStrings(values []string) []string {
	filtered := values[:0]
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			filtered = append(filtered, value)
		}
	}
	return filtered
}
