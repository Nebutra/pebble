package runtimehttp

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/nebutra/pebble/runtime/go/internal/runtimecore"
)

func TestSshTargetRoutesCRUD(t *testing.T) {
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	server := NewServer(manager)

	body, _ := json.Marshal(map[string]interface{}{"host": "route.example", "username": "deploy"})
	req := httptest.NewRequest(http.MethodPost, "/v1/ssh-targets", bytes.NewReader(body))
	rec := httptest.NewRecorder()
	server.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", rec.Code, rec.Body.String())
	}
	var created runtimecore.SshTarget
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	if created.ID == "" || created.Port != 22 {
		t.Fatalf("unexpected created target %+v", created)
	}

	listReq := httptest.NewRequest(http.MethodGet, "/v1/ssh-targets", nil)
	listRec := httptest.NewRecorder()
	server.ServeHTTP(listRec, listReq)
	var listed []runtimecore.SshTarget
	if err := json.Unmarshal(listRec.Body.Bytes(), &listed); err != nil {
		t.Fatal(err)
	}
	if len(listed) != 1 {
		t.Fatalf("expected 1 target, got %d", len(listed))
	}

	patch, _ := json.Marshal(map[string]interface{}{"label": "renamed"})
	patchReq := httptest.NewRequest(http.MethodPatch, "/v1/ssh-targets/"+created.ID, bytes.NewReader(patch))
	patchRec := httptest.NewRecorder()
	server.ServeHTTP(patchRec, patchReq)
	if patchRec.Code != http.StatusOK {
		t.Fatalf("expected 200 on patch, got %d: %s", patchRec.Code, patchRec.Body.String())
	}

	delReq := httptest.NewRequest(http.MethodDelete, "/v1/ssh-targets/"+created.ID, nil)
	delRec := httptest.NewRecorder()
	server.ServeHTTP(delRec, delReq)
	if delRec.Code != http.StatusOK {
		t.Fatalf("expected 200 on delete, got %d", delRec.Code)
	}
}

func TestSshTargetProbeRouteMissing(t *testing.T) {
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	server := NewServer(manager)
	req := httptest.NewRequest(http.MethodPost, "/v1/ssh-targets/missing/probe", nil)
	rec := httptest.NewRecorder()
	server.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404 for unknown target probe, got %d", rec.Code)
	}
}

func TestSshTargetTerminalCapabilitiesRouteMissing(t *testing.T) {
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	server := NewServer(manager)
	req := httptest.NewRequest(http.MethodGet, "/v1/ssh-targets/missing/terminal-capabilities", nil)
	rec := httptest.NewRecorder()
	server.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404 for unknown target capabilities, got %d", rec.Code)
	}
}

func TestSshTargetBrowseRouteMissingAndCancelled(t *testing.T) {
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	server := NewServer(manager)

	missingBody := bytes.NewBufferString(`{"path":"C:\\Users\\Dev User"}`)
	missingReq := httptest.NewRequest(http.MethodPost, "/v1/ssh-targets/missing/browse", missingBody)
	missingRec := httptest.NewRecorder()
	server.ServeHTTP(missingRec, missingReq)
	if missingRec.Code != http.StatusNotFound {
		t.Fatalf("expected 404 for unknown browse target, got %d: %s", missingRec.Code, missingRec.Body.String())
	}

	target, err := manager.CreateSshTarget(runtimecore.SshTargetInput{Host: "cancelled.example"})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	cancelledReq := httptest.NewRequest(http.MethodPost, "/v1/ssh-targets/"+target.ID+"/browse", bytes.NewBufferString(`{"path":"\\\\server\\Shared Projects"}`)).WithContext(ctx)
	cancelledRec := httptest.NewRecorder()
	server.ServeHTTP(cancelledRec, cancelledReq)
	if cancelledRec.Code != http.StatusBadRequest {
		t.Fatalf("expected bounded cancellation error, got %d: %s", cancelledRec.Code, cancelledRec.Body.String())
	}
	var payload map[string]string
	if err := json.Unmarshal(cancelledRec.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(payload["error"], context.Canceled.Error()) {
		t.Fatalf("expected cancellation response, got %#v", payload)
	}
}
