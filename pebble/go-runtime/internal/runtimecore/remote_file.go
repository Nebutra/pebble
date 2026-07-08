package runtimecore

import (
	"errors"
	"path/filepath"
	"strings"
	"time"
)

type RemoteFileTreeSnapshot struct {
	ProjectID  string      `json:"projectId"`
	WorktreeID string      `json:"worktreeId,omitempty"`
	Path       string      `json:"path,omitempty"`
	Entries    []FileEntry `json:"entries"`
	UpdatedAt  time.Time   `json:"updatedAt"`
}

type RemoteFileContentSnapshot struct {
	ProjectID  string      `json:"projectId"`
	WorktreeID string      `json:"worktreeId,omitempty"`
	Path       string      `json:"path"`
	Content    FileContent `json:"content"`
	UpdatedAt  time.Time   `json:"updatedAt"`
}

type UpdateRemoteFileTreeRequest struct {
	ProjectID  string      `json:"projectId"`
	WorktreeID string      `json:"worktreeId,omitempty"`
	Path       string      `json:"path,omitempty"`
	Entries    []FileEntry `json:"entries"`
}

type UpdateRemoteFileContentRequest struct {
	ProjectID  string     `json:"projectId"`
	WorktreeID string     `json:"worktreeId,omitempty"`
	Path       string     `json:"path"`
	Encoding   string     `json:"encoding,omitempty"`
	Content    string     `json:"content"`
	Size       int64      `json:"size,omitempty"`
	ModifiedAt *time.Time `json:"modifiedAt,omitempty"`
}

func (m *Manager) UpdateRemoteFileTree(req UpdateRemoteFileTreeRequest) (RemoteFileTreeSnapshot, error) {
	project, err := m.remoteFileProject(req.ProjectID)
	if err != nil {
		return RemoteFileTreeSnapshot{}, err
	}
	if project.LocationKind == "local" {
		return RemoteFileTreeSnapshot{}, errors.New("remote file snapshots are only for remote projects")
	}
	relPath, err := cleanWorkspaceRelativePath(req.Path)
	if err != nil {
		return RemoteFileTreeSnapshot{}, err
	}
	entries := make([]FileEntry, 0, len(req.Entries))
	for _, entry := range req.Entries {
		normalized, err := normalizeRemoteFileEntry(req.ProjectID, req.WorktreeID, entry)
		if err != nil {
			return RemoteFileTreeSnapshot{}, err
		}
		entries = append(entries, normalized)
	}
	sortFileEntries(entries)
	snapshot := RemoteFileTreeSnapshot{
		ProjectID:  strings.TrimSpace(req.ProjectID),
		WorktreeID: strings.TrimSpace(req.WorktreeID),
		Path:       filepath.ToSlash(relPath),
		Entries:    entries,
		UpdatedAt:  time.Now().UTC(),
	}
	m.mu.Lock()
	m.remoteFileTrees[remoteFileSnapshotKey(snapshot.ProjectID, snapshot.WorktreeID, snapshot.Path)] = snapshot
	err = m.saveLocked()
	m.mu.Unlock()
	if err != nil {
		return RemoteFileTreeSnapshot{}, err
	}
	m.emit("file.changed", snapshot)
	return snapshot, nil
}

func (m *Manager) UpdateRemoteFileContent(req UpdateRemoteFileContentRequest) (RemoteFileContentSnapshot, error) {
	project, err := m.remoteFileProject(req.ProjectID)
	if err != nil {
		return RemoteFileContentSnapshot{}, err
	}
	if project.LocationKind == "local" {
		return RemoteFileContentSnapshot{}, errors.New("remote file snapshots are only for remote projects")
	}
	relPath, err := cleanWorkspaceRelativePath(req.Path)
	if err != nil {
		return RemoteFileContentSnapshot{}, err
	}
	if relPath == "" {
		return RemoteFileContentSnapshot{}, errors.New("file path is required")
	}
	modifiedAt := time.Now().UTC()
	if req.ModifiedAt != nil {
		modifiedAt = req.ModifiedAt.UTC()
	}
	encoding := strings.TrimSpace(req.Encoding)
	if encoding == "" {
		encoding = "utf-8"
	}
	if int64(len(req.Content)) > maxFileReadLimitBytes {
		return RemoteFileContentSnapshot{}, errors.New("remote file content exceeds read limit")
	}
	size := req.Size
	if size < 0 {
		return RemoteFileContentSnapshot{}, errors.New("remote file size cannot be negative")
	}
	if size == 0 {
		size = int64(len(req.Content))
	}
	content := FileContent{
		ProjectID:  strings.TrimSpace(req.ProjectID),
		WorktreeID: strings.TrimSpace(req.WorktreeID),
		Path:       filepath.ToSlash(relPath),
		Encoding:   encoding,
		Content:    req.Content,
		Size:       size,
		ModifiedAt: modifiedAt,
	}
	snapshot := RemoteFileContentSnapshot{
		ProjectID:  content.ProjectID,
		WorktreeID: content.WorktreeID,
		Path:       content.Path,
		Content:    content,
		UpdatedAt:  time.Now().UTC(),
	}
	m.mu.Lock()
	m.remoteFileContents[remoteFileSnapshotKey(snapshot.ProjectID, snapshot.WorktreeID, snapshot.Path)] = snapshot
	err = m.saveLocked()
	m.mu.Unlock()
	if err != nil {
		return RemoteFileContentSnapshot{}, err
	}
	m.emit("file.changed", snapshot)
	return snapshot, nil
}

func (m *Manager) cachedRemoteFileTree(req ListFilesRequest) ([]FileEntry, bool, error) {
	relPath, err := cleanWorkspaceRelativePath(req.Path)
	if err != nil {
		return nil, false, err
	}
	key := remoteFileSnapshotKey(req.ProjectID, req.WorktreeID, relPath)
	m.mu.RLock()
	snapshot, ok := m.remoteFileTrees[key]
	m.mu.RUnlock()
	if !ok {
		return nil, false, nil
	}
	entries := append([]FileEntry(nil), snapshot.Entries...)
	return entries, true, nil
}

func (m *Manager) cachedRemoteFileContent(req ReadFileRequest) (FileContent, bool, error) {
	relPath, err := cleanWorkspaceRelativePath(req.Path)
	if err != nil {
		return FileContent{}, false, err
	}
	key := remoteFileSnapshotKey(req.ProjectID, req.WorktreeID, relPath)
	m.mu.RLock()
	snapshot, ok := m.remoteFileContents[key]
	m.mu.RUnlock()
	if !ok {
		return FileContent{}, false, nil
	}
	if int64(len(snapshot.Content.Content)) > normalizedFileReadLimit(req.MaxBytes) {
		return FileContent{}, false, errors.New("file exceeds read limit")
	}
	return snapshot.Content, true, nil
}

func (m *Manager) remoteFileProject(projectID string) (Project, error) {
	projectID = strings.TrimSpace(projectID)
	if projectID == "" {
		return Project{}, ErrProjectRequired
	}
	m.mu.RLock()
	project, ok := m.projects[projectID]
	m.mu.RUnlock()
	if !ok {
		return Project{}, ErrNotFound
	}
	return project, nil
}

func normalizeRemoteFileEntry(projectID string, worktreeID string, entry FileEntry) (FileEntry, error) {
	relPath, err := cleanWorkspaceRelativePath(entry.Path)
	if err != nil {
		return FileEntry{}, err
	}
	if relPath == "" {
		return FileEntry{}, errors.New("file entry path is required")
	}
	if entry.Kind != FileEntryFile && entry.Kind != FileEntryDirectory && entry.Kind != FileEntrySymlink {
		return FileEntry{}, errors.New("invalid file entry kind")
	}
	entry.ProjectID = strings.TrimSpace(projectID)
	entry.WorktreeID = strings.TrimSpace(worktreeID)
	entry.Path = filepath.ToSlash(relPath)
	if entry.Name == "" {
		entry.Name = pathBase(relPath)
	}
	if entry.ModifiedAt.IsZero() {
		entry.ModifiedAt = time.Now().UTC()
	} else {
		entry.ModifiedAt = entry.ModifiedAt.UTC()
	}
	return entry, nil
}

func remoteFileSnapshotKey(projectID string, worktreeID string, path string) string {
	cleanPath := filepath.FromSlash(strings.TrimSpace(path))
	if cleanPath == "." {
		cleanPath = ""
	}
	if cleanPath != "" {
		cleanPath = filepath.Clean(cleanPath)
		if cleanPath == "." {
			cleanPath = ""
		}
	}
	return strings.TrimSpace(projectID) + "|" + strings.TrimSpace(worktreeID) + "|" + cleanPath
}
