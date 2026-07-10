package main

import (
	"bytes"
	"context"
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

	"github.com/tsekaluk/pebble/go-runtime/internal/runtimecore"
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
	case "file-read":
		return runFileRead(args[1:], client, output)
	case "git-status":
		return runGitStatus(args[1:], client, output)
	case "worktree-remove":
		return runWorktreeRemove(args[1:], client, output)
	case "branch-delete":
		return runBranchDelete(args[1:], client, output)
	case "agent-detect":
		return runAgentDetect(args[1:], client, output)
	default:
		usage()
		return fmt.Errorf("unknown relay worker command %q", args[0])
	}
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
	_ = fs.Parse(args)
	projection, err := buildGitProjection(*repositoryID, *workspaceID, *root, *provider, *reviewKind, *baseBranch)
	if err != nil {
		return err
	}
	return postJSON(client, output, *endpoint, *token, "/v1/source-control/projections", projection)
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
	branch, ahead, behind, changes := parseGitStatusOutput(string(output))
	syncStatus := "clean"
	if len(changes) > 0 {
		syncStatus = "dirty"
	}
	return runtimecore.UpdateSourceControlProjectionRequest{
		RepositoryID: repositoryID,
		WorkspaceID:  workspaceID,
		Provider:     strings.TrimSpace(provider),
		ReviewKind:   strings.TrimSpace(reviewKind),
		Branch:       branch,
		BaseBranch:   strings.TrimSpace(baseBranch),
		Ahead:        ahead,
		Behind:       behind,
		SyncStatus:   syncStatus,
		Changes:      changes,
	}, nil
}

func parseGitStatusOutput(output string) (string, int, int, []runtimecore.SourceControlChange) {
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
		status := gitChangeStatus(line[:2])
		path := strings.TrimSpace(line[3:])
		if _, renamedTo, ok := strings.Cut(path, " -> "); ok {
			path = strings.TrimSpace(renamedTo)
		}
		if status == "" || path == "" {
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
	fmt.Fprintln(os.Stderr, "usage: pebble-relay-worker <file-tree|file-read|git-status|worktree-remove|branch-delete|agent-detect> [flags]")
}
