package runtimecore

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const (
	defaultFileReadLimitBytes int64 = 1024 * 1024
	maxFileReadLimitBytes     int64 = 10 * 1024 * 1024
)

type FileEntryKind string

const (
	FileEntryFile      FileEntryKind = "file"
	FileEntryDirectory FileEntryKind = "directory"
	FileEntrySymlink   FileEntryKind = "symlink"
)

type FileEntry struct {
	ProjectID  string        `json:"projectId"`
	WorktreeID string        `json:"worktreeId,omitempty"`
	Path       string        `json:"path"`
	Name       string        `json:"name"`
	Kind       FileEntryKind `json:"kind"`
	Size       int64         `json:"size,omitempty"`
	ModifiedAt time.Time     `json:"modifiedAt"`
}

type ListFilesRequest struct {
	ProjectID  string `json:"projectId"`
	WorktreeID string `json:"worktreeId,omitempty"`
	Path       string `json:"path,omitempty"`
	MaxDepth   int    `json:"maxDepth,omitempty"`
}

type ReadFileRequest struct {
	ProjectID  string `json:"projectId"`
	WorktreeID string `json:"worktreeId,omitempty"`
	Path       string `json:"path"`
	MaxBytes   int64  `json:"maxBytes,omitempty"`
}

type FileContent struct {
	ProjectID  string    `json:"projectId"`
	WorktreeID string    `json:"worktreeId,omitempty"`
	Path       string    `json:"path"`
	Encoding   string    `json:"encoding"`
	Content    string    `json:"content"`
	Size       int64     `json:"size"`
	ModifiedAt time.Time `json:"modifiedAt"`
}

type WriteFileRequest struct {
	ProjectID  string `json:"projectId"`
	WorktreeID string `json:"worktreeId,omitempty"`
	Path       string `json:"path"`
	Content    string `json:"content"`
	CreateDirs bool   `json:"createDirs,omitempty"`
}

func (m *Manager) ListFiles(req ListFilesRequest) ([]FileEntry, error) {
	base, err := m.resolveWorkspacePath(req.ProjectID, req.WorktreeID)
	if err != nil {
		if errors.Is(err, ErrRemoteNeedsRelay) {
			entries, ok, cacheErr := m.cachedRemoteFileTree(req)
			if cacheErr != nil {
				return nil, cacheErr
			}
			if ok {
				return entries, nil
			}
		}
		return nil, err
	}
	relPath, err := cleanWorkspaceRelativePath(req.Path)
	if err != nil {
		return nil, err
	}
	maxDepth := req.MaxDepth
	if maxDepth <= 0 {
		maxDepth = 1
	}
	if maxDepth > 8 {
		maxDepth = 8
	}
	root := filepath.Join(base, relPath)
	info, err := os.Lstat(root)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() {
		entry, err := fileEntryFromInfo(req.ProjectID, req.WorktreeID, base, root, info)
		if err != nil {
			return nil, err
		}
		return []FileEntry{entry}, nil
	}
	entries := make([]FileEntry, 0)
	err = collectFileEntries(req.ProjectID, req.WorktreeID, base, root, 1, maxDepth, &entries)
	if err != nil {
		return nil, err
	}
	sortFileEntries(entries)
	return entries, nil
}

func (m *Manager) ReadFile(req ReadFileRequest) (FileContent, error) {
	base, err := m.resolveWorkspacePath(req.ProjectID, req.WorktreeID)
	if err != nil {
		if errors.Is(err, ErrRemoteNeedsRelay) {
			content, ok, cacheErr := m.cachedRemoteFileContent(req)
			if cacheErr != nil {
				return FileContent{}, cacheErr
			}
			if ok {
				return content, nil
			}
		}
		return FileContent{}, err
	}
	relPath, err := cleanWorkspaceRelativePath(req.Path)
	if err != nil {
		return FileContent{}, err
	}
	if relPath == "" {
		return FileContent{}, errors.New("file path is required")
	}
	fullPath := filepath.Join(base, relPath)
	readPath, info, err := resolveExistingWorkspaceFilePath(base, fullPath)
	if err != nil {
		return FileContent{}, err
	}
	if info.IsDir() {
		return FileContent{}, errors.New("cannot read a directory")
	}
	limit := req.MaxBytes
	limit = normalizedFileReadLimit(limit)
	file, err := os.Open(readPath)
	if err != nil {
		return FileContent{}, err
	}
	defer file.Close()
	content, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil {
		return FileContent{}, err
	}
	if int64(len(content)) > limit {
		return FileContent{}, errors.New("file exceeds read limit")
	}
	return FileContent{
		ProjectID:  strings.TrimSpace(req.ProjectID),
		WorktreeID: strings.TrimSpace(req.WorktreeID),
		Path:       filepath.ToSlash(relPath),
		Encoding:   "utf-8",
		Content:    string(content),
		Size:       info.Size(),
		ModifiedAt: info.ModTime().UTC(),
	}, nil
}

func (m *Manager) WriteFile(req WriteFileRequest) (FileContent, error) {
	base, err := m.resolveWorkspacePath(req.ProjectID, req.WorktreeID)
	if err != nil {
		return FileContent{}, err
	}
	relPath, err := cleanWorkspaceRelativePath(req.Path)
	if err != nil {
		return FileContent{}, err
	}
	if relPath == "" {
		return FileContent{}, errors.New("file path is required")
	}
	if int64(len(req.Content)) > maxFileReadLimitBytes {
		return FileContent{}, errors.New("file exceeds write limit")
	}
	writePath, err := resolveWorkspaceWritePath(base, relPath, req.CreateDirs)
	if err != nil {
		return FileContent{}, err
	}
	if err := os.WriteFile(writePath, []byte(req.Content), 0o644); err != nil {
		return FileContent{}, err
	}
	content, err := m.ReadFile(ReadFileRequest{
		ProjectID:  req.ProjectID,
		WorktreeID: req.WorktreeID,
		Path:       relPath,
		MaxBytes:   int64(len(req.Content)) + 1,
	})
	if err != nil {
		return FileContent{}, err
	}
	m.emit("file.changed", content)
	return content, nil
}

func normalizedFileReadLimit(limit int64) int64 {
	if limit <= 0 {
		return defaultFileReadLimitBytes
	}
	if limit > maxFileReadLimitBytes {
		return maxFileReadLimitBytes
	}
	return limit
}

func (m *Manager) resolveWorkspacePath(projectID string, worktreeID string) (string, error) {
	projectID = strings.TrimSpace(projectID)
	worktreeID = strings.TrimSpace(worktreeID)
	if projectID == "" {
		return "", ErrProjectRequired
	}
	m.mu.RLock()
	project, projectOK := m.projects[projectID]
	var worktree Worktree
	var worktreeOK bool
	if worktreeID != "" {
		worktree, worktreeOK = m.worktrees[worktreeID]
	}
	m.mu.RUnlock()
	if !projectOK {
		return "", ErrNotFound
	}
	if project.LocationKind != "local" {
		return "", ErrRemoteNeedsRelay
	}
	if worktreeID == "" {
		return project.Path, nil
	}
	if !worktreeOK || worktree.ProjectID != projectID {
		return "", ErrNotFound
	}
	return worktree.Path, nil
}

func collectFileEntries(projectID string, worktreeID string, base string, dir string, depth int, maxDepth int, entries *[]FileEntry) error {
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
		entry, err := fileEntryFromInfo(projectID, worktreeID, base, fullPath, info)
		if err != nil {
			return err
		}
		*entries = append(*entries, entry)
		if info.IsDir() && depth < maxDepth {
			if err := collectFileEntries(projectID, worktreeID, base, fullPath, depth+1, maxDepth, entries); err != nil {
				return err
			}
		}
	}
	return nil
}

func fileEntryFromInfo(projectID string, worktreeID string, base string, fullPath string, info os.FileInfo) (FileEntry, error) {
	rel, err := filepath.Rel(base, fullPath)
	if err != nil {
		return FileEntry{}, err
	}
	kind := FileEntryFile
	if info.IsDir() {
		kind = FileEntryDirectory
	} else if info.Mode()&os.ModeSymlink != 0 {
		kind = FileEntrySymlink
	}
	return FileEntry{
		ProjectID:  strings.TrimSpace(projectID),
		WorktreeID: strings.TrimSpace(worktreeID),
		Path:       filepath.ToSlash(rel),
		Name:       info.Name(),
		Kind:       kind,
		Size:       info.Size(),
		ModifiedAt: info.ModTime().UTC(),
	}, nil
}

func resolveExistingWorkspaceFilePath(base string, fullPath string) (string, os.FileInfo, error) {
	resolvedBase, err := filepath.EvalSymlinks(base)
	if err != nil {
		return "", nil, err
	}
	resolvedPath, err := filepath.EvalSymlinks(fullPath)
	if err != nil {
		return "", nil, err
	}
	if err := requirePathInsideWorkspace(resolvedBase, resolvedPath); err != nil {
		return "", nil, err
	}
	info, err := os.Stat(resolvedPath)
	if err != nil {
		return "", nil, err
	}
	return resolvedPath, info, nil
}

func resolveWorkspaceWritePath(base string, relPath string, createDirs bool) (string, error) {
	resolvedBase, err := filepath.EvalSymlinks(base)
	if err != nil {
		return "", err
	}
	parent, err := resolveWorkspaceParentPath(resolvedBase, filepath.Dir(relPath), createDirs)
	if err != nil {
		return "", err
	}
	target := filepath.Join(parent, filepath.Base(relPath))
	if resolvedTarget, err := filepath.EvalSymlinks(target); err == nil {
		if err := requirePathInsideWorkspace(resolvedBase, resolvedTarget); err != nil {
			return "", err
		}
		return resolvedTarget, nil
	} else if !os.IsNotExist(err) {
		return "", err
	}
	return target, nil
}

func resolveWorkspaceParentPath(resolvedBase string, parentRel string, createDirs bool) (string, error) {
	parentRel = filepath.Clean(parentRel)
	if parentRel == "." || parentRel == "" {
		return resolvedBase, nil
	}
	components := strings.Split(parentRel, string(filepath.Separator))
	current := resolvedBase
	for index, component := range components {
		if component == "" || component == "." {
			continue
		}
		candidate := filepath.Join(current, component)
		info, err := os.Lstat(candidate)
		if err != nil {
			if os.IsNotExist(err) && createDirs {
				createdPath := filepath.Join(current, joinPathComponents(components[index:]))
				if err := os.MkdirAll(createdPath, 0o755); err != nil {
					return "", err
				}
				resolvedCreatedPath, err := filepath.EvalSymlinks(createdPath)
				if err != nil {
					return "", err
				}
				if err := requirePathInsideWorkspace(resolvedBase, resolvedCreatedPath); err != nil {
					return "", err
				}
				return resolvedCreatedPath, nil
			}
			return "", err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			resolvedCandidate, err := filepath.EvalSymlinks(candidate)
			if err != nil {
				return "", err
			}
			if err := requirePathInsideWorkspace(resolvedBase, resolvedCandidate); err != nil {
				return "", err
			}
			info, err = os.Stat(resolvedCandidate)
			if err != nil {
				return "", err
			}
			if !info.IsDir() {
				return "", errors.New("parent path is not a directory")
			}
			current = resolvedCandidate
			continue
		}
		if !info.IsDir() {
			return "", errors.New("parent path is not a directory")
		}
		current = candidate
	}
	if err := requirePathInsideWorkspace(resolvedBase, current); err != nil {
		return "", err
	}
	return current, nil
}

func requirePathInsideWorkspace(resolvedBase string, resolvedPath string) error {
	rel, err := filepath.Rel(resolvedBase, resolvedPath)
	if err != nil {
		return err
	}
	// Symlinks can escape lexical workspace checks even after "../" is rejected.
	if rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
		return ErrInvalidPath
	}
	return nil
}

func joinPathComponents(components []string) string {
	if len(components) == 0 {
		return ""
	}
	return filepath.Join(components...)
}

func cleanWorkspaceRelativePath(path string) (string, error) {
	path = strings.TrimSpace(path)
	if path == "" || path == "." {
		return "", nil
	}
	path = filepath.FromSlash(path)
	if filepath.IsAbs(path) {
		return "", ErrInvalidPath
	}
	cleaned := filepath.Clean(path)
	if cleaned == "." {
		return "", nil
	}
	if cleaned == ".." || strings.HasPrefix(cleaned, ".."+string(filepath.Separator)) {
		return "", ErrInvalidPath
	}
	return cleaned, nil
}

func sortFileEntries(entries []FileEntry) {
	sort.Slice(entries, func(i, j int) bool {
		if entries[i].Path == entries[j].Path {
			return entries[i].Name < entries[j].Name
		}
		return entries[i].Path < entries[j].Path
	})
}
