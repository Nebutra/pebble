package runtimecore

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestDiscoverCodexUsageFilesPrefersMatchedManagedLegacyCopy(t *testing.T) {
	manager, managedHome, systemHome := codexDiscoveryTestManager(t)
	relative := filepath.Join("2026", "session.jsonl")
	source := writeCodexDiscoveryFile(t, filepath.Join(systemHome, ".codex", "sessions", relative), "source")
	target := writeCodexDiscoveryFile(t, filepath.Join(managedHome, "sessions", relative), "source")
	writeLegacyCodexMarker(t, managedHome, relative, source, target)

	files := manager.discoverCodexUsageFiles()
	if len(files) != 1 || files[0].Path != target || files[0].SkipBytes != 0 {
		t.Fatalf("expected only managed legacy copy, got %#v", files)
	}
}

func TestDiscoverCodexUsageFilesSkipsCopiedPrefixAfterBothLogsDiverge(t *testing.T) {
	manager, managedHome, systemHome := codexDiscoveryTestManager(t)
	relative := filepath.Join("2026", "session.jsonl")
	source := writeCodexDiscoveryFile(t, filepath.Join(systemHome, ".codex", "sessions", relative), "prefix")
	target := writeCodexDiscoveryFile(t, filepath.Join(managedHome, "sessions", relative), "prefix")
	writeLegacyCodexMarker(t, managedHome, relative, source, target)
	if err := appendCodexDiscoveryFile(source, "-source"); err != nil {
		t.Fatal(err)
	}
	if err := appendCodexDiscoveryFile(target, "-managed"); err != nil {
		t.Fatal(err)
	}

	files := manager.discoverCodexUsageFiles()
	if len(files) != 2 {
		t.Fatalf("expected both diverged logs, got %#v", files)
	}
	for _, file := range files {
		if file.Path == source && file.SkipBytes != int64(len("prefix")) {
			t.Fatalf("expected source prefix skip, got %#v", file)
		}
	}
}

func codexDiscoveryTestManager(t *testing.T) (*Manager, string, string) {
	t.Helper()
	root := t.TempDir()
	systemHome := filepath.Join(root, "system-home")
	t.Setenv("HOME", systemHome)
	dataDir := filepath.Join(root, "data")
	manager := &Manager{store: &fileStore{path: filepath.Join(dataDir, "state.json")}}
	return manager, filepath.Join(dataDir, "codex-runtime-home", "home"), systemHome
}

func writeCodexDiscoveryFile(t *testing.T, path, content string) string {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func appendCodexDiscoveryFile(path, content string) error {
	file, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	_, writeErr := file.WriteString(content)
	closeErr := file.Close()
	if writeErr != nil {
		return writeErr
	}
	return closeErr
}

func writeLegacyCodexMarker(t *testing.T, managedHome, relative, source, target string) {
	t.Helper()
	sourceInfo, err := os.Stat(source)
	if err != nil {
		t.Fatal(err)
	}
	targetInfo, err := os.Stat(target)
	if err != nil {
		t.Fatal(err)
	}
	marker := legacyCodexSessionCopyMarker{
		SourcePath:    source,
		SourceSize:    sourceInfo.Size(),
		SourceMtimeMs: float64(sourceInfo.ModTime().UnixNano()) / 1e6,
		TargetSize:    targetInfo.Size(),
		TargetMtimeMs: float64(targetInfo.ModTime().UnixNano()) / 1e6,
	}
	data, err := json.Marshal(marker)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(managedHome, ".pebble-session-copies", relative+".json")
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
}
