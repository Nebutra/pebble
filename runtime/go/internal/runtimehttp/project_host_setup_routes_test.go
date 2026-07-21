package runtimehttp

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/nebutra/pebble/runtime/go/internal/runtimecore"
)

func TestProjectHostSetupRoutesCrud(t *testing.T) {
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	project, err := manager.CreateProject(runtimecore.CreateProjectRequest{
		Name: "Pebble",
		Path: t.TempDir(),
	})
	if err != nil {
		t.Fatal(err)
	}
	server := NewServer(manager)
	created := requestProjectHostSetup[runtimecore.ProjectHostSetup](t, server, http.MethodPost, "/v1/project-host-setups", map[string]any{
		"setupId": "pebble::gpu-vm", "projectId": "repo:" + project.ID,
		"hostId": "runtime:gpu-vm", "displayName": "GPU VM",
		"setupState": "setting-up", "setupMethod": "provisioned",
	}, http.StatusCreated)
	if created.ID != "pebble::gpu-vm" || created.ProjectID != "repo:"+project.ID {
		t.Fatalf("unexpected created setup: %#v", created)
	}

	setups := requestProjectHostSetup[[]runtimecore.ProjectHostSetup](t, server, http.MethodGet, "/v1/project-host-setups", nil, http.StatusOK)
	if len(setups) != 1 || setups[0].ID != created.ID {
		t.Fatalf("unexpected setup list: %#v", setups)
	}

	updated := requestProjectHostSetup[runtimecore.ProjectHostSetup](t, server, http.MethodPatch, "/v1/project-host-setups/"+created.ID, map[string]any{
		"setupState": "ready", "path": "/srv/pebble",
	}, http.StatusOK)
	if updated.SetupState != "ready" || updated.Path != "/srv/pebble" {
		t.Fatalf("unexpected updated setup: %#v", updated)
	}

	deleted := requestProjectHostSetup[runtimecore.ProjectHostSetup](t, server, http.MethodDelete, "/v1/project-host-setups/"+created.ID, nil, http.StatusOK)
	if deleted.ID != created.ID {
		t.Fatalf("unexpected deleted setup: %#v", deleted)
	}
	setups = requestProjectHostSetup[[]runtimecore.ProjectHostSetup](t, server, http.MethodGet, "/v1/project-host-setups", nil, http.StatusOK)
	if len(setups) != 0 {
		t.Fatalf("expected empty setup list, got %#v", setups)
	}
}

func requestProjectHostSetup[T any](t *testing.T, server http.Handler, method string, path string, body any, expectedStatus int) T {
	t.Helper()
	var encoded []byte
	var err error
	if body != nil {
		encoded, err = json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
	}
	req := httptest.NewRequest(method, path, bytes.NewReader(encoded))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	server.ServeHTTP(rec, req)
	if rec.Code != expectedStatus {
		t.Fatalf("%s %s: expected %d, got %d: %s", method, path, expectedStatus, rec.Code, rec.Body.String())
	}
	var result T
	if err := json.Unmarshal(rec.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	return result
}
