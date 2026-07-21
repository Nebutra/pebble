package main

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestTerminalArtifactGrantReadAndWriteback(t *testing.T) {
	path := filepath.Join(t.TempDir(), "report.md")
	if err := os.WriteFile(path, []byte("before"), 0o640); err != nil {
		t.Fatal(err)
	}
	grant, err := applyTerminalArtifactOperation("grant", terminalArtifactRequest{AbsolutePath: path})
	if err != nil {
		t.Fatal(err)
	}
	read, err := applyTerminalArtifactOperation("read", terminalArtifactRequest{AbsolutePath: grant.AbsolutePath, Identity: grant.Identity})
	if err != nil || read.Content != "before" || read.ByteLength != 6 {
		t.Fatalf("read = %#v, err = %v", read, err)
	}
	written, err := applyTerminalArtifactOperation("write", terminalArtifactRequest{AbsolutePath: grant.AbsolutePath, Identity: grant.Identity, Content: "after"})
	if err != nil || written.Identity == grant.Identity {
		t.Fatalf("write = %#v, err = %v", written, err)
	}
	content, err := os.ReadFile(path)
	if err != nil || string(content) != "after" {
		t.Fatalf("content = %q, err = %v", content, err)
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0o640 {
		t.Fatalf("mode = %v, err = %v", info.Mode().Perm(), err)
	}
}

func TestTerminalArtifactRejectsOutsideTempAndStaleFiles(t *testing.T) {
	outside := filepath.Join(t.TempDir(), "inside.txt")
	if err := os.WriteFile(outside, []byte("first"), 0o600); err != nil {
		t.Fatal(err)
	}
	grant, err := applyTerminalArtifactOperation("grant", terminalArtifactRequest{AbsolutePath: outside})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(outside, []byte("changed-size"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := applyTerminalArtifactOperation("read", terminalArtifactRequest{AbsolutePath: grant.AbsolutePath, Identity: grant.Identity}); err == nil || !strings.Contains(err.Error(), "stale") {
		t.Fatalf("expected stale grant, got %v", err)
	}
	if filepath.Separator == '/' {
		if _, err := applyTerminalArtifactOperation("grant", terminalArtifactRequest{AbsolutePath: "/etc/hosts"}); err == nil || !strings.Contains(err.Error(), "unavailable") {
			t.Fatalf("expected outside-temp rejection, got %v", err)
		}
	}
}

func TestTerminalArtifactRejectsHardLinks(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "artifact.txt")
	link := filepath.Join(dir, "artifact-link.txt")
	if err := os.WriteFile(path, []byte("linked"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(path, link); err != nil {
		t.Skipf("hard links unavailable: %v", err)
	}
	if _, err := applyTerminalArtifactOperation("grant", terminalArtifactRequest{AbsolutePath: path}); err == nil || !strings.Contains(err.Error(), "unavailable") {
		t.Fatalf("expected hard-link rejection, got %v", err)
	}
}

func TestTerminalArtifactPreviewsPdfForCanonicalViewer(t *testing.T) {
	path := filepath.Join(t.TempDir(), "report.pdf")
	content := []byte("%PDF-1.4\n%%EOF\n")
	if err := os.WriteFile(path, content, 0o600); err != nil {
		t.Fatal(err)
	}
	grant, err := applyTerminalArtifactOperation("grant", terminalArtifactRequest{AbsolutePath: path})
	if err != nil {
		t.Fatal(err)
	}
	preview, err := applyTerminalArtifactOperation("preview", terminalArtifactRequest{
		AbsolutePath: grant.AbsolutePath, Identity: grant.Identity,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !preview.IsBinary || !preview.IsImage || preview.MimeType != "application/pdf" ||
		preview.Content != base64.StdEncoding.EncodeToString(content) {
		t.Fatalf("unexpected PDF preview: %#v", preview)
	}
}
