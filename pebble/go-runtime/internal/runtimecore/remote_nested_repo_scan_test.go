package runtimecore

import (
	"context"
	"testing"
)

func makeRelayScanResult(repos ...string) NestedRepoScanResult {
	candidates := make([]NestedRepoCandidate, 0, len(repos))
	for _, repoPath := range repos {
		candidates = append(candidates, NestedRepoCandidate{
			Path:        repoPath,
			DisplayName: repoPath,
			Depth:       1,
		})
	}
	return NestedRepoScanResult{
		SelectedPath:     "/srv/projects",
		SelectedPathKind: "non_git_folder",
		Repos:            candidates,
		MaxDepth:         3,
		MaxRepos:         100,
	}
}

func TestUpdateRemoteNestedRepoScanCachesByHostAndPath(t *testing.T) {
	manager, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.UpdateRemoteNestedRepoScan(UpdateRemoteNestedRepoScanRequest{
		HostID: "host-1",
		Path:   "/srv/projects/",
		Scan:   makeRelayScanResult("/srv/projects/api"),
	}); err != nil {
		t.Fatal(err)
	}
	cached, ok := manager.RemoteNestedRepoScanForHost("host-1", "/srv/projects")
	if !ok {
		t.Fatal("expected trailing-slash path to hit the normalized cache key")
	}
	if len(cached.Scan.Repos) != 1 || cached.Scan.Repos[0].Path != "/srv/projects/api" {
		t.Fatalf("unexpected cached scan: %#v", cached.Scan)
	}
	if _, ok := manager.RemoteNestedRepoScanForHost("host-2", "/srv/projects"); ok {
		t.Fatal("scan must be scoped to its host")
	}
	if _, err := manager.UpdateRemoteNestedRepoScan(UpdateRemoteNestedRepoScanRequest{Path: "/srv/projects"}); err == nil {
		t.Fatal("expected missing host id to be rejected")
	}
}

func TestUpdateRemoteNestedRepoScanEmitsScanProgressForScanID(t *testing.T) {
	manager, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	id, events := manager.Subscribe(16)
	defer manager.Unsubscribe(id)
	if _, err := manager.UpdateRemoteNestedRepoScan(UpdateRemoteNestedRepoScanRequest{
		HostID:  "host-1",
		ScanID:  "scan-9",
		Path:    "/srv/projects",
		Partial: true,
		Scan:    makeRelayScanResult("/srv/projects/api"),
	}); err != nil {
		t.Fatal(err)
	}
	topics := map[string]bool{}
	for len(topics) < 2 {
		select {
		case event := <-events:
			topics[event.Topic] = true
		default:
			t.Fatalf("missing expected events, saw %#v", topics)
		}
	}
	if !topics["remote-nested-scans.changed"] || !topics["project-group.scan-progress"] {
		t.Fatalf("unexpected topics: %#v", topics)
	}
}

func TestImportRemoteNestedReposRequiresPostedScan(t *testing.T) {
	manager, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	_, err = manager.ImportRemoteNestedRepos(ImportRemoteNestedReposRequest{
		HostID:     "host-1",
		ParentPath: "/srv/projects",
	})
	if err != ErrRemoteNestedScanRequired {
		t.Fatalf("expected ErrRemoteNestedScanRequired, got %v", err)
	}
}

func TestImportRemoteNestedReposCreatesSshProjectsAndGroups(t *testing.T) {
	manager, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.UpdateRemoteNestedRepoScan(UpdateRemoteNestedRepoScanRequest{
		HostID: "host-1",
		Path:   "/srv/projects",
		Scan:   makeRelayScanResult("/srv/projects/api", "/srv/projects/services/auth", "/srv/projects/services/billing"),
	}); err != nil {
		t.Fatal(err)
	}
	result, err := manager.ImportRemoteNestedRepos(ImportRemoteNestedReposRequest{
		HostID:     "host-1",
		ParentPath: "/srv/projects",
		GroupName:  "Projects",
		Mode:       "group",
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.ImportedCount != 3 || result.FailedCount != 0 {
		t.Fatalf("unexpected result: %#v", result)
	}
	if result.Group == nil || result.Group.Name != "Projects" {
		t.Fatalf("expected root group, got %#v", result.Group)
	}
	if result.Group.ConnectionID == nil || *result.Group.ConnectionID != "host-1" {
		t.Fatalf("root group must carry the ssh connection id: %#v", result.Group)
	}
	groups := manager.ListProjectGroups()
	var servicesGroup *ProjectGroup
	for index := range groups {
		if groups[index].Name == "services" {
			servicesGroup = &groups[index]
		}
	}
	if servicesGroup == nil {
		t.Fatalf("expected a nested 'services' scope group, got %#v", groups)
	}
	if servicesGroup.ParentPath == nil || *servicesGroup.ParentPath != "/srv/projects/services" {
		t.Fatalf("nested group must keep the posix folder path: %#v", servicesGroup)
	}
	for _, project := range manager.ListProjects() {
		if project.LocationKind != "ssh" || project.HostID != "host-1" {
			t.Fatalf("imported project must be an ssh project: %#v", project)
		}
	}
	// Re-importing must report already-known instead of duplicating projects.
	again, err := manager.ImportRemoteNestedRepos(ImportRemoteNestedReposRequest{
		HostID:     "host-1",
		ParentPath: "/srv/projects",
		Mode:       "separate",
	})
	if err != nil {
		t.Fatal(err)
	}
	if again.ImportedCount != 0 || again.AlreadyKnownCount != 3 {
		t.Fatalf("expected idempotent import, got %#v", again)
	}
}

func TestImportRemoteNestedReposRejectsPathsOutsideScan(t *testing.T) {
	manager, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.UpdateRemoteNestedRepoScan(UpdateRemoteNestedRepoScanRequest{
		HostID: "host-1",
		Path:   "/srv/projects",
		Scan:   makeRelayScanResult("/srv/projects/api"),
	}); err != nil {
		t.Fatal(err)
	}
	result, err := manager.ImportRemoteNestedRepos(ImportRemoteNestedReposRequest{
		HostID:       "host-1",
		ParentPath:   "/srv/projects",
		ProjectPaths: []string{"/etc/passwd", "/srv/projects/api"},
		Mode:         "separate",
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.ImportedCount != 1 || result.FailedCount != 1 {
		t.Fatalf("unexpected result: %#v", result)
	}
	for _, project := range result.Projects {
		if project.Path == "/etc/passwd" && project.Status != "failed" {
			t.Fatalf("paths outside the scan must be rejected: %#v", project)
		}
	}
}

func TestScanNestedReposOnHostReportsProgressAndDirectoryCounts(t *testing.T) {
	parent, repos := makeNestedRepoFixture(t)
	var snapshots []NestedRepoScanResult
	scan, err := ScanNestedReposOnHost(context.Background(), NestedRepoScanRequest{Path: parent}, func(snapshot NestedRepoScanResult) {
		snapshots = append(snapshots, snapshot)
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(scan.Repos) != len(repos) {
		t.Fatalf("expected %d repos, got %#v", len(repos), scan.Repos)
	}
	if scan.DirectoriesVisited == 0 {
		t.Fatalf("expected visited-directory count, got %#v", scan)
	}
	// One progress snapshot per found repo (Electron's cadence) at minimum.
	if len(snapshots) < len(repos) {
		t.Fatalf("expected a snapshot per repo, got %d", len(snapshots))
	}
	last := snapshots[len(snapshots)-1]
	if len(last.Repos) != len(repos) {
		t.Fatalf("final snapshot must include all repos: %#v", last.Repos)
	}
}

func TestManagerScanNestedReposEmitsProgressEventsForScanID(t *testing.T) {
	parent, _ := makeNestedRepoFixture(t)
	manager, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	id, events := manager.Subscribe(64)
	defer manager.Unsubscribe(id)
	if _, err := manager.ScanNestedRepos(context.Background(), NestedRepoScanRequest{
		Path:   parent,
		ScanID: "scan-1",
	}); err != nil {
		t.Fatal(err)
	}
	sawProgress := false
	for !sawProgress {
		select {
		case event := <-events:
			if event.Topic == "project-group.scan-progress" {
				sawProgress = true
			}
		default:
			t.Fatal("expected a project-group.scan-progress event")
		}
	}
}
