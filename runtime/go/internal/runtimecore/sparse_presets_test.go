package runtimecore

import (
	"path/filepath"
	"reflect"
	"testing"
)

func TestSparsePresetsPersistAndPreserveCreationTime(t *testing.T) {
	dataDir := t.TempDir()
	repoPath := t.TempDir()
	manager, err := NewManager(dataDir, nil)
	if err != nil {
		t.Fatal(err)
	}
	project, err := manager.CreateProject(CreateProjectRequest{Name: "Pebble", Path: repoPath})
	if err != nil {
		t.Fatal(err)
	}
	created, err := manager.SaveSparsePreset(project.ID, SaveSparsePresetRequest{Name: " Web ", Directories: []string{"apps/web", "apps\\web", "packages/ui"}})
	if err != nil {
		t.Fatal(err)
	}
	updated, err := manager.SaveSparsePreset(project.ID, SaveSparsePresetRequest{ID: created.ID, Name: "Frontend", Directories: []string{"apps/web"}})
	if err != nil {
		t.Fatal(err)
	}
	if updated.CreatedAt != created.CreatedAt || updated.Name != "Frontend" {
		t.Fatalf("unexpected update: %#v", updated)
	}
	reloaded, err := NewManager(dataDir, nil)
	if err != nil {
		t.Fatal(err)
	}
	presets, err := reloaded.ListSparsePresets(project.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(presets) != 1 || !reflect.DeepEqual(presets[0].Directories, []string{"apps/web"}) {
		t.Fatalf("unexpected persisted presets: %#v", presets)
	}
}

func TestSparsePresetDirectoriesRejectEscapeAndAbsolutePaths(t *testing.T) {
	for _, directories := range [][]string{{"../secret"}, {filepath.VolumeName(t.TempDir()) + "/absolute"}, {"/absolute"}, {"."}} {
		if _, err := normalizeSparsePresetDirectories(directories); err == nil {
			t.Fatalf("expected rejection for %#v", directories)
		}
	}
}
