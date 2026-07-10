package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"github.com/tsekaluk/pebble/go-runtime/internal/runtimecore"
)

func TestRunScanNestedPostsScanResult(t *testing.T) {
	parent := t.TempDir()
	for _, name := range []string{"api", "web"} {
		if err := os.MkdirAll(filepath.Join(parent, name, ".git"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.MkdirAll(filepath.Join(parent, "docs"), 0o755); err != nil {
		t.Fatal(err)
	}

	var mu sync.Mutex
	var paths []string
	var posts []runtimecore.UpdateRemoteNestedRepoScanRequest
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var payload runtimecore.UpdateRemoteNestedRepoScanRequest
		if err := json.Unmarshal(body, &payload); err != nil {
			t.Error(err)
		}
		mu.Lock()
		paths = append(paths, r.URL.Path)
		posts = append(posts, payload)
		mu.Unlock()
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer server.Close()

	var output bytes.Buffer
	err := run([]string{
		"scan-nested",
		"--endpoint", server.URL,
		"--host", "host-1",
		"--path", parent,
		"--scan-id", "scan-42",
	}, server.Client(), &output)
	if err != nil {
		t.Fatal(err)
	}

	mu.Lock()
	defer mu.Unlock()
	if len(posts) == 0 {
		t.Fatal("expected at least the final scan post")
	}
	for _, path := range paths {
		if path != "/v1/project-groups/remote-nested-scans" {
			t.Fatalf("unexpected post path %q", path)
		}
	}
	final := posts[len(posts)-1]
	if final.Partial {
		t.Fatalf("final post must not be partial: %#v", final)
	}
	if final.HostID != "host-1" || final.ScanID != "scan-42" {
		t.Fatalf("unexpected identity fields: %#v", final)
	}
	if len(final.Scan.Repos) != 2 {
		t.Fatalf("expected 2 repos, got %#v", final.Scan.Repos)
	}
	if final.Scan.DirectoriesVisited == 0 {
		t.Fatalf("expected directory-visit count: %#v", final.Scan)
	}
}

func TestRunScanNestedRequiresHostAndPath(t *testing.T) {
	client := &http.Client{}
	if err := run([]string{"scan-nested", "--path", t.TempDir()}, client, io.Discard); err == nil {
		t.Fatal("expected missing host to fail")
	}
	if err := run([]string{"scan-nested", "--host", "host-1"}, client, io.Discard); err == nil {
		t.Fatal("expected missing path to fail")
	}
}
