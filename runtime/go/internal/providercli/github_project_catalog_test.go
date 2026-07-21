package providercli

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestResolveGitHubProjectRefPreservesViewAndOwnerType(t *testing.T) {
	withPath(t, githubProjectCatalogCLI(t))
	result := ResolveGitHubProjectRef(context.Background(), "https://github.com/orgs/nebutra/projects/4/views/9")
	if !result.OK || result.Owner != "nebutra" || result.OwnerType != "organization" || result.Number != 4 || result.ViewNumber != 9 || result.Title != "Pebble" {
		t.Fatalf("unexpected project ref: %+v", result)
	}
}

func TestResolveGitHubProjectRefFallsBackToUserForShorthand(t *testing.T) {
	withPath(t, githubProjectCatalogCLI(t))
	result := ResolveGitHubProjectRef(context.Background(), "alice/4")
	if !result.OK || result.OwnerType != "user" || result.Title != "Personal" {
		t.Fatalf("unexpected shorthand result: %+v", result)
	}
}

func TestListGitHubProjectViewsPaginates(t *testing.T) {
	withPath(t, githubProjectCatalogCLI(t))
	result := ListGitHubProjectViews(context.Background(), "nebutra", "organization", 4)
	if !result.OK || len(result.Views) != 2 || result.Views[0].Layout != "TABLE_LAYOUT" || result.Views[1].Number != 2 {
		t.Fatalf("unexpected views: %+v", result)
	}
}

func TestListAccessibleGitHubProjectsCombinesViewerAndOrganizations(t *testing.T) {
	withPath(t, githubProjectCatalogCLI(t))
	result := ListAccessibleGitHubProjects(context.Background())
	if !result.OK || len(result.Projects) != 2 || result.Projects[0].Source != "viewer" || result.Projects[1].Source != "org:nebutra" {
		t.Fatalf("unexpected discovery: %+v", result)
	}
}

func githubProjectCatalogCLI(t *testing.T) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("fake CLI stub uses POSIX shell scripts")
	}
	dir := t.TempDir()
	script := `#!/bin/sh
case "$*" in
  *"organizations(first:20"*) printf '%s' '{"data":{"viewer":{"organizations":{"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":[{"login":"nebutra","projectsV2":{"nodes":[{"id":"PO","number":4,"title":"Pebble","url":"https://github.com/orgs/nebutra/projects/4"}]}}]}}}}';;
  *"viewer { login projectsV2"*) printf '%s' '{"data":{"viewer":{"login":"alice","projectsV2":{"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":[{"id":"PV","number":2,"title":"Personal","url":"https://github.com/users/alice/projects/2","owner":{"__typename":"User","login":"alice"}}]}}}}';;
  *"organization(login"*"owner=alice"*) printf '%s' '{"data":{"organization":null}}';;
  *"user(login"*"owner=alice"*) printf '%s' '{"data":{"user":{"projectV2":{"id":"P_user","title":"Personal"}}}}';;
  *"after=next"*) printf '%s' '{"data":{"organization":{"projectV2":{"id":"P1","views":{"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":[{"id":"V2","number":2,"name":"Roadmap","layout":"ROADMAP_LAYOUT"}]}}}}}';;
  *"views(first:50"*) printf '%s' '{"data":{"organization":{"projectV2":{"id":"P1","views":{"pageInfo":{"hasNextPage":true,"endCursor":"next"},"nodes":[{"id":"V1","number":1,"name":"Table","layout":"TABLE_LAYOUT"}]}}}}}';;
  *"owner=nebutra"*) printf '%s' '{"data":{"organization":{"projectV2":{"id":"P1","title":"Pebble"}}}}';;
  *) exit 1;;
esac
`
	if err := os.WriteFile(filepath.Join(dir, "gh"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return dir
}
