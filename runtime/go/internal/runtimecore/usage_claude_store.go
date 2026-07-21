package runtimecore

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

const claudeUsageStoreVersion = 1
const claudeUsageStaleDuration = 5 * time.Minute

type ClaudeUsageScanState struct {
	Enabled             bool    `json:"enabled"`
	IsScanning          bool    `json:"isScanning"`
	LastScanStartedAt   *int64  `json:"lastScanStartedAt"`
	LastScanCompletedAt *int64  `json:"lastScanCompletedAt"`
	LastScanError       *string `json:"lastScanError"`
	HasAnyClaudeData    bool    `json:"hasAnyClaudeData"`
}

type ClaudeUsageNativeSnapshot struct {
	ScanState ClaudeUsageScanState        `json:"scanState"`
	Turns     []ClaudeUsageAttributedTurn `json:"turns"`
}

type claudeUsageProcessedFile struct {
	Path    string            `json:"path"`
	MtimeMs int64             `json:"mtimeMs"`
	Size    int64             `json:"size"`
	Turns   []claudeUsageTurn `json:"turns"`
}

type claudeUsageStore struct {
	Version             int                        `json:"version"`
	Enabled             bool                       `json:"enabled"`
	LastScanStartedAt   *int64                     `json:"lastScanStartedAt"`
	LastScanCompletedAt *int64                     `json:"lastScanCompletedAt"`
	LastScanError       *string                    `json:"lastScanError"`
	WorktreeFingerprint string                     `json:"worktreeFingerprint"`
	Files               []claudeUsageProcessedFile `json:"files"`
}

var claudeUsageLocks sync.Map

func (m *Manager) SetClaudeUsageEnabled(enabled bool) (ClaudeUsageScanState, error) {
	lock := m.claudeUsageLock()
	lock.Lock()
	defer lock.Unlock()
	store, err := m.readClaudeUsageStore()
	if err != nil {
		return ClaudeUsageScanState{}, err
	}
	store.Enabled = enabled
	if err := m.writeClaudeUsageStore(store); err != nil {
		return ClaudeUsageScanState{}, err
	}
	return claudeScanState(store, false), nil
}

func (m *Manager) ClaudeUsageState() (ClaudeUsageScanState, error) {
	lock := m.claudeUsageLock()
	lock.Lock()
	defer lock.Unlock()
	store, err := m.readClaudeUsageStore()
	if err != nil {
		return ClaudeUsageScanState{}, err
	}
	return claudeScanState(store, false), nil
}

func (m *Manager) RefreshClaudeUsage(ctx context.Context, force bool) (ClaudeUsageNativeSnapshot, error) {
	lock := m.claudeUsageLock()
	lock.Lock()
	defer lock.Unlock()
	store, err := m.readClaudeUsageStore()
	if err != nil {
		return ClaudeUsageNativeSnapshot{}, err
	}
	if !store.Enabled {
		return m.claudeUsageSnapshot(store), nil
	}
	fingerprint := m.claudeUsageWorktreeFingerprint()
	if !force && store.LastScanCompletedAt != nil && time.Since(time.UnixMilli(*store.LastScanCompletedAt)) < claudeUsageStaleDuration && store.WorktreeFingerprint == fingerprint {
		return m.claudeUsageSnapshot(store), nil
	}
	started := time.Now().UnixMilli()
	store.LastScanStartedAt = &started
	store.LastScanError = nil
	if err := m.writeClaudeUsageStore(store); err != nil {
		return ClaudeUsageNativeSnapshot{}, err
	}
	files, scanErr := scanClaudeUsageIncremental(ctx, discoverClaudeUsageFiles(), store.Files)
	if scanErr != nil {
		message := scanErr.Error()
		store.LastScanError = &message
		_ = m.writeClaudeUsageStore(store)
		return m.claudeUsageSnapshot(store), nil
	}
	store.Files = files
	store.WorktreeFingerprint = fingerprint
	completed := time.Now().UnixMilli()
	store.LastScanCompletedAt = &completed
	store.LastScanError = nil
	if err := m.writeClaudeUsageStore(store); err != nil {
		return ClaudeUsageNativeSnapshot{}, err
	}
	return m.claudeUsageSnapshot(store), nil
}

func (m *Manager) claudeUsageSnapshot(store claudeUsageStore) ClaudeUsageNativeSnapshot {
	refs := m.usageWorktreeRefs()
	turns := make([]ClaudeUsageAttributedTurn, 0)
	for _, file := range store.Files {
		turns = append(turns, attributeClaudeUsageTurns(file.Turns, refs)...)
	}
	sort.Slice(turns, func(i, j int) bool { return turns[i].Timestamp < turns[j].Timestamp })
	return ClaudeUsageNativeSnapshot{ScanState: claudeScanState(store, false), Turns: turns}
}

func scanClaudeUsageIncremental(ctx context.Context, paths []string, previous []claudeUsageProcessedFile) ([]claudeUsageProcessedFile, error) {
	previousByPath := map[string]claudeUsageProcessedFile{}
	for _, file := range previous {
		previousByPath[file.Path] = file
	}
	files := make([]claudeUsageProcessedFile, 0, len(paths))
	for _, path := range paths {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		default:
		}
		info, err := os.Stat(path)
		if err != nil {
			continue
		}
		mtime := info.ModTime().UnixMilli()
		if cached, ok := previousByPath[path]; ok && cached.MtimeMs == mtime && cached.Size == info.Size() {
			files = append(files, cached)
			continue
		}
		input, err := os.Open(path)
		if err != nil {
			continue
		}
		turns, readErr := readClaudeUsageTurns(input, strings.TrimSuffix(filepath.Base(path), filepath.Ext(path)))
		_ = input.Close()
		if readErr != nil {
			return nil, readErr
		}
		files = append(files, claudeUsageProcessedFile{Path: path, MtimeMs: mtime, Size: info.Size(), Turns: turns})
	}
	return files, nil
}

func attributeClaudeUsageTurns(turns []claudeUsageTurn, refs []usageWorktreeRef) []ClaudeUsageAttributedTurn {
	result := make([]ClaudeUsageAttributedTurn, 0, len(turns))
	for _, turn := range turns {
		day := localUsageDay(turn.Timestamp)
		if day == "" {
			continue
		}
		projectKey, projectLabel, repoID, worktreeID := externalUsageLocation(turn.Cwd)
		if ref := containingUsageWorktree(turn.Cwd, refs); ref != nil {
			projectKey, projectLabel, repoID, worktreeID = ref.WorktreeID, ref.DisplayName, ref.RepoID, ref.WorktreeID
		}
		result = append(result, ClaudeUsageAttributedTurn{SessionID: turn.SessionID, Timestamp: turn.Timestamp, Model: turn.Model, Cwd: turn.Cwd, GitBranch: turn.GitBranch, Day: day, ProjectKey: projectKey, ProjectLabel: projectLabel, RepoID: repoID, WorktreeID: worktreeID, InputTokens: turn.InputTokens, OutputTokens: turn.OutputTokens, CacheReadTokens: turn.CacheReadTokens, CacheWriteTokens: turn.CacheWriteTokens})
	}
	return result
}

func (m *Manager) claudeUsageStorePath() string {
	return filepath.Join(filepath.Dir(m.store.path), "pebble-claude-usage-native.json")
}
func (m *Manager) claudeUsageLock() *sync.Mutex {
	value, _ := claudeUsageLocks.LoadOrStore(m.claudeUsageStorePath(), &sync.Mutex{})
	return value.(*sync.Mutex)
}
func (m *Manager) readClaudeUsageStore() (claudeUsageStore, error) {
	data, err := os.ReadFile(m.claudeUsageStorePath())
	if errors.Is(err, os.ErrNotExist) {
		return claudeUsageStore{Version: claudeUsageStoreVersion, Files: []claudeUsageProcessedFile{}}, nil
	}
	if err != nil {
		return claudeUsageStore{}, err
	}
	var store claudeUsageStore
	if json.Unmarshal(data, &store) != nil || store.Version != claudeUsageStoreVersion {
		return claudeUsageStore{}, errors.New("Claude usage store is invalid")
	}
	return store, nil
}
func (m *Manager) writeClaudeUsageStore(store claudeUsageStore) error {
	data, err := json.MarshalIndent(store, "", "  ")
	if err != nil {
		return err
	}
	path := m.claudeUsageStorePath()
	temporary, err := os.CreateTemp(filepath.Dir(path), ".claude-usage-*.tmp")
	if err != nil {
		return err
	}
	name := temporary.Name()
	defer os.Remove(name)
	if _, err = temporary.Write(data); err == nil {
		err = temporary.Chmod(0o600)
	}
	if closeErr := temporary.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	return os.Rename(name, path)
}
func (m *Manager) claudeUsageWorktreeFingerprint() string {
	refs := m.usageWorktreeRefs()
	rows := make([]string, len(refs))
	for index, ref := range refs {
		rows[index] = ref.RepoID + "\x00" + ref.WorktreeID + "\x00" + ref.Path + "\x00" + ref.DisplayName
	}
	sort.Strings(rows)
	return strings.Join(rows, "\n")
}
func claudeScanState(store claudeUsageStore, scanning bool) ClaudeUsageScanState {
	count := 0
	for _, file := range store.Files {
		count += len(file.Turns)
	}
	return ClaudeUsageScanState{Enabled: store.Enabled, IsScanning: scanning, LastScanStartedAt: store.LastScanStartedAt, LastScanCompletedAt: store.LastScanCompletedAt, LastScanError: store.LastScanError, HasAnyClaudeData: count > 0}
}
