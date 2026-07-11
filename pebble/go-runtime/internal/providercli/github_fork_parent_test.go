package providercli

import (
	"context"
	"testing"
)

func TestResolveGitHubForkParentReturnsParentForFork(t *testing.T) {
	dir := fakeCLIStub(t, "gh",
		`{"isFork":true,"parent":{"name":"pebble","owner":{"login":"nebutra"}}}`,
		0)
	withPath(t, dir)

	parent := ResolveGitHubForkParent(context.Background(), t.TempDir(), "contributor", "pebble")
	if parent == nil {
		t.Fatalf("expected a fork parent, got nil")
	}
	if parent.Owner != "nebutra" || parent.Repo != "pebble" {
		t.Fatalf("unexpected fork parent: %+v", parent)
	}
}

func TestResolveGitHubForkParentReturnsNilWhenNotAFork(t *testing.T) {
	dir := fakeCLIStub(t, "gh", `{"isFork":false,"parent":null}`, 0)
	withPath(t, dir)

	parent := ResolveGitHubForkParent(context.Background(), t.TempDir(), "nebutra", "pebble")
	if parent != nil {
		t.Fatalf("expected nil for a non-fork repo, got %+v", parent)
	}
}

func TestResolveGitHubForkParentReturnsNilWhenCLIMissing(t *testing.T) {
	withEmptyPath(t, t.TempDir())

	parent := ResolveGitHubForkParent(context.Background(), t.TempDir(), "contributor", "pebble")
	if parent != nil {
		t.Fatalf("expected nil when gh is unavailable, got %+v", parent)
	}
}

func TestResolveGitHubForkParentReturnsNilWhenUnauthenticated(t *testing.T) {
	dir := fakeCLIStub(t, "gh", "gh auth login required: not authenticated", 1)
	withPath(t, dir)

	parent := ResolveGitHubForkParent(context.Background(), t.TempDir(), "contributor", "pebble")
	if parent != nil {
		t.Fatalf("expected nil on auth failure (best-effort), got %+v", parent)
	}
}

func TestResolveGitHubForkParentReturnsNilForEmptyOwnerOrRepo(t *testing.T) {
	parent := ResolveGitHubForkParent(context.Background(), t.TempDir(), "", "pebble")
	if parent != nil {
		t.Fatalf("expected nil for empty owner, got %+v", parent)
	}
	parent = ResolveGitHubForkParent(context.Background(), t.TempDir(), "contributor", "")
	if parent != nil {
		t.Fatalf("expected nil for empty repo, got %+v", parent)
	}
}
