package runtimecore

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"
)

type OpenCodeUsageAttributedEvent struct {
	SessionID             string   `json:"sessionId"`
	Timestamp             string   `json:"timestamp"`
	Cwd                   string   `json:"cwd,omitempty"`
	Model                 string   `json:"model,omitempty"`
	Day                   string   `json:"day"`
	ProjectKey            string   `json:"projectKey"`
	ProjectLabel          string   `json:"projectLabel"`
	RepoID                string   `json:"repoId,omitempty"`
	WorktreeID            string   `json:"worktreeId,omitempty"`
	EstimatedCostUSD      *float64 `json:"estimatedCostUsd"`
	InputTokens           int64    `json:"inputTokens"`
	CachedInputTokens     int64    `json:"cachedInputTokens"`
	OutputTokens          int64    `json:"outputTokens"`
	ReasoningOutputTokens int64    `json:"reasoningOutputTokens"`
	TotalTokens           int64    `json:"totalTokens"`
}

type OpenCodeUsageScanState struct {
	Enabled             bool    `json:"enabled"`
	IsScanning          bool    `json:"isScanning"`
	LastScanStartedAt   *int64  `json:"lastScanStartedAt"`
	LastScanCompletedAt *int64  `json:"lastScanCompletedAt"`
	LastScanError       *string `json:"lastScanError"`
	HasAnyOpenCodeData  bool    `json:"hasAnyOpenCodeData"`
}

type OpenCodeUsageNativeSnapshot struct {
	ScanState OpenCodeUsageScanState         `json:"scanState"`
	Events    []OpenCodeUsageAttributedEvent `json:"events"`
}

type openCodeUsageDatabase struct {
	Path       string               `json:"path"`
	MtimeMs    int64                `json:"mtimeMs"`
	Size       int64                `json:"size"`
	WalMtimeMs int64                `json:"walMtimeMs,omitempty"`
	WalSize    int64                `json:"walSize,omitempty"`
	Events     []openCodeUsageEvent `json:"events"`
}

type openCodeUsageStore struct {
	Version             int                     `json:"version"`
	Enabled             bool                    `json:"enabled"`
	LastScanStartedAt   *int64                  `json:"lastScanStartedAt"`
	LastScanCompletedAt *int64                  `json:"lastScanCompletedAt"`
	LastScanError       *string                 `json:"lastScanError"`
	WorktreeFingerprint string                  `json:"worktreeFingerprint"`
	Databases           []openCodeUsageDatabase `json:"databases"`
}

var openCodeUsageLocks sync.Map

func (m *Manager) OpenCodeUsageState() (OpenCodeUsageScanState, error) {
	lock := m.openCodeUsageLock()
	lock.Lock()
	defer lock.Unlock()
	store, err := m.readOpenCodeUsageStore()
	return openCodeScanState(store, false), err
}

func (m *Manager) SetOpenCodeUsageEnabled(enabled bool) (OpenCodeUsageScanState, error) {
	lock := m.openCodeUsageLock()
	lock.Lock()
	defer lock.Unlock()
	store, err := m.readOpenCodeUsageStore()
	if err != nil {
		return OpenCodeUsageScanState{}, err
	}
	store.Enabled = enabled
	err = m.writeOpenCodeUsageStore(store)
	return openCodeScanState(store, false), err
}

func (m *Manager) RefreshOpenCodeUsage(ctx context.Context, force bool) (OpenCodeUsageNativeSnapshot, error) {
	lock := m.openCodeUsageLock()
	lock.Lock()
	defer lock.Unlock()
	store, err := m.readOpenCodeUsageStore()
	if err != nil {
		return OpenCodeUsageNativeSnapshot{}, err
	}
	if !store.Enabled {
		return m.openCodeUsageSnapshot(store), nil
	}
	fingerprint := m.claudeUsageWorktreeFingerprint()
	if !force && store.LastScanCompletedAt != nil && time.Since(time.UnixMilli(*store.LastScanCompletedAt)) < claudeUsageStaleDuration && store.WorktreeFingerprint == fingerprint {
		return m.openCodeUsageSnapshot(store), nil
	}
	started := time.Now().UnixMilli()
	store.LastScanStartedAt = &started
	store.LastScanError = nil
	_ = m.writeOpenCodeUsageStore(store)
	databases, scanErr := m.scanOpenCodeUsageDatabases(ctx, store.Databases)
	if scanErr != nil {
		message := scanErr.Error()
		store.LastScanError = &message
		_ = m.writeOpenCodeUsageStore(store)
		return m.openCodeUsageSnapshot(store), nil
	}
	store.Databases = databases
	store.WorktreeFingerprint = fingerprint
	completed := time.Now().UnixMilli()
	store.LastScanCompletedAt = &completed
	store.LastScanError = nil
	if err := m.writeOpenCodeUsageStore(store); err != nil {
		return OpenCodeUsageNativeSnapshot{}, err
	}
	return m.openCodeUsageSnapshot(store), nil
}

func (m *Manager) openCodeUsageSnapshot(store openCodeUsageStore) OpenCodeUsageNativeSnapshot {
	refs := m.usageWorktreeRefs()
	events := make([]OpenCodeUsageAttributedEvent, 0)
	for _, database := range store.Databases {
		for _, event := range database.Events {
			day := localUsageDay(event.Timestamp)
			if day == "" {
				continue
			}
			key, label, repoID, worktreeID := "unscoped", "Unknown location", "", ""
			if ref := containingUsageWorktree(event.Cwd, refs); ref != nil {
				key, label, repoID, worktreeID = "worktree:"+ref.WorktreeID, ref.DisplayName, ref.RepoID, ref.WorktreeID
			} else if event.Cwd != "" {
				_, label, _, _ = externalUsageLocation(event.Cwd)
				key = "cwd:" + comparableUsagePath(event.Cwd)
			}
			events = append(events, OpenCodeUsageAttributedEvent{
				SessionID: event.SessionID, Timestamp: event.Timestamp, Cwd: event.Cwd, Model: event.Model,
				Day: day, ProjectKey: key, ProjectLabel: label, RepoID: repoID, WorktreeID: worktreeID,
				EstimatedCostUSD: event.EstimatedCostUSD, InputTokens: event.InputTokens,
				CachedInputTokens: event.CachedInputTokens, OutputTokens: event.OutputTokens,
				ReasoningOutputTokens: event.ReasoningOutputTokens, TotalTokens: event.TotalTokens,
			})
		}
	}
	sort.Slice(events, func(i, j int) bool { return events[i].Timestamp < events[j].Timestamp })
	return OpenCodeUsageNativeSnapshot{ScanState: openCodeScanState(store, false), Events: events}
}

func (m *Manager) scanOpenCodeUsageDatabases(ctx context.Context, previous []openCodeUsageDatabase) ([]openCodeUsageDatabase, error) {
	paths := discoverOpenCodeUsageDatabases()
	cached := make(map[string]openCodeUsageDatabase)
	for _, database := range previous {
		cached[database.Path] = database
	}
	result := make([]openCodeUsageDatabase, 0, len(paths))
	for _, path := range paths {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		info, err := os.Stat(path)
		if err != nil {
			continue
		}
		mtime := info.ModTime().UnixMilli()
		walMtime, walSize := openCodeWALFingerprint(path)
		if old, ok := cached[path]; ok && old.MtimeMs == mtime && old.Size == info.Size() && old.WalMtimeMs == walMtime && old.WalSize == walSize {
			result = append(result, old)
			continue
		}
		database, err := sql.Open("sqlite", "file:"+filepath.ToSlash(path)+"?mode=ro")
		if err != nil {
			continue
		}
		events, readErr := readOpenCodeUsageEvents(database)
		_ = database.Close()
		if readErr != nil {
			return nil, readErr
		}
		result = append(result, openCodeUsageDatabase{Path: path, MtimeMs: mtime, Size: info.Size(), WalMtimeMs: walMtime, WalSize: walSize, Events: events})
	}
	return result, nil
}

func openCodeWALFingerprint(databasePath string) (int64, int64) {
	info, err := os.Stat(databasePath + "-wal")
	if err != nil {
		return 0, 0
	}
	return info.ModTime().UnixMilli(), info.Size()
}

func discoverOpenCodeUsageDatabases() []string {
	home, _ := os.UserHomeDir()
	dataHome := strings.TrimSpace(os.Getenv("XDG_DATA_HOME"))
	if dataHome == "" {
		if runtime.GOOS == "windows" {
			dataHome = firstNonEmpty(os.Getenv("LOCALAPPDATA"), os.Getenv("APPDATA"), filepath.Join(home, "AppData", "Local"))
		} else {
			dataHome = filepath.Join(home, ".local", "share")
		}
	}
	dataDir := filepath.Join(dataHome, "opencode")
	if configured := strings.TrimSpace(os.Getenv("OPENCODE_DB")); configured != "" && configured != ":memory:" {
		if !filepath.IsAbs(configured) {
			configured = filepath.Join(dataDir, configured)
		}
		if info, err := os.Stat(configured); err == nil && info.Mode().IsRegular() {
			return []string{configured}
		}
		return []string{}
	}
	entries, err := os.ReadDir(dataDir)
	if err != nil {
		return []string{}
	}
	result := make([]string, 0)
	for _, entry := range entries {
		name := entry.Name()
		if !entry.Type().IsRegular() || !strings.HasPrefix(name, "opencode") || !strings.HasSuffix(name, ".db") {
			continue
		}
		middle := strings.TrimSuffix(strings.TrimPrefix(name, "opencode"), ".db")
		if middle == "" || (strings.HasPrefix(middle, "-") && isOpenCodeDatabaseSuffix(middle[1:])) {
			result = append(result, filepath.Join(dataDir, name))
		}
	}
	sort.Strings(result)
	return result
}

func isOpenCodeDatabaseSuffix(value string) bool {
	if value == "" {
		return false
	}
	for _, char := range value {
		if !(char == '_' || char == '-' || char == '.' || char >= '0' && char <= '9' || char >= 'a' && char <= 'z' || char >= 'A' && char <= 'Z') {
			return false
		}
	}
	return true
}

func (m *Manager) openCodeUsageStorePath() string {
	return filepath.Join(filepath.Dir(m.store.path), "pebble-opencode-usage-native.json")
}

func (m *Manager) openCodeUsageLock() *sync.Mutex {
	value, _ := openCodeUsageLocks.LoadOrStore(m.openCodeUsageStorePath(), &sync.Mutex{})
	return value.(*sync.Mutex)
}

func (m *Manager) readOpenCodeUsageStore() (openCodeUsageStore, error) {
	data, err := os.ReadFile(m.openCodeUsageStorePath())
	if errors.Is(err, os.ErrNotExist) {
		return openCodeUsageStore{Version: 1, Databases: []openCodeUsageDatabase{}}, nil
	}
	if err != nil {
		return openCodeUsageStore{}, err
	}
	var store openCodeUsageStore
	if json.Unmarshal(data, &store) != nil || store.Version != 1 {
		return openCodeUsageStore{}, errors.New("OpenCode usage store is invalid")
	}
	return store, nil
}

func (m *Manager) writeOpenCodeUsageStore(store openCodeUsageStore) error {
	data, err := json.MarshalIndent(store, "", "  ")
	if err != nil {
		return err
	}
	path := m.openCodeUsageStorePath()
	file, err := os.CreateTemp(filepath.Dir(path), ".opencode-usage-*.tmp")
	if err != nil {
		return err
	}
	name := file.Name()
	defer os.Remove(name)
	if _, err = file.Write(data); err == nil {
		err = file.Chmod(0o600)
	}
	if closeErr := file.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	return os.Rename(name, path)
}

func openCodeScanState(store openCodeUsageStore, scanning bool) OpenCodeUsageScanState {
	count := 0
	for _, database := range store.Databases {
		count += len(database.Events)
	}
	return OpenCodeUsageScanState{Enabled: store.Enabled, IsScanning: scanning, LastScanStartedAt: store.LastScanStartedAt, LastScanCompletedAt: store.LastScanCompletedAt, LastScanError: store.LastScanError, HasAnyOpenCodeData: count > 0}
}
