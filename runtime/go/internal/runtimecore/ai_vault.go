package runtimecore

import (
	"bufio"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

type AiVaultListRequest struct {
	Limit              int      `json:"limit,omitempty"`
	ExecutionHostScope string   `json:"executionHostScope,omitempty"`
	ScopePaths         []string `json:"scopePaths,omitempty"`
}

type AiVaultPreviewMessage struct {
	Role      string  `json:"role"`
	Text      string  `json:"text"`
	Timestamp *string `json:"timestamp"`
}

type AiVaultSession struct {
	ID                    string                  `json:"id"`
	ExecutionHostID       string                  `json:"executionHostId"`
	ExecutionHostPlatform string                  `json:"executionHostPlatform,omitempty"`
	Agent                 string                  `json:"agent"`
	SessionID             string                  `json:"sessionId"`
	Title                 string                  `json:"title"`
	Cwd                   *string                 `json:"cwd"`
	Branch                *string                 `json:"branch"`
	Model                 *string                 `json:"model"`
	FilePath              string                  `json:"filePath"`
	CodexHome             *string                 `json:"codexHome"`
	CreatedAt             *string                 `json:"createdAt"`
	UpdatedAt             *string                 `json:"updatedAt"`
	ModifiedAt            string                  `json:"modifiedAt"`
	MessageCount          int                     `json:"messageCount"`
	TotalTokens           int                     `json:"totalTokens"`
	PreviewMessages       []AiVaultPreviewMessage `json:"previewMessages"`
	ResumeCommand         string                  `json:"resumeCommand"`
}

type AiVaultScanIssue struct {
	ExecutionHostID string `json:"executionHostId"`
	Agent           string `json:"agent"`
	Path            string `json:"path"`
	Message         string `json:"message"`
}

type AiVaultListResult struct {
	Sessions  []AiVaultSession   `json:"sessions"`
	Issues    []AiVaultScanIssue `json:"issues"`
	ScannedAt string             `json:"scannedAt"`
}

type aiVaultCandidate struct {
	agent string
	path  string
	info  os.FileInfo
}

type aiVaultSyntheticFileInfo struct {
	name    string
	size    int64
	modTime time.Time
}

func (i aiVaultSyntheticFileInfo) Name() string       { return i.name }
func (i aiVaultSyntheticFileInfo) Size() int64        { return i.size }
func (i aiVaultSyntheticFileInfo) Mode() os.FileMode  { return 0o400 }
func (i aiVaultSyntheticFileInfo) ModTime() time.Time { return i.modTime }
func (i aiVaultSyntheticFileInfo) IsDir() bool        { return false }
func (i aiVaultSyntheticFileInfo) Sys() any           { return nil }

type aiVaultRoot struct {
	agent      string
	path       string
	extensions []string
	fileMatch  func(string) bool
}

type aiVaultDiscoveryIssue struct {
	path    string
	message string
}

const aiVaultScopeParseLimit = 2000

func (m *Manager) ListAiVaultSessions(req AiVaultListRequest) AiVaultListResult {
	return ScanLocalAiVaultSessions(req)
}

func (m *Manager) ListAiVaultSessionsByScope(ctx context.Context, req AiVaultListRequest) AiVaultListResult {
	scope := strings.TrimSpace(req.ExecutionHostScope)
	if scope == "" || scope == "local" {
		return ScanLocalAiVaultSessions(req)
	}
	if scope == "all" {
		results := []AiVaultListResult{ScanLocalAiVaultSessions(req)}
		targets := m.ListSshTargets()
		type indexedResult struct {
			index  int
			result AiVaultListResult
		}
		channel := make(chan indexedResult, len(targets))
		for index, target := range targets {
			go func(index int, targetID string) {
				channel <- indexedResult{index: index, result: m.scanSshAiVaultSessions(ctx, targetID, req)}
			}(index, target.ID)
		}
		remote := make([]AiVaultListResult, len(targets))
		for range targets {
			item := <-channel
			remote[item.index] = item.result
		}
		return mergeAiVaultResults(append(results, remote...), req.Limit)
	}
	if strings.HasPrefix(scope, "ssh:") {
		targetID, err := url.PathUnescape(strings.TrimPrefix(scope, "ssh:"))
		if err == nil && targetID != "" {
			return m.scanSshAiVaultSessions(ctx, targetID, req)
		}
	}
	return AiVaultListResult{Sessions: []AiVaultSession{}, Issues: []AiVaultScanIssue{{ExecutionHostID: scope, Agent: "codex", Path: scope, Message: "Agent Session History is not available for this execution host."}}, ScannedAt: time.Now().UTC().Format(time.RFC3339Nano)}
}

func ScanLocalAiVaultSessions(req AiVaultListRequest) AiVaultListResult {
	limit := req.Limit
	if limit <= 0 || limit > 2000 {
		limit = 1000
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return AiVaultListResult{Sessions: []AiVaultSession{}, Issues: []AiVaultScanIssue{{ExecutionHostID: "local", Agent: "codex", Path: "~", Message: err.Error()}}, ScannedAt: time.Now().UTC().Format(time.RFC3339Nano)}
	}
	codexHome := strings.TrimSpace(os.Getenv("CODEX_HOME"))
	if codexHome == "" {
		codexHome = filepath.Join(home, ".codex")
	}
	copilotHome := strings.TrimSpace(os.Getenv("COPILOT_HOME"))
	if copilotHome == "" {
		copilotHome = filepath.Join(home, ".copilot")
	}
	piHome := strings.TrimSpace(os.Getenv("PI_CODING_AGENT_DIR"))
	if piHome == "" {
		piHome = filepath.Join(home, ".pi", "agent", "sessions")
	}
	opencodeDataDir := envHomeOrDefault("OPENCODE_CONFIG_DIR", filepath.Join(home, ".local", "share", "opencode"))
	roots := []aiVaultRoot{
		{agent: "claude", path: filepath.Join(home, ".claude", "projects"), extensions: []string{".jsonl"}},
		{agent: "codex", path: filepath.Join(codexHome, "sessions"), extensions: []string{".jsonl"}},
		{agent: "copilot", path: filepath.Join(copilotHome, "session-state"), extensions: []string{".jsonl"}},
		{
			agent:      "cursor",
			path:       filepath.Join(home, ".cursor", "projects"),
			extensions: []string{".jsonl"},
			fileMatch: func(path string) bool {
				return pathContainsSegment(path, "agent-transcripts")
			},
		},
		{agent: "pi", path: piHome, extensions: []string{".jsonl"}},
		{agent: "gemini", path: filepath.Join(home, ".gemini", "tmp"), extensions: []string{".json", ".jsonl"}},
		{
			agent:      "hermes",
			path:       filepath.Join(home, ".hermes", "sessions"),
			extensions: []string{".json"},
			fileMatch:  func(path string) bool { return strings.HasPrefix(filepath.Base(path), "session_") },
		},
		{
			agent:      "rovo",
			path:       filepath.Join(home, ".rovodev", "sessions"),
			extensions: []string{".json"},
			fileMatch:  func(path string) bool { return filepath.Base(path) == "metadata.json" },
		},
		{
			agent:      "grok",
			path:       filepath.Join(envHomeOrDefault("GROK_HOME", filepath.Join(home, ".grok")), "sessions"),
			extensions: []string{".json"},
			fileMatch:  func(path string) bool { return filepath.Base(path) == "summary.json" },
		},
		{
			agent:      "openclaw",
			path:       filepath.Join(envHomeOrDefault("OPENCLAW_STATE_DIR", filepath.Join(home, ".openclaw")), "agents"),
			extensions: []string{".jsonl"},
			fileMatch:  func(path string) bool { return pathContainsSegment(path, "sessions") },
		},
		{
			agent:      "openclaw",
			path:       filepath.Join(home, ".clawdbot", "agents"),
			extensions: []string{".jsonl"},
			fileMatch:  func(path string) bool { return pathContainsSegment(path, "sessions") },
		},
		{
			agent:      "devin",
			path:       filepath.Join(envHomeOrDefault("DEVIN_HOME", filepath.Join(home, ".local", "share", "devin", "cli")), "transcripts"),
			extensions: []string{".json"},
		},
		{agent: "droid", path: filepath.Join(home, ".factory", "sessions"), extensions: []string{".jsonl"}},
		{agent: "droid", path: filepath.Join(home, ".factory", "projects"), extensions: []string{".jsonl"}},
		{
			agent:      "kimi",
			path:       filepath.Join(envHomeOrDefault("KIMI_CODE_HOME", filepath.Join(home, ".kimi-code")), "sessions"),
			extensions: []string{".json"},
			fileMatch: func(path string) bool {
				return filepath.Base(path) == "state.json" && strings.HasPrefix(filepath.Base(filepath.Dir(path)), "session_")
			},
		},
		{agent: "opencode", path: filepath.Join(opencodeDataDir, "storage", "session"), extensions: []string{".json"}},
	}
	discoveryLimit := limit
	if len(normalizeAiVaultScopePaths(req.ScopePaths)) > 0 {
		discoveryLimit += aiVaultScopeParseLimit
	}
	candidates := make([]aiVaultCandidate, 0, discoveryLimit*2)
	issues := make([]AiVaultScanIssue, 0)
	for _, root := range roots {
		found, discoveryIssues := discoverAiVaultFiles(root, discoveryLimit)
		for _, issue := range discoveryIssues {
			issues = append(issues, AiVaultScanIssue{
				ExecutionHostID: "local",
				Agent:           root.agent,
				Path:            issue.path,
				Message:         issue.message,
			})
		}
		candidates = append(candidates, found...)
	}
	sqliteCandidates, sqliteIssues := discoverOpenCodeSQLiteCandidates(opencodeDataDir, discoveryLimit)
	candidates = append(candidates, sqliteCandidates...)
	issues = append(issues, sqliteIssues...)
	candidates = dedupeOpenCodeCandidates(candidates)
	sortAiVaultCandidates(candidates)
	selectedCandidates := selectAiVaultCandidates(candidates, limit)
	sessions := make([]AiVaultSession, 0, len(selectedCandidates))
	parsedPaths := make(map[string]struct{}, len(selectedCandidates))
	for _, candidate := range selectedCandidates {
		if len(sessions) >= limit {
			break
		}
		session, err := parseAiVaultCandidate(candidate, codexHome)
		if err != nil {
			issues = append(issues, AiVaultScanIssue{ExecutionHostID: "local", Agent: candidate.agent, Path: candidate.path, Message: err.Error()})
			continue
		}
		if session != nil {
			sessions = append(sessions, *session)
		}
		parsedPaths[candidate.path] = struct{}{}
	}
	scopedSessions, scopedIssues := scanScopedAiVaultCandidates(
		candidates,
		parsedPaths,
		normalizeAiVaultScopePaths(req.ScopePaths),
		codexHome,
	)
	sessions = mergeAiVaultSessionsWithoutLimit(sessions, scopedSessions)
	issues = append(issues, scopedIssues...)
	result := AiVaultListResult{Sessions: sessions, Issues: issues, ScannedAt: time.Now().UTC().Format(time.RFC3339Nano)}
	RewriteAiVaultExecutionHost(&result, "local", runtime.GOOS)
	return result
}

func scanScopedAiVaultCandidates(candidates []aiVaultCandidate, parsedPaths map[string]struct{}, scopePaths []string, codexHome string) ([]AiVaultSession, []AiVaultScanIssue) {
	if len(scopePaths) == 0 {
		return nil, nil
	}
	sessions := make([]AiVaultSession, 0)
	issues := make([]AiVaultScanIssue, 0)
	parsed := 0
	for _, candidate := range candidates {
		if parsed >= aiVaultScopeParseLimit {
			break
		}
		if _, exists := parsedPaths[candidate.path]; exists {
			continue
		}
		parsed++
		session, err := parseAiVaultCandidate(candidate, codexHome)
		if err != nil {
			issues = append(issues, AiVaultScanIssue{ExecutionHostID: "local", Agent: candidate.agent, Path: candidate.path, Message: err.Error()})
			continue
		}
		if session != nil && aiVaultSessionInScope(*session, scopePaths) {
			sessions = append(sessions, *session)
		}
	}
	return sessions, issues
}

func normalizeAiVaultScopePaths(paths []string) []string {
	result := make([]string, 0, len(paths))
	for _, path := range paths {
		if normalized := strings.TrimSpace(path); normalized != "" {
			result = append(result, filepath.Clean(normalized))
		}
	}
	return result
}

func aiVaultSessionInScope(session AiVaultSession, scopePaths []string) bool {
	if session.Cwd == nil || strings.TrimSpace(*session.Cwd) == "" {
		return false
	}
	cwd := filepath.Clean(*session.Cwd)
	for _, scopePath := range scopePaths {
		relative, err := filepath.Rel(scopePath, cwd)
		if err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
			return true
		}
	}
	return false
}

func mergeAiVaultSessionsWithoutLimit(primary, scoped []AiVaultSession) []AiVaultSession {
	byID := make(map[string]AiVaultSession, len(primary)+len(scoped))
	for _, session := range primary {
		byID[session.ID] = session
	}
	for _, session := range scoped {
		byID[session.ID] = session
	}
	result := make([]AiVaultSession, 0, len(byID))
	for _, session := range byID {
		result = append(result, session)
	}
	sort.Slice(result, func(i, j int) bool {
		return aiVaultSessionTime(result[i]).After(aiVaultSessionTime(result[j]))
	})
	return result
}

func (m *Manager) scanSshAiVaultSessions(ctx context.Context, targetID string, req AiVaultListRequest) AiVaultListResult {
	hostID := "ssh:" + url.PathEscape(targetID)
	args := []string{"ai-vault-scan-json", "--limit", strconv.Itoa(normalizeAiVaultLimit(req.Limit))}
	for _, scopePath := range normalizeAiVaultScopePaths(req.ScopePaths) {
		args = append(args, "--scope-path", scopePath)
	}
	output, err := m.runSshRelayWorker(ctx, targetID, args)
	if err != nil {
		return AiVaultListResult{Sessions: []AiVaultSession{}, Issues: []AiVaultScanIssue{{ExecutionHostID: hostID, Agent: "codex", Path: targetID, Message: err.Error()}}, ScannedAt: time.Now().UTC().Format(time.RFC3339Nano)}
	}
	var result AiVaultListResult
	if err := json.Unmarshal(output, &result); err != nil {
		return AiVaultListResult{Sessions: []AiVaultSession{}, Issues: []AiVaultScanIssue{{ExecutionHostID: hostID, Agent: "codex", Path: targetID, Message: "relay worker returned malformed AI Vault data: " + err.Error()}}, ScannedAt: time.Now().UTC().Format(time.RFC3339Nano)}
	}
	platform := ""
	if len(result.Sessions) > 0 {
		platform = result.Sessions[0].ExecutionHostPlatform
	}
	RewriteAiVaultExecutionHost(&result, hostID, platform)
	return result
}

func RewriteAiVaultExecutionHost(result *AiVaultListResult, executionHostID, platform string) {
	for index := range result.Sessions {
		session := &result.Sessions[index]
		session.ExecutionHostID = executionHostID
		session.ExecutionHostPlatform = platform
		session.ID = executionHostID + ":" + session.Agent + ":" + session.SessionID + ":" + session.FilePath
	}
	for index := range result.Issues {
		result.Issues[index].ExecutionHostID = executionHostID
	}
}

func mergeAiVaultResults(results []AiVaultListResult, rawLimit int) AiVaultListResult {
	limit := normalizeAiVaultLimit(rawLimit)
	byID := make(map[string]AiVaultSession)
	issues := make([]AiVaultScanIssue, 0)
	for _, result := range results {
		for _, session := range result.Sessions {
			byID[session.ID] = session
		}
		issues = append(issues, result.Issues...)
	}
	sessions := make([]AiVaultSession, 0, len(byID))
	for _, session := range byID {
		sessions = append(sessions, session)
	}
	sort.Slice(sessions, func(i, j int) bool {
		return aiVaultSessionTime(sessions[i]).After(aiVaultSessionTime(sessions[j]))
	})
	if len(sessions) > limit {
		sessions = sessions[:limit]
	}
	return AiVaultListResult{Sessions: sessions, Issues: issues, ScannedAt: time.Now().UTC().Format(time.RFC3339Nano)}
}

func normalizeAiVaultLimit(limit int) int {
	if limit <= 0 || limit > 2000 {
		return 1000
	}
	return limit
}

func aiVaultSessionTime(session AiVaultSession) time.Time {
	for _, value := range []*string{session.UpdatedAt, session.CreatedAt} {
		if value != nil {
			if parsed, err := time.Parse(time.RFC3339Nano, *value); err == nil {
				return parsed
			}
		}
	}
	parsed, _ := time.Parse(time.RFC3339Nano, session.ModifiedAt)
	return parsed
}

func selectAiVaultCandidates(candidates []aiVaultCandidate, limit int) []aiVaultCandidate {
	if len(candidates) <= limit {
		return candidates
	}
	const maxSourceReserve = 20
	agents := make(map[string]struct{})
	for _, candidate := range candidates {
		agents[candidate.agent] = struct{}{}
	}
	sourceReserve := limit / max(1, len(agents))
	if sourceReserve < 1 {
		sourceReserve = 1
	}
	if sourceReserve > maxSourceReserve {
		sourceReserve = maxSourceReserve
	}
	selected := make([]aiVaultCandidate, 0, limit)
	selectedPaths := make(map[string]struct{}, limit)
	perAgent := make(map[string]int)
	for _, candidate := range candidates {
		if perAgent[candidate.agent] >= sourceReserve || len(selected) >= limit {
			continue
		}
		selected = append(selected, candidate)
		selectedPaths[candidate.path] = struct{}{}
		perAgent[candidate.agent]++
	}
	for _, candidate := range candidates {
		if len(selected) >= limit {
			break
		}
		if _, exists := selectedPaths[candidate.path]; exists {
			continue
		}
		selected = append(selected, candidate)
		selectedPaths[candidate.path] = struct{}{}
	}
	sortAiVaultCandidates(selected)
	return selected
}

func sortAiVaultCandidates(candidates []aiVaultCandidate) {
	sort.Slice(candidates, func(i, j int) bool {
		return candidates[i].info.ModTime().After(candidates[j].info.ModTime())
	})
}

func discoverAiVaultFiles(root aiVaultRoot, limit int) ([]aiVaultCandidate, []aiVaultDiscoveryIssue) {
	result := make([]aiVaultCandidate, 0, limit)
	issues := make([]aiVaultDiscoveryIssue, 0)
	rootUnavailable := false
	_ = filepath.Walk(root.path, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			if os.IsNotExist(err) && path == root.path {
				rootUnavailable = true
				return filepath.SkipAll
			}
			issues = append(issues, aiVaultDiscoveryIssue{path: path, message: err.Error()})
			// Why: one protected/corrupt session directory must not hide readable
			// histories in sibling directories from the AI Vault.
			if info == nil || info.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if root.agent == "claude" && isClaudeWorkerTranscript(path) {
			return nil
		}
		if !info.Mode().IsRegular() || !matchesAiVaultExtension(path, root.extensions) {
			return nil
		}
		if root.fileMatch != nil && !root.fileMatch(path) {
			return nil
		}
		result = append(result, aiVaultCandidate{agent: root.agent, path: path, info: info})
		return nil
	})
	sort.Slice(result, func(i, j int) bool { return result[i].info.ModTime().After(result[j].info.ModTime()) })
	if len(result) > limit {
		result = result[:limit]
	}
	if rootUnavailable {
		return result, nil
	}
	return result, issues
}

func matchesAiVaultExtension(path string, extensions []string) bool {
	extension := filepath.Ext(path)
	for _, candidate := range extensions {
		if strings.EqualFold(extension, candidate) {
			return true
		}
	}
	return false
}

func envHomeOrDefault(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}

func discoverOpenCodeSQLiteCandidates(dataDir string, limit int) ([]aiVaultCandidate, []AiVaultScanIssue) {
	entries, err := os.ReadDir(dataDir)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, []AiVaultScanIssue{{ExecutionHostID: "local", Agent: "opencode", Path: dataDir, Message: err.Error()}}
	}
	candidates := make([]aiVaultCandidate, 0)
	issues := make([]AiVaultScanIssue, 0)
	for _, entry := range entries {
		if entry.IsDir() || !isOpenCodeDatabaseName(entry.Name()) {
			continue
		}
		dbPath := filepath.Join(dataDir, entry.Name())
		found, scanErr := readOpenCodeDatabaseCandidates(dbPath, limit)
		if scanErr != nil {
			issues = append(issues, AiVaultScanIssue{ExecutionHostID: "local", Agent: "opencode", Path: dbPath, Message: scanErr.Error()})
			continue
		}
		candidates = append(candidates, found...)
	}
	return candidates, issues
}

func isOpenCodeDatabaseName(name string) bool {
	lower := strings.ToLower(name)
	return strings.HasPrefix(lower, "opencode") && strings.HasSuffix(lower, ".db") && !strings.ContainsAny(name, `/\\`)
}

func readOpenCodeDatabaseCandidates(dbPath string, limit int) ([]aiVaultCandidate, error) {
	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(dbPath)+"?mode=ro")
	if err != nil {
		return nil, err
	}
	defer db.Close()
	columns, err := sqliteTableColumns(db, "session")
	if err != nil || !columns["id"] || !columns["time_created"] || !columns["time_updated"] {
		return nil, err
	}
	predicates := []string{"1=1"}
	if columns["parent_id"] {
		predicates = append(predicates, "parent_id IS NULL")
	}
	if columns["time_archived"] {
		predicates = append(predicates, "time_archived IS NULL")
	}
	query := fmt.Sprintf("SELECT id, time_created, time_updated FROM session WHERE %s ORDER BY time_updated DESC LIMIT ?", strings.Join(predicates, " AND "))
	rows, err := db.Query(query, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]aiVaultCandidate, 0)
	for rows.Next() {
		var sessionID string
		var created, updated int64
		if err := rows.Scan(&sessionID, &created, &updated); err != nil {
			return nil, err
		}
		stamp := openCodeTimestamp(updated)
		if stamp.IsZero() {
			stamp = openCodeTimestamp(created)
		}
		result = append(result, aiVaultCandidate{
			agent: "opencode",
			path:  dbPath + "#" + sessionID,
			info:  aiVaultSyntheticFileInfo{name: filepath.Base(dbPath), modTime: stamp},
		})
	}
	return result, rows.Err()
}

func sqliteTableColumns(db *sql.DB, table string) (map[string]bool, error) {
	rows, err := db.Query("PRAGMA table_info(" + table + ")")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	columns := make(map[string]bool)
	for rows.Next() {
		var cid int
		var name, kind string
		var notNull, primaryKey int
		var defaultValue any
		if err := rows.Scan(&cid, &name, &kind, &notNull, &defaultValue, &primaryKey); err != nil {
			return nil, err
		}
		columns[name] = true
	}
	return columns, rows.Err()
}

func openCodeTimestamp(value int64) time.Time {
	if value <= 0 {
		return time.Time{}
	}
	if value < 10_000_000_000 {
		return time.Unix(value, 0).UTC()
	}
	return time.UnixMilli(value).UTC()
}

func splitOpenCodeSQLiteCandidate(path string) (string, string, bool) {
	index := strings.LastIndex(path, "#")
	if index <= 0 || index == len(path)-1 {
		return "", "", false
	}
	dbPath, sessionID := path[:index], path[index+1:]
	if !isOpenCodeDatabaseName(filepath.Base(dbPath)) {
		return "", "", false
	}
	return dbPath, sessionID, true
}

func dedupeOpenCodeCandidates(candidates []aiVaultCandidate) []aiVaultCandidate {
	newestSQLiteByID := make(map[string]aiVaultCandidate)
	for _, candidate := range candidates {
		if candidate.agent != "opencode" {
			continue
		}
		_, sessionID, sqlite := splitOpenCodeSQLiteCandidate(candidate.path)
		if !sqlite {
			continue
		}
		if previous, ok := newestSQLiteByID[sessionID]; !ok || candidate.info.ModTime().After(previous.info.ModTime()) {
			newestSQLiteByID[sessionID] = candidate
		}
	}
	result := make([]aiVaultCandidate, 0, len(candidates))
	seenSQLite := make(map[string]bool)
	for _, candidate := range candidates {
		if candidate.agent != "opencode" {
			result = append(result, candidate)
			continue
		}
		_, sessionID, sqlite := splitOpenCodeSQLiteCandidate(candidate.path)
		if sqlite {
			if seenSQLite[sessionID] || newestSQLiteByID[sessionID].path != candidate.path {
				continue
			}
			seenSQLite[sessionID] = true
			result = append(result, candidate)
			continue
		}
		legacyID := strings.TrimSuffix(filepath.Base(candidate.path), filepath.Ext(candidate.path))
		if _, exists := newestSQLiteByID[legacyID]; !exists {
			result = append(result, candidate)
		}
	}
	return result
}

func parseAiVaultCandidate(candidate aiVaultCandidate, codexHome string) (*AiVaultSession, error) {
	switch candidate.agent {
	case "openclaw":
		return parseOpenClawAiVaultSession(candidate)
	case "droid":
		return parseDroidAiVaultSession(candidate)
	case "opencode":
		if dbPath, sessionID, ok := splitOpenCodeSQLiteCandidate(candidate.path); ok {
			return parseOpenCodeSQLiteSession(dbPath, sessionID, candidate.info)
		}
		return parseOpenCodeLegacySession(candidate)
	case "gemini", "hermes", "rovo", "grok", "devin", "kimi":
		return parseAiVaultJSON(candidate)
	default:
		return parseAiVaultJSONL(candidate, codexHome)
	}
}

func pathContainsSegment(path, segment string) bool {
	for _, part := range strings.FieldsFunc(filepath.Clean(path), func(r rune) bool {
		return r == '/' || r == '\\'
	}) {
		if part == segment {
			return true
		}
	}
	return false
}

func parseAiVaultJSONL(candidate aiVaultCandidate, codexHome string) (*AiVaultSession, error) {
	file, err := os.Open(candidate.path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	sessionID := strings.TrimSuffix(filepath.Base(candidate.path), filepath.Ext(candidate.path))
	var title, cwd, model, created, updated string
	messageCount, totalTokens := 0, 0
	preview := make([]AiVaultPreviewMessage, 0, 6)
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 64*1024), 64*1024*1024)
	for scanner.Scan() {
		var record map[string]any
		if json.Unmarshal(scanner.Bytes(), &record) != nil {
			continue
		}
		payload := objectValue(record["payload"])
		message := objectValue(record["message"])
		if value := firstString(record, "sessionId", "session_id"); value != "" {
			sessionID = value
		}
		if value := firstString(payload, "id"); candidate.agent == "codex" && value != "" {
			sessionID = value
		}
		if value := firstString(record, "cwd"); value != "" {
			cwd = value
		} else if value := firstString(payload, "cwd"); value != "" {
			cwd = value
		}
		if value := firstString(record, "timestamp"); value != "" {
			if created == "" {
				created = value
			}
			updated = value
		}
		role := firstString(record, "role", "type")
		if value := firstString(message, "role"); value != "" {
			role = value
		} else if value := firstString(payload, "role"); value != "" {
			role = value
		}
		text := extractAiVaultText(record["content"])
		if text == "" {
			text = extractAiVaultText(message["content"])
		}
		if text == "" {
			text = extractAiVaultText(payload["content"])
		}
		if text != "" && (role == "user" || role == "assistant" || strings.Contains(role, "message")) {
			messageCount++
			if title == "" && role == "user" {
				title = compactAiVaultText(text, 96)
			}
			preview = append(preview, AiVaultPreviewMessage{Role: normalizeAiVaultRole(role), Text: compactAiVaultText(text, 220), Timestamp: optionalString(updated)})
			if len(preview) > 6 {
				preview = preview[len(preview)-6:]
			}
		}
		if value := firstString(message, "model"); value != "" {
			model = value
		}
		totalTokens += tokenCount(message["usage"])
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	if title == "" {
		title = fmt.Sprintf("%s %s", strings.Title(candidate.agent), shortSessionID(sessionID))
	}
	modified := candidate.info.ModTime().UTC().Format(time.RFC3339Nano)
	resume := candidate.agent + " --resume " + quoteAiVaultShellArg(sessionID)
	switch candidate.agent {
	case "codex":
		resume = "codex resume " + quoteAiVaultShellArg(sessionID)
	case "copilot":
		resume = "copilot --resume=" + quoteAiVaultShellArg(sessionID)
	case "cursor":
		resume = "cursor-agent --resume " + quoteAiVaultShellArg(sessionID)
	case "pi":
		resume = "pi --session " + quoteAiVaultShellArg(sessionID)
	}
	if cwd != "" {
		resume = "cd " + quoteAiVaultShellArg(cwd) + " && " + resume
	}
	return &AiVaultSession{ID: "local:" + candidate.agent + ":" + sessionID + ":" + candidate.path, ExecutionHostID: "local", Agent: candidate.agent, SessionID: sessionID, Title: title, Cwd: optionalString(cwd), Branch: nil, Model: optionalString(model), FilePath: candidate.path, CodexHome: optionalCodexHome(candidate.agent, codexHome), CreatedAt: optionalString(created), UpdatedAt: optionalString(updated), ModifiedAt: modified, MessageCount: messageCount, TotalTokens: totalTokens, PreviewMessages: preview, ResumeCommand: resume}, nil
}

func parseAiVaultJSON(candidate aiVaultCandidate) (*AiVaultSession, error) {
	content, err := readBoundedAiVaultFile(candidate.path)
	if err != nil {
		return nil, err
	}
	var record map[string]any
	if err := json.Unmarshal(content, &record); err != nil {
		return nil, err
	}
	session := newAiVaultJSONSession(candidate)
	switch candidate.agent {
	case "gemini":
		consumeGeminiJSONSession(session, record)
	case "hermes":
		consumeHermesJSONSession(session, record)
	case "rovo":
		if err := consumeRovoJSONSession(session, record, filepath.Dir(candidate.path)); err != nil {
			return nil, err
		}
	case "grok":
		if err := consumeGrokJSONSession(session, record, filepath.Dir(candidate.path)); err != nil {
			return nil, err
		}
	case "devin":
		consumeDevinJSONSession(session, record)
	case "kimi":
		if err := consumeKimiJSONSession(session, record); err != nil {
			return nil, err
		}
	}
	finalizeAiVaultJSONSession(session)
	return session, nil
}

func parseOpenClawAiVaultSession(candidate aiVaultCandidate) (*AiVaultSession, error) {
	session := newAiVaultJSONSession(candidate)
	file, err := os.Open(candidate.path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 64*1024), 64*1024*1024)
	for scanner.Scan() {
		var record map[string]any
		if json.Unmarshal(scanner.Bytes(), &record) != nil {
			continue
		}
		setAiVaultTimeline(session, firstString(record, "timestamp"))
		switch firstString(record, "type") {
		case "session":
			if value := firstString(record, "id"); value != "" {
				session.SessionID = value
			}
			session.Cwd = optionalString(firstString(record, "cwd"))
		case "model_change":
			session.Model = optionalString(firstString(record, "modelId"))
		case "message":
			message := objectValue(record["message"])
			role := firstString(message, "role")
			if role != "user" && role != "assistant" {
				continue
			}
			if role == "assistant" {
				session.Model = optionalString(firstString(message, "model"))
				session.TotalTokens += tokenCount(message["usage"])
			}
			text := extractAiVaultText(message["content"])
			if role == "user" && session.Title == "" {
				session.Title = compactAiVaultText(text, 96)
			}
			appendAiVaultPreview(session, role, text, firstString(record, "timestamp"))
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	finalizeAiVaultJSONSession(session)
	return session, nil
}

func parseDroidAiVaultSession(candidate aiVaultCandidate) (*AiVaultSession, error) {
	session := newAiVaultJSONSession(candidate)
	file, err := os.Open(candidate.path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 64*1024), 64*1024*1024)
	for scanner.Scan() {
		var record map[string]any
		if json.Unmarshal(scanner.Bytes(), &record) != nil {
			continue
		}
		setAiVaultTimeline(session, firstString(record, "timestamp"))
		if value := firstString(record, "session_id", "sessionId"); value != "" {
			session.SessionID = value
		}
		switch firstString(record, "type") {
		case "session_start":
			if value := firstString(record, "id"); value != "" {
				session.SessionID = value
			}
			session.Title = firstString(record, "title")
			session.Cwd = optionalString(firstString(record, "cwd"))
		case "system":
			session.Cwd = optionalString(firstString(record, "cwd"))
			session.Model = optionalString(firstString(record, "model"))
		case "message":
			consumeDroidMessage(session, record)
		case "completion":
			session.TotalTokens += tokenCount(record["usage"])
			appendAiVaultPreview(session, "assistant", firstString(record, "finalText"), firstString(record, "timestamp"))
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	finalizeAiVaultJSONSession(session)
	return session, nil
}

func parseOpenCodeLegacySession(candidate aiVaultCandidate) (*AiVaultSession, error) {
	content, err := readBoundedAiVaultFile(candidate.path)
	if err != nil {
		return nil, err
	}
	var record map[string]any
	if err := json.Unmarshal(content, &record); err != nil {
		return nil, err
	}
	session := newAiVaultJSONSession(candidate)
	if value := firstString(record, "id"); value != "" {
		session.SessionID = value
	}
	session.Title = firstString(record, "title")
	session.Cwd = optionalString(firstString(record, "directory"))
	timeRecord := objectValue(record["time"])
	setAiVaultTimeline(session, anyTimestamp(timeRecord["created"]))
	setAiVaultTimeline(session, anyTimestamp(timeRecord["updated"]))
	storageRoot := findPathAncestor(candidate.path, "storage")
	if storageRoot != "" {
		messageDir := filepath.Join(storageRoot, "message", session.SessionID)
		entries, _ := os.ReadDir(messageDir)
		for _, entry := range entries {
			if entry.IsDir() || !strings.EqualFold(filepath.Ext(entry.Name()), ".json") {
				continue
			}
			messageContent, readErr := readBoundedAiVaultFile(filepath.Join(messageDir, entry.Name()))
			if readErr != nil {
				continue
			}
			var message map[string]any
			if json.Unmarshal(messageContent, &message) != nil {
				continue
			}
			role := firstString(message, "role")
			if role != "user" && role != "assistant" {
				continue
			}
			messageTime := objectValue(message["time"])
			text := extractAiVaultText(message["content"])
			summary := objectValue(message["summary"])
			if text == "" {
				text = firstString(summary, "body", "title")
			}
			if role == "user" && session.Title == "" {
				session.Title = firstNonEmpty(firstString(summary, "title", "body"), compactAiVaultText(text, 96))
			}
			model := objectValue(message["model"])
			if value := firstString(model, "modelID"); value != "" {
				session.Model = optionalString(value)
			} else if value := firstString(message, "modelID"); value != "" {
				session.Model = optionalString(value)
			}
			session.TotalTokens += tokenCount(message["tokens"])
			appendAiVaultPreview(session, role, text, anyTimestamp(messageTime["created"]))
		}
	}
	finalizeAiVaultJSONSession(session)
	return session, nil
}

func parseOpenCodeSQLiteSession(dbPath, sessionID string, info os.FileInfo) (*AiVaultSession, error) {
	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(dbPath)+"?mode=ro")
	if err != nil {
		return nil, err
	}
	defer db.Close()
	columns, err := sqliteTableColumns(db, "session")
	if err != nil || !columns["id"] || !columns["time_created"] || !columns["time_updated"] {
		return nil, err
	}
	selectExpr := func(name, fallback string) string {
		if columns[name] {
			return name
		}
		return fallback
	}
	query := fmt.Sprintf(`SELECT id, %s, %s, time_created, time_updated, %s,
		%s, %s, %s FROM session WHERE id = ? LIMIT 1`,
		selectExpr("title", "NULL"), selectExpr("directory", "NULL"), selectExpr("model", "NULL"),
		selectExpr("tokens_input", "0"), selectExpr("tokens_output", "0"), selectExpr("tokens_reasoning", "0"))
	var id string
	var title, directory, modelJSON sql.NullString
	var created, updated int64
	var inputTokens, outputTokens, reasoningTokens int
	if err := db.QueryRow(query, sessionID).Scan(&id, &title, &directory, &created, &updated, &modelJSON, &inputTokens, &outputTokens, &reasoningTokens); err != nil {
		if err == sql.ErrNoRows {
			return nil, nil
		}
		return nil, err
	}
	session := &AiVaultSession{
		ID: "local:opencode:" + id + ":" + dbPath, ExecutionHostID: "local", Agent: "opencode",
		SessionID: id, Title: title.String, Cwd: nullableString(directory), FilePath: dbPath,
		ModifiedAt: info.ModTime().UTC().Format(time.RFC3339Nano), TotalTokens: inputTokens + outputTokens + reasoningTokens,
		PreviewMessages: []AiVaultPreviewMessage{},
	}
	setAiVaultTimeline(session, anyTimestamp(created))
	setAiVaultTimeline(session, anyTimestamp(updated))
	if modelJSON.Valid {
		var model map[string]any
		if json.Unmarshal([]byte(modelJSON.String), &model) == nil {
			session.Model = optionalString(firstString(model, "id", "modelID"))
		}
	}
	if err := consumeOpenCodeSQLitePreview(db, session); err != nil {
		return nil, err
	}
	finalizeAiVaultJSONSession(session)
	return session, nil
}

func consumeOpenCodeSQLitePreview(db *sql.DB, session *AiVaultSession) error {
	messageColumns, err := sqliteTableColumns(db, "message")
	if err != nil || !messageColumns["id"] || !messageColumns["session_id"] || !messageColumns["data"] {
		return err
	}
	partColumns, err := sqliteTableColumns(db, "part")
	if err != nil || !partColumns["message_id"] || !partColumns["data"] || !partColumns["time_created"] {
		return err
	}
	rows, err := db.Query(`SELECT m.data, p.data, p.time_created
		FROM message m JOIN part p ON p.message_id = m.id
		WHERE m.session_id = ? ORDER BY p.time_created DESC LIMIT 5`, session.SessionID)
	if err != nil {
		return err
	}
	defer rows.Close()
	type preview struct{ role, text, timestamp string }
	previews := make([]preview, 0, 5)
	roles := make(map[string]bool)
	for rows.Next() {
		var messageJSON, partJSON string
		var created int64
		if err := rows.Scan(&messageJSON, &partJSON, &created); err != nil {
			return err
		}
		var message, part map[string]any
		if json.Unmarshal([]byte(messageJSON), &message) != nil || json.Unmarshal([]byte(partJSON), &part) != nil {
			continue
		}
		role := firstString(message, "role")
		if (role != "user" && role != "assistant") || firstString(part, "type") != "text" {
			continue
		}
		text := firstString(part, "text")
		if text == "" {
			continue
		}
		roles[role+":"+messageJSON] = true
		previews = append(previews, preview{role: role, text: text, timestamp: anyTimestamp(created)})
		if role == "user" && session.Title == "" {
			summary := objectValue(message["summary"])
			session.Title = firstString(summary, "title", "body")
		}
	}
	for index := len(previews) - 1; index >= 0; index-- {
		item := previews[index]
		appendAiVaultPreview(session, item.role, item.text, item.timestamp)
	}
	if count, err := countOpenCodeMessages(db, session.SessionID); err == nil {
		session.MessageCount = count
	} else if session.MessageCount == 0 {
		session.MessageCount = len(roles)
	}
	return rows.Err()
}

func countOpenCodeMessages(db *sql.DB, sessionID string) (int, error) {
	rows, err := db.Query("SELECT data FROM message WHERE session_id = ?", sessionID)
	if err != nil {
		return 0, err
	}
	defer rows.Close()
	count := 0
	for rows.Next() {
		var raw string
		if err := rows.Scan(&raw); err != nil {
			return 0, err
		}
		var message map[string]any
		if json.Unmarshal([]byte(raw), &message) == nil {
			role := firstString(message, "role")
			if role == "user" || role == "assistant" {
				count++
			}
		}
	}
	return count, rows.Err()
}

func findPathAncestor(path, name string) string {
	current := filepath.Dir(path)
	for {
		if filepath.Base(current) == name {
			return current
		}
		parent := filepath.Dir(current)
		if parent == current {
			return ""
		}
		current = parent
	}
}

func anyTimestamp(value any) string {
	switch typed := value.(type) {
	case string:
		return strings.TrimSpace(typed)
	case float64:
		return formatOpenCodeTimestamp(int64(typed))
	case int64:
		return formatOpenCodeTimestamp(typed)
	case int:
		return formatOpenCodeTimestamp(int64(typed))
	}
	return ""
}

func formatOpenCodeTimestamp(value int64) string {
	stamp := openCodeTimestamp(value)
	if stamp.IsZero() {
		return ""
	}
	return stamp.Format(time.RFC3339Nano)
}

func nullableString(value sql.NullString) *string {
	if !value.Valid || strings.TrimSpace(value.String) == "" {
		return nil
	}
	result := strings.TrimSpace(value.String)
	return &result
}

func consumeDroidMessage(session *AiVaultSession, record map[string]any) {
	message := objectValue(record["message"])
	role := firstString(record, "role")
	if role == "" {
		role = firstString(message, "role")
	}
	if role != "user" && role != "assistant" {
		return
	}
	text := firstString(record, "text")
	if text == "" {
		text = extractAiVaultText(message["content"])
	}
	if role == "user" && session.Title == "" {
		session.Title = compactAiVaultText(text, 96)
	}
	appendAiVaultPreview(session, role, text, firstString(record, "timestamp"))
}

func readBoundedAiVaultFile(path string) ([]byte, error) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	if info.Size() > 64*1024*1024 {
		return nil, fmt.Errorf("AI Vault file exceeds 64 MiB")
	}
	return os.ReadFile(path)
}

func newAiVaultJSONSession(candidate aiVaultCandidate) *AiVaultSession {
	sessionID := strings.TrimSuffix(filepath.Base(candidate.path), filepath.Ext(candidate.path))
	return &AiVaultSession{
		ID:              "local:" + candidate.agent + ":" + sessionID + ":" + candidate.path,
		ExecutionHostID: "local",
		Agent:           candidate.agent,
		SessionID:       sessionID,
		FilePath:        candidate.path,
		ModifiedAt:      candidate.info.ModTime().UTC().Format(time.RFC3339Nano),
		PreviewMessages: []AiVaultPreviewMessage{},
	}
}

func consumeGeminiJSONSession(session *AiVaultSession, record map[string]any) {
	if value := firstString(record, "sessionId"); value != "" {
		session.SessionID = value
	}
	setAiVaultTimeline(session, firstString(record, "startTime"))
	setAiVaultTimeline(session, firstString(record, "lastUpdated"))
	for _, message := range arrayObjects(record["messages"]) {
		consumeGeminiJSONMessage(session, message)
	}
}

func consumeGeminiJSONMessage(session *AiVaultSession, message map[string]any) {
	setAiVaultTimeline(session, firstString(message, "timestamp"))
	role := firstString(message, "type")
	if role != "user" && role != "gemini" {
		return
	}
	text := extractAiVaultText(message["content"])
	previewRole := "assistant"
	if role == "user" {
		previewRole = "user"
		if session.Title == "" {
			session.Title = compactAiVaultText(text, 96)
		}
	} else {
		session.Model = optionalString(firstString(message, "model"))
		session.TotalTokens += tokenCount(message["tokens"])
	}
	appendAiVaultPreview(session, previewRole, text, firstString(message, "timestamp"))
}

func consumeHermesJSONSession(session *AiVaultSession, record map[string]any) {
	if value := firstString(record, "session_id"); value != "" {
		session.SessionID = value
	}
	session.Model = optionalString(firstString(record, "model"))
	session.Cwd = optionalString(firstString(record, "cwd"))
	setAiVaultTimeline(session, firstString(record, "session_start"))
	setAiVaultTimeline(session, firstString(record, "last_updated"))
	for _, message := range arrayObjects(record["messages"]) {
		role := firstString(message, "role")
		if role != "user" && role != "assistant" {
			continue
		}
		text := extractAiVaultText(message["content"])
		if role == "user" && session.Title == "" {
			session.Title = compactAiVaultText(text, 96)
		}
		appendAiVaultPreview(session, role, text, "")
	}
	if session.MessageCount == 0 {
		session.MessageCount = int(numberValue(record["message_count"]))
	}
}

func consumeRovoJSONSession(session *AiVaultSession, record map[string]any, sessionDir string) error {
	session.SessionID = filepath.Base(sessionDir)
	session.Title = firstString(record, "title", "name", "summary")
	session.Cwd = optionalString(firstString(record, "workspace_path", "workspacePath", "workspace", "cwd", "working_directory", "workingDirectory", "project_path", "projectPath"))
	setAiVaultTimeline(session, firstString(record, "created_at", "createdAt"))
	setAiVaultTimeline(session, firstString(record, "updated_at", "updatedAt"))
	contextPath := filepath.Join(sessionDir, "session_context.json")
	content, err := readBoundedAiVaultFile(contextPath)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	var context map[string]any
	if err := json.Unmarshal(content, &context); err != nil {
		return err
	}
	for _, message := range arrayObjects(context["messages"]) {
		consumeSimpleRoleMessage(session, message)
	}
	for _, message := range arrayObjects(context["message_history"]) {
		consumeRovoHistoryMessage(session, message)
	}
	return nil
}

func consumeRovoHistoryMessage(session *AiVaultSession, message map[string]any) {
	role := firstString(message, "role")
	if role == "" {
		switch firstString(message, "kind") {
		case "request":
			role = "user"
		case "response":
			role = "assistant"
		}
	}
	if role != "user" && role != "assistant" {
		return
	}
	parts := make([]string, 0)
	for _, part := range arrayObjects(message["parts"]) {
		kind := firstString(part, "part_kind")
		if role == "user" && kind != "user-prompt" && kind != "text" {
			continue
		}
		if role == "assistant" && kind != "text" {
			continue
		}
		if text := firstString(part, "content", "text"); text != "" {
			parts = append(parts, text)
		}
	}
	appendAiVaultPreview(session, role, strings.Join(parts, " "), firstString(message, "timestamp"))
}

func consumeGrokJSONSession(session *AiVaultSession, record map[string]any, sessionDir string) error {
	info := objectValue(record["info"])
	if value := firstString(info, "id"); value != "" {
		session.SessionID = value
	} else {
		session.SessionID = filepath.Base(sessionDir)
	}
	session.Cwd = optionalString(firstString(info, "cwd"))
	session.Title = firstString(record, "generated_title", "session_summary")
	session.Model = optionalString(firstString(record, "current_model_id"))
	session.Branch = optionalString(firstString(record, "head_branch"))
	session.MessageCount = int(numberValue(record["num_chat_messages"]))
	if session.MessageCount == 0 {
		session.MessageCount = int(numberValue(record["num_messages"]))
	}
	setAiVaultTimeline(session, firstString(record, "created_at"))
	setAiVaultTimeline(session, firstString(record, "updated_at"))
	setAiVaultTimeline(session, firstString(record, "last_active_at"))
	chatPath := filepath.Join(sessionDir, "chat_history.jsonl")
	file, err := os.Open(chatPath)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 64*1024), 64*1024*1024)
	for scanner.Scan() {
		var message map[string]any
		if json.Unmarshal(scanner.Bytes(), &message) != nil {
			continue
		}
		consumeGrokPreviewMessage(session, message)
	}
	return scanner.Err()
}

func consumeDevinJSONSession(session *AiVaultSession, record map[string]any) {
	if value := firstString(record, "session_id", "sessionId"); value != "" {
		session.SessionID = value
	}
	agent := objectValue(record["agent"])
	session.Model = optionalString(firstNonEmpty(
		firstString(agent, "model_name", "model"),
		firstString(record, "generation_model"),
	))
	session.Cwd = optionalString(firstString(record, "working_directory"))
	for _, step := range arrayObjects(record["steps"]) {
		metadata := objectValue(step["metadata"])
		metrics := objectValue(metadata["metrics"])
		setAiVaultTimeline(session, firstString(metadata, "created_at"))
		if session.Model == nil {
			session.Model = optionalString(firstNonEmpty(
				firstString(metadata, "generation_model"),
				firstString(metrics, "generation_model"),
			))
		}
		session.TotalTokens += devinTokenTotal(metadata, metrics)
		role := ""
		if metadata["is_user_input"] == true {
			role = "user"
		} else if firstString(step, "role") == "assistant" || step["tool_calls"] != nil {
			role = "assistant"
		}
		if role == "" {
			continue
		}
		message := objectValue(step["message"])
		text := extractAiVaultText(message["content"])
		if text == "" {
			text = firstString(step, "text")
		}
		if text == "" {
			text = extractAiVaultText(step["content"])
		}
		if role == "user" && session.Title == "" {
			session.Title = compactAiVaultText(text, 96)
		}
		appendAiVaultPreview(session, role, text, firstString(metadata, "created_at"))
	}
}

func devinTokenTotal(metadata, metrics map[string]any) int {
	total := 0
	for _, keys := range [][]string{
		{"total_input_tokens", "input_tokens"},
		{"output_tokens"},
		{"cache_read_tokens", "cache_read_input_tokens"},
		{"cache_creation_tokens", "cache_creation_input_tokens"},
	} {
		for _, source := range []map[string]any{metadata, metrics} {
			value := 0
			for _, key := range keys {
				value = int(numberValue(source[key]))
				if value > 0 {
					break
				}
			}
			if value > 0 {
				total += value
				break
			}
		}
	}
	return total
}

func consumeKimiJSONSession(session *AiVaultSession, state map[string]any) error {
	sessionDir := filepath.Dir(session.FilePath)
	session.SessionID = filepath.Base(sessionDir)
	session.Title = firstString(state, "title")
	if session.Title == "" {
		session.Title = firstString(state, "lastPrompt")
	}
	setAiVaultTimeline(session, firstString(state, "createdAt"))
	setAiVaultTimeline(session, firstString(state, "updatedAt"))
	session.Cwd = optionalString(readKimiWorkDir(session.FilePath, session.SessionID))
	primaryID := "main"
	for id, value := range objectValue(state["agents"]) {
		agent := objectValue(value)
		if firstString(agent, "type") == "main" && agent["parentAgentId"] == nil {
			primaryID = id
			break
		}
	}
	wirePath := filepath.Join(sessionDir, "agents", primaryID, "wire.jsonl")
	file, err := os.Open(wirePath)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	defer file.Close()
	pendingAssistant := strings.Builder{}
	flushAssistant := func() {
		appendAiVaultPreview(session, "assistant", pendingAssistant.String(), "")
		pendingAssistant.Reset()
	}
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 64*1024), 64*1024*1024)
	for scanner.Scan() {
		var record map[string]any
		if json.Unmarshal(scanner.Bytes(), &record) != nil {
			continue
		}
		switch firstString(record, "type") {
		case "config.update":
			session.Model = optionalString(firstString(record, "modelAlias"))
		case "usage.record":
			if firstString(record, "usageScope") != "session" {
				session.Model = optionalString(firstNonEmpty(firstString(record, "model"), derefString(session.Model)))
				session.TotalTokens += kimiUsageTotal(objectValue(record["usage"]))
			}
		case "context.append_message":
			message := objectValue(record["message"])
			origin := objectValue(message["origin"])
			if firstString(message, "role") == "user" && firstString(origin, "kind") == "user" {
				text := extractAiVaultText(message["content"])
				if session.Title == "" {
					session.Title = compactAiVaultText(text, 96)
				}
				appendAiVaultPreview(session, "user", text, "")
			}
		case "context.append_loop_event":
			event := objectValue(record["event"])
			switch firstString(event, "type") {
			case "content.part":
				part := objectValue(event["part"])
				if firstString(part, "type") == "text" {
					pendingAssistant.WriteString(firstString(part, "text"))
				}
			case "step.end":
				flushAssistant()
			}
		}
	}
	flushAssistant()
	return scanner.Err()
}

func readKimiWorkDir(statePath, sessionID string) string {
	sessionDir := filepath.Dir(statePath)
	workspaceDir := filepath.Dir(sessionDir)
	sessionsDir := filepath.Dir(workspaceDir)
	indexPath := filepath.Join(filepath.Dir(sessionsDir), "session_index.jsonl")
	file, err := os.Open(indexPath)
	if err != nil {
		return ""
	}
	defer file.Close()
	workDir := ""
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 64*1024), 4*1024*1024)
	for scanner.Scan() {
		var record map[string]any
		if json.Unmarshal(scanner.Bytes(), &record) == nil && firstString(record, "sessionId") == sessionID {
			workDir = firstString(record, "workDir")
		}
	}
	return workDir
}

func kimiUsageTotal(usage map[string]any) int {
	return int(numberValue(usage["inputOther"]) + numberValue(usage["output"]) + numberValue(usage["inputCacheRead"]) + numberValue(usage["inputCacheCreation"]))
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

func derefString(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func consumeGrokPreviewMessage(session *AiVaultSession, message map[string]any) {
	role := firstString(message, "type")
	if role != "user" && role != "assistant" {
		return
	}
	text := compactAiVaultText(extractAiVaultText(message["content"]), 220)
	if text == "" {
		return
	}
	if role == "user" && session.Title == "" {
		session.Title = compactAiVaultText(text, 96)
	}
	session.PreviewMessages = append(session.PreviewMessages, AiVaultPreviewMessage{
		Role: role, Text: text, Timestamp: optionalString(firstString(message, "timestamp")),
	})
	if len(session.PreviewMessages) > 6 {
		session.PreviewMessages = session.PreviewMessages[len(session.PreviewMessages)-6:]
	}
}

func consumeSimpleRoleMessage(session *AiVaultSession, message map[string]any) {
	role := firstString(message, "role", "type")
	if role == "gemini" {
		role = "assistant"
	}
	if role != "user" && role != "assistant" {
		return
	}
	text := extractAiVaultText(message["content"])
	if role == "user" && session.Title == "" {
		session.Title = compactAiVaultText(text, 96)
	}
	appendAiVaultPreview(session, role, text, firstString(message, "timestamp"))
}

func appendAiVaultPreview(session *AiVaultSession, role, text, timestamp string) {
	text = compactAiVaultText(text, 220)
	if text == "" {
		return
	}
	session.MessageCount++
	session.PreviewMessages = append(session.PreviewMessages, AiVaultPreviewMessage{Role: role, Text: text, Timestamp: optionalString(timestamp)})
	if len(session.PreviewMessages) > 6 {
		session.PreviewMessages = session.PreviewMessages[len(session.PreviewMessages)-6:]
	}
	setAiVaultTimeline(session, timestamp)
}

func setAiVaultTimeline(session *AiVaultSession, timestamp string) {
	if timestamp == "" {
		return
	}
	if session.CreatedAt == nil || timestamp < *session.CreatedAt {
		session.CreatedAt = optionalString(timestamp)
	}
	if session.UpdatedAt == nil || timestamp > *session.UpdatedAt {
		session.UpdatedAt = optionalString(timestamp)
	}
}

func finalizeAiVaultJSONSession(session *AiVaultSession) {
	if session.Title == "" {
		session.Title = strings.Title(session.Agent) + " " + shortSessionID(session.SessionID)
	}
	session.ID = "local:" + session.Agent + ":" + session.SessionID + ":" + session.FilePath
	base := session.Agent
	switch session.Agent {
	case "rovo":
		base = "acli rovodev run --restore"
	case "kimi":
		base = "kimi --session"
	case "opencode":
		base = "opencode --session"
	default:
		base += " --resume"
	}
	session.ResumeCommand = base + " " + quoteAiVaultShellArg(session.SessionID)
	if session.Cwd != nil {
		session.ResumeCommand = "cd " + quoteAiVaultShellArg(*session.Cwd) + " && " + session.ResumeCommand
	}
}

func arrayObjects(value any) []map[string]any {
	items, ok := value.([]any)
	if !ok {
		return nil
	}
	result := make([]map[string]any, 0, len(items))
	for _, item := range items {
		if object, ok := item.(map[string]any); ok {
			result = append(result, object)
		}
	}
	return result
}

func numberValue(value any) float64 {
	switch typed := value.(type) {
	case float64:
		return typed
	case json.Number:
		result, _ := typed.Float64()
		return result
	}
	return 0
}

func objectValue(value any) map[string]any {
	if result, ok := value.(map[string]any); ok {
		return result
	}
	return map[string]any{}
}
func firstString(record map[string]any, keys ...string) string {
	for _, key := range keys {
		if value, ok := record[key].(string); ok && strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}
func extractAiVaultText(value any) string {
	switch typed := value.(type) {
	case string:
		return typed
	case []any:
		parts := make([]string, 0, len(typed))
		for _, item := range typed {
			text := extractAiVaultText(item)
			if text != "" {
				parts = append(parts, text)
			}
		}
		return strings.Join(parts, " ")
	case map[string]any:
		return firstString(typed, "text", "content", "input", "output")
	}
	return ""
}
func compactAiVaultText(value string, limit int) string {
	value = normalizeAiVaultTranscriptText(value)
	value = strings.Join(strings.Fields(value), " ")
	if len([]rune(value)) <= limit {
		return value
	}
	return string([]rune(value)[:limit])
}

func normalizeAiVaultTranscriptText(value string) string {
	if body, ok := aiVaultTagBody(value, "user_query"); ok {
		return body
	}
	for {
		start := strings.Index(strings.ToLower(value), "<timestamp>")
		if start < 0 {
			break
		}
		endMarker := "</timestamp>"
		endRelative := strings.Index(strings.ToLower(value[start:]), endMarker)
		if endRelative < 0 {
			break
		}
		end := start + endRelative + len(endMarker)
		value = value[:start] + " " + value[end:]
	}
	return value
}

func aiVaultTagBody(value, tag string) (string, bool) {
	lower := strings.ToLower(value)
	opener := "<" + tag + ">"
	closer := "</" + tag + ">"
	start := strings.Index(lower, opener)
	if start < 0 {
		return "", false
	}
	start += len(opener)
	endRelative := strings.Index(lower[start:], closer)
	if endRelative < 0 {
		return "", false
	}
	return value[start : start+endRelative], true
}
func normalizeAiVaultRole(value string) string {
	if strings.Contains(value, "assistant") {
		return "assistant"
	}
	if strings.Contains(value, "user") {
		return "user"
	}
	if strings.Contains(value, "system") {
		return "system"
	}
	if strings.Contains(value, "tool") {
		return "tool"
	}
	return "unknown"
}
func tokenCount(value any) int {
	record := objectValue(value)
	for _, key := range []string{"total", "totalTokens", "total_tokens"} {
		if total := int(numberValue(record[key])); total > 0 {
			return total
		}
	}
	total := 0
	for _, key := range []string{
		"input", "inputTokens", "input_tokens", "output", "outputTokens", "output_tokens",
		"cacheRead", "cacheReadTokens", "cache_read_input_tokens", "cacheWrite",
		"cacheWriteTokens", "cache_creation_input_tokens", "cached", "cachedInputTokens",
		"cached_input_tokens", "reasoning", "reasoningOutputTokens", "reasoning_output_tokens",
	} {
		total += int(numberValue(record[key]))
	}
	return total
}
func optionalString(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}
func optionalCodexHome(agent, value string) *string {
	if agent != "codex" {
		return nil
	}
	return &value
}
func shortSessionID(value string) string {
	if len(value) <= 8 {
		return value
	}
	return value[:8]
}
func isClaudeWorkerTranscript(path string) bool {
	clean := filepath.ToSlash(path)
	base := filepath.Base(path)
	return strings.Contains(clean, "/subagents/") ||
		strings.Contains(clean, "/workflows/") ||
		base == "journal.jsonl" || strings.HasPrefix(base, "agent-")
}
func quoteAiVaultShellArg(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'"
}
