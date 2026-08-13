package runtimecore

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestSnapshotStoreKeepsTheContentThatIsAboutToBeReplaced(t *testing.T) {
	dir := t.TempDir()
	store := filepath.Join(dir, "runtime-state.json")
	if err := os.WriteFile(store, []byte(`{"projects":["kept"]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	day := time.Date(2026, time.August, 13, 9, 0, 0, 0, time.UTC)

	snapshotStoreForDay(store, day)

	saved, err := os.ReadFile(store + storeBackupSuffix + "2026-08-13")
	if err != nil {
		t.Fatalf("the replaced content was not kept: %v", err)
	}
	if string(saved) != `{"projects":["kept"]}` {
		t.Fatalf("snapshot does not match what was on disk: %s", saved)
	}
}

func TestSnapshotStoreDoesNotOverwriteTheDaysFirstSnapshot(t *testing.T) {
	dir := t.TempDir()
	store := filepath.Join(dir, "runtime-state.json")
	day := time.Date(2026, time.August, 13, 9, 0, 0, 0, time.UTC)
	if err := os.WriteFile(store, []byte(`{"projects":["morning"]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	snapshotStoreForDay(store, day)

	// Why: save runs on every state change. If each one rotated, the state that
	// emptied the store would overwrite every good copy within seconds — which
	// is the exact loss this is meant to survive.
	if err := os.WriteFile(store, []byte(`{"projects":[]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	snapshotStoreForDay(store, day.Add(6*time.Hour))

	saved, err := os.ReadFile(store + storeBackupSuffix + "2026-08-13")
	if err != nil {
		t.Fatal(err)
	}
	if string(saved) != `{"projects":["morning"]}` {
		t.Fatalf("a later save replaced the day's good snapshot: %s", saved)
	}
}

func TestSnapshotStoreKeepsABoundedHistory(t *testing.T) {
	dir := t.TempDir()
	store := filepath.Join(dir, "runtime-state.json")
	start := time.Date(2026, time.August, 10, 9, 0, 0, 0, time.UTC)
	for day := 0; day < 6; day++ {
		if err := os.WriteFile(store, []byte(`{"day":`+time.Duration(day).String()+`}`), 0o600); err != nil {
			t.Fatal(err)
		}
		snapshotStoreForDay(store, start.AddDate(0, 0, day))
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	backups := 0
	for _, entry := range entries {
		if entry.Name() != "runtime-state.json" {
			backups++
		}
	}
	if backups != storeBackupRetention {
		t.Fatalf("expected %d snapshots retained, found %d", storeBackupRetention, backups)
	}
	// The oldest must be the one dropped, not an arbitrary entry.
	if _, err := os.Stat(store + storeBackupSuffix + "2026-08-10"); !os.IsNotExist(err) {
		t.Fatal("the oldest snapshot should have been pruned")
	}
	if _, err := os.Stat(store + storeBackupSuffix + "2026-08-15"); err != nil {
		t.Fatal("the newest snapshot must survive pruning")
	}
}

func TestSnapshotStoreIgnoresAMissingOrEmptyStore(t *testing.T) {
	dir := t.TempDir()
	store := filepath.Join(dir, "runtime-state.json")
	day := time.Date(2026, time.August, 13, 9, 0, 0, 0, time.UTC)

	snapshotStoreForDay(store, day)
	if err := os.WriteFile(store, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	snapshotStoreForDay(store, day)

	// Why: an empty first run must not manufacture an empty "known good" copy
	// that a later recovery would happily restore.
	if _, err := os.Stat(store + storeBackupSuffix + "2026-08-13"); !os.IsNotExist(err) {
		t.Fatal("nothing worth keeping should have produced no snapshot")
	}
}
