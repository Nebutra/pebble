package runtimecore

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// gitTextGenerationRelayTimeout bounds the SSH round trip (connect + remote
// `pebble-relay-worker git-text-generation-context` git plumbing); mirrors
// ProbeSshTarget's ConnectTimeout=8 headroom plus the relay subcommand's own
// 30s ceiling.
const gitTextGenerationRelayTimeout = 40 * time.Second

const (
	maxSshRelayInputBytes  = 32 << 20
	maxSshRelayOutputBytes = 24 << 20
)

// FetchSshGitCommitTextGenerationContext runs `pebble-relay-worker
// git-text-generation-context --kind commit` on the SSH target's remote host
// over a direct (non-interactive) SSH exec and parses its JSON stdout. This
// answers synchronously so the desktop can build the same commit-message
// prompt it builds for local projects, just sourced from the remote git
// checkout instead of the desktop's own filesystem.
func (m *Manager) FetchSshGitCommitTextGenerationContext(
	ctx context.Context,
	sshTargetID string,
	repoRoot string,
) (GitCommitTextGenerationContext, error) {
	var result GitCommitTextGenerationContext
	output, err := m.runSshRelayWorker(ctx, sshTargetID, []string{
		"git-text-generation-context",
		"--kind", "commit",
		"--root", repoRoot,
	})
	if err != nil {
		return result, err
	}
	if err := json.Unmarshal(output, &result); err != nil {
		return result, errors.New("relay worker returned malformed commit context: " + err.Error())
	}
	return result, nil
}

// FetchSshGitPullRequestTextGenerationContext runs `pebble-relay-worker
// git-text-generation-context --kind pull-request` on the SSH target's remote
// host and parses its JSON stdout. Returns (nil, nil) when the relay worker
// reports nothing to summarize (JSON `null`), matching the local Rust
// command's Option semantics.
func (m *Manager) FetchSshGitPullRequestTextGenerationContext(
	ctx context.Context,
	sshTargetID string,
	repoRoot string,
	base string,
	currentTitle string,
	currentBody string,
	currentDraft bool,
) (*GitPullRequestTextGenerationContext, error) {
	output, err := m.runSshRelayWorker(ctx, sshTargetID, []string{
		"git-text-generation-context",
		"--kind", "pull-request",
		"--root", repoRoot,
		"--base", base,
		"--current-title", currentTitle,
		"--current-body", currentBody,
		"--current-draft", strconv.FormatBool(currentDraft),
	})
	if err != nil {
		return nil, err
	}
	trimmed := strings.TrimSpace(string(output))
	if trimmed == "" || trimmed == "null" {
		return nil, nil
	}
	var result GitPullRequestTextGenerationContext
	if err := json.Unmarshal(output, &result); err != nil {
		return nil, errors.New("relay worker returned malformed pull request context: " + err.Error())
	}
	return &result, nil
}

// runSshRelayWorker execs `pebble-relay-worker <args...>` on the SSH target's
// remote host via the system ssh binary and returns its stdout. A host without
// the worker on PATH is bootstrapped through the shared native deploy path.
func (m *Manager) runSshRelayWorker(ctx context.Context, sshTargetID string, relayArgs []string) ([]byte, error) {
	return m.runSshRelayWorkerWithInput(ctx, sshTargetID, relayArgs, nil)
}

func (m *Manager) runSshRelayWorkerWithInput(ctx context.Context, sshTargetID string, relayArgs []string, input []byte) ([]byte, error) {
	return m.runSshRelayWorkerWithInputTimeout(ctx, sshTargetID, relayArgs, input, gitTextGenerationRelayTimeout)
}

func (m *Manager) runSshRelayWorkerWithInputTimeout(ctx context.Context, sshTargetID string, relayArgs []string, input []byte, timeout time.Duration) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if len(input) > maxSshRelayInputBytes {
		return nil, errors.New("relay worker input exceeds limit")
	}
	target, ok := m.GetSshTarget(sshTargetID)
	if !ok {
		return nil, ErrNotFound
	}
	sshPath, ok := findSystemSshBinary()
	if !ok {
		return nil, errors.New("system ssh binary not found")
	}
	relayCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	if deployment, ok := m.cachedSshRelayWorker(sshTargetID, target); ok {
		stdout, err := runSshRelayWorkerCommand(relayCtx, sshPath, target, deployment, relayArgs, input)
		if err == nil {
			return stdout, nil
		}
		if contextErr := relayContextError(ctx, relayCtx); contextErr != nil {
			return nil, contextErr
		}
		m.invalidateSshRelayWorker(sshTargetID)
	}
	platform, probeErr := m.probeRemoteRelayPlatform(relayCtx, sshPath, sshTargetID, target)
	if probeErr != nil {
		return nil, probeErr
	}
	pathDeployment := sshRelayWorkerDeployment{
		connectionKey: sshRelayConnectionKey(target),
		platform:      platform,
		path:          relayWorkerExecutableName(platform.goos),
	}
	stdout, err := runSshRelayWorkerCommand(relayCtx, sshPath, target, pathDeployment, relayArgs, input)
	if err := relayContextError(ctx, relayCtx); err != nil {
		return nil, err
	}
	if relayCtx.Err() == context.DeadlineExceeded {
		return nil, errors.New("relay worker command timed out")
	}
	if err == nil {
		m.cacheSshRelayWorker(sshTargetID, pathDeployment)
		return stdout, nil
	}
	if !isMissingRelayWorkerError(err) {
		return nil, err
	}
	deployment, deployErr := m.deploySshRelayWorker(relayCtx, sshPath, sshTargetID, target)
	if deployErr != nil {
		return nil, deployErr
	}
	m.cacheSshRelayWorker(sshTargetID, deployment)
	stdout, err = runSshRelayWorkerCommand(relayCtx, sshPath, target, deployment, relayArgs, input)
	if err := relayContextError(ctx, relayCtx); err != nil {
		return nil, err
	}
	if relayCtx.Err() == context.DeadlineExceeded {
		return nil, errors.New("relay worker command timed out")
	}
	return stdout, err
}

func runSshRelayWorkerCommand(ctx context.Context, sshPath string, target SshTarget, deployment sshRelayWorkerDeployment, relayArgs []string, input []byte) ([]byte, error) {
	args := append(sshConnectionArgs(target), remoteWorkerCommand(deployment, relayArgs))
	cmd := exec.CommandContext(ctx, sshPath, args...)
	if len(input) > 0 {
		cmd.Stdin = bytes.NewReader(input)
	}
	stdout := boundedRelayOutput{limit: maxSshRelayOutputBytes}
	stderr := boundedRelayOutput{limit: maxAgentHookBootstrapOutput}
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	if stdout.overflowed {
		return nil, errors.New("relay worker output exceeds limit")
	}
	if err == nil {
		return append([]byte(nil), stdout.buffer.Bytes()...), nil
	}
	detail := strings.TrimSpace(stderr.String())
	if detail == "" {
		detail = strings.TrimSpace(stdout.String())
	}
	if detail == "" {
		detail = err.Error()
	}
	return nil, errors.New(detail)
}

func (m *Manager) cachedSshRelayWorker(targetID string, target SshTarget) (sshRelayWorkerDeployment, bool) {
	m.sshRelayWorkerMu.Lock()
	defer m.sshRelayWorkerMu.Unlock()
	deployment, ok := m.sshRelayWorkers[targetID]
	return deployment, ok && deployment.connectionKey == sshRelayConnectionKey(target)
}

func (m *Manager) cacheSshRelayWorker(targetID string, deployment sshRelayWorkerDeployment) {
	m.sshRelayWorkerMu.Lock()
	m.sshRelayWorkers[targetID] = deployment
	m.sshRelayWorkerMu.Unlock()
}

func (m *Manager) invalidateSshRelayWorker(targetID string) {
	m.sshRelayWorkerMu.Lock()
	delete(m.sshRelayWorkers, targetID)
	m.sshRelayWorkerMu.Unlock()
}

func sshRelayConnectionKey(target SshTarget) string {
	return strings.Join([]string{target.ConfigHost, target.Host, strconv.Itoa(target.Port), target.Username}, "\x00")
}

func remoteWorkerCommand(deployment sshRelayWorkerDeployment, args []string) string {
	if deployment.platform.goos == "windows" {
		invocation := "& " + quotePowerShellLiteral(deployment.path)
		for _, arg := range args {
			invocation += " " + quotePowerShellLiteral(arg)
		}
		script := "$ErrorActionPreference='Stop';" + invocation + `;if($null -ne $LASTEXITCODE){exit $LASTEXITCODE}`
		return windowsPowerShellCommand(script)
	}
	return quoteRemoteWorkerCommand(deployment.path, args)
}

func quotePowerShellLiteral(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "''") + "'"
}

func relayContextError(parent context.Context, relay context.Context) error {
	if err := parent.Err(); err != nil {
		return err
	}
	if errors.Is(relay.Err(), context.Canceled) {
		return context.Canceled
	}
	return nil
}

type boundedRelayOutput struct {
	buffer     bytes.Buffer
	limit      int
	overflowed bool
}

func (b *boundedRelayOutput) Write(input []byte) (int, error) {
	original := len(input)
	remaining := b.limit - b.buffer.Len()
	if remaining < len(input) {
		b.overflowed = true
	}
	if remaining > 0 {
		if len(input) > remaining {
			input = input[:remaining]
		}
		_, _ = b.buffer.Write(input)
	}
	return original, nil
}

func (b *boundedRelayOutput) String() string {
	return b.buffer.String()
}

func quoteRemoteWorkerCommand(workerPath string, args []string) string {
	executable := shellQuoteSingle(workerPath)
	if strings.HasPrefix(workerPath, "$HOME/") {
		// The deployment path is generated by Pebble, not user input. Preserve
		// HOME expansion while keeping the remaining path a quoted literal.
		executable = `"$HOME"/` + shellQuoteSingle(strings.TrimPrefix(workerPath, "$HOME/"))
	}
	quoted := make([]string, 0, len(args)+1)
	quoted = append(quoted, executable)
	for _, arg := range args {
		quoted = append(quoted, shellQuoteSingle(arg))
	}
	return strings.Join(quoted, " ")
}

func isMissingRelayWorkerError(err error) bool {
	detail := strings.ToLower(err.Error())
	return strings.Contains(detail, "pebble-relay-worker: command not found") ||
		strings.Contains(detail, "pebble-relay-worker: not found") ||
		strings.Contains(detail, "pebble-relay-worker: command not recognized") ||
		(strings.Contains(detail, "pebble-relay-worker.exe") && strings.Contains(detail, "is not recognized")) ||
		(strings.Contains(detail, "pebble-relay-worker.exe") && strings.Contains(detail, "not found")) ||
		strings.Contains(detail, "exit status 127")
}

// sshConnectionArgs is the shared BatchMode/ConnectTimeout/identity/proxy
// argument set for any non-interactive system-ssh exec against a target
// (ProbeSshTarget's connectivity check and this file's relay-worker exec both
// build on it), so a real remote command can be appended after the
// destination instead of the probe's literal "true".
func sshConnectionArgs(target SshTarget) []string {
	// BatchMode=yes: no prompts. ConnectTimeout bounds the TCP connect within the
	// outer context deadline. StrictHostKeyChecking=accept-new avoids a hang on an
	// unknown host key while still refusing a changed key.
	args := []string{
		"-o", "BatchMode=yes",
		"-o", "ConnectTimeout=8",
		"-o", "StrictHostKeyChecking=accept-new",
		"-o", "PasswordAuthentication=no",
		"-o", "NumberOfPasswordPrompts=0",
	}
	if target.Port != 0 && target.Port != 22 {
		args = append(args, "-p", strconv.Itoa(target.Port))
	}
	if target.IdentityFile != "" {
		args = append(args, "-o", "IdentitiesOnly=yes", "-i", target.IdentityFile)
	}
	if target.ProxyCommand != "" {
		args = append(args, "-o", "ProxyCommand="+target.ProxyCommand)
	}
	if target.JumpHost != "" {
		args = append(args, "-J", target.JumpHost)
	}
	// Why: ControlMaster/ControlPath/ControlPersist multiplex every SSH exec
	// against this target (probe, relay-worker invocation, ...) over one
	// connection instead of a fresh TCP+auth handshake each time, mirroring
	// Electron's system-ssh-args.ts. Skipped when the target opts out, on
	// Windows (no unix domain sockets), or when the computed socket path
	// would exceed the platform's length limit.
	if socketPath, ok := controlSocketPath(target); ok && !sshConfigOwnsConnectionReuse(target) {
		args = append(args,
			"-o", "ControlMaster=auto",
			"-o", "ControlPath="+socketPath,
			"-o", "ControlPersist=300",
		)
	}
	destination := sshDestination(target)
	return append(args, destination)
}

func sshDestination(target SshTarget) string {
	destination := target.Host
	// Why: configHost resolves through ~/.ssh/config; prefer it so ProxyJump and
	// per-host options the config declares are honored.
	if target.ConfigHost != "" && target.Source == "ssh-config" {
		destination = target.ConfigHost
	}
	if target.Username != "" {
		destination = target.Username + "@" + destination
	}
	return destination
}

// quoteRemoteCommand builds a single shell-safe remote command string (ssh
// passes the final positional arg to the remote shell), single-quoting each
// argument so paths/titles/bodies with spaces or shell metacharacters survive
// the remote shell's parsing intact.
func quoteRemoteCommand(binary string, args []string) string {
	parts := make([]string, 0, len(args)+1)
	parts = append(parts, shellQuoteSingle(binary))
	for _, arg := range args {
		parts = append(parts, shellQuoteSingle(arg))
	}
	return strings.Join(parts, " ")
}

func shellQuoteSingle(value string) string {
	return "'" + strings.ReplaceAll(value, "'", `'\''`) + "'"
}
