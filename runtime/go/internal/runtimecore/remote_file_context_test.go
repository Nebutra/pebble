package runtimecore

import (
	"context"
	"encoding/base64"
	"errors"
	"path/filepath"
	"testing"
)

func TestSshFileOperationsReturnParentCancellation(t *testing.T) {
	manager, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	target, err := manager.CreateSshTarget(SshTargetInput{Host: "files.example"})
	if err != nil {
		t.Fatal(err)
	}
	remotePath := filepath.Join(t.TempDir(), "remote-worktree")
	project, err := manager.CreateProject(CreateProjectRequest{
		Name: "remote", Path: remotePath, LocationKind: "ssh", HostID: target.ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	worktree, err := manager.CreateWorktree(context.Background(), CreateWorktreeRequest{
		ProjectID: project.ID, Path: remotePath, Branch: "main",
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	scope := ReadFileRequest{ProjectID: project.ID, WorktreeID: worktree.ID, Path: "README.md"}
	mutation := FileMutationRequest{ProjectID: project.ID, WorktreeID: worktree.ID, Path: "README.md"}
	rename := FileRenameRequest{
		ProjectID: project.ID, WorktreeID: worktree.ID,
		OldPath: "README.md", NewPath: "README.old.md",
		SourcePath: "README.md", DestinationPath: "README.copy.md",
	}
	operations := map[string]func() error{
		"list tree": func() error {
			_, err := manager.ListFilesContext(ctx, ListFilesRequest{ProjectID: project.ID, WorktreeID: worktree.ID})
			return err
		},
		"read": func() error { _, err := manager.ReadFileContext(ctx, scope); return err },
		"read chunk": func() error {
			_, err := manager.ReadFileChunkContext(ctx, ReadFileChunkRequest{ProjectID: project.ID, WorktreeID: worktree.ID, Path: scope.Path, Length: 1})
			return err
		},
		"write": func() error {
			_, err := manager.WriteFileContext(ctx, WriteFileRequest{ProjectID: project.ID, WorktreeID: worktree.ID, Path: scope.Path, Content: "text"})
			return err
		},
		"write base64": func() error {
			return manager.WriteFileBase64Context(ctx, WriteFileBase64Request{ProjectID: project.ID, WorktreeID: worktree.ID, Path: scope.Path, ContentBase64: base64.StdEncoding.EncodeToString([]byte("text"))})
		},
		"create file":      func() error { return manager.CreateFileContext(ctx, mutation) },
		"create directory": func() error { return manager.CreateDirectoryContext(ctx, mutation) },
		"rename":           func() error { return manager.RenamePathContext(ctx, rename) },
		"copy":             func() error { return manager.CopyPathContext(ctx, rename) },
		"commit upload":    func() error { return manager.CommitUploadContext(ctx, rename) },
		"delete":           func() error { return manager.DeletePathContext(ctx, mutation) },
		"stat":             func() error { _, err := manager.StatFileContext(ctx, scope); return err },
		"list all": func() error {
			_, err := manager.ListAllFilesContext(ctx, ListAllFilesRequest{ProjectID: project.ID, WorktreeID: worktree.ID})
			return err
		},
		"watch snapshot": func() error {
			_, err := manager.FileWatchSnapshotContext(ctx, ListFilesRequest{ProjectID: project.ID, WorktreeID: worktree.ID})
			return err
		},
		"clipboard image": func() error {
			_, err := manager.WriteSshClipboardImageContext(ctx, SshClipboardImageRequest{TargetID: target.ID, ContentBase64: "AQID"})
			return err
		},
		"grant terminal artifact": func() error {
			_, err := manager.GrantSshTerminalArtifactContext(ctx, TerminalArtifactGrantRequest{ProjectID: project.ID, WorktreeID: worktree.ID, AbsolutePath: remotePath})
			return err
		},
		"read terminal artifact": func() error {
			_, err := manager.ReadSshTerminalArtifactContext(ctx, TerminalArtifactAccessRequest{})
			return err
		},
		"preview terminal artifact": func() error {
			_, err := manager.PreviewSshTerminalArtifactContext(ctx, TerminalArtifactAccessRequest{})
			return err
		},
		"write terminal artifact": func() error {
			return manager.WriteSshTerminalArtifactContext(ctx, TerminalArtifactAccessRequest{})
		},
		"search": func() error {
			_, err := manager.SearchFilesContext(ctx, FileSearchRequest{ProjectID: project.ID, WorktreeID: worktree.ID, Query: "needle"})
			return err
		},
	}
	for name, operation := range operations {
		t.Run(name, func(t *testing.T) {
			if err := operation(); !errors.Is(err, context.Canceled) {
				t.Fatalf("expected parent cancellation, got %v", err)
			}
		})
	}
}
