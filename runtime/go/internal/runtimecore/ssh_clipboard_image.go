package runtimecore

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

type SshClipboardImageRequest struct {
	TargetID      string `json:"targetId"`
	ContentBase64 string `json:"contentBase64"`
}

type SshClipboardImageResult struct {
	Path string `json:"path"`
}

func (m *Manager) WriteSshClipboardImage(req SshClipboardImageRequest) (SshClipboardImageResult, error) {
	return m.WriteSshClipboardImageContext(context.Background(), req)
}

func (m *Manager) WriteSshClipboardImageContext(parent context.Context, req SshClipboardImageRequest) (SshClipboardImageResult, error) {
	if err := parent.Err(); err != nil {
		return SshClipboardImageResult{}, err
	}
	targetID := strings.TrimSpace(req.TargetID)
	if targetID == "" || strings.TrimSpace(req.ContentBase64) == "" {
		return SshClipboardImageResult{}, errors.New("ssh target and clipboard image content are required")
	}
	if _, ok := m.GetSshTarget(targetID); !ok {
		return SshClipboardImageResult{}, ErrNotFound
	}
	input, err := json.Marshal(map[string]string{"contentBase64": req.ContentBase64})
	if err != nil {
		return SshClipboardImageResult{}, err
	}
	ctx, cancel := context.WithTimeout(parent, 60*time.Second)
	defer cancel()
	output, err := m.runSshRelayWorkerWithInput(ctx, targetID, []string{"clipboard-write-json"}, input)
	if err != nil {
		return SshClipboardImageResult{}, err
	}
	var result SshClipboardImageResult
	if json.Unmarshal(output, &result) != nil || strings.TrimSpace(result.Path) == "" {
		return SshClipboardImageResult{}, errors.New("relay worker returned malformed clipboard image path")
	}
	return result, nil
}
