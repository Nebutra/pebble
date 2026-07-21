package runtimecore

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestFileStoreSaveWritesSchemaVersionAndReplacesState(t *testing.T) {
	store, err := newFileStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := store.save(persistedState{RelayID: "relay_first"}); err != nil {
		t.Fatal(err)
	}
	if err := store.save(persistedState{RelayID: "relay_second"}); err != nil {
		t.Fatal(err)
	}

	content, err := os.ReadFile(store.path)
	if err != nil {
		t.Fatal(err)
	}
	var raw map[string]interface{}
	if err := json.Unmarshal(content, &raw); err != nil {
		t.Fatal(err)
	}
	if got := int(raw["schemaVersion"].(float64)); got != persistedStateSchemaVersion {
		t.Fatalf("expected schema version %d, got %d", persistedStateSchemaVersion, got)
	}
	if got := raw["relayId"]; got != "relay_second" {
		t.Fatalf("expected replacement state, got %v", got)
	}

	loaded, err := store.load()
	if err != nil {
		t.Fatal(err)
	}
	if loaded.RelayID != "relay_second" {
		t.Fatalf("expected loaded replacement state, got %#v", loaded)
	}
}

func TestFileStoreLoadsLegacyStateWithoutSchemaVersion(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "runtime-state.json"), []byte(`{"relayId":"relay_legacy"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	store, err := newFileStore(dir)
	if err != nil {
		t.Fatal(err)
	}

	loaded, err := store.load()
	if err != nil {
		t.Fatal(err)
	}
	if loaded.RelayID != "relay_legacy" {
		t.Fatalf("expected legacy state to load, got %#v", loaded)
	}
}

func TestFileStoreRejectsFutureSchemaVersion(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "runtime-state.json"), []byte(`{"schemaVersion":999,"relayId":"relay_future"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	store, err := newFileStore(dir)
	if err != nil {
		t.Fatal(err)
	}

	if _, err := store.load(); err == nil {
		t.Fatal("expected future schema version to be rejected")
	}
}
