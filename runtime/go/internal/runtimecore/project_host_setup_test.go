package runtimecore

import "testing"

func TestProjectHostSetupCrudPersists(t *testing.T) {
	stateDir := t.TempDir()
	manager, err := NewManager(stateDir, nil)
	if err != nil {
		t.Fatal(err)
	}
	project, err := manager.CreateProject(CreateProjectRequest{Name: "Pebble", Path: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	created, err := manager.CreateProjectHostSetup(CreateProjectHostSetupRequest{
		ProjectID:   "repo:" + project.ID,
		HostID:      "runtime:gpu-vm",
		SetupID:     "pebble::gpu-vm",
		DisplayName: "GPU VM",
		SetupState:  "setting-up",
		SetupMethod: "provisioned",
	})
	if err != nil {
		t.Fatal(err)
	}
	updatedPath := "/srv/pebble"
	updatedState := "ready"
	updated, err := manager.UpdateProjectHostSetup(created.ID, UpdateProjectHostSetupRequest{
		Path:       &updatedPath,
		SetupState: &updatedState,
	})
	if err != nil {
		t.Fatal(err)
	}
	if updated.Path != updatedPath || updated.SetupState != "ready" {
		t.Fatalf("unexpected setup update: %#v", updated)
	}

	reloaded, err := NewManager(stateDir, nil)
	if err != nil {
		t.Fatal(err)
	}
	setups := reloaded.ListProjectHostSetups()
	if len(setups) != 1 || setups[0].ID != created.ID || setups[0].Path != updatedPath {
		t.Fatalf("setup did not survive reload: %#v", setups)
	}
	if _, err := reloaded.DeleteProjectHostSetup(created.ID); err != nil {
		t.Fatal(err)
	}
	if len(reloaded.ListProjectHostSetups()) != 0 {
		t.Fatal("setup was not deleted")
	}
}

func TestProjectHostSetupRejectsDuplicateHost(t *testing.T) {
	manager, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	project, err := manager.CreateProject(CreateProjectRequest{Name: "Pebble", Path: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	req := CreateProjectHostSetupRequest{ProjectID: "repo:" + project.ID, HostID: "runtime:gpu-vm"}
	if _, err := manager.CreateProjectHostSetup(req); err != nil {
		t.Fatal(err)
	}
	if _, err := manager.CreateProjectHostSetup(req); err == nil {
		t.Fatal("expected duplicate project/host setup to be rejected")
	}
}
