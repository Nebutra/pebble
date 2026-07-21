package runtimehttp

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/nebutra/pebble/runtime/go/internal/runtimecore"
)

func newSshRelayTestServer(t *testing.T) (*Server, runtimecore.Project, runtimecore.Worktree) {
	t.Helper()
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	project, err := manager.CreateProject(runtimecore.CreateProjectRequest{
		Name:         "remote-repo",
		Path:         "/srv/remote-repo",
		LocationKind: "ssh",
		HostID:       "host-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	worktree, err := manager.CreateWorktree(context.Background(), runtimecore.CreateWorktreeRequest{
		ProjectID: project.ID,
		Path:      "/srv/remote-repo-worktrees/feature",
		Branch:    "feature/remote",
	})
	if err != nil {
		t.Fatal(err)
	}
	return NewServer(manager), project, worktree
}

func postRelayJSON(t *testing.T, server *Server, path string, payload interface{}) *httptest.ResponseRecorder {
	t.Helper()
	body, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	server.ServeHTTP(rec, req)
	return rec
}

func TestRemoteWorktreeRemovalRoute(t *testing.T) {
	server, project, worktree := newSshRelayTestServer(t)
	rec := postRelayJSON(t, server, "/v1/worktrees/remote-removals", runtimecore.CompleteRemoteWorktreeRemovalRequest{
		ProjectID:       project.ID,
		WorktreeID:      worktree.ID,
		PreservedBranch: &runtimecore.PreservedWorktreeBranch{BranchName: "feature/remote", Head: "abc123"},
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var result runtimecore.DeleteWorktreeResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.ID != worktree.ID || result.PreservedBranch == nil {
		t.Fatalf("unexpected removal response: %s", rec.Body.String())
	}
	// A second completion for the same worktree must 404 (already retired).
	rec = postRelayJSON(t, server, "/v1/worktrees/remote-removals", runtimecore.CompleteRemoteWorktreeRemovalRequest{
		ProjectID:  project.ID,
		WorktreeID: worktree.ID,
	})
	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404 for repeated removal, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestRemotePreservedBranchRemovalRoute(t *testing.T) {
	server, project, _ := newSshRelayTestServer(t)
	rec := postRelayJSON(t, server, "/v1/worktrees/branches/remote-removals", runtimecore.CompleteRemotePreservedBranchRemovalRequest{
		ProjectID:  project.ID,
		BranchName: "feature/remote",
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var removal runtimecore.RemotePreservedBranchRemoval
	if err := json.Unmarshal(rec.Body.Bytes(), &removal); err != nil {
		t.Fatal(err)
	}
	if !removal.Deleted || removal.BranchName != "feature/remote" {
		t.Fatalf("unexpected removal payload: %s", rec.Body.String())
	}
}

func TestRemoteAgentDetectionRoutes(t *testing.T) {
	server, _, _ := newSshRelayTestServer(t)
	rec := postRelayJSON(t, server, "/v1/remote-hosts/agent-detections", runtimecore.UpdateRemoteAgentDetectionRequest{
		HostID: "host-1",
		Agents: []string{"codex", "claude"},
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}

	req := httptest.NewRequest(http.MethodGet, "/v1/remote-hosts/agent-detections?hostId=host-1", nil)
	getRec := httptest.NewRecorder()
	server.ServeHTTP(getRec, req)
	if getRec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", getRec.Code, getRec.Body.String())
	}
	var detection runtimecore.RemoteAgentDetection
	if err := json.Unmarshal(getRec.Body.Bytes(), &detection); err != nil {
		t.Fatal(err)
	}
	if detection.HostID != "host-1" || len(detection.Agents) != 2 {
		t.Fatalf("unexpected detection: %s", getRec.Body.String())
	}

	missing := httptest.NewRequest(http.MethodGet, "/v1/remote-hosts/agent-detections?hostId=other", nil)
	missingRec := httptest.NewRecorder()
	server.ServeHTTP(missingRec, missing)
	if missingRec.Code != http.StatusNotFound {
		t.Fatalf("expected 404 for unknown host, got %d", missingRec.Code)
	}
}

func TestRemoteNestedRepoScanRoutes(t *testing.T) {
	server, _, _ := newSshRelayTestServer(t)
	scan := runtimecore.NestedRepoScanResult{
		SelectedPath:     "/srv/projects",
		SelectedPathKind: "non_git_folder",
		Repos: []runtimecore.NestedRepoCandidate{
			{Path: "/srv/projects/api", DisplayName: "api", Depth: 1},
		},
	}
	rec := postRelayJSON(t, server, "/v1/project-groups/remote-nested-scans", runtimecore.UpdateRemoteNestedRepoScanRequest{
		HostID: "host-1",
		Path:   "/srv/projects",
		Scan:   scan,
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}

	req := httptest.NewRequest(http.MethodGet, "/v1/project-groups/remote-nested-scans?hostId=host-1&path=%2Fsrv%2Fprojects", nil)
	get := httptest.NewRecorder()
	server.ServeHTTP(get, req)
	if get.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", get.Code, get.Body.String())
	}
	var cached runtimecore.RemoteNestedRepoScan
	if err := json.Unmarshal(get.Body.Bytes(), &cached); err != nil {
		t.Fatal(err)
	}
	if cached.HostID != "host-1" || len(cached.Scan.Repos) != 1 {
		t.Fatalf("unexpected cached scan: %#v", cached)
	}

	miss := httptest.NewRequest(http.MethodGet, "/v1/project-groups/remote-nested-scans?hostId=host-2&path=%2Fsrv%2Fprojects", nil)
	missRec := httptest.NewRecorder()
	server.ServeHTTP(missRec, miss)
	if missRec.Code != http.StatusNotFound {
		t.Fatalf("expected 404 for unknown host, got %d", missRec.Code)
	}
}

func TestImportRemoteNestedRoute(t *testing.T) {
	server, _, _ := newSshRelayTestServer(t)
	// Import before any relay scan is a sequencing conflict, not a 500.
	rec := postRelayJSON(t, server, "/v1/project-groups/import-remote-nested", runtimecore.ImportRemoteNestedReposRequest{
		HostID:     "host-1",
		ScanID:     "scan-1",
		ParentPath: "/srv/projects",
	})
	if rec.Code != http.StatusConflict {
		t.Fatalf("expected 409 without a posted scan, got %d: %s", rec.Code, rec.Body.String())
	}

	post := postRelayJSON(t, server, "/v1/project-groups/remote-nested-scans", runtimecore.UpdateRemoteNestedRepoScanRequest{
		HostID: "host-1",
		ScanID: "scan-1",
		Path:   "/srv/projects",
		Scan: runtimecore.NestedRepoScanResult{
			SelectedPath:     "/srv/projects",
			SelectedPathKind: "non_git_folder",
			Repos: []runtimecore.NestedRepoCandidate{
				{Path: "/srv/projects/api", DisplayName: "api", Depth: 1},
			},
		},
	})
	if post.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", post.Code, post.Body.String())
	}

	for _, request := range []runtimecore.ImportRemoteNestedReposRequest{
		{HostID: "host-1", ParentPath: "/srv/projects", Mode: "separate"},
		{HostID: "host-1", ScanID: "scan-stale", ParentPath: "/srv/projects", Mode: "separate"},
	} {
		conflict := postRelayJSON(t, server, "/v1/project-groups/import-remote-nested", request)
		if conflict.Code != http.StatusConflict {
			t.Fatalf("expected 409 for uncorrelated scan, got %d: %s", conflict.Code, conflict.Body.String())
		}
	}

	imported := postRelayJSON(t, server, "/v1/project-groups/import-remote-nested", runtimecore.ImportRemoteNestedReposRequest{
		HostID:     "host-1",
		ScanID:     "scan-1",
		ParentPath: "/srv/projects",
		Mode:       "separate",
	})
	if imported.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", imported.Code, imported.Body.String())
	}
	var result runtimecore.ProjectGroupImportResult
	if err := json.Unmarshal(imported.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.ImportedCount != 1 {
		t.Fatalf("expected one imported ssh project, got %#v", result)
	}
}
