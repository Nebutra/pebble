package runtimecore

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
)

const remoteRelayWorkerPath = "$HOME/.pebble/bin/pebble-relay-worker"

const windowsRelayWorkerRelativePath = `.pebble\bin\pebble-relay-worker.exe`

var relayWorkerBuildLocks sync.Map

type sshRelayWorkerDeployment struct {
	connectionKey string
	platform      relayPlatform
	path          string
}

func (m *Manager) deploySshRelayWorker(ctx context.Context, sshPath, targetID string, target SshTarget) (sshRelayWorkerDeployment, error) {
	platform, err := m.probeRemoteRelayPlatform(ctx, sshPath, targetID, target)
	if err != nil {
		return sshRelayWorkerDeployment{}, err
	}
	binary, err := resolveRelayWorkerBinary(ctx, platform.goos, platform.goarch)
	if err != nil {
		return sshRelayWorkerDeployment{}, err
	}
	content, err := os.ReadFile(binary)
	if err != nil {
		return sshRelayWorkerDeployment{}, fmt.Errorf("read relay worker: %w", err)
	}
	command := relayWorkerDeployCommand(platform)
	output, err := m.runPurposeScopedSsh(ctx, sshPath, targetID, target, command, bytes.NewReader(content))
	if err != nil {
		return sshRelayWorkerDeployment{}, boundedSshOperationError("deploy relay worker", err, output)
	}
	path := remoteRelayWorkerPath
	if platform.goos == "windows" {
		path = strings.TrimSpace(output)
		if !isWindowsAbsolutePath(path) {
			return sshRelayWorkerDeployment{}, fmt.Errorf("deploy relay worker: Windows host returned invalid path %q", path)
		}
	}
	return sshRelayWorkerDeployment{connectionKey: sshRelayConnectionKey(target), platform: platform, path: path}, nil
}

func isWindowsAbsolutePath(path string) bool {
	if strings.HasPrefix(path, `\\`) {
		return true
	}
	return len(path) >= 3 && ((path[0] >= 'A' && path[0] <= 'Z') || (path[0] >= 'a' && path[0] <= 'z')) && path[1] == ':' && (path[2] == '\\' || path[2] == '/')
}

type relayPlatform struct{ goos, goarch string }

func (m *Manager) probeRemoteRelayPlatform(ctx context.Context, sshPath, targetID string, target SshTarget) (relayPlatform, error) {
	output, posixErr := m.runPurposeScopedSsh(ctx, sshPath, targetID, target, "uname -s && uname -m", nil)
	if posixErr == nil {
		return parseRelayPlatform(output)
	}
	if ctx.Err() != nil {
		return relayPlatform{}, ctx.Err()
	}
	output, windowsErr := m.runPurposeScopedSsh(ctx, sshPath, targetID, target, windowsRelayPlatformProbeCommand(), nil)
	if windowsErr != nil {
		return relayPlatform{}, fmt.Errorf("detect relay worker platform: POSIX probe: %v; Windows probe: %w (%s)", posixErr, windowsErr, strings.TrimSpace(output))
	}
	return parseRelayPlatform(output)
}

func parseRelayPlatform(output string) (relayPlatform, error) {
	parts := strings.Fields(strings.ToLower(output))
	if len(parts) < 2 {
		return relayPlatform{}, fmt.Errorf("detect relay worker platform: unexpected response %q", strings.TrimSpace(output))
	}
	goos := map[string]string{"linux": "linux", "darwin": "darwin", "windows": "windows"}[parts[0]]
	goarch := map[string]string{"x86_64": "amd64", "x64": "amd64", "amd64": "amd64", "aarch64": "arm64", "arm64": "arm64"}[parts[1]]
	if goos == "" || goarch == "" {
		return relayPlatform{}, fmt.Errorf("relay worker does not support remote platform %s/%s", parts[0], parts[1])
	}
	return relayPlatform{goos: goos, goarch: goarch}, nil
}

func relayWorkerDeployCommand(platform relayPlatform) string {
	if platform.goos != "windows" {
		return "umask 077; mkdir -p \"$HOME/.pebble/bin\" && cat > \"$HOME/.pebble/bin/.pebble-relay-worker.tmp\" && chmod 700 \"$HOME/.pebble/bin/.pebble-relay-worker.tmp\" && mv \"$HOME/.pebble/bin/.pebble-relay-worker.tmp\" \"$HOME/.pebble/bin/pebble-relay-worker\""
	}
	script := `$ErrorActionPreference='Stop';` +
		`$dir=Join-Path $env:USERPROFILE '.pebble\bin';` +
		`[IO.Directory]::CreateDirectory($dir)|Out-Null;` +
		`$dst=Join-Path $env:USERPROFILE '` + windowsRelayWorkerRelativePath + `';` +
		`$tmp=$dst+'.tmp';` +
		`$src=[Console]::OpenStandardInput();` +
		`$file=[IO.File]::Open($tmp,[IO.FileMode]::Create,[IO.FileAccess]::Write,[IO.FileShare]::None);` +
		`try{$src.CopyTo($file)}finally{$file.Dispose()};` +
		`Move-Item -LiteralPath $tmp -Destination $dst -Force;` +
		`[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);Write-Output $dst`
	return windowsPowerShellCommand(script)
}

func windowsRelayPlatformProbeCommand() string {
	script := `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);` +
		`$arch=[Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant();` +
		`Write-Output ('windows '+$arch)`
	return windowsPowerShellCommand(script)
}

func windowsPowerShellCommand(script string) string {
	encoded := base64.StdEncoding.EncodeToString(encodeUTF16LE(script))
	return "powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand " + encoded
}

func encodeUTF16LE(value string) []byte {
	result := make([]byte, 0, len(value)*2)
	for _, codePoint := range []rune(value) {
		if codePoint <= 0xffff {
			result = append(result, byte(codePoint), byte(codePoint>>8))
			continue
		}
		value := codePoint - 0x10000
		high, low := rune(0xd800+(value>>10)), rune(0xdc00+(value&0x3ff))
		result = append(result, byte(high), byte(high>>8), byte(low), byte(low>>8))
	}
	return result
}

func boundedSshOperationError(operation string, err error, output string) error {
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return fmt.Errorf("%s: %w", operation, err)
	}
	detail := strings.TrimSpace(output)
	if detail == "" {
		return fmt.Errorf("%s: %w", operation, err)
	}
	return fmt.Errorf("%s: %w (%s)", operation, err, detail)
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
	if bundleDir := strings.TrimSpace(os.Getenv("PEBBLE_RELAY_WORKER_BUNDLE_DIR")); bundleDir != "" {
		if candidate, err := bundledRelayWorkerPath(bundleDir, goos, goarch); err == nil {
			return candidate, nil
		}
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

func bundledRelayWorkerPath(bundleDir, goos, goarch string) (string, error) {
	if !supportedRelayWorkerTarget(goos, goarch) {
		return "", fmt.Errorf("unsupported relay worker target %s/%s", goos, goarch)
	}
	extension := ""
	if goos == "windows" {
		extension = ".exe"
	}
	candidate := filepath.Join(bundleDir, "pebble-relay-worker-"+goos+"-"+goarch+extension)
	info, err := os.Stat(candidate)
	if err != nil || info.IsDir() || info.Size() == 0 {
		return "", fmt.Errorf("matching pebble-relay-worker resource is unavailable for %s/%s", goos, goarch)
	}
	return candidate, nil
}

func supportedRelayWorkerTarget(goos, goarch string) bool {
	return (goos == "darwin" || goos == "linux" || goos == "windows") &&
		(goarch == "amd64" || goarch == "arm64")
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
			candidate := filepath.Join(dir, "runtime", "go")
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
