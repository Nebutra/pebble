package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRunDirectoryListJSONUsesNativePathsAndPreservesSpaces(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "Project One"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "README file.md"), []byte("ok"), 0o644); err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	input, err := json.Marshal(map[string]string{"path": root})
	if err != nil {
		t.Fatal(err)
	}
	if err := runDirectoryListJSON(bytes.NewReader(input), &output); err != nil {
		t.Fatal(err)
	}
	var result directoryListingResult
	if err := json.Unmarshal(output.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	canonicalRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		t.Fatal(err)
	}
	if result.ResolvedPath != canonicalRoot || len(result.Entries) != 2 {
		t.Fatalf("unexpected listing: %#v", result)
	}
	if result.Entries[0].Name != "Project One" || !result.Entries[0].IsDirectory || result.Entries[1].Name != "README file.md" {
		t.Fatalf("directory entries did not preserve names and kinds: %#v", result.Entries)
	}
}

func TestResolveRemoteBrowsePathAnchorsHomeAndRejectsUnsafeInput(t *testing.T) {
	home := t.TempDir()
	for requested, expected := range map[string]string{
		"":              home,
		"~":             home,
		"~/Project One": filepath.Join(home, "Project One"),
		"relative path": filepath.Join(home, "relative path"),
	} {
		resolved, err := resolveRemoteBrowsePath(requested, home)
		if err != nil {
			t.Fatalf("resolve %q: %v", requested, err)
		}
		if resolved != expected {
			t.Fatalf("resolve %q = %q, want %q", requested, resolved, expected)
		}
	}
	for _, requested := range []string{"~other", "bad\npath", strings.Repeat("x", maxDirectoryBrowsePathBytes+1)} {
		if _, err := resolveRemoteBrowsePath(requested, home); err == nil {
			t.Fatalf("expected %q to be rejected", requested)
		}
	}
}

func TestRunDirectoryListJSONRejectsMalformedAndOversizedRequests(t *testing.T) {
	for _, input := range [][]byte{
		[]byte(`{"path":`),
		bytes.Repeat([]byte("x"), maxDirectoryBrowseRequest+1),
	} {
		if err := runDirectoryListJSON(bytes.NewReader(input), &bytes.Buffer{}); err == nil {
			t.Fatalf("expected request of %d bytes to fail", len(input))
		}
	}
}

func TestListRemoteDirectoryRejectsFilesAndEntryOverflow(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "file.txt")
	if err := os.WriteFile(file, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := listRemoteDirectory(file, root); err == nil || !strings.Contains(err.Error(), "not a directory") {
		t.Fatalf("expected file rejection, got %v", err)
	}

	for index := 0; index <= maxDirectoryBrowseEntries; index++ {
		if err := os.WriteFile(filepath.Join(root, fmt.Sprintf("entry-%05d", index)), nil, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := listRemoteDirectory(root, root); err == nil || !strings.Contains(err.Error(), "entry limit") {
		t.Fatalf("expected entry limit rejection, got %v", err)
	}
}

func TestValidateRemoteDirectoryEntryNameEnforcesBoundaries(t *testing.T) {
	invalid := []string{"", ".", "..", "line\nbreak", "carriage\rreturn", strings.Repeat("x", maxDirectoryBrowseNameBytes+1)}
	for _, name := range invalid {
		if err := validateRemoteDirectoryEntryName(name); err == nil {
			t.Fatalf("expected %q to be rejected", name)
		}
	}
	for _, name := range []string{"Project One", "Pebble's source", "..."} {
		if err := validateRemoteDirectoryEntryName(name); err != nil {
			t.Fatalf("expected %q to be accepted: %v", name, err)
		}
	}
}
