package runtimecore

import (
	"context"
	"errors"
	"strings"
	"testing"
)

func TestDecodeSshRemoteDirectoryPreservesPlatformPathsAndSpaces(t *testing.T) {
	result, err := decodeSshRemoteDirectory([]byte(`{"resolvedPath":"C:\\Users\\Dev User\\source","entries":[{"name":"Project One","isDirectory":true},{"name":"README.md","isDirectory":false}]}`))
	if err != nil {
		t.Fatal(err)
	}
	if result.ResolvedPath != `C:\Users\Dev User\source` || len(result.Entries) != 2 || !result.Entries[0].IsDirectory {
		t.Fatalf("unexpected directory response: %#v", result)
	}
}

func TestDecodeSshRemoteDirectoryRejectsMalformedResponses(t *testing.T) {
	for _, payload := range []string{
		`not-json`,
		`{"entries":[]}`,
		`{"resolvedPath":"/home/dev","entries":[{"name":"..","isDirectory":true}]}`,
		`{"resolvedPath":"/home/dev","entries":[]} trailing`,
		`{"resolvedPath":"/home/dev\nsource","entries":[]}`,
		`{"resolvedPath":"/home/dev","entries":[{"name":"line\nbreak","isDirectory":true}]}`,
		`{"resolvedPath":"/home/dev","entries":[],"unexpected":true}`,
	} {
		if _, err := decodeSshRemoteDirectory([]byte(payload)); err == nil {
			t.Fatalf("expected payload to fail: %s", payload)
		}
	}
}

func TestDecodeSshRemoteDirectoryEnforcesResponseBounds(t *testing.T) {
	if _, err := decodeSshRemoteDirectory([]byte(`{"resolvedPath":"` + strings.Repeat("x", maxSshRemoteDirectoryPathBytes+1) + `","entries":[]}`)); err == nil {
		t.Fatal("expected oversized resolved path to fail")
	}
	entries := strings.Repeat(`{"name":"x","isDirectory":false},`, maxSshRemoteDirectoryEntries) + `{"name":"last","isDirectory":false}`
	if _, err := decodeSshRemoteDirectory([]byte(`{"resolvedPath":"/home/dev","entries":[` + entries + `]}`)); err == nil {
		t.Fatal("expected oversized entry list to fail")
	}
	oversizedName := `{"resolvedPath":"/home/dev","entries":[{"name":"` + strings.Repeat("x", maxSshRemoteDirectoryNameBytes+1) + `","isDirectory":false}]}`
	if _, err := decodeSshRemoteDirectory([]byte(oversizedName)); err == nil {
		t.Fatal("expected oversized entry name to fail")
	}
}

func TestBrowseSshDirectoryHonorsCancelledContextBeforeSsh(t *testing.T) {
	manager, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	target, err := manager.CreateSshTarget(SshTargetInput{Host: "cancelled.example"})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err = manager.BrowseSshDirectory(ctx, target.ID, `C:\Users\Dev User`)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("expected cancellation, got %v", err)
	}
}
