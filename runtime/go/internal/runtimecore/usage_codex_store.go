package runtimecore

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

type CodexUsageAttributedEvent struct {
	SessionID             string `json:"sessionId"`
	Timestamp             string `json:"timestamp"`
	Cwd                   string `json:"cwd,omitempty"`
	Model                 string `json:"model,omitempty"`
	Day                   string `json:"day"`
	ProjectKey            string `json:"projectKey"`
	ProjectLabel          string `json:"projectLabel"`
	RepoID                string `json:"repoId,omitempty"`
	WorktreeID            string `json:"worktreeId,omitempty"`
	HasInferredPricing    bool   `json:"hasInferredPricing"`
	InputTokens           int64  `json:"inputTokens"`
	CachedInputTokens     int64  `json:"cachedInputTokens"`
	OutputTokens          int64  `json:"outputTokens"`
	ReasoningOutputTokens int64  `json:"reasoningOutputTokens"`
	TotalTokens           int64  `json:"totalTokens"`
}

type CodexUsageScanState struct {
	Enabled             bool    `json:"enabled"`
	IsScanning          bool    `json:"isScanning"`
	LastScanStartedAt   *int64  `json:"lastScanStartedAt"`
	LastScanCompletedAt *int64  `json:"lastScanCompletedAt"`
	LastScanError       *string `json:"lastScanError"`
	HasAnyCodexData     bool    `json:"hasAnyCodexData"`
}

type CodexUsageNativeSnapshot struct {
	ScanState CodexUsageScanState         `json:"scanState"`
	Events    []CodexUsageAttributedEvent `json:"events"`
}
type codexUsageFile struct {
	Path      string            `json:"path"`
	MtimeMs   int64             `json:"mtimeMs"`
	Size      int64             `json:"size"`
	SkipBytes int64             `json:"skipBytes,omitempty"`
	Events    []codexUsageEvent `json:"events"`
}
type codexUsageStore struct {
	Version             int              `json:"version"`
	Enabled             bool             `json:"enabled"`
	LastScanStartedAt   *int64           `json:"lastScanStartedAt"`
	LastScanCompletedAt *int64           `json:"lastScanCompletedAt"`
	LastScanError       *string          `json:"lastScanError"`
	WorktreeFingerprint string           `json:"worktreeFingerprint"`
	Files               []codexUsageFile `json:"files"`
}

var codexUsageLocks sync.Map

func (m *Manager) CodexUsageState() (CodexUsageScanState, error) {
	lock := m.codexUsageLock()
	lock.Lock()
	defer lock.Unlock()
	store, err := m.readCodexUsageStore()
	return codexScanState(store, false), err
}
func (m *Manager) SetCodexUsageEnabled(enabled bool) (CodexUsageScanState, error) {
	lock := m.codexUsageLock()
	lock.Lock()
	defer lock.Unlock()
	store, err := m.readCodexUsageStore()
	if err != nil {
		return CodexUsageScanState{}, err
	}
	store.Enabled = enabled
	err = m.writeCodexUsageStore(store)
	return codexScanState(store, false), err
}
func (m *Manager) RefreshCodexUsage(ctx context.Context, force bool) (CodexUsageNativeSnapshot, error) {
	lock := m.codexUsageLock()
	lock.Lock()
	defer lock.Unlock()
	store, err := m.readCodexUsageStore()
	if err != nil {
		return CodexUsageNativeSnapshot{}, err
	}
	if !store.Enabled {
		return m.codexUsageSnapshot(store), nil
	}
	fingerprint := m.claudeUsageWorktreeFingerprint()
	if !force && store.LastScanCompletedAt != nil && time.Since(time.UnixMilli(*store.LastScanCompletedAt)) < claudeUsageStaleDuration && store.WorktreeFingerprint == fingerprint {
		return m.codexUsageSnapshot(store), nil
	}
	started := time.Now().UnixMilli()
	store.LastScanStartedAt = &started
	store.LastScanError = nil
	_ = m.writeCodexUsageStore(store)
	files, scanErr := m.scanCodexUsageFiles(ctx, store.Files)
	if scanErr != nil {
		message := scanErr.Error()
		store.LastScanError = &message
		_ = m.writeCodexUsageStore(store)
		return m.codexUsageSnapshot(store), nil
	}
	store.Files = files
	store.WorktreeFingerprint = fingerprint
	completed := time.Now().UnixMilli()
	store.LastScanCompletedAt = &completed
	store.LastScanError = nil
	if err = m.writeCodexUsageStore(store); err != nil {
		return CodexUsageNativeSnapshot{}, err
	}
	return m.codexUsageSnapshot(store), nil
}
func (m *Manager) codexUsageSnapshot(store codexUsageStore) CodexUsageNativeSnapshot {
	refs := m.usageWorktreeRefs()
	events := []CodexUsageAttributedEvent{}
	for _, file := range store.Files {
		for _, event := range file.Events {
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
			events = append(events, CodexUsageAttributedEvent{SessionID: event.SessionID, Timestamp: event.Timestamp, Cwd: event.Cwd, Model: event.Model, Day: day, ProjectKey: key, ProjectLabel: label, RepoID: repoID, WorktreeID: worktreeID, HasInferredPricing: event.HasInferredPricing, InputTokens: event.InputTokens, CachedInputTokens: event.CachedInputTokens, OutputTokens: event.OutputTokens, ReasoningOutputTokens: event.ReasoningOutputTokens, TotalTokens: event.TotalTokens})
		}
	}
	sort.Slice(events, func(i, j int) bool { return events[i].Timestamp < events[j].Timestamp })
	return CodexUsageNativeSnapshot{ScanState: codexScanState(store, false), Events: events}
}
func (m *Manager) scanCodexUsageFiles(ctx context.Context, previous []codexUsageFile) ([]codexUsageFile, error) {
	filesToScan := m.discoverCodexUsageFiles()
	cached := map[string]codexUsageFile{}
	for _, file := range previous {
		cached[file.Path] = file
	}
	files := []codexUsageFile{}
	for _, candidate := range filesToScan {
		path := candidate.Path
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
		if old, ok := cached[path]; ok && old.MtimeMs == mtime && old.Size == info.Size() && old.SkipBytes == candidate.SkipBytes {
			files = append(files, old)
			continue
		}
		input, err := os.Open(path)
		if err != nil {
			continue
		}
		var reader io.Reader = input
		if candidate.SkipBytes > 0 {
			if _, err := input.Seek(candidate.SkipBytes, io.SeekStart); err != nil {
				_ = input.Close()
				continue
			}
			reader = input
		}
		events, readErr := readCodexUsageEvents(reader, strings.TrimSuffix(filepath.Base(path), filepath.Ext(path)))
		_ = input.Close()
		if readErr != nil {
			return nil, readErr
		}
		files = append(files, codexUsageFile{Path: path, MtimeMs: mtime, Size: info.Size(), SkipBytes: candidate.SkipBytes, Events: events})
	}
	return files, nil
}
func (m *Manager) codexUsageStorePath() string {
	return filepath.Join(filepath.Dir(m.store.path), "pebble-codex-usage-native.json")
}
func (m *Manager) codexUsageLock() *sync.Mutex {
	value, _ := codexUsageLocks.LoadOrStore(m.codexUsageStorePath(), &sync.Mutex{})
	return value.(*sync.Mutex)
}
func (m *Manager) readCodexUsageStore() (codexUsageStore, error) {
	data, err := os.ReadFile(m.codexUsageStorePath())
	if errors.Is(err, os.ErrNotExist) {
		return codexUsageStore{Version: 1, Files: []codexUsageFile{}}, nil
	}
	if err != nil {
		return codexUsageStore{}, err
	}
	var store codexUsageStore
	if json.Unmarshal(data, &store) != nil || store.Version != 1 {
		return codexUsageStore{}, errors.New("Codex usage store is invalid")
	}
	return store, nil
}
func (m *Manager) writeCodexUsageStore(store codexUsageStore) error {
	data, err := json.MarshalIndent(store, "", "  ")
	if err != nil {
		return err
	}
	path := m.codexUsageStorePath()
	file, err := os.CreateTemp(filepath.Dir(path), ".codex-usage-*.tmp")
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
func codexScanState(store codexUsageStore, scanning bool) CodexUsageScanState {
	count := 0
	for _, file := range store.Files {
		count += len(file.Events)
	}
	return CodexUsageScanState{Enabled: store.Enabled, IsScanning: scanning, LastScanStartedAt: store.LastScanStartedAt, LastScanCompletedAt: store.LastScanCompletedAt, LastScanError: store.LastScanError, HasAnyCodexData: count > 0}
}
