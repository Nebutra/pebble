package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/nebutra/pebble/runtime/go/internal/hostprobe"
	"github.com/nebutra/pebble/runtime/go/internal/remotehooks"
	"github.com/nebutra/pebble/runtime/go/internal/runtimecore"
)

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	if err := run(os.Args[1:], &http.Client{Timeout: 30 * time.Second}, os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(args []string, client *http.Client, output io.Writer) error {
	switch args[0] {
	case "file-tree":
		return runFileTree(args[1:], client, output)
	case "file-tree-json":
		return runFileTreeJSON(args[1:], output)
	case "file-read":
		return runFileRead(args[1:], client, output)
	case "file-read-json":
		return runFileReadJSON(args[1:], output)
	case "file-read-chunk-json":
		return runFileReadChunkJSON(args[1:], output)
	case "file-stat-json":
		return runFileStatJSON(args[1:], output)
	case "file-list-all-json":
		return runFileListAllJSON(args[1:], output)
	case "directory-list-json":
		return runDirectoryListJSON(os.Stdin, output)
	case "file-mutate-json":
		return runFileMutateJSON(os.Stdin, output)
	case "clipboard-write-json":
		return runClipboardWriteJSON(os.Stdin, output)
	case "file-search-json":
		return runFileSearchJSON(os.Stdin, output)
	case "file-watch-snapshot-json":
		return runFileWatchSnapshotJSON(args[1:], output)
	case "terminal-artifact-json":
		return runTerminalArtifactJSON(args[1:], os.Stdin, output)
	case "project-clone-json":
		return runProjectCloneJSON(args[1:], output)
	case "git-base-refs-json":
		return runGitBaseRefsJSON(args[1:], output)
	case "git-review-start-json":
		return runGitReviewStartJSON(args[1:], output)
	case "git-worktree-create-json":
		return runGitWorktreeCreateJSON(args[1:], output)
	case "git-base-status-json":
		return runGitBaseStatusJSON(args[1:], os.Stdin, output)
	case "git-username-json":
		return runGitUsernameJSON(args[1:], output)
	case "git-status":
		return runGitStatus(args[1:], client, output)
	case "worktree-remove":
		return runWorktreeRemove(args[1:], client, output)
	case "branch-delete":
		return runBranchDelete(args[1:], client, output)
	case "agent-detect":
		return runAgentDetect(args[1:], client, output)
	case "terminal-capabilities-json":
		return json.NewEncoder(output).Encode(hostprobe.NewProber().Detect())
	case "scan-nested":
		return runScanNested(args[1:], client, output)
	case "agent-hooks-install":
		return runAgentHooksInstall(args[1:], output)
	case "external-automations":
		return runExternalAutomations(args[1:], output)
	case "ports-detect":
		return runPortsDetect(output)
	case "git-text-generation-context":
		return runGitTextGenerationContext(args[1:], output)
	case "provider-text-generation-json":
		return runProviderTextGenerationJSON(os.Stdin, output)
	case "provider-http-json":
		return runProviderHTTPJSON(os.Stdin, output)
	case "ai-vault-scan-json":
		return runAiVaultScanJSON(args[1:], output)
	case "workspace-get-json":
		return runWorkspaceGetJSON(args[1:], output)
	case "workspace-watch-json":
		return runWorkspaceWatchJSON(args[1:], output)
	case "workspace-patch-json":
		return runWorkspacePatchJSON(os.Stdin, output)
	case "workspace-presence-json":
		return runWorkspacePresenceJSON(os.Stdin, output)
	default:
		usage()
		return fmt.Errorf("unknown relay worker command %q", args[0])
	}
}

func runWorkspaceWatchJSON(args []string, output io.Writer) error {
	fs := flag.NewFlagSet("workspace-watch-json", flag.ContinueOnError)
	fs.SetOutput(output)
	namespace := fs.String("namespace", "", "remote workspace namespace")
	interval := fs.Duration("interval", 500*time.Millisecond, "workspace check interval")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *interval < 50*time.Millisecond {
		return errors.New("workspace watch interval is too short")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	return streamRemoteWorkspaceChanges(context.Background(), home, *namespace, *interval, output)
}

func streamRemoteWorkspaceChanges(ctx context.Context, root, namespace string, interval time.Duration, output io.Writer) error {
	encoder := json.NewEncoder(output)
	lastRevision := int64(-1)
	emit := func() error {
		snapshot, err := runtimecore.ReadRemoteWorkspace(root, namespace)
		if err != nil {
			return err
		}
		if snapshot.Revision == lastRevision {
			return nil
		}
		lastRevision = snapshot.Revision
		return encoder.Encode(snapshot)
	}
	if err := emit(); err != nil {
		return err
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
			if err := emit(); err != nil {
				return err
			}
		}
	}
}

func runWorkspaceGetJSON(args []string, output io.Writer) error {
	fs := flag.NewFlagSet("workspace-get-json", flag.ContinueOnError)
	fs.SetOutput(output)
	namespace := fs.String("namespace", "", "remote workspace namespace")
	if err := fs.Parse(args); err != nil {
		return err
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	snapshot, err := runtimecore.ReadRemoteWorkspace(home, *namespace)
	if err != nil {
		return err
	}
	return json.NewEncoder(output).Encode(snapshot)
}

func runWorkspacePatchJSON(input io.Reader, output io.Writer) error {
	var req runtimecore.RemoteWorkspacePatchRequest
	if err := json.NewDecoder(io.LimitReader(input, 16*1024*1024+1)).Decode(&req); err != nil {
		return err
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	result, err := runtimecore.PatchRemoteWorkspace(home, req)
	if err != nil {
		return err
	}
	return json.NewEncoder(output).Encode(result)
}

func runWorkspacePresenceJSON(input io.Reader, output io.Writer) error {
	var req runtimecore.RemoteWorkspacePresenceRequest
	if err := json.NewDecoder(io.LimitReader(input, 64*1024)).Decode(&req); err != nil {
		return err
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	result, err := runtimecore.TouchRemoteWorkspacePresence(home, req)
	if err != nil {
		return err
	}
	return json.NewEncoder(output).Encode(result)
}

func runAiVaultScanJSON(args []string, output io.Writer) error {
	fs := flag.NewFlagSet("ai-vault-scan-json", flag.ContinueOnError)
	fs.SetOutput(output)
	limit := fs.Int("limit", 1000, "maximum sessions")
	var scopePaths repeatedPathFlag
	fs.Var(&scopePaths, "scope-path", "active workspace or project path")
	if err := fs.Parse(args); err != nil {
		return err
	}
	return json.NewEncoder(output).Encode(runtimecore.ScanLocalAiVaultSessions(runtimecore.AiVaultListRequest{
		Limit:      *limit,
		ScopePaths: scopePaths,
	}))
}

type repeatedPathFlag []string

func (f *repeatedPathFlag) String() string {
	return strings.Join(*f, string(os.PathListSeparator))
}

func (f *repeatedPathFlag) Set(value string) error {
	*f = append(*f, value)
	return nil
}

func runGitUsernameJSON(args []string, output io.Writer) error {
	fs := flag.NewFlagSet("git-username-json", flag.ContinueOnError)
	fs.SetOutput(output)
	root := fs.String("root", "", "remote git repository root")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if strings.TrimSpace(*root) == "" {
		return errors.New("root is required")
	}
	return json.NewEncoder(output).Encode(map[string]string{
		"username": runtimecore.ResolveExplicitGitUsername(*root),
	})
}

func runClipboardWriteJSON(input io.Reader, output io.Writer) error {
	var payload struct {
		ContentBase64 string `json:"contentBase64"`
	}
	if err := json.NewDecoder(io.LimitReader(input, 24*1024*1024)).Decode(&payload); err != nil {
		return err
	}
	content, err := base64.StdEncoding.DecodeString(payload.ContentBase64)
	if err != nil {
		return errors.New("clipboard image content must be base64")
	}
	if len(content) == 0 || len(content) > 18*1024*1024 {
		return errors.New("clipboard image exceeds write limit")
	}
	file, err := os.CreateTemp(os.TempDir(), "pebble-paste-*.png")
	if err != nil {
		return err
	}
	path := file.Name()
	if _, err := file.Write(content); err != nil {
		file.Close()
		os.Remove(path)
		return err
	}
	if err := file.Close(); err != nil {
		os.Remove(path)
		return err
	}
	return json.NewEncoder(output).Encode(map[string]string{"path": path})
}

func runFileWatchSnapshotJSON(args []string, output io.Writer) error {
	fs := flag.NewFlagSet("file-watch-snapshot-json", flag.ContinueOnError)
	fs.SetOutput(output)
	root := fs.String("root", "", "remote workspace root")
	if err := fs.Parse(args); err != nil {
		return err
	}
	entries, err := runtimecore.SnapshotWorkspaceFiles(*root)
	if err != nil {
		return err
	}
	return json.NewEncoder(output).Encode(entries)
}

func runFileSearchJSON(input io.Reader, output io.Writer) error {
	var payload struct {
		Root    string                        `json:"root"`
		Request runtimecore.FileSearchRequest `json:"request"`
	}
	if err := json.NewDecoder(io.LimitReader(input, 1024*1024)).Decode(&payload); err != nil {
		return err
	}
	if strings.TrimSpace(payload.Root) == "" {
		return errors.New("root is required")
	}
	root, err := filepath.Abs(payload.Root)
	if err != nil {
		return err
	}
	result, err := runtimecore.SearchWorkspaceFiles(root, payload.Request)
	if err != nil {
		return err
	}
	return json.NewEncoder(output).Encode(result)
}

type fileMutationPayload struct {
	Operation       string `json:"operation"`
	Root            string `json:"root"`
	Path            string `json:"path,omitempty"`
	OldPath         string `json:"oldPath,omitempty"`
	NewPath         string `json:"newPath,omitempty"`
	SourcePath      string `json:"sourcePath,omitempty"`
	DestinationPath string `json:"destinationPath,omitempty"`
	Content         string `json:"content,omitempty"`
	ContentBase64   string `json:"contentBase64,omitempty"`
	Append          bool   `json:"append,omitempty"`
	Recursive       bool   `json:"recursive,omitempty"`
	CreateDirs      bool   `json:"createDirs,omitempty"`
}

func runFileMutateJSON(input io.Reader, output io.Writer) error {
	var payload fileMutationPayload
	decoder := json.NewDecoder(io.LimitReader(input, 24*1024*1024))
	if err := decoder.Decode(&payload); err != nil {
		return err
	}
	if err := applyFileMutation(payload); err != nil {
		return err
	}
	return json.NewEncoder(output).Encode(map[string]bool{"ok": true})
}

func applyFileMutation(payload fileMutationPayload) error {
	switch payload.Operation {
	case "write":
		if int64(len(payload.Content)) > 10*1024*1024 {
			return errors.New("file exceeds write limit")
		}
		target, err := resolveWorkspaceMutationTarget(payload.Root, payload.Path, payload.CreateDirs, false)
		if err != nil {
			return err
		}
		return os.WriteFile(target, []byte(payload.Content), 0o644)
	case "write-base64":
		content, err := base64.StdEncoding.DecodeString(payload.ContentBase64)
		if err != nil {
			return err
		}
		if int64(len(content)) > 10*1024*1024 {
			return errors.New("file exceeds write limit")
		}
		target, err := resolveWorkspaceMutationTarget(payload.Root, payload.Path, true, !payload.Append)
		if err != nil {
			return err
		}
		flag := os.O_WRONLY | os.O_CREATE | os.O_EXCL
		if payload.Append {
			flag = os.O_WRONLY | os.O_CREATE | os.O_APPEND
		}
		file, err := os.OpenFile(target, flag, 0o644)
		if err != nil {
			return err
		}
		_, writeErr := file.Write(content)
		closeErr := file.Close()
		if writeErr != nil {
			return writeErr
		}
		return closeErr
	case "create-file":
		target, err := resolveWorkspaceMutationTarget(payload.Root, payload.Path, true, true)
		if err != nil {
			return err
		}
		file, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
		if err != nil {
			return err
		}
		return file.Close()
	case "create-dir":
		target, err := resolveWorkspaceMutationTarget(payload.Root, payload.Path, false, true)
		if err != nil {
			return err
		}
		return os.Mkdir(target, 0o755)
	case "rename":
		source, err := resolveWorkspaceExistingMutationPath(payload.Root, payload.OldPath)
		if err != nil {
			return err
		}
		destination, err := resolveWorkspaceMutationTarget(payload.Root, payload.NewPath, false, true)
		if err != nil {
			return err
		}
		return os.Rename(source, destination)
	case "copy":
		source, info, err := resolveWorkspaceMutationSource(payload.Root, payload.SourcePath)
		if err != nil {
			return err
		}
		if info.IsDir() {
			return errors.New("cannot copy a directory")
		}
		destination, err := resolveWorkspaceMutationTarget(payload.Root, payload.DestinationPath, true, true)
		if err != nil {
			return err
		}
		return copyRelayWorkspaceFile(source, destination, info.Mode())
	case "commit-upload":
		source, info, err := resolveWorkspaceMutationSource(payload.Root, payload.SourcePath)
		if err != nil {
			return err
		}
		if info.IsDir() {
			return errors.New("cannot commit a directory upload")
		}
		destination, err := resolveWorkspaceReplaceMutationTarget(payload.Root, payload.DestinationPath)
		if err != nil {
			return err
		}
		return replaceRelayUpload(source, destination)
	case "delete":
		target, err := resolveWorkspaceExistingMutationPath(payload.Root, payload.Path)
		if err != nil {
			return err
		}
		if payload.Recursive {
			return os.RemoveAll(target)
		}
		return os.Remove(target)
	default:
		return errors.New("unsupported file mutation")
	}
}

func runFileTreeJSON(args []string, output io.Writer) error {
	fs := flag.NewFlagSet("file-tree-json", flag.ContinueOnError)
	fs.SetOutput(output)
	projectID := fs.String("project", "", "runtime project id")
	worktreeID := fs.String("worktree", "", "runtime worktree id")
	root := fs.String("root", "", "remote workspace root")
	path := fs.String("path", "", "workspace-relative path")
	maxDepth := fs.Int("max-depth", 1, "maximum directory depth")
	if err := fs.Parse(args); err != nil {
		return err
	}
	entries, err := buildFileEntries(*projectID, *worktreeID, *root, *path, *maxDepth)
	if err != nil {
		return err
	}
	return json.NewEncoder(output).Encode(entries)
}

func runAgentHooksInstall(args []string, output io.Writer) error {
	fs := flag.NewFlagSet("agent-hooks-install", flag.ContinueOnError)
	fs.SetOutput(output)
	home := fs.String("home", "", "remote user home")
	if err := fs.Parse(args); err != nil {
		return err
	}
	statuses := remotehooks.InstallAll(*home)
	return json.NewEncoder(output).Encode(map[string]any{"version": 1, "statuses": statuses})
}

func runFileTree(args []string, client *http.Client, output io.Writer) error {
	fs := flag.NewFlagSet("file-tree", flag.ExitOnError)
	endpoint := fs.String("endpoint", "http://127.0.0.1:17777", "runtime endpoint")
	token := fs.String("token", os.Getenv("PEBBLE_RUNTIME_TOKEN"), "runtime bearer token")
	projectID := fs.String("project", "", "runtime project id")
	worktreeID := fs.String("worktree", "", "runtime worktree id")
	root := fs.String("root", "", "remote workspace root")
	path := fs.String("path", "", "workspace-relative path")
	maxDepth := fs.Int("max-depth", 2, "maximum directory depth")
	_ = fs.Parse(args)
	entries, err := buildFileEntries(*projectID, *worktreeID, *root, *path, *maxDepth)
	if err != nil {
		return err
	}
	payload := runtimecore.UpdateRemoteFileTreeRequest{
		ProjectID:  *projectID,
		WorktreeID: *worktreeID,
		Path:       *path,
		Entries:    entries,
	}
	return postJSON(client, output, *endpoint, *token, "/v1/files/tree-snapshots", payload)
}

func runFileRead(args []string, client *http.Client, output io.Writer) error {
	fs := flag.NewFlagSet("file-read", flag.ExitOnError)
	endpoint := fs.String("endpoint", "http://127.0.0.1:17777", "runtime endpoint")
	token := fs.String("token", os.Getenv("PEBBLE_RUNTIME_TOKEN"), "runtime bearer token")
	projectID := fs.String("project", "", "runtime project id")
	worktreeID := fs.String("worktree", "", "runtime worktree id")
	root := fs.String("root", "", "remote workspace root")
	path := fs.String("path", "", "workspace-relative file path")
	maxBytes := fs.Int64("max-bytes", 1024*1024, "maximum bytes to read")
	_ = fs.Parse(args)
	content, size, modifiedAt, err := readWorkspaceFile(*root, *path, *maxBytes)
	if err != nil {
		return err
	}
	payload := runtimecore.UpdateRemoteFileContentRequest{
		ProjectID:  *projectID,
		WorktreeID: *worktreeID,
		Path:       *path,
		Encoding:   "utf-8",
		Content:    content,
		Size:       size,
		ModifiedAt: &modifiedAt,
	}
	return postJSON(client, output, *endpoint, *token, "/v1/files/content-snapshots", payload)
}

func runFileReadJSON(args []string, output io.Writer) error {
	fs := flag.NewFlagSet("file-read-json", flag.ContinueOnError)
	fs.SetOutput(output)
	projectID := fs.String("project", "", "runtime project id")
	worktreeID := fs.String("worktree", "", "runtime worktree id")
	root := fs.String("root", "", "remote workspace root")
	path := fs.String("path", "", "workspace-relative file path")
	maxBytes := fs.Int64("max-bytes", 1024*1024, "maximum bytes to read")
	if err := fs.Parse(args); err != nil {
		return err
	}
	content, size, modifiedAt, err := readWorkspaceFile(*root, *path, *maxBytes)
	if err != nil {
		return err
	}
	return json.NewEncoder(output).Encode(runtimecore.FileContent{
		ProjectID:  *projectID,
		WorktreeID: *worktreeID,
		Path:       filepath.ToSlash(*path),
		Encoding:   "utf-8",
		Content:    content,
		Size:       size,
		ModifiedAt: modifiedAt,
	})
}

func runFileReadChunkJSON(args []string, output io.Writer) error {
	fs := flag.NewFlagSet("file-read-chunk-json", flag.ContinueOnError)
	fs.SetOutput(output)
	root := fs.String("root", "", "remote workspace root")
	path := fs.String("path", "", "workspace-relative file path")
	offset := fs.Int64("offset", 0, "zero-based byte offset")
	length := fs.Int64("length", 0, "maximum bytes to read")
	if err := fs.Parse(args); err != nil {
		return err
	}
	chunk, err := readWorkspaceFileChunk(*root, *path, *offset, *length)
	if err != nil {
		return err
	}
	return json.NewEncoder(output).Encode(chunk)
}

func runFileStatJSON(args []string, output io.Writer) error {
	fs := flag.NewFlagSet("file-stat-json", flag.ContinueOnError)
	fs.SetOutput(output)
	root := fs.String("root", "", "remote workspace root")
	path := fs.String("path", "", "workspace-relative file path")
	if err := fs.Parse(args); err != nil {
		return err
	}
	_, info, err := resolveWorkspaceFile(*root, *path)
	if err != nil {
		return err
	}
	return json.NewEncoder(output).Encode(runtimecore.FileStat{
		Size:        info.Size(),
		IsDirectory: info.IsDir(),
		Mtime:       info.ModTime().UnixMilli(),
	})
}

func runFileListAllJSON(args []string, output io.Writer) error {
	fs := flag.NewFlagSet("file-list-all-json", flag.ContinueOnError)
	fs.SetOutput(output)
	root := fs.String("root", "", "remote workspace root")
	excludeJSON := fs.String("exclude-json", "[]", "JSON array of workspace-relative exclusions")
	limit := fs.Int("limit", 10000, "maximum files to return")
	if err := fs.Parse(args); err != nil {
		return err
	}
	var excluded []string
	if err := json.Unmarshal([]byte(*excludeJSON), &excluded); err != nil {
		return errors.New("exclude-json must be a JSON string array")
	}
	result, err := buildFileList(*root, excluded, *limit)
	if err != nil {
		return err
	}
	return json.NewEncoder(output).Encode(result)
}

func runGitStatus(args []string, client *http.Client, output io.Writer) error {
	fs := flag.NewFlagSet("git-status", flag.ExitOnError)
	endpoint := fs.String("endpoint", "http://127.0.0.1:17777", "runtime endpoint")
	token := fs.String("token", os.Getenv("PEBBLE_RUNTIME_TOKEN"), "runtime bearer token")
	repositoryID := fs.String("repository", "", "runtime repository/project id")
	workspaceID := fs.String("workspace", "", "runtime workspace/worktree id")
	root := fs.String("root", "", "remote git workspace root")
	provider := fs.String("provider", "", "git provider")
	reviewKind := fs.String("review-kind", "", "review kind")
	baseBranch := fs.String("base", "", "base branch")
	baseRef := fs.String("base-ref", "", "base ref for base-status drift probing")
	createdBaseSHA := fs.String("created-base-sha", "", "base SHA recorded at workspace creation")
	branchName := fs.String("branch", "", "workspace branch name for remote-conflict probing")
	_ = fs.Parse(args)
	projection, err := buildGitProjection(*repositoryID, *workspaceID, *root, *provider, *reviewKind, *baseBranch)
	if err != nil {
		return err
	}
	// Why: base drift needs the base SHA recorded at workspace creation, which
	// only the caller knows — without it the runtime keeps an honest "unknown".
	if strings.TrimSpace(*baseRef) != "" && strings.TrimSpace(*createdBaseSHA) != "" {
		projection.BaseStatus = probeGitBaseStatus(*root, *baseRef, *createdBaseSHA, *branchName)
	}
	return postJSON(client, output, *endpoint, *token, "/v1/source-control/projections", projection)
}

func probeGitBaseStatus(root string, baseRef string, createdBaseSHA string, branchName string) *runtimecore.SourceControlBaseStatus {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	result := runtimecore.ComputeGitBaseStatus(ctx, strings.TrimSpace(root), runtimecore.GitBaseStatusRequest{
		BaseRef:        strings.TrimSpace(baseRef),
		CreatedBaseSHA: strings.TrimSpace(createdBaseSHA),
		BranchName:     strings.TrimSpace(branchName),
	})
	return &runtimecore.SourceControlBaseStatus{
		Status:         result.Status,
		Base:           result.Base,
		Remote:         result.Remote,
		Behind:         result.Behind,
		RecentSubjects: result.RecentSubjects,
		Conflict:       result.Conflict,
	}
}

func buildFileEntries(projectID string, worktreeID string, root string, relPath string, maxDepth int) ([]runtimecore.FileEntry, error) {
	root = strings.TrimSpace(root)
	if root == "" {
		return nil, errors.New("root is required")
	}
	base, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	cleanRel, err := cleanRelativePath(relPath)
	if err != nil {
		return nil, err
	}
	if maxDepth <= 0 {
		maxDepth = 1
	}
	if maxDepth > 8 {
		maxDepth = 8
	}
	start := filepath.Join(base, cleanRel)
	info, err := os.Lstat(start)
	if err != nil {
		return nil, err
	}
	entries := make([]runtimecore.FileEntry, 0)
	if !info.IsDir() {
		entry, err := entryFromInfo(projectID, worktreeID, base, start, info)
		if err != nil {
			return nil, err
		}
		return []runtimecore.FileEntry{entry}, nil
	}
	if err := collectEntries(projectID, worktreeID, base, start, 1, maxDepth, &entries); err != nil {
		return nil, err
	}
	sort.Slice(entries, func(i, j int) bool {
		return entries[i].Path < entries[j].Path
	})
	return entries, nil
}

func buildGitProjection(repositoryID string, workspaceID string, root string, provider string, reviewKind string, baseBranch string) (runtimecore.UpdateSourceControlProjectionRequest, error) {
	repositoryID = strings.TrimSpace(repositoryID)
	workspaceID = strings.TrimSpace(workspaceID)
	root = strings.TrimSpace(root)
	if repositoryID == "" || workspaceID == "" || root == "" {
		return runtimecore.UpdateSourceControlProjectionRequest{}, errors.New("repository, workspace, and root are required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	output, err := exec.CommandContext(ctx, "git", "-C", root, "status", "--short", "--branch").CombinedOutput()
	if err != nil {
		return runtimecore.UpdateSourceControlProjectionRequest{}, errors.New(strings.TrimSpace(string(output)) + ": " + err.Error())
	}
	branch, ahead, behind, changes := parseGitStatusOutput(string(output), root)
	syncStatus := "clean"
	if len(changes) > 0 {
		syncStatus = "dirty"
	}
	return runtimecore.UpdateSourceControlProjectionRequest{
		RepositoryID:      repositoryID,
		WorkspaceID:       workspaceID,
		Provider:          strings.TrimSpace(provider),
		ReviewKind:        strings.TrimSpace(reviewKind),
		Branch:            branch,
		BaseBranch:        strings.TrimSpace(baseBranch),
		Ahead:             ahead,
		Behind:            behind,
		SyncStatus:        syncStatus,
		Changes:           changes,
		ConflictOperation: runtimecore.DetectGitConflictOperation(root),
	}, nil
}

func parseGitStatusOutput(output string, root string) (string, int, int, []runtimecore.SourceControlChange) {
	lines := strings.Split(strings.TrimRight(output, "\n"), "\n")
	branch := ""
	ahead := 0
	behind := 0
	var changes []runtimecore.SourceControlChange
	for index, line := range lines {
		if line == "" {
			continue
		}
		if index == 0 && strings.HasPrefix(line, "## ") {
			branch, ahead, behind = parseGitBranchLine(strings.TrimPrefix(line, "## "))
			continue
		}
		if len(line) < 4 {
			continue
		}
		path := strings.TrimSpace(line[3:])
		if _, renamedTo, ok := strings.Cut(path, " -> "); ok {
			path = strings.TrimSpace(renamedTo)
		}
		if path == "" {
			continue
		}
		// Why: unmerged XY pairs are one conflict row; the Contains-based status
		// mapping below would misread them (e.g. "AA" as a plain add).
		if conflictKind := runtimecore.ParseGitConflictKind(line[:2]); conflictKind != "" {
			changes = append(changes, runtimecore.SourceControlChange{
				Path:           path,
				Status:         runtimecore.ConflictCompatibilityStatus(root, path, conflictKind),
				Area:           "unstaged",
				ConflictKind:   conflictKind,
				ConflictStatus: "unresolved",
			})
			continue
		}
		status := gitChangeStatus(line[:2])
		if status == "" {
			continue
		}
		changes = append(changes, runtimecore.SourceControlChange{Path: path, Status: status})
	}
	return branch, ahead, behind, changes
}

func gitChangeStatus(statusCode string) string {
	switch {
	case strings.Contains(statusCode, "?"):
		return "untracked"
	case strings.Contains(statusCode, "!"):
		return "ignored"
	case strings.Contains(statusCode, "R"):
		return "renamed"
	case strings.Contains(statusCode, "A"):
		return "added"
	case strings.Contains(statusCode, "D"):
		return "deleted"
	case strings.Contains(statusCode, "M"):
		return "modified"
	default:
		return ""
	}
}

func parseGitBranchLine(line string) (string, int, int) {
	branchPart := line
	if cut := strings.Index(line, "..."); cut >= 0 {
		branchPart = line[:cut]
	}
	if cut := strings.Index(branchPart, " "); cut >= 0 {
		branchPart = branchPart[:cut]
	}
	ahead := parseGitBranchCount(line, "ahead ")
	behind := parseGitBranchCount(line, "behind ")
	return strings.TrimSpace(branchPart), ahead, behind
}

func parseGitBranchCount(line string, marker string) int {
	index := strings.Index(line, marker)
	if index < 0 {
		return 0
	}
	rest := line[index+len(marker):]
	count := 0
	for _, char := range rest {
		if char < '0' || char > '9' {
			break
		}
		count = count*10 + int(char-'0')
	}
	return count
}

func readWorkspaceFile(root string, relPath string, maxBytes int64) (string, int64, time.Time, error) {
	root = strings.TrimSpace(root)
	if root == "" {
		return "", 0, time.Time{}, errors.New("root is required")
	}
	if maxBytes <= 0 {
		maxBytes = 1024 * 1024
	}
	base, err := filepath.Abs(root)
	if err != nil {
		return "", 0, time.Time{}, err
	}
	cleanRel, err := cleanRelativePath(relPath)
	if err != nil {
		return "", 0, time.Time{}, err
	}
	if cleanRel == "" {
		return "", 0, time.Time{}, errors.New("path is required")
	}
	fullPath := filepath.Join(base, cleanRel)
	resolvedPath, err := resolveWorkspaceReadPath(base, fullPath)
	if err != nil {
		return "", 0, time.Time{}, err
	}
	info, err := os.Stat(resolvedPath)
	if err != nil {
		return "", 0, time.Time{}, err
	}
	if info.IsDir() {
		return "", 0, time.Time{}, errors.New("cannot read a directory")
	}
	file, err := os.Open(resolvedPath)
	if err != nil {
		return "", 0, time.Time{}, err
	}
	defer file.Close()
	content, err := io.ReadAll(io.LimitReader(file, maxBytes+1))
	if err != nil {
		return "", 0, time.Time{}, err
	}
	if int64(len(content)) > maxBytes {
		return "", 0, time.Time{}, errors.New("file exceeds read limit")
	}
	return string(content), info.Size(), info.ModTime().UTC(), nil
}

func readWorkspaceFileChunk(root string, relPath string, offset int64, length int64) (runtimecore.FileChunk, error) {
	if offset < 0 {
		return runtimecore.FileChunk{}, errors.New("offset must be non-negative")
	}
	if length <= 0 {
		return runtimecore.FileChunk{}, errors.New("length must be positive")
	}
	if length > 10*1024*1024 {
		length = 10 * 1024 * 1024
	}
	readPath, info, err := resolveWorkspaceFile(root, relPath)
	if err != nil {
		return runtimecore.FileChunk{}, err
	}
	if info.IsDir() {
		return runtimecore.FileChunk{}, errors.New("cannot read a directory")
	}
	if offset >= info.Size() {
		return runtimecore.FileChunk{ContentBase64: "", BytesRead: 0, EOF: true}, nil
	}
	if remaining := info.Size() - offset; length > remaining {
		length = remaining
	}
	file, err := os.Open(readPath)
	if err != nil {
		return runtimecore.FileChunk{}, err
	}
	defer file.Close()
	buffer := make([]byte, int(length))
	bytesRead, err := file.ReadAt(buffer, offset)
	if err != nil && !errors.Is(err, io.EOF) {
		return runtimecore.FileChunk{}, err
	}
	return runtimecore.FileChunk{
		ContentBase64: base64.StdEncoding.EncodeToString(buffer[:bytesRead]),
		BytesRead:     bytesRead,
		EOF:           offset+int64(bytesRead) >= info.Size(),
	}, nil
}

func resolveWorkspaceFile(root string, relPath string) (string, os.FileInfo, error) {
	root = strings.TrimSpace(root)
	if root == "" {
		return "", nil, errors.New("root is required")
	}
	base, err := filepath.Abs(root)
	if err != nil {
		return "", nil, err
	}
	cleanRel, err := cleanRelativePath(relPath)
	if err != nil {
		return "", nil, err
	}
	if cleanRel == "" {
		return "", nil, errors.New("path is required")
	}
	resolvedPath, err := resolveWorkspaceReadPath(base, filepath.Join(base, cleanRel))
	if err != nil {
		return "", nil, err
	}
	info, err := os.Stat(resolvedPath)
	if err != nil {
		return "", nil, err
	}
	return resolvedPath, info, nil
}

func resolveWorkspaceMutationTarget(root string, relPath string, createDirs bool, noClobber bool) (string, error) {
	base, cleanRel, err := resolveWorkspaceMutationBase(root, relPath)
	if err != nil {
		return "", err
	}
	parent, err := resolveRelayWorkspaceParent(base, filepath.Dir(cleanRel), createDirs)
	if err != nil {
		return "", err
	}
	target := filepath.Join(parent, filepath.Base(cleanRel))
	if err := requireRelayPathInsideWorkspace(base, target); err != nil {
		return "", err
	}
	info, statErr := os.Lstat(target)
	if statErr == nil {
		if noClobber {
			return "", os.ErrExist
		}
		if info.Mode()&os.ModeSymlink != 0 {
			resolved, resolveErr := filepath.EvalSymlinks(target)
			if resolveErr != nil {
				return "", resolveErr
			}
			if err := requireRelayPathInsideWorkspace(base, resolved); err != nil {
				return "", err
			}
			return resolved, nil
		}
		return target, nil
	}
	if !os.IsNotExist(statErr) {
		return "", statErr
	}
	return target, nil
}

func resolveWorkspaceReplaceMutationTarget(root string, relPath string) (string, error) {
	base, cleanRel, err := resolveWorkspaceMutationBase(root, relPath)
	if err != nil {
		return "", err
	}
	parent, err := resolveRelayWorkspaceParent(base, filepath.Dir(cleanRel), true)
	if err != nil {
		return "", err
	}
	target := filepath.Join(parent, filepath.Base(cleanRel))
	if err := requireRelayPathInsideWorkspace(base, target); err != nil {
		return "", err
	}
	if info, statErr := os.Lstat(target); statErr == nil {
		if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
			return "", errors.New("upload destination must be a regular file")
		}
	} else if !os.IsNotExist(statErr) {
		return "", statErr
	}
	return target, nil
}

func resolveWorkspaceExistingMutationPath(root string, relPath string) (string, error) {
	base, cleanRel, err := resolveWorkspaceMutationBase(root, relPath)
	if err != nil {
		return "", err
	}
	parent, err := resolveRelayWorkspaceParent(base, filepath.Dir(cleanRel), false)
	if err != nil {
		return "", err
	}
	target := filepath.Join(parent, filepath.Base(cleanRel))
	if err := requireRelayPathInsideWorkspace(base, target); err != nil {
		return "", err
	}
	if _, err := os.Lstat(target); err != nil {
		return "", err
	}
	return target, nil
}

func resolveWorkspaceMutationSource(root string, relPath string) (string, os.FileInfo, error) {
	path, info, err := resolveWorkspaceFile(root, relPath)
	return path, info, err
}

func resolveWorkspaceMutationBase(root string, relPath string) (string, string, error) {
	root = strings.TrimSpace(root)
	if root == "" {
		return "", "", errors.New("root is required")
	}
	cleanRel, err := cleanRelativePath(relPath)
	if err != nil {
		return "", "", err
	}
	if cleanRel == "" {
		return "", "", errors.New("path is required")
	}
	base, err := filepath.EvalSymlinks(root)
	if err != nil {
		return "", "", err
	}
	return base, cleanRel, nil
}

func resolveRelayWorkspaceParent(base string, parentRel string, createDirs bool) (string, error) {
	parentRel = filepath.Clean(parentRel)
	if parentRel == "." || parentRel == "" {
		return base, nil
	}
	current := base
	components := strings.Split(parentRel, string(filepath.Separator))
	for index, component := range components {
		if component == "" || component == "." {
			continue
		}
		candidate := filepath.Join(current, component)
		info, err := os.Lstat(candidate)
		if os.IsNotExist(err) && createDirs {
			created := filepath.Join(current, filepath.Join(components[index:]...))
			if err := os.MkdirAll(created, 0o755); err != nil {
				return "", err
			}
			resolved, err := filepath.EvalSymlinks(created)
			if err != nil {
				return "", err
			}
			if err := requireRelayPathInsideWorkspace(base, resolved); err != nil {
				return "", err
			}
			return resolved, nil
		}
		if err != nil {
			return "", err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			candidate, err = filepath.EvalSymlinks(candidate)
			if err != nil {
				return "", err
			}
			if err := requireRelayPathInsideWorkspace(base, candidate); err != nil {
				return "", err
			}
			info, err = os.Stat(candidate)
			if err != nil {
				return "", err
			}
		}
		if !info.IsDir() {
			return "", errors.New("parent path is not a directory")
		}
		current = candidate
	}
	return current, requireRelayPathInsideWorkspace(base, current)
}

func requireRelayPathInsideWorkspace(base string, target string) error {
	rel, err := filepath.Rel(base, target)
	if err != nil {
		return err
	}
	if rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
		return errors.New("path escapes workspace root")
	}
	return nil
}

func copyRelayWorkspaceFile(source string, destination string, mode os.FileMode) error {
	input, err := os.Open(source)
	if err != nil {
		return err
	}
	defer input.Close()
	output, err := os.OpenFile(destination, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode.Perm())
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(output, input)
	closeErr := output.Close()
	if copyErr != nil || closeErr != nil {
		_ = os.Remove(destination)
		if copyErr != nil {
			return copyErr
		}
	}
	return closeErr
}

func buildFileList(root string, excluded []string, limit int) (runtimecore.FileListResult, error) {
	root = strings.TrimSpace(root)
	if root == "" {
		return runtimecore.FileListResult{}, errors.New("root is required")
	}
	base, err := filepath.Abs(root)
	if err != nil {
		return runtimecore.FileListResult{}, err
	}
	if limit <= 0 || limit > 10000 {
		limit = 10000
	}
	normalizedExcluded := make([]string, 0, len(excluded))
	for _, path := range excluded {
		cleaned, cleanErr := cleanRelativePath(path)
		if cleanErr == nil && cleaned != "" {
			normalizedExcluded = append(normalizedExcluded, filepath.ToSlash(cleaned))
		}
	}
	result := runtimecore.FileListResult{Files: []runtimecore.FileListEntry{}}
	err = filepath.WalkDir(base, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil || path == base {
			return nil
		}
		rel, relErr := filepath.Rel(base, path)
		if relErr != nil {
			return nil
		}
		relativePath := filepath.ToSlash(rel)
		if fileListPathExcluded(relativePath, normalizedExcluded) {
			if entry.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if entry.IsDir() {
			return nil
		}
		result.TotalCount++
		if len(result.Files) >= limit {
			result.Truncated = true
			return filepath.SkipAll
		}
		result.Files = append(result.Files, runtimecore.FileListEntry{RelativePath: relativePath})
		return nil
	})
	return result, err
}

func fileListPathExcluded(path string, excluded []string) bool {
	for _, entry := range excluded {
		if path == entry || strings.HasPrefix(path, entry+"/") {
			return true
		}
	}
	return false
}

func resolveWorkspaceReadPath(base string, fullPath string) (string, error) {
	resolvedBase, err := filepath.EvalSymlinks(base)
	if err != nil {
		return "", err
	}
	resolvedPath, err := filepath.EvalSymlinks(fullPath)
	if err != nil {
		return "", err
	}
	rel, err := filepath.Rel(resolvedBase, resolvedPath)
	if err != nil {
		return "", err
	}
	if rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
		return "", errors.New("path escapes workspace root")
	}

	return resolvedPath, nil
}

func collectEntries(projectID string, worktreeID string, base string, dir string, depth int, maxDepth int, entries *[]runtimecore.FileEntry) error {
	children, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	for _, child := range children {
		fullPath := filepath.Join(dir, child.Name())
		info, err := os.Lstat(fullPath)
		if err != nil {
			return err
		}
		entry, err := entryFromInfo(projectID, worktreeID, base, fullPath, info)
		if err != nil {
			return err
		}
		*entries = append(*entries, entry)
		if info.IsDir() && depth < maxDepth {
			if err := collectEntries(projectID, worktreeID, base, fullPath, depth+1, maxDepth, entries); err != nil {
				return err
			}
		}
	}
	return nil
}

func entryFromInfo(projectID string, worktreeID string, base string, fullPath string, info os.FileInfo) (runtimecore.FileEntry, error) {
	rel, err := filepath.Rel(base, fullPath)
	if err != nil {
		return runtimecore.FileEntry{}, err
	}
	kind := runtimecore.FileEntryFile
	if info.IsDir() {
		kind = runtimecore.FileEntryDirectory
	} else if info.Mode()&os.ModeSymlink != 0 {
		kind = runtimecore.FileEntrySymlink
	}
	return runtimecore.FileEntry{
		ProjectID:  projectID,
		WorktreeID: worktreeID,
		Path:       filepath.ToSlash(rel),
		Name:       info.Name(),
		Kind:       kind,
		Size:       info.Size(),
		ModifiedAt: info.ModTime().UTC(),
	}, nil
}

func cleanRelativePath(path string) (string, error) {
	path = strings.TrimSpace(path)
	if path == "" || path == "." {
		return "", nil
	}
	path = filepath.FromSlash(path)
	if filepath.IsAbs(path) {
		return "", errors.New("path must be workspace-relative")
	}
	cleaned := filepath.Clean(path)
	if cleaned == "." {
		return "", nil
	}
	if cleaned == ".." || strings.HasPrefix(cleaned, ".."+string(filepath.Separator)) {
		return "", errors.New("path escapes workspace root")
	}
	return cleaned, nil
}

func postJSON(client *http.Client, output io.Writer, endpoint string, token string, path string, payload interface{}) error {
	content, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	req, err := http.NewRequest(http.MethodPost, strings.TrimRight(endpoint, "/")+path, bytes.NewReader(content))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if strings.TrimSpace(token) != "" {
		req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(token))
	}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}
	if resp.StatusCode >= 400 {
		return fmt.Errorf("%s", strings.TrimSpace(string(body)))
	}
	_, err = output.Write(body)
	return err
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: pebble-relay-worker <file-tree|file-tree-json|file-read|file-read-json|file-read-chunk-json|file-stat-json|file-list-all-json|directory-list-json|file-mutate-json|file-search-json|file-watch-snapshot-json|terminal-artifact-json|project-clone-json|git-status|worktree-remove|branch-delete|agent-detect|terminal-capabilities-json|scan-nested|agent-hooks-install|external-automations|ports-detect|git-text-generation-context|provider-text-generation-json|ai-vault-scan-json> [flags]")
}
