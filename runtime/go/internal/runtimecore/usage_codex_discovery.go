package runtimecore

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

type codexUsageScanFile struct {
	Path      string
	SkipBytes int64
}

type legacyCodexSessionCopyMarker struct {
	SourcePath    string  `json:"sourcePath"`
	SourceSize    int64   `json:"sourceSize"`
	SourceMtimeMs float64 `json:"sourceMtimeMs"`
	TargetSize    int64   `json:"targetSize"`
	TargetMtimeMs float64 `json:"targetMtimeMs"`
}

type legacyCodexScanPreference struct {
	sourcePath      string
	preferManaged   bool
	sourceSkipBytes int64
	hasSourceSkip   bool
}

func (m *Manager) discoverCodexUsageFiles() []codexUsageScanFile {
	managedHome := filepath.Join(filepath.Dir(m.store.path), "codex-runtime-home", "home")
	managedRoot := filepath.Join(managedHome, "sessions")
	home, _ := os.UserHomeDir()
	paths := walkCodexUsageFiles([]string{managedRoot, filepath.Join(home, ".codex", "sessions")})
	excluded := make([]string, 0)
	skips := make(map[string]int64)
	for _, path := range paths {
		preference := readLegacyCodexScanPreference(managedHome, managedRoot, path)
		if preference == nil {
			continue
		}
		if preference.hasSourceSkip {
			if preference.sourceSkipBytes > skips[preference.sourcePath] {
				skips[preference.sourcePath] = preference.sourceSkipBytes
			}
			continue
		}
		if preference.preferManaged {
			excluded = append(excluded, preference.sourcePath)
		} else {
			excluded = append(excluded, path)
		}
	}

	seen := make([]string, 0)
	result := make([]codexUsageScanFile, 0, len(paths))
	for _, path := range paths {
		if codexPathAliasesAny(path, excluded) || codexPathAliasesAny(path, seen) {
			continue
		}
		seen = append(seen, path)
		result = append(result, codexUsageScanFile{Path: path, SkipBytes: skips[path]})
	}
	return result
}

func walkCodexUsageFiles(roots []string) []string {
	files := make([]string, 0)
	for _, root := range roots {
		_ = filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
			if err == nil && entry.Type().IsRegular() && strings.EqualFold(filepath.Ext(entry.Name()), ".jsonl") {
				files = append(files, path)
			}
			return nil
		})
	}
	sort.Strings(files)
	return files
}

func readLegacyCodexScanPreference(managedHome, managedRoot, path string) *legacyCodexScanPreference {
	relative, err := filepath.Rel(managedRoot, path)
	if err != nil || relative == "." || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) || filepath.IsAbs(relative) {
		return nil
	}
	markerPath := filepath.Join(managedHome, ".pebble-session-copies", relative+".json")
	data, err := os.ReadFile(markerPath)
	if err != nil {
		return nil
	}
	var marker legacyCodexSessionCopyMarker
	if json.Unmarshal(data, &marker) != nil || strings.TrimSpace(marker.SourcePath) == "" {
		return nil
	}
	targetMatches := codexFileMatchesMarker(path, marker.TargetSize, marker.TargetMtimeMs)
	sourceMatches := codexFileMatchesMarker(marker.SourcePath, marker.SourceSize, marker.SourceMtimeMs)
	return &legacyCodexScanPreference{
		sourcePath:      marker.SourcePath,
		preferManaged:   !targetMatches || sourceMatches,
		sourceSkipBytes: marker.SourceSize,
		hasSourceSkip:   !targetMatches && !sourceMatches,
	}
}

func codexFileMatchesMarker(path string, size int64, mtimeMs float64) bool {
	info, err := os.Lstat(path)
	if err != nil {
		return false
	}
	return info.Size() == size && float64(info.ModTime().UnixNano())/1e6 == mtimeMs
}

func codexPathAliasesAny(path string, candidates []string) bool {
	info, err := os.Stat(path)
	if err != nil {
		return false
	}
	for _, candidate := range candidates {
		candidateInfo, candidateErr := os.Stat(candidate)
		if candidateErr == nil && os.SameFile(info, candidateInfo) {
			return true
		}
	}
	return false
}
