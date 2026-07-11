package runtimecore

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
)

const remoteRelayWorkerPath = "$HOME/.pebble/bin/pebble-relay-worker"

var relayWorkerBuildLocks sync.Map

func (m *Manager) deployAgentHookRelayWorker(ctx context.Context, sshPath, targetID string, target SshTarget) (string, error) {
	platform, err := m.probeRemoteRelayPlatform(ctx, sshPath, targetID, target)
	if err != nil {
		return "", err
	}
	binary, err := resolveRelayWorkerBinary(ctx, platform.goos, platform.goarch)
	if err != nil {
		return "", err
	}
	content, err := os.ReadFile(binary)
	if err != nil {
		return "", fmt.Errorf("read relay worker: %w", err)
	}
	command := "umask 077; mkdir -p \"$HOME/.pebble/bin\" && cat > \"$HOME/.pebble/bin/.pebble-relay-worker.tmp\" && chmod 700 \"$HOME/.pebble/bin/.pebble-relay-worker.tmp\" && mv \"$HOME/.pebble/bin/.pebble-relay-worker.tmp\" \"$HOME/.pebble/bin/pebble-relay-worker\""
	output, err := m.runPurposeScopedSsh(ctx, sshPath, targetID, target, command, bytes.NewReader(content))
	if err != nil {
		return "", fmt.Errorf("deploy relay worker: %w (%s)", err, strings.TrimSpace(output))
	}
	return remoteRelayWorkerPath, nil
}

type relayPlatform struct{ goos, goarch string }

func (m *Manager) probeRemoteRelayPlatform(ctx context.Context, sshPath, targetID string, target SshTarget) (relayPlatform, error) {
	output, err := m.runPurposeScopedSsh(ctx, sshPath, targetID, target, "uname -s; uname -m", nil)
	if err != nil {
		return relayPlatform{}, fmt.Errorf("detect relay worker platform: %w (%s)", err, strings.TrimSpace(output))
	}
	parts := strings.Fields(strings.ToLower(output))
	if len(parts) < 2 {
		return relayPlatform{}, fmt.Errorf("detect relay worker platform: unexpected response %q", strings.TrimSpace(output))
	}
	goos := map[string]string{"linux": "linux", "darwin": "darwin"}[parts[0]]
	goarch := map[string]string{"x86_64": "amd64", "amd64": "amd64", "aarch64": "arm64", "arm64": "arm64"}[parts[1]]
	if goos == "" || goarch == "" {
		return relayPlatform{}, fmt.Errorf("relay worker does not support remote platform %s/%s", parts[0], parts[1])
	}
	return relayPlatform{goos: goos, goarch: goarch}, nil
}

func (m *Manager) runPurposeScopedSsh(ctx context.Context, sshPath, targetID string, target SshTarget, command string, stdin *bytes.Reader) (string, error) {
	cmd := exec.CommandContext(ctx, sshPath, sshCommandArgs(target, command)...)
	if stdin != nil {
		cmd.Stdin = stdin
	}
	var output cappedBuffer
	output.limit = maxAgentHookBootstrapOutput
	cmd.Stdout, cmd.Stderr = &output, &output
	cleanup, err := configureSshAskpass(cmd, m, targetID)
	if err != nil {
		return "", err
	}
	defer cleanup()
	err = cmd.Run()
	return output.String(), err
}

func resolveRelayWorkerBinary(ctx context.Context, goos, goarch string) (string, error) {
	if explicit := strings.TrimSpace(os.Getenv("PEBBLE_RELAY_WORKER_PATH")); explicit != "" {
		return explicit, nil
	}
	if executable, err := os.Executable(); err == nil {
		candidate := filepath.Join(filepath.Dir(executable), relayWorkerExecutableName(runtime.GOOS))
		if info, statErr := os.Stat(candidate); statErr == nil && !info.IsDir() && goos == runtime.GOOS && goarch == runtime.GOARCH {
			return candidate, nil
		}
	}
	sourceDir := findGoRuntimeSourceDir()
	if sourceDir == "" {
		return "", fmt.Errorf("matching pebble-relay-worker binary is not bundled")
	}
	cacheRoot, err := os.UserCacheDir()
	if err != nil {
		return "", err
	}
	output := filepath.Join(cacheRoot, "pebble", "relay-workers", goos+"-"+goarch, relayWorkerExecutableName(goos))
	lockValue, _ := relayWorkerBuildLocks.LoadOrStore(output, &sync.Mutex{})
	lock := lockValue.(*sync.Mutex)
	lock.Lock()
	defer lock.Unlock()
	if info, statErr := os.Stat(output); statErr == nil && info.Size() > 0 {
		return output, nil
	}
	if err := os.MkdirAll(filepath.Dir(output), 0o700); err != nil {
		return "", err
	}
	cmd := exec.CommandContext(ctx, "go", "build", "-trimpath", "-o", output, "./cmd/pebble-relay-worker")
	cmd.Dir = sourceDir
	cmd.Env = append(os.Environ(), "CGO_ENABLED=0", "GOOS="+goos, "GOARCH="+goarch)
	if result, buildErr := cmd.CombinedOutput(); buildErr != nil {
		return "", fmt.Errorf("build relay worker for %s/%s: %w (%s)", goos, goarch, buildErr, strings.TrimSpace(string(result)))
	}
	return output, nil
}

func findGoRuntimeSourceDir() string {
	if explicit := strings.TrimSpace(os.Getenv("PEBBLE_GO_RUNTIME_SOURCE_DIR")); explicit != "" {
		return explicit
	}
	starts := []string{}
	if cwd, err := os.Getwd(); err == nil {
		starts = append(starts, cwd)
	}
	for _, start := range starts {
		for dir := start; ; dir = filepath.Dir(dir) {
			if _, err := os.Stat(filepath.Join(dir, "cmd", "pebble-relay-worker")); err == nil {
				return dir
			}
			candidate := filepath.Join(dir, "pebble", "go-runtime")
			if _, err := os.Stat(filepath.Join(candidate, "cmd", "pebble-relay-worker")); err == nil {
				return candidate
			}
			parent := filepath.Dir(dir)
			if parent == dir {
				break
			}
		}
	}
	return ""
}

func relayWorkerExecutableName(goos string) string {
	if goos == "windows" {
		return "pebble-relay-worker.exe"
	}
	return "pebble-relay-worker"
}

func quotePosixShell(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'"
}
