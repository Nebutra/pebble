//go:build windows

package main

import "testing"

func TestResolveRemoteBrowsePathPreservesWindowsAbsolutePaths(t *testing.T) {
	for _, path := range []string{
		`C:\Users\Dev User\source`,
		`\\build-server\Shared Projects\Pebble`,
	} {
		resolved, err := resolveRemoteBrowsePath(path, `C:\Users\Dev User`)
		if err != nil {
			t.Fatalf("resolve %q: %v", path, err)
		}
		if resolved != path {
			t.Fatalf("resolve %q = %q", path, resolved)
		}
	}
}

func TestResolveRemoteBrowsePathRejectsWindowsDriveRelativePath(t *testing.T) {
	if _, err := resolveRemoteBrowsePath(`D:relative\project`, `C:\Users\Dev User`); err == nil {
		t.Fatal("expected drive-relative path to fail")
	}
}
