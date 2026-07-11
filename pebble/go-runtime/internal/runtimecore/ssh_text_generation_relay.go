package runtimecore

import (
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
// remote host via the system ssh binary (same BatchMode=yes/no-prompt
// connection args as ProbeSshTarget) and returns its stdout. The relay worker
// binary is expected to already be deployed on the remote host's PATH.
func (m *Manager) runSshRelayWorker(ctx context.Context, sshTargetID string, relayArgs []string) ([]byte, error) {
	target, ok := m.GetSshTarget(sshTargetID)
	if !ok {
		return nil, ErrNotFound
	}
	sshPath, ok := findSystemSshBinary()
	if !ok {
		return nil, errors.New("system ssh binary not found")
	}
	relayCtx, cancel := context.WithTimeout(ctx, gitTextGenerationRelayTimeout)
	defer cancel()
	args := append(sshConnectionArgs(target), quoteRemoteCommand("pebble-relay-worker", relayArgs))
	cmd := exec.CommandContext(relayCtx, sshPath, args...)
	stdout, err := cmd.Output()
	if relayCtx.Err() == context.DeadlineExceeded {
		return nil, errors.New("relay worker command timed out")
	}
	if err != nil {
		detail := strings.TrimSpace(string(stdout))
		if exitErr, ok := err.(*exec.ExitError); ok {
			if stderrDetail := strings.TrimSpace(string(exitErr.Stderr)); stderrDetail != "" {
				detail = stderrDetail
			}
		}
		if detail == "" {
			detail = err.Error()
		}
		return nil, errors.New(detail)
	}
	return stdout, nil
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
	if socketPath, ok := controlSocketPath(target); ok {
		args = append(args,
			"-o", "ControlMaster=auto",
			"-o", "ControlPath="+socketPath,
			"-o", "ControlPersist=300",
		)
	}
	destination := target.Host
	// Why: configHost resolves through ~/.ssh/config; prefer it so ProxyJump and
	// per-host options the config declares are honored.
	if target.ConfigHost != "" && target.Source == "ssh-config" {
		destination = target.ConfigHost
	}
	if target.Username != "" {
		destination = target.Username + "@" + destination
	}
	return append(args, destination)
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
