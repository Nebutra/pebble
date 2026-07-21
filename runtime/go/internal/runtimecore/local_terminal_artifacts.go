package runtimecore

import (
	"encoding/base64"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	localTerminalArtifactTextLimit    int64 = 512 * 1024
	localTerminalArtifactPreviewLimit int64 = 10 * 1024 * 1024
)

func (m *Manager) GrantLocalTerminalArtifact(req TerminalArtifactGrantRequest) (TerminalArtifactGrantResult, error) {
	worktreeID := strings.TrimSpace(req.WorktreeID)
	found := false
	for _, worktree := range m.ListWorktrees("") {
		if worktree.ID == worktreeID {
			found = true
			break
		}
	}
	if !found {
		return TerminalArtifactGrantResult{}, ErrNotFound
	}
	canonical, err := canonicalLocalTerminalArtifactPath(req.AbsolutePath)
	if err != nil || !localTerminalArtifactPathAllowed(canonical) {
		return TerminalArtifactGrantResult{}, errors.New("terminal_file_grant_unavailable")
	}
	info, err := os.Lstat(canonical)
	if err != nil {
		return TerminalArtifactGrantResult{}, err
	}
	if info.IsDir() {
		return TerminalArtifactGrantResult{AbsolutePath: canonical, IsDirectory: true}, nil
	}
	if err := validateLocalTerminalArtifactFile(info); err != nil {
		return TerminalArtifactGrantResult{}, err
	}
	grant := SshTerminalArtifactGrant{ID: newID("tgrant"), ProjectID: strings.TrimSpace(req.ProjectID), WorktreeID: worktreeID, AbsolutePath: canonical, Identity: localTerminalArtifactIdentity(info), ExpiresAt: time.Now().Add(sshTerminalArtifactGrantTTL)}
	m.mu.Lock()
	m.pruneTerminalArtifactGrantsLocked(time.Now())
	m.terminalArtifactGrants[grant.ID] = grant
	m.mu.Unlock()
	return TerminalArtifactGrantResult{AbsolutePath: canonical, GrantID: grant.ID}, nil
}

func (m *Manager) ReadLocalTerminalArtifact(req TerminalArtifactAccessRequest) (TerminalArtifactReadResult, error) {
	grant, err := m.requireLocalTerminalArtifactGrant(req)
	if err != nil {
		return TerminalArtifactReadResult{}, err
	}
	content, info, err := readLocalTerminalArtifactText(grant)
	if err != nil {
		return TerminalArtifactReadResult{}, err
	}
	m.refreshSshTerminalArtifactGrant(grant.ID, localTerminalArtifactIdentity(info))
	return TerminalArtifactReadResult{Worktree: grant.WorktreeID, RelativePath: grant.AbsolutePath, Content: content, ByteLength: len([]byte(content))}, nil
}

func (m *Manager) PreviewLocalTerminalArtifact(req TerminalArtifactAccessRequest) (TerminalArtifactPreviewResult, error) {
	grant, err := m.requireLocalTerminalArtifactGrant(req)
	if err != nil {
		return TerminalArtifactPreviewResult{}, err
	}
	if mimeType := localTerminalArtifactPreviewMIME(filepath.Ext(grant.AbsolutePath)); mimeType != "" {
		bytes, info, readErr := readLocalTerminalArtifactBytes(grant, localTerminalArtifactPreviewLimit)
		if readErr != nil {
			return TerminalArtifactPreviewResult{}, readErr
		}
		m.refreshSshTerminalArtifactGrant(grant.ID, localTerminalArtifactIdentity(info))
		return TerminalArtifactPreviewResult{Content: base64.StdEncoding.EncodeToString(bytes), IsBinary: true, IsImage: true, MimeType: mimeType}, nil
	}
	content, info, err := readLocalTerminalArtifactText(grant)
	if err != nil {
		return TerminalArtifactPreviewResult{}, err
	}
	m.refreshSshTerminalArtifactGrant(grant.ID, localTerminalArtifactIdentity(info))
	return TerminalArtifactPreviewResult{Content: content}, nil
}

func (m *Manager) WriteLocalTerminalArtifact(req TerminalArtifactAccessRequest) error {
	if int64(len([]byte(req.Content))) > localTerminalArtifactTextLimit {
		return errors.New("file_too_large")
	}
	grant, err := m.requireLocalTerminalArtifactGrant(req)
	if err != nil {
		return err
	}
	_, info, err := readLocalTerminalArtifactText(grant)
	if err != nil {
		return err
	}
	temp, err := os.CreateTemp(filepath.Dir(grant.AbsolutePath), ".pebble-terminal-artifact-*")
	if err != nil {
		return err
	}
	tempPath := temp.Name()
	defer os.Remove(tempPath)
	if _, err = temp.WriteString(req.Content); err == nil {
		err = temp.Sync()
	}
	if closeErr := temp.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	if err := os.Chmod(tempPath, info.Mode().Perm()); err != nil {
		return err
	}
	if _, _, err := readLocalTerminalArtifactBytes(grant, localTerminalArtifactTextLimit); err != nil {
		return err
	}
	if err := replaceLocalTerminalArtifact(tempPath, grant.AbsolutePath); err != nil {
		return err
	}
	nextInfo, err := os.Lstat(grant.AbsolutePath)
	if err != nil {
		return err
	}
	m.refreshSshTerminalArtifactGrant(grant.ID, localTerminalArtifactIdentity(nextInfo))
	return nil
}

func (m *Manager) requireLocalTerminalArtifactGrant(req TerminalArtifactAccessRequest) (SshTerminalArtifactGrant, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	now := time.Now()
	m.pruneTerminalArtifactGrantsLocked(now)
	grant, ok := m.terminalArtifactGrants[strings.TrimSpace(req.GrantID)]
	if !ok || grant.ExpiresAt.Before(now) {
		return SshTerminalArtifactGrant{}, errors.New("terminal_file_grant_expired")
	}
	canonical, err := canonicalLocalTerminalArtifactPath(req.AbsolutePath)
	if err != nil || grant.WorktreeID != strings.TrimSpace(req.WorktreeID) || grant.AbsolutePath != canonical || grant.HostID != "" {
		return SshTerminalArtifactGrant{}, errors.New("terminal_file_grant_mismatch")
	}
	return grant, nil
}

func readLocalTerminalArtifactText(grant SshTerminalArtifactGrant) (string, os.FileInfo, error) {
	if legacyBinaryTerminalArtifactExtension(filepath.Ext(grant.AbsolutePath)) {
		return "", nil, errors.New("binary_file")
	}
	bytes, info, err := readLocalTerminalArtifactBytes(grant, localTerminalArtifactTextLimit)
	if err != nil {
		return "", nil, err
	}
	if strings.ContainsRune(string(bytes), '\x00') {
		return "", nil, errors.New("binary_file")
	}
	return string(bytes), info, nil
}

func readLocalTerminalArtifactBytes(grant SshTerminalArtifactGrant, limit int64) ([]byte, os.FileInfo, error) {
	canonical, err := canonicalLocalTerminalArtifactPath(grant.AbsolutePath)
	if err != nil || canonical != grant.AbsolutePath {
		return nil, nil, errors.New("terminal_file_grant_stale")
	}
	file, err := os.Open(canonical)
	if err != nil {
		return nil, nil, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil, nil, err
	}
	if info.IsDir() || info.Size() > limit {
		return nil, nil, errors.New("file_too_large")
	}
	if err := validateLocalTerminalArtifactFile(info); err != nil || localTerminalArtifactIdentity(info) != grant.Identity {
		return nil, nil, errors.New("terminal_file_grant_stale")
	}
	bytes, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil {
		return nil, nil, err
	}
	if int64(len(bytes)) > limit {
		return nil, nil, errors.New("file_too_large")
	}
	return bytes, info, nil
}

func canonicalLocalTerminalArtifactPath(value string) (string, error) {
	path := filepath.Clean(strings.TrimSpace(value))
	if path == "." || !filepath.IsAbs(path) {
		return "", errors.New("not_absolute")
	}
	return filepath.EvalSymlinks(path)
}

func localTerminalArtifactPathAllowed(path string) bool {
	for _, root := range []string{os.TempDir(), "/tmp", "/private/tmp"} {
		canonicalRoot, err := filepath.EvalSymlinks(root)
		if err != nil {
			continue
		}
		relative, err := filepath.Rel(canonicalRoot, path)
		if err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
			return true
		}
	}
	return false
}

func localTerminalArtifactPreviewMIME(extension string) string {
	return map[string]string{".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".svg": "image/svg+xml", ".webp": "image/webp", ".bmp": "image/bmp", ".ico": "image/x-icon", ".pdf": "application/pdf"}[strings.ToLower(extension)]
}

func legacyBinaryTerminalArtifactExtension(extension string) bool {
	switch strings.ToLower(extension) {
	case ".avif", ".bmp", ".gif", ".heic", ".ico", ".jpeg", ".jpg", ".mov", ".mp3", ".mp4", ".pdf", ".png", ".webp", ".zip":
		return true
	default:
		return false
	}
}
