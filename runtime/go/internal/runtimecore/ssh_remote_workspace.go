package runtimecore

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
	"strings"
)

func (m *Manager) GetSshRemoteWorkspace(ctx context.Context, targetID, namespace string) (RemoteWorkspaceSnapshot, error) {
	var result RemoteWorkspaceSnapshot
	if namespace == "" {
		var err error
		namespace, err = m.sshRemoteWorkspaceNamespace(targetID)
		if err != nil {
			return result, err
		}
	}
	output, err := m.runSshRelayWorker(ctx, targetID, []string{"workspace-get-json", "--namespace", namespace})
	if err != nil {
		return result, err
	}
	if err := json.Unmarshal(output, &result); err != nil {
		return result, errors.New("relay worker returned malformed workspace snapshot")
	}
	return result, nil
}

func (m *Manager) PatchSshRemoteWorkspace(ctx context.Context, targetID string, req RemoteWorkspacePatchRequest) (RemoteWorkspacePatchResult, error) {
	var result RemoteWorkspacePatchResult
	if req.Namespace == "" {
		var err error
		req.Namespace, err = m.sshRemoteWorkspaceNamespace(targetID)
		if err != nil {
			return result, err
		}
	}
	input, err := json.Marshal(req)
	if err != nil {
		return result, err
	}
	output, err := m.runSshRelayWorkerWithInput(ctx, targetID, []string{"workspace-patch-json"}, input)
	if err != nil {
		return result, err
	}
	if err := json.Unmarshal(output, &result); err != nil {
		return result, errors.New("relay worker returned malformed workspace patch result")
	}
	return result, nil
}

func (m *Manager) TouchSshRemoteWorkspacePresence(ctx context.Context, targetID string, req RemoteWorkspacePresenceRequest) (RemoteWorkspacePresenceResult, error) {
	var result RemoteWorkspacePresenceResult
	if req.Namespace == "" {
		var err error
		req.Namespace, err = m.sshRemoteWorkspaceNamespace(targetID)
		if err != nil {
			return result, err
		}
	}
	input, err := json.Marshal(req)
	if err != nil {
		return result, err
	}
	output, err := m.runSshRelayWorkerWithInput(ctx, targetID, []string{"workspace-presence-json"}, input)
	if err != nil {
		return result, err
	}
	if err := json.Unmarshal(output, &result); err != nil {
		return result, errors.New("relay worker returned malformed workspace presence result")
	}
	return result, nil
}

func (m *Manager) StreamSshRemoteWorkspace(ctx context.Context, targetID string, onSnapshot func(RemoteWorkspaceSnapshot)) error {
	namespace, err := m.sshRemoteWorkspaceNamespace(targetID)
	if err != nil {
		return err
	}
	target, ok := m.GetSshTarget(targetID)
	if !ok {
		return ErrNotFound
	}
	sshPath, ok := findSystemSshBinary()
	if !ok {
		return errors.New("system ssh binary not found")
	}
	deployment, err := m.deploySshRelayWorker(ctx, sshPath, targetID, target)
	if err != nil {
		return err
	}
	command := remoteWorkerCommand(deployment, []string{"workspace-watch-json", "--namespace", namespace})
	cmd := exec.CommandContext(ctx, sshPath, append(sshConnectionArgs(target), command)...)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	var stderr cappedBuffer
	stderr.limit = maxAgentHookBootstrapOutput
	cmd.Stderr = &stderr
	cleanup, err := configureSshAskpass(cmd, m, targetID)
	if err != nil {
		return err
	}
	defer cleanup()
	if err := cmd.Start(); err != nil {
		return err
	}
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 64*1024), remoteWorkspaceMaxBytes+1024)
	for scanner.Scan() {
		var snapshot RemoteWorkspaceSnapshot
		if err := json.Unmarshal(scanner.Bytes(), &snapshot); err != nil {
			_ = cmd.Process.Kill()
			_ = cmd.Wait()
			return errors.New("relay worker returned malformed workspace stream")
		}
		onSnapshot(snapshot)
	}
	if err := scanner.Err(); err != nil {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		return err
	}
	if err := cmd.Wait(); err != nil && ctx.Err() == nil {
		detail := strings.TrimSpace(stderr.String())
		if detail != "" {
			return errors.New(detail)
		}
		return err
	}
	return ctx.Err()
}

func (m *Manager) PublishRemoteWorkspaceEvent(topic string, payload interface{}) {
	m.emit(topic, payload)
}

func (m *Manager) sshRemoteWorkspaceNamespace(targetID string) (string, error) {
	target, ok := m.GetSshTarget(targetID)
	if !ok {
		return "", ErrNotFound
	}
	configHost := strings.TrimSpace(target.ConfigHost)
	if configHost == "" {
		configHost = target.Host
	}
	stable := strings.Join([]string{configHost, target.Host, fmt.Sprint(target.Port), target.Username}, "\n")
	hash := sha256.Sum256([]byte(stable))
	return fmt.Sprintf("%x", hash[:16]), nil
}
