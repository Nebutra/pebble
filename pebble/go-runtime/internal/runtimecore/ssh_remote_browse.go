package runtimecore

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

const sshRemoteBrowseTimeout = 15 * time.Second

type SshDetectedPort struct {
	Port        int    `json:"port"`
	Host        string `json:"host"`
	PID         int    `json:"pid,omitempty"`
	ProcessName string `json:"processName,omitempty"`
}

type SshRemoteDirectoryEntry struct {
	Name        string `json:"name"`
	IsDirectory bool   `json:"isDirectory"`
}

type SshRemoteDirectory struct {
	Entries      []SshRemoteDirectoryEntry `json:"entries"`
	ResolvedPath string                    `json:"resolvedPath"`
}

func (m *Manager) DetectSshPorts(ctx context.Context, targetID string) ([]SshDetectedPort, error) {
	target, ok := m.GetSshTarget(targetID)
	if !ok {
		return nil, ErrNotFound
	}
	sshPath, found := findSystemSshBinary()
	if !found {
		return nil, errors.New("system ssh binary not found")
	}
	commandContext, cancel := context.WithTimeout(ctx, sshRemoteBrowseTimeout)
	defer cancel()
	workerPath, err := m.deployAgentHookRelayWorker(commandContext, sshPath, targetID, target)
	if err != nil {
		return nil, err
	}
	output, err := m.runPurposeScopedSsh(commandContext, sshPath, targetID, target, workerPath+" ports-detect", nil)
	if err != nil {
		return nil, fmt.Errorf("detect remote ports: %w (%s)", err, strings.TrimSpace(output))
	}
	var result struct {
		Ports []SshDetectedPort `json:"ports"`
	}
	if err := json.Unmarshal([]byte(output), &result); err != nil {
		return nil, errors.New("remote port response was not valid JSON")
	}
	return result.Ports, nil
}

func (m *Manager) BrowseSshDirectory(ctx context.Context, targetID, directory string) (SshRemoteDirectory, error) {
	target, ok := m.GetSshTarget(targetID)
	if !ok {
		return SshRemoteDirectory{}, ErrNotFound
	}
	sshPath, found := findSystemSshBinary()
	if !found {
		return SshRemoteDirectory{}, errors.New("system ssh binary not found")
	}
	directory = strings.TrimSpace(directory)
	if directory == "" {
		directory = "~"
	}
	commandContext, cancel := context.WithTimeout(ctx, sshRemoteBrowseTimeout)
	defer cancel()
	// Why: one entry per line preserves spaces; the trailing slash is the
	// established Electron contract for identifying directories before roots exist.
	command := "cd " + quotePosixShell(directory) + " && pwd && command ls -1Ap"
	output, err := m.runPurposeScopedSsh(commandContext, sshPath, targetID, target, command, nil)
	if err != nil {
		return SshRemoteDirectory{}, fmt.Errorf("browse remote directory: %w (%s)", err, strings.TrimSpace(output))
	}
	lines := strings.Split(strings.TrimRight(output, "\r\n"), "\n")
	if len(lines) == 0 || strings.TrimSpace(lines[0]) == "" {
		return SshRemoteDirectory{}, errors.New("remote directory response omitted resolved path")
	}
	entries := make([]SshRemoteDirectoryEntry, 0, len(lines)-1)
	for _, line := range lines[1:] {
		line = strings.TrimSuffix(line, "\r")
		if line == "" || line == "./" || line == "../" {
			continue
		}
		isDirectory := strings.HasSuffix(line, "/")
		entries = append(entries, SshRemoteDirectoryEntry{Name: strings.TrimSuffix(line, "/"), IsDirectory: isDirectory})
	}
	return SshRemoteDirectory{Entries: entries, ResolvedPath: strings.TrimSuffix(lines[0], "\r")}, nil
}
