package runtimecore

import (
	"context"
	"encoding/json"
	"strings"
)

type RemoteProviderContext struct {
	HostID string
	Root   string
}

type ProviderRelayRequest struct {
	Method   string            `json:"method"`
	Path     string            `json:"path"`
	RawQuery string            `json:"rawQuery,omitempty"`
	Headers  map[string]string `json:"headers,omitempty"`
	Body     []byte            `json:"body,omitempty"`
}

type ProviderRelayResponse struct {
	Status  int               `json:"status"`
	Headers map[string]string `json:"headers,omitempty"`
	Body    []byte            `json:"body,omitempty"`
}

func (m *Manager) ResolveRemoteProviderContext(projectID, worktreeID string) (RemoteProviderContext, bool, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	project, ok := m.projects[strings.TrimSpace(projectID)]
	root := project.Path
	if strings.TrimSpace(worktreeID) != "" {
		worktree, found := m.worktrees[strings.TrimSpace(worktreeID)]
		if !found {
			return RemoteProviderContext{}, false, ErrNotFound
		}
		project, ok = m.projects[worktree.ProjectID]
		root = worktree.Path
	}
	if !ok {
		return RemoteProviderContext{}, false, ErrNotFound
	}
	if project.LocationKind != "ssh" {
		return RemoteProviderContext{}, false, nil
	}
	if strings.TrimSpace(project.HostID) == "" || strings.TrimSpace(root) == "" {
		return RemoteProviderContext{}, false, ErrRemoteNeedsRelay
	}
	if _, targetExists := m.sshTargets[project.HostID]; !targetExists {
		// Legacy remote rows without a target keep the stable 409 path until
		// the user reconnects them; only executable SSH contexts are proxied.
		return RemoteProviderContext{}, false, nil
	}
	return RemoteProviderContext{HostID: project.HostID, Root: root}, true, nil
}

func (m *Manager) RelayProviderRequest(ctx context.Context, remote RemoteProviderContext, request ProviderRelayRequest) (ProviderRelayResponse, error) {
	input, err := json.Marshal(struct {
		Root    string               `json:"root"`
		Request ProviderRelayRequest `json:"request"`
	}{Root: remote.Root, Request: request})
	if err != nil {
		return ProviderRelayResponse{}, err
	}
	output, err := m.runSshRelayWorkerWithInput(ctx, remote.HostID, []string{"provider-http-json"}, input)
	if err != nil {
		return ProviderRelayResponse{}, err
	}
	var response ProviderRelayResponse
	if err := json.Unmarshal([]byte(output), &response); err != nil {
		return ProviderRelayResponse{}, err
	}
	return response, nil
}
