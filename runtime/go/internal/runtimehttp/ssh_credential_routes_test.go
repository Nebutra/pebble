package runtimehttp

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/nebutra/pebble/runtime/go/internal/runtimecore"
)

func newSshCredentialTestServer(t *testing.T) (*Server, runtimecore.SshTarget) {
	t.Helper()
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	target, err := manager.CreateSshTarget(runtimecore.SshTargetInput{Host: "route.example"})
	if err != nil {
		t.Fatal(err)
	}
	required := true
	target, err = manager.UpdateSshTarget(target.ID, runtimecore.SshTargetUpdate{LastRequiredPassphrase: &required})
	if err != nil {
		t.Fatal(err)
	}
	return NewServer(manager), target
}

func doSshCredentialRequest(t *testing.T, server *Server, method string, id string, body string) *httptest.ResponseRecorder {
	t.Helper()
	var reader *strings.Reader
	if body == "" {
		reader = strings.NewReader("")
	} else {
		reader = strings.NewReader(body)
	}
	req := httptest.NewRequest(method, "/v1/ssh-targets/"+id+"/credential", reader)
	rec := httptest.NewRecorder()
	server.ServeHTTP(rec, req)
	return rec
}

func TestSshCredentialRoutesSeedConsultClear(t *testing.T) {
	server, target := newSshCredentialTestServer(t)

	rec := doSshCredentialRequest(t, server, http.MethodGet, target.ID, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status GET failed: %d %s", rec.Code, rec.Body.String())
	}
	var status runtimecore.SshCredentialStatus
	if err := json.Unmarshal(rec.Body.Bytes(), &status); err != nil {
		t.Fatal(err)
	}
	if status.Cached || !status.PromptRequired {
		t.Fatalf("expected prompt-required miss, got %+v", status)
	}

	rec = doSshCredentialRequest(t, server, http.MethodPost, target.ID, `{"kind":"passphrase","value":"route-secret"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("seed failed: %d %s", rec.Code, rec.Body.String())
	}
	// Why: the seed response must acknowledge the cache without echoing the value.
	if strings.Contains(rec.Body.String(), "route-secret") {
		t.Fatal("seed response echoed the credential value")
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &status); err != nil {
		t.Fatal(err)
	}
	if !status.Cached || status.PromptRequired {
		t.Fatalf("expected cached status after seed, got %+v", status)
	}

	rec = doSshCredentialRequest(t, server, http.MethodDelete, target.ID, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("clear failed: %d %s", rec.Code, rec.Body.String())
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &status); err != nil {
		t.Fatal(err)
	}
	if status.Cached || !status.PromptRequired {
		t.Fatalf("expected cleared status, got %+v", status)
	}
}

func TestSshCredentialRoutesRejectBadSeed(t *testing.T) {
	server, target := newSshCredentialTestServer(t)

	rec := doSshCredentialRequest(t, server, http.MethodPost, target.ID, `{"kind":"pin","value":"1234"}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for unknown kind, got %d", rec.Code)
	}
	// Why: even rejection bodies must not reflect the submitted secret.
	if strings.Contains(rec.Body.String(), "1234") {
		t.Fatal("rejection response echoed the credential value")
	}

	rec = doSshCredentialRequest(t, server, http.MethodPost, target.ID, `{"kind":"passphrase","value":""}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for empty value, got %d", rec.Code)
	}

	rec = doSshCredentialRequest(t, server, http.MethodPost, "ssh-missing", `{"kind":"passphrase","value":"x"}`)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404 for unknown target, got %d", rec.Code)
	}
}
