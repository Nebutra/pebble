package runtimehttp

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/tsekaluk/pebble/go-runtime/internal/runtimecore"
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
