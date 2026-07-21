package runtimecore

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSearchWorkspaceFilesContextReturnsCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	_, err := SearchWorkspaceFilesContext(ctx, t.TempDir(), FileSearchRequest{Query: "needle"})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("expected context cancellation, got %v", err)
	}
}

func TestSearchWorkspaceFilesSkipsOversizedFilesAndLines(t *testing.T) {
	root := t.TempDir()
	oversizedFile := "needle\n" + strings.Repeat("a", maxFileSearchReadBytes)
	if err := os.WriteFile(filepath.Join(root, "oversized.txt"), []byte(oversizedFile), 0o644); err != nil {
		t.Fatal(err)
	}
	oversizedLine := strings.Repeat("a", maxFileSearchLineBytes) + "needle"
	if err := os.WriteFile(filepath.Join(root, "minified.js"), []byte(oversizedLine), 0o644); err != nil {
		t.Fatal(err)
	}

	result, err := SearchWorkspaceFiles(root, FileSearchRequest{Query: "needle"})
	if err != nil {
		t.Fatal(err)
	}
	if result.TotalMatches != 0 || len(result.Files) != 0 {
		t.Fatalf("expected bounded search to skip oversized input, got %#v", result)
	}
}

func TestSearchWorkspaceFilesNormalizesNestedResultPaths(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "docs", "nested", "readme.txt")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("needle\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	result, err := SearchWorkspaceFiles(root, FileSearchRequest{Query: "needle"})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Files) != 1 || result.Files[0].RelativePath != "docs/nested/readme.txt" {
		t.Fatalf("expected slash-normalized remote path, got %#v", result.Files)
	}
}
