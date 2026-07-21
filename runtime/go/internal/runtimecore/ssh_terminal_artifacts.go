package runtimecore

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

const sshTerminalArtifactGrantTTL = 10 * time.Minute

type SshTerminalArtifactGrant struct {
	ID           string
	ProjectID    string
	WorktreeID   string
	HostID       string
	AbsolutePath string
	Identity     string
	ExpiresAt    time.Time
}

type TerminalArtifactGrantRequest struct {
	ProjectID    string `json:"projectId"`
	WorktreeID   string `json:"worktreeId"`
	AbsolutePath string `json:"absolutePath"`
}

type TerminalArtifactAccessRequest struct {
	WorktreeID   string `json:"worktreeId"`
	GrantID      string `json:"grantId"`
	AbsolutePath string `json:"absolutePath"`
	Content      string `json:"content,omitempty"`
}

type TerminalArtifactGrantResult struct {
	AbsolutePath string `json:"absolutePath"`
	IsDirectory  bool   `json:"isDirectory"`
	GrantID      string `json:"grantId,omitempty"`
}

type TerminalArtifactReadResult struct {
	Worktree     string `json:"worktree"`
	RelativePath string `json:"relativePath"`
	Content      string `json:"content"`
	Truncated    bool   `json:"truncated"`
	ByteLength   int    `json:"byteLength"`
}

type TerminalArtifactPreviewResult struct {
	Content  string `json:"content"`
	IsBinary bool   `json:"isBinary"`
	IsImage  bool   `json:"isImage,omitempty"`
	MimeType string `json:"mimeType,omitempty"`
}

type terminalArtifactWorkerRequest struct {
	AbsolutePath string `json:"absolutePath"`
	Identity     string `json:"identity,omitempty"`
	Content      string `json:"content,omitempty"`
}

type terminalArtifactWorkerResult struct {
	AbsolutePath string `json:"absolutePath"`
	IsDirectory  bool   `json:"isDirectory"`
	Identity     string `json:"identity,omitempty"`
	Content      string `json:"content,omitempty"`
	IsBinary     bool   `json:"isBinary,omitempty"`
	IsImage      bool   `json:"isImage,omitempty"`
	MimeType     string `json:"mimeType,omitempty"`
	ByteLength   int    `json:"byteLength,omitempty"`
}

func (m *Manager) GrantSshTerminalArtifact(req TerminalArtifactGrantRequest) (TerminalArtifactGrantResult, error) {
	return m.GrantSshTerminalArtifactContext(context.Background(), req)
}

func (m *Manager) GrantSshTerminalArtifactContext(ctx context.Context, req TerminalArtifactGrantRequest) (TerminalArtifactGrantResult, error) {
	if err := ctx.Err(); err != nil {
		return TerminalArtifactGrantResult{}, err
	}
	project, _, err := m.sshFileRelayScope(req.ProjectID, req.WorktreeID)
	if err != nil {
		return TerminalArtifactGrantResult{}, err
	}
	result, err := m.runSshTerminalArtifactWorker(ctx, project.HostID, "grant", terminalArtifactWorkerRequest{AbsolutePath: req.AbsolutePath})
	if err != nil {
		return TerminalArtifactGrantResult{}, err
	}
	if result.IsDirectory {
		return TerminalArtifactGrantResult{AbsolutePath: result.AbsolutePath, IsDirectory: true}, nil
	}
	grant := SshTerminalArtifactGrant{
		ID: newID("tgrant"), ProjectID: project.ID, WorktreeID: req.WorktreeID, HostID: project.HostID,
		AbsolutePath: result.AbsolutePath, Identity: result.Identity, ExpiresAt: time.Now().Add(sshTerminalArtifactGrantTTL),
	}
	m.mu.Lock()
	m.pruneTerminalArtifactGrantsLocked(time.Now())
	m.terminalArtifactGrants[grant.ID] = grant
	m.mu.Unlock()
	return TerminalArtifactGrantResult{AbsolutePath: grant.AbsolutePath, GrantID: grant.ID}, nil
}

func (m *Manager) ReadSshTerminalArtifact(req TerminalArtifactAccessRequest) (TerminalArtifactReadResult, error) {
	return m.ReadSshTerminalArtifactContext(context.Background(), req)
}

func (m *Manager) ReadSshTerminalArtifactContext(ctx context.Context, req TerminalArtifactAccessRequest) (TerminalArtifactReadResult, error) {
	if err := ctx.Err(); err != nil {
		return TerminalArtifactReadResult{}, err
	}
	grant, err := m.requireSshTerminalArtifactGrant(req)
	if err != nil {
		return TerminalArtifactReadResult{}, err
	}
	result, err := m.runSshTerminalArtifactWorker(ctx, grant.HostID, "read", terminalArtifactWorkerRequest{AbsolutePath: grant.AbsolutePath, Identity: grant.Identity})
	if err != nil {
		return TerminalArtifactReadResult{}, err
	}
	m.refreshSshTerminalArtifactGrant(grant.ID, result.Identity)
	return TerminalArtifactReadResult{Worktree: grant.WorktreeID, RelativePath: grant.AbsolutePath, Content: result.Content, ByteLength: result.ByteLength}, nil
}

func (m *Manager) PreviewSshTerminalArtifact(req TerminalArtifactAccessRequest) (TerminalArtifactPreviewResult, error) {
	return m.PreviewSshTerminalArtifactContext(context.Background(), req)
}

func (m *Manager) PreviewSshTerminalArtifactContext(ctx context.Context, req TerminalArtifactAccessRequest) (TerminalArtifactPreviewResult, error) {
	if err := ctx.Err(); err != nil {
		return TerminalArtifactPreviewResult{}, err
	}
	grant, err := m.requireSshTerminalArtifactGrant(req)
	if err != nil {
		return TerminalArtifactPreviewResult{}, err
	}
	result, err := m.runSshTerminalArtifactWorker(ctx, grant.HostID, "preview", terminalArtifactWorkerRequest{AbsolutePath: grant.AbsolutePath, Identity: grant.Identity})
	if err != nil {
		return TerminalArtifactPreviewResult{}, err
	}
	m.refreshSshTerminalArtifactGrant(grant.ID, result.Identity)
	return TerminalArtifactPreviewResult{Content: result.Content, IsBinary: result.IsBinary, IsImage: result.IsImage, MimeType: result.MimeType}, nil
}

func (m *Manager) WriteSshTerminalArtifact(req TerminalArtifactAccessRequest) error {
	return m.WriteSshTerminalArtifactContext(context.Background(), req)
}

func (m *Manager) WriteSshTerminalArtifactContext(ctx context.Context, req TerminalArtifactAccessRequest) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	grant, err := m.requireSshTerminalArtifactGrant(req)
	if err != nil {
		return err
	}
	result, err := m.runSshTerminalArtifactWorker(ctx, grant.HostID, "write", terminalArtifactWorkerRequest{AbsolutePath: grant.AbsolutePath, Identity: grant.Identity, Content: req.Content})
	if err != nil {
		return err
	}
	m.refreshSshTerminalArtifactGrant(grant.ID, result.Identity)
	return nil
}

func (m *Manager) requireSshTerminalArtifactGrant(req TerminalArtifactAccessRequest) (SshTerminalArtifactGrant, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	now := time.Now()
	m.pruneTerminalArtifactGrantsLocked(now)
	grant, ok := m.terminalArtifactGrants[strings.TrimSpace(req.GrantID)]
	if !ok || grant.ExpiresAt.Before(now) {
		return SshTerminalArtifactGrant{}, errors.New("terminal_file_grant_expired")
	}
	if grant.WorktreeID != strings.TrimSpace(req.WorktreeID) || grant.AbsolutePath != strings.TrimSpace(req.AbsolutePath) {
		return SshTerminalArtifactGrant{}, errors.New("terminal_file_grant_mismatch")
	}
	return grant, nil
}

func (m *Manager) refreshSshTerminalArtifactGrant(id string, identity string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	grant, ok := m.terminalArtifactGrants[id]
	if !ok {
		return
	}
	grant.ExpiresAt = time.Now().Add(sshTerminalArtifactGrantTTL)
	if identity != "" {
		grant.Identity = identity
	}
	m.terminalArtifactGrants[id] = grant
}

func (m *Manager) pruneTerminalArtifactGrantsLocked(now time.Time) {
	for id, grant := range m.terminalArtifactGrants {
		if !grant.ExpiresAt.After(now) {
			delete(m.terminalArtifactGrants, id)
		}
	}
}

func (m *Manager) runSshTerminalArtifactWorker(parent context.Context, hostID string, operation string, request terminalArtifactWorkerRequest) (terminalArtifactWorkerResult, error) {
	input, err := json.Marshal(request)
	if err != nil {
		return terminalArtifactWorkerResult{}, err
	}
	ctx, cancel := context.WithTimeout(parent, 60*time.Second)
	defer cancel()
	output, err := m.runSshRelayWorkerWithInput(ctx, hostID, []string{"terminal-artifact-json", "--operation", operation}, input)
	if err != nil {
		return terminalArtifactWorkerResult{}, err
	}
	var result terminalArtifactWorkerResult
	if err := json.Unmarshal(output, &result); err != nil {
		return terminalArtifactWorkerResult{}, errors.New("relay worker returned malformed terminal artifact result")
	}
	return result, nil
}
