package runtimecore

import (
	"encoding/base64"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode"
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

type ReadFileChunkRequest struct {
	ProjectID  string `json:"projectId"`
	WorktreeID string `json:"worktreeId,omitempty"`
	Path       string `json:"path"`
	Offset     int64  `json:"offset,omitempty"`
	Length     int64  `json:"length,omitempty"`
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

type FileChunk struct {
	ContentBase64 string `json:"contentBase64"`
	BytesRead     int    `json:"bytesRead"`
	EOF           bool   `json:"eof"`
}

type WriteFileRequest struct {
	ProjectID  string `json:"projectId"`
	WorktreeID string `json:"worktreeId,omitempty"`
	Path       string `json:"path"`
	Content    string `json:"content"`
	CreateDirs bool   `json:"createDirs,omitempty"`
}

type WriteFileBase64Request struct {
	ProjectID     string `json:"projectId"`
	WorktreeID    string `json:"worktreeId,omitempty"`
	Path          string `json:"path"`
	ContentBase64 string `json:"contentBase64"`
	Append        bool   `json:"append,omitempty"`
}

type FileMutationRequest struct {
	ProjectID  string `json:"projectId"`
	WorktreeID string `json:"worktreeId,omitempty"`
	Path       string `json:"path"`
	Recursive  bool   `json:"recursive,omitempty"`
}

type FileRenameRequest struct {
	ProjectID       string `json:"projectId"`
	WorktreeID      string `json:"worktreeId,omitempty"`
	OldPath         string `json:"oldPath"`
	NewPath         string `json:"newPath"`
	SourcePath      string `json:"sourcePath,omitempty"`
	DestinationPath string `json:"destinationPath,omitempty"`
}

type FileStat struct {
	Size        int64 `json:"size"`
	IsDirectory bool  `json:"isDirectory"`
	Mtime       int64 `json:"mtime"`
}

type ListAllFilesRequest struct {
	ProjectID    string   `json:"projectId"`
	WorktreeID   string   `json:"worktreeId,omitempty"`
	ExcludePaths []string `json:"excludePaths,omitempty"`
	Limit        int      `json:"limit,omitempty"`
}

type FileListEntry struct {
	RelativePath string `json:"relativePath"`
}

type FileListResult struct {
	Files      []FileListEntry `json:"files"`
	TotalCount int             `json:"totalCount"`
	Truncated  bool            `json:"truncated"`
}

type MarkdownDocument struct {
	FilePath     string `json:"filePath"`
	RelativePath string `json:"relativePath"`
	Basename     string `json:"basename"`
	Name         string `json:"name"`
}

type FileSearchRequest struct {
	ProjectID      string `json:"projectId"`
	WorktreeID     string `json:"worktreeId,omitempty"`
	Query          string `json:"query"`
	CaseSensitive  bool   `json:"caseSensitive,omitempty"`
	WholeWord      bool   `json:"wholeWord,omitempty"`
	UseRegex       bool   `json:"useRegex,omitempty"`
	IncludePattern string `json:"includePattern,omitempty"`
	ExcludePattern string `json:"excludePattern,omitempty"`
	MaxResults     int    `json:"maxResults,omitempty"`
}

type SearchMatch struct {
	Line        int    `json:"line"`
	Column      int    `json:"column"`
	MatchLength int    `json:"matchLength"`
	LineContent string `json:"lineContent"`
}

type SearchFileResult struct {
	FilePath     string        `json:"filePath"`
	RelativePath string        `json:"relativePath"`
	Matches      []SearchMatch `json:"matches"`
	MatchCount   int           `json:"matchCount,omitempty"`
}

type SearchResult struct {
	Files        []SearchFileResult `json:"files"`
	TotalMatches int                `json:"totalMatches"`
	Truncated    bool               `json:"truncated"`
}

type ServerDirectoryBrowseRequest struct {
	Path string `json:"path"`
}

type ServerDirectoryEntry struct {
	Name        string `json:"name"`
	IsDirectory bool   `json:"isDirectory"`
	IsSymlink   bool   `json:"isSymlink"`
}

type ServerDirectoryBrowseResult struct {
	ResolvedPath string                 `json:"resolvedPath"`
	Entries      []ServerDirectoryEntry `json:"entries"`
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

func (m *Manager) ReadFileChunk(req ReadFileChunkRequest) (FileChunk, error) {
	base, err := m.resolveWorkspacePath(req.ProjectID, req.WorktreeID)
	if err != nil {
		return FileChunk{}, err
	}
	relPath, err := cleanRequiredWorkspaceRelativePath(req.Path)
	if err != nil {
		return FileChunk{}, err
	}
	readPath, info, err := resolveExistingWorkspaceFilePath(base, filepath.Join(base, relPath))
	if err != nil {
		return FileChunk{}, err
	}
	if info.IsDir() {
		return FileChunk{}, errors.New("cannot read a directory")
	}
	if req.Offset < 0 {
		return FileChunk{}, errors.New("offset must be non-negative")
	}
	length := req.Length
	if length <= 0 {
		return FileChunk{}, errors.New("length must be positive")
	}
	if length > maxFileReadLimitBytes {
		length = maxFileReadLimitBytes
	}
	if req.Offset >= info.Size() {
		return FileChunk{ContentBase64: "", BytesRead: 0, EOF: true}, nil
	}
	remaining := info.Size() - req.Offset
	if length > remaining {
		length = remaining
	}
	file, err := os.Open(readPath)
	if err != nil {
		return FileChunk{}, err
	}
	defer file.Close()
	buffer := make([]byte, int(length))
	bytesRead, err := file.ReadAt(buffer, req.Offset)
	if err != nil && !errors.Is(err, io.EOF) {
		return FileChunk{}, err
	}
	buffer = buffer[:bytesRead]
	return FileChunk{
		ContentBase64: base64.StdEncoding.EncodeToString(buffer),
		BytesRead:     bytesRead,
		EOF:           req.Offset+int64(bytesRead) >= info.Size(),
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

func (m *Manager) WriteFileBase64(req WriteFileBase64Request) error {
	base, relPath, err := m.resolveLocalMutationTarget(req.ProjectID, req.WorktreeID, req.Path)
	if err != nil {
		return err
	}
	content, err := base64.StdEncoding.DecodeString(req.ContentBase64)
	if err != nil {
		return err
	}
	if int64(len(content)) > maxFileReadLimitBytes {
		return errors.New("file exceeds write limit")
	}
	writePath, err := resolveWorkspaceWritePath(base, relPath, true)
	if err != nil {
		return err
	}
	flag := os.O_WRONLY | os.O_CREATE | os.O_EXCL
	if req.Append {
		flag = os.O_WRONLY | os.O_CREATE | os.O_APPEND
	}
	file, err := os.OpenFile(writePath, flag, 0o644)
	if err != nil {
		return err
	}
	_, writeErr := file.Write(content)
	closeErr := file.Close()
	if writeErr != nil {
		return writeErr
	}
	return closeErr
}

func (m *Manager) CreateFile(req FileMutationRequest) error {
	base, relPath, err := m.resolveLocalMutationTarget(req.ProjectID, req.WorktreeID, req.Path)
	if err != nil {
		return err
	}
	target, err := resolveWorkspaceWritePath(base, relPath, true)
	if err != nil {
		return err
	}
	file, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		return err
	}
	return file.Close()
}

func (m *Manager) CreateDirectory(req FileMutationRequest) error {
	base, relPath, err := m.resolveLocalMutationTarget(req.ProjectID, req.WorktreeID, req.Path)
	if err != nil {
		return err
	}
	target, err := resolveWorkspaceNewChildPath(base, relPath, false)
	if err != nil {
		return err
	}
	return os.Mkdir(target, 0o755)
}

func (m *Manager) RenamePath(req FileRenameRequest) error {
	base, oldRelPath, err := m.resolveLocalMutationTarget(req.ProjectID, req.WorktreeID, req.OldPath)
	if err != nil {
		return err
	}
	newRelPath, err := cleanRequiredWorkspaceRelativePath(req.NewPath)
	if err != nil {
		return err
	}
	oldPath, err := resolveWorkspaceExistingChildPath(base, oldRelPath)
	if err != nil {
		return err
	}
	newPath, err := resolveWorkspaceNewChildPath(base, newRelPath, false)
	if err != nil {
		return err
	}
	return os.Rename(oldPath, newPath)
}

func (m *Manager) CopyPath(req FileRenameRequest) error {
	sourcePath := req.SourcePath
	if sourcePath == "" {
		sourcePath = req.OldPath
	}
	destinationPath := req.DestinationPath
	if destinationPath == "" {
		destinationPath = req.NewPath
	}
	base, sourceRelPath, err := m.resolveLocalMutationTarget(req.ProjectID, req.WorktreeID, sourcePath)
	if err != nil {
		return err
	}
	destinationRelPath, err := cleanRequiredWorkspaceRelativePath(destinationPath)
	if err != nil {
		return err
	}
	source, info, err := resolveExistingWorkspaceFilePath(base, filepath.Join(base, sourceRelPath))
	if err != nil {
		return err
	}
	if info.IsDir() {
		return errors.New("cannot copy a directory")
	}
	destination, err := resolveWorkspaceNewChildPath(base, destinationRelPath, true)
	if err != nil {
		return err
	}
	return copyWorkspaceFile(source, destination, info.Mode())
}

func (m *Manager) DeletePath(req FileMutationRequest) error {
	base, relPath, err := m.resolveLocalMutationTarget(req.ProjectID, req.WorktreeID, req.Path)
	if err != nil {
		return err
	}
	target, err := resolveWorkspaceExistingChildPath(base, relPath)
	if err != nil {
		return err
	}
	if req.Recursive {
		return os.RemoveAll(target)
	}
	return os.Remove(target)
}

func (m *Manager) StatFile(req ReadFileRequest) (FileStat, error) {
	base, err := m.resolveWorkspacePath(req.ProjectID, req.WorktreeID)
	if err != nil {
		return FileStat{}, err
	}
	relPath, err := cleanRequiredWorkspaceRelativePath(req.Path)
	if err != nil {
		return FileStat{}, err
	}
	_, info, err := resolveExistingWorkspaceFilePath(base, filepath.Join(base, relPath))
	if err != nil {
		return FileStat{}, err
	}
	return FileStat{
		Size:        info.Size(),
		IsDirectory: info.IsDir(),
		Mtime:       info.ModTime().UnixMilli(),
	}, nil
}

func (m *Manager) ListAllFiles(req ListAllFilesRequest) (FileListResult, error) {
	base, err := m.resolveWorkspacePath(req.ProjectID, req.WorktreeID)
	if err != nil {
		return FileListResult{}, err
	}
	limit := req.Limit
	if limit <= 0 || limit > 10000 {
		limit = 10000
	}
	excluded := normalizedExcludedPaths(req.ExcludePaths)
	result := FileListResult{Files: []FileListEntry{}}
	err = filepath.WalkDir(base, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil || path == base {
			return nil
		}
		rel, err := filepath.Rel(base, path)
		if err != nil {
			return nil
		}
		relativePath := filepath.ToSlash(rel)
		if isExcludedRelativePath(relativePath, excluded) {
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
		result.Files = append(result.Files, FileListEntry{RelativePath: relativePath})
		return nil
	})
	if err != nil {
		return FileListResult{}, err
	}
	return result, nil
}

func (m *Manager) ListMarkdownDocuments(req ListAllFilesRequest) ([]MarkdownDocument, error) {
	base, err := m.resolveWorkspacePath(req.ProjectID, req.WorktreeID)
	if err != nil {
		return nil, err
	}
	files, err := m.ListAllFiles(req)
	if err != nil {
		return nil, err
	}
	documents := make([]MarkdownDocument, 0)
	for _, file := range files.Files {
		ext := strings.ToLower(filepath.Ext(file.RelativePath))
		if ext != ".md" && ext != ".mdx" {
			continue
		}
		basename := filepath.Base(file.RelativePath)
		documents = append(documents, MarkdownDocument{
			FilePath:     filepath.Join(base, filepath.FromSlash(file.RelativePath)),
			RelativePath: file.RelativePath,
			Basename:     basename,
			Name:         strings.TrimSuffix(basename, filepath.Ext(basename)),
		})
	}
	return documents, nil
}

func (m *Manager) SearchFiles(req FileSearchRequest) (SearchResult, error) {
	base, err := m.resolveWorkspacePath(req.ProjectID, req.WorktreeID)
	if err != nil {
		return SearchResult{}, err
	}
	if strings.TrimSpace(req.Query) == "" {
		return SearchResult{Files: []SearchFileResult{}}, nil
	}
	matcher, err := newRuntimeFileMatcher(req)
	if err != nil {
		return SearchResult{}, err
	}
	limit := req.MaxResults
	if limit <= 0 || limit > 1000 {
		limit = 1000
	}
	result := SearchResult{Files: []SearchFileResult{}}
	err = filepath.WalkDir(base, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil || path == base {
			return nil
		}
		rel, err := filepath.Rel(base, path)
		if err != nil {
			return nil
		}
		relativePath := filepath.ToSlash(rel)
		if entry.IsDir() {
			if matcher.excludesPath(relativePath) {
				return filepath.SkipDir
			}
			return nil
		}
		if !matcher.includesPath(relativePath) || matcher.excludesPath(relativePath) {
			return nil
		}
		fileResult, ok := searchFile(path, relativePath, matcher, limit-result.TotalMatches)
		if !ok {
			return nil
		}
		result.Files = append(result.Files, fileResult)
		result.TotalMatches += fileResult.MatchCount
		if result.TotalMatches >= limit {
			result.Truncated = true
			return filepath.SkipAll
		}
		return nil
	})
	if err != nil {
		return SearchResult{}, err
	}
	return result, nil
}

func (m *Manager) BrowseServerDirectory(req ServerDirectoryBrowseRequest) (ServerDirectoryBrowseResult, error) {
	rawPath := strings.TrimSpace(req.Path)
	if rawPath == "" || rawPath == "~" {
		home, err := os.UserHomeDir()
		if err != nil {
			return ServerDirectoryBrowseResult{}, err
		}
		rawPath = home
	} else if strings.HasPrefix(rawPath, "~/") || strings.HasPrefix(rawPath, "~\\") {
		home, err := os.UserHomeDir()
		if err != nil {
			return ServerDirectoryBrowseResult{}, err
		}
		rawPath = filepath.Join(home, rawPath[2:])
	}
	if !filepath.IsAbs(rawPath) {
		return ServerDirectoryBrowseResult{}, errors.New("server directory path must be absolute")
	}
	resolvedPath, err := filepath.Abs(rawPath)
	if err != nil {
		return ServerDirectoryBrowseResult{}, err
	}
	info, err := os.Stat(resolvedPath)
	if err != nil {
		return ServerDirectoryBrowseResult{}, err
	}
	if !info.IsDir() {
		return ServerDirectoryBrowseResult{}, errors.New("path is not a directory")
	}
	children, err := os.ReadDir(resolvedPath)
	if err != nil {
		return ServerDirectoryBrowseResult{}, err
	}
	entries := make([]ServerDirectoryEntry, 0, len(children))
	for _, child := range children {
		childInfo, err := child.Info()
		if err != nil {
			continue
		}
		entries = append(entries, ServerDirectoryEntry{
			Name:        child.Name(),
			IsDirectory: childInfo.IsDir(),
			IsSymlink:   childInfo.Mode()&os.ModeSymlink != 0,
		})
	}
	sort.Slice(entries, func(i, j int) bool {
		if entries[i].IsDirectory != entries[j].IsDirectory {
			return entries[i].IsDirectory
		}
		return strings.ToLower(entries[i].Name) < strings.ToLower(entries[j].Name)
	})
	return ServerDirectoryBrowseResult{
		ResolvedPath: resolvedPath,
		Entries:      entries,
	}, nil
}

func (m *Manager) resolveLocalMutationTarget(projectID string, worktreeID string, path string) (string, string, error) {
	base, err := m.resolveWorkspacePath(projectID, worktreeID)
	if err != nil {
		return "", "", err
	}
	relPath, err := cleanRequiredWorkspaceRelativePath(path)
	if err != nil {
		return "", "", err
	}
	return base, relPath, nil
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

func cleanRequiredWorkspaceRelativePath(path string) (string, error) {
	relPath, err := cleanWorkspaceRelativePath(path)
	if err != nil {
		return "", err
	}
	if relPath == "" {
		return "", errors.New("file path is required")
	}
	return relPath, nil
}

func resolveWorkspaceExistingChildPath(base string, relPath string) (string, error) {
	resolvedBase, err := filepath.EvalSymlinks(base)
	if err != nil {
		return "", err
	}
	parent, err := resolveWorkspaceParentPath(resolvedBase, filepath.Dir(relPath), false)
	if err != nil {
		return "", err
	}
	target := filepath.Join(parent, filepath.Base(relPath))
	if err := requirePathInsideWorkspace(resolvedBase, target); err != nil {
		return "", err
	}
	if _, err := os.Lstat(target); err != nil {
		return "", err
	}
	return target, nil
}

func resolveWorkspaceNewChildPath(base string, relPath string, createDirs bool) (string, error) {
	resolvedBase, err := filepath.EvalSymlinks(base)
	if err != nil {
		return "", err
	}
	parent, err := resolveWorkspaceParentPath(resolvedBase, filepath.Dir(relPath), createDirs)
	if err != nil {
		return "", err
	}
	target := filepath.Join(parent, filepath.Base(relPath))
	if err := requirePathInsideWorkspace(resolvedBase, target); err != nil {
		return "", err
	}
	if _, err := os.Lstat(target); err == nil {
		return "", os.ErrExist
	} else if !os.IsNotExist(err) {
		return "", err
	}
	return target, nil
}

func copyWorkspaceFile(source string, destination string, mode os.FileMode) error {
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
	if copyErr != nil {
		_ = os.Remove(destination)
		return copyErr
	}
	if closeErr != nil {
		_ = os.Remove(destination)
		return closeErr
	}
	return nil
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

func normalizedExcludedPaths(paths []string) []string {
	normalized := make([]string, 0, len(paths))
	for _, path := range paths {
		relPath, err := cleanWorkspaceRelativePath(path)
		if err != nil || relPath == "" {
			continue
		}
		normalized = append(normalized, filepath.ToSlash(relPath))
	}
	return normalized
}

func isExcludedRelativePath(path string, excluded []string) bool {
	for _, entry := range excluded {
		if path == entry || strings.HasPrefix(path, entry+"/") {
			return true
		}
	}
	return false
}

type runtimeFileMatcher struct {
	query          string
	caseSensitive  bool
	wholeWord      bool
	regex          *regexp.Regexp
	includePattern string
	excludePattern string
}

func newRuntimeFileMatcher(req FileSearchRequest) (runtimeFileMatcher, error) {
	matcher := runtimeFileMatcher{
		query:          req.Query,
		caseSensitive:  req.CaseSensitive,
		wholeWord:      req.WholeWord,
		includePattern: strings.TrimSpace(req.IncludePattern),
		excludePattern: strings.TrimSpace(req.ExcludePattern),
	}
	if !matcher.caseSensitive {
		matcher.query = strings.ToLower(matcher.query)
	}
	if req.UseRegex {
		pattern := req.Query
		if !req.CaseSensitive {
			pattern = "(?i)" + pattern
		}
		regex, err := regexp.Compile(pattern)
		if err != nil {
			return runtimeFileMatcher{}, err
		}
		matcher.regex = regex
	}
	return matcher, nil
}

func (m runtimeFileMatcher) includesPath(path string) bool {
	return matchRuntimeGlob(m.includePattern, path, true)
}

func (m runtimeFileMatcher) excludesPath(path string) bool {
	return matchRuntimeGlob(m.excludePattern, path, false)
}

func matchRuntimeGlob(pattern string, path string, emptyDefault bool) bool {
	if pattern == "" {
		return emptyDefault
	}
	matched, err := filepath.Match(filepath.ToSlash(pattern), path)
	if err == nil && matched {
		return true
	}
	matched, err = filepath.Match(filepath.ToSlash(pattern), filepath.Base(path))
	return err == nil && matched
}

func searchFile(path string, relativePath string, matcher runtimeFileMatcher, remaining int) (SearchFileResult, bool) {
	if remaining <= 0 {
		return SearchFileResult{}, false
	}
	content, err := os.ReadFile(path)
	if err != nil || isLikelyBinary(content) {
		return SearchFileResult{}, false
	}
	result := SearchFileResult{
		FilePath:     path,
		RelativePath: relativePath,
		Matches:      []SearchMatch{},
	}
	lines := strings.Split(string(content), "\n")
	for index, line := range lines {
		matches := matcher.matchLine(line)
		for _, match := range matches {
			result.Matches = append(result.Matches, SearchMatch{
				Line:        index + 1,
				Column:      match.start + 1,
				MatchLength: match.length,
				LineContent: line,
			})
			result.MatchCount++
			if result.MatchCount >= remaining {
				return result, true
			}
		}
	}
	return result, result.MatchCount > 0
}

type lineMatch struct {
	start  int
	length int
}

func (m runtimeFileMatcher) matchLine(line string) []lineMatch {
	if m.regex != nil {
		locations := m.regex.FindAllStringIndex(line, -1)
		matches := make([]lineMatch, 0, len(locations))
		for _, location := range locations {
			if location[0] == location[1] {
				continue
			}
			if m.wholeWord && !isWholeWordMatch(line, location[0], location[1]) {
				continue
			}
			matches = append(matches, lineMatch{start: location[0], length: location[1] - location[0]})
		}
		return matches
	}
	haystack := line
	needle := m.query
	if !m.caseSensitive {
		haystack = strings.ToLower(line)
	}
	matches := []lineMatch{}
	offset := 0
	for {
		index := strings.Index(haystack[offset:], needle)
		if index < 0 {
			break
		}
		start := offset + index
		end := start + len(needle)
		if !m.wholeWord || isWholeWordMatch(line, start, end) {
			matches = append(matches, lineMatch{start: start, length: len(needle)})
		}
		offset = end
	}
	return matches
}

func isWholeWordMatch(line string, start int, end int) bool {
	before := rune(0)
	after := rune(0)
	if start > 0 {
		before, _ = lastRune(line[:start])
	}
	if end < len(line) {
		after, _ = firstRune(line[end:])
	}
	return !isWordRune(before) && !isWordRune(after)
}

func firstRune(value string) (rune, bool) {
	for _, char := range value {
		return char, true
	}
	return 0, false
}

func lastRune(value string) (rune, bool) {
	var last rune
	var ok bool
	for _, char := range value {
		last = char
		ok = true
	}
	return last, ok
}

func isWordRune(char rune) bool {
	return char == '_' || unicode.IsLetter(char) || unicode.IsDigit(char)
}

// binaryScanWindowBytes bounds the NUL scan; callers seeing longer payloads
// should corroborate with git's numstat markers (see gitNumstatReportsBinary).
const binaryScanWindowBytes = 8000

func isLikelyBinary(content []byte) bool {
	if len(content) == 0 {
		return false
	}
	limit := len(content)
	if limit > binaryScanWindowBytes {
		limit = binaryScanWindowBytes
	}
	for _, b := range content[:limit] {
		if b == 0 {
			return true
		}
	}
	return false
}

func sortFileEntries(entries []FileEntry) {
	sort.Slice(entries, func(i, j int) bool {
		if entries[i].Path == entries[j].Path {
			return entries[i].Name < entries[j].Name
		}
		return entries[i].Path < entries[j].Path
	})
}
