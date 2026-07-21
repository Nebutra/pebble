package runtimecore

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"
)

const sshRemoteBrowseTimeout = 15 * time.Second

const (
	maxSshRemoteDirectoryPathBytes = 32 << 10
	maxSshRemoteDirectoryNameBytes = 4 << 10
	maxSshRemoteDirectoryEntries   = 10_000
)

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
	if _, ok := m.GetSshTarget(targetID); !ok {
		return nil, ErrNotFound
	}
	commandContext, cancel := context.WithTimeout(ctx, sshRemoteBrowseTimeout)
	defer cancel()
	outputBytes, err := m.runSshRelayWorker(commandContext, targetID, []string{"ports-detect"})
	if err != nil {
		return nil, fmt.Errorf("detect remote ports: %w", err)
	}
	output := string(outputBytes)
	var result struct {
		Ports []SshDetectedPort `json:"ports"`
	}
	if err := json.Unmarshal([]byte(output), &result); err != nil {
		return nil, errors.New("remote port response was not valid JSON")
	}
	return result.Ports, nil
}

func (m *Manager) BrowseSshDirectory(ctx context.Context, targetID, directory string) (SshRemoteDirectory, error) {
	if _, ok := m.GetSshTarget(targetID); !ok {
		return SshRemoteDirectory{}, ErrNotFound
	}
	commandContext, cancel := context.WithTimeout(ctx, sshRemoteBrowseTimeout)
	defer cancel()
	input, err := json.Marshal(map[string]string{"path": directory})
	if err != nil {
		return SshRemoteDirectory{}, errors.New("encode remote directory request")
	}
	output, err := m.runSshRelayWorkerWithInput(commandContext, targetID, []string{"directory-list-json"}, input)
	if err != nil {
		return SshRemoteDirectory{}, fmt.Errorf("browse remote directory: %w", err)
	}
	return decodeSshRemoteDirectory(output)
}

func decodeSshRemoteDirectory(output []byte) (SshRemoteDirectory, error) {
	var result SshRemoteDirectory
	decoder := json.NewDecoder(bytes.NewReader(output))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&result); err != nil {
		return SshRemoteDirectory{}, errors.New("remote directory response was not valid JSON")
	}
	if err := requireSshBrowseJSONEOF(decoder); err != nil {
		return SshRemoteDirectory{}, errors.New("remote directory response contained trailing data")
	}
	if result.ResolvedPath == "" {
		return SshRemoteDirectory{}, errors.New("remote directory response omitted resolved path")
	}
	if len(result.ResolvedPath) > maxSshRemoteDirectoryPathBytes {
		return SshRemoteDirectory{}, errors.New("remote directory response path exceeded limit")
	}
	if containsSshBrowseControlCharacter(result.ResolvedPath) {
		return SshRemoteDirectory{}, errors.New("remote directory response path contained control characters")
	}
	if result.Entries == nil {
		result.Entries = []SshRemoteDirectoryEntry{}
	}
	if len(result.Entries) > maxSshRemoteDirectoryEntries {
		return SshRemoteDirectory{}, errors.New("remote directory response exceeded entry limit")
	}
	for _, entry := range result.Entries {
		if entry.Name == "" || entry.Name == "." || entry.Name == ".." || len(entry.Name) > maxSshRemoteDirectoryNameBytes || containsSshBrowseControlCharacter(entry.Name) {
			return SshRemoteDirectory{}, errors.New("remote directory response contained an invalid entry")
		}
	}
	return result, nil
}

func requireSshBrowseJSONEOF(decoder *json.Decoder) error {
	var trailing any
	err := decoder.Decode(&trailing)
	if errors.Is(err, io.EOF) {
		return nil
	}
	return errors.New("expected end of JSON input")
}

func containsSshBrowseControlCharacter(value string) bool {
	return strings.ContainsAny(value, "\x00\r\n")
}
