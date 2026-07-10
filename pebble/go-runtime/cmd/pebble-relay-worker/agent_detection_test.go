package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/tsekaluk/pebble/go-runtime/internal/runtimecore"
)

func TestParseAgentCatalog(t *testing.T) {
	catalog, err := parseAgentCatalog("claude=claude, codex , command-code=command-code|cmd")
	if err != nil {
		t.Fatal(err)
	}
	if len(catalog) != 3 {
		t.Fatalf("unexpected catalog: %#v", catalog)
	}
	if catalog[1].ID != "codex" || catalog[1].Commands[0] != "codex" {
		t.Fatalf("bare id should probe itself: %#v", catalog[1])
	}
	if len(catalog[2].Commands) != 2 || catalog[2].Commands[1] != "cmd" {
		t.Fatalf("aliases were not parsed: %#v", catalog[2])
	}
	if _, err := parseAgentCatalog("  "); err == nil {
		t.Fatal("expected empty catalog to be rejected")
	}
}

func TestDetectAgentsOnPath(t *testing.T) {
	catalog := []agentCatalogEntry{
		{ID: "claude", Commands: []string{"claude"}},
		{ID: "pebble-teams", Commands: []string{"pebble", "pebble-dev"}},
		{ID: "missing", Commands: []string{"not-installed"}},
	}
	detected := detectAgentsOnPath(catalog, func(command string) (string, error) {
		if command == "claude" || command == "pebble-dev" {
			return "/usr/bin/" + command, nil
		}
		return "", errors.New("not found")
	})
	if len(detected) != 2 || detected[0] != "claude" || detected[1] != "pebble-teams" {
		t.Fatalf("unexpected detection: %#v", detected)
	}
}

func TestRunAgentDetectPostsDetection(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fake PATH executables need unix permissions")
	}
	binDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(binDir, "fake-agent"), []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", binDir)

	var gotPath string
	var got runtimecore.UpdateRemoteAgentDetectionRequest
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		body, _ := io.ReadAll(r.Body)
		if err := json.Unmarshal(body, &got); err != nil {
			t.Fatal(err)
		}
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer server.Close()

	var output bytes.Buffer
	err := run([]string{
		"agent-detect",
		"--endpoint", server.URL,
		"--host", "host-1",
		"--agents", "fake=fake-agent,missing=missing-agent",
	}, server.Client(), &output)
	if err != nil {
		t.Fatal(err)
	}
	if gotPath != "/v1/remote-hosts/agent-detections" {
		t.Fatalf("unexpected path %q", gotPath)
	}
	if got.HostID != "host-1" || len(got.Agents) != 1 || got.Agents[0] != "fake" {
		t.Fatalf("unexpected detection payload: %#v", got)
	}
}
