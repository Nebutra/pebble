package runtimecore

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// Electron parity (src/main/hooks.ts + src/main/ipc/worktrees.ts): the
// `scripts.archive` command from the project root's pebble.yaml runs in the
// worktree directory before `git worktree remove`, bounded by the same
// two-minute hook timeout, with the PEBBLE_* env vars teardown scripts expect.
// This file is shared by the local removal path (manager.go) and
// pebble-relay-worker so hosted and SSH deletions cannot drift.

// archiveHookTimeout mirrors Electron's HOOK_TIMEOUT /
// WORKTREE_ARCHIVE_HOOK_TIMEOUT_MS (both 120s).
const archiveHookTimeout = 2 * time.Minute

// ErrArchiveHookFailed is the sentinel for errors.Is checks; the concrete
// *ArchiveHookError carries the captured hook output for the renderer.
var ErrArchiveHookFailed = errors.New("archive hook failed")

// ArchiveHookError reports an archive hook that exited non-zero, timed out, or
// failed to spawn. Removal is aborted so teardown scripts can veto deletion.
type ArchiveHookError struct {
	Output   string
	TimedOut bool
	cause    error
}

func (e *ArchiveHookError) Error() string {
	reason := "archive hook failed"
	if e.TimedOut {
		reason = "archive hook timed out after " + archiveHookTimeout.String()
	} else if e.cause != nil {
		reason = "archive hook failed: " + e.cause.Error()
	}
	if e.Output != "" {
		return reason + "\n" + e.Output
	}
	return reason
}

func (e *ArchiveHookError) Unwrap() error { return ErrArchiveHookFailed }

// LoadWorktreeArchiveHookScript returns the `scripts.archive` command from
// {repoRoot}/pebble.yaml, or "" when the file or key is absent. Parse failures
// return "" to match Electron's loadHooks, which treats unreadable pebble.yaml
// as "no hooks configured" rather than blocking removal.
func LoadWorktreeArchiveHookScript(repoPath string) string {
	content, err := os.ReadFile(filepath.Join(repoPath, "pebble.yaml"))
	if err != nil {
		return ""
	}
	return parsePebbleYamlArchiveScript(string(content))
}

// RunWorktreeArchiveHookOnHost runs the project's archive hook (if configured)
// in the worktree directory on the executing host. A nil return means the hook
// succeeded or no hook is configured; any error is an *ArchiveHookError and
// the caller must abort the removal.
func RunWorktreeArchiveHookOnHost(ctx context.Context, repoPath, worktreePath string) error {
	script := LoadWorktreeArchiveHookScript(repoPath)
	if script == "" {
		return nil
	}
	// A missing worktree directory (failed-creation rollback, manual cleanup)
	// leaves nothing for teardown to see; don't let a spawn failure veto it.
	if _, err := os.Stat(worktreePath); err != nil {
		return nil
	}
	return runWorktreeArchiveHookScript(ctx, repoPath, worktreePath, script, archiveHookTimeout)
}

// runWorktreeArchiveHookScript is split from the public entry point so tests
// can exercise timeout behavior without waiting the full production limit.
func runWorktreeArchiveHookScript(
	ctx context.Context,
	repoPath string,
	worktreePath string,
	script string,
	timeout time.Duration,
) error {
	hookCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	var cmd *exec.Cmd
	if runtime.GOOS == "windows" {
		// Electron routes Windows hooks through ComSpec (cmd.exe) rather than bash.
		comSpec := os.Getenv("ComSpec")
		if comSpec == "" {
			comSpec = "cmd.exe"
		}
		cmd = exec.CommandContext(hookCtx, comSpec, "/d", "/s", "/c", script)
	} else {
		cmd = exec.CommandContext(hookCtx, "/bin/bash", "-c", script)
	}
	cmd.Dir = worktreePath
	cmd.Env = append(os.Environ(),
		"PEBBLE_ROOT_PATH="+repoPath,
		"PEBBLE_WORKTREE_PATH="+worktreePath,
		"PEBBLE_WORKSPACE_NAME="+filepath.Base(worktreePath),
		// Compat with conductor.json users, mirroring Electron's hook env.
		"CONDUCTOR_ROOT_PATH="+repoPath,
		"GHOSTX_ROOT_PATH="+repoPath,
	)
	output, err := cmd.CombinedOutput()
	if err == nil {
		return nil
	}
	return &ArchiveHookError{
		Output:   strings.TrimSpace(string(output)),
		TimedOut: errors.Is(hookCtx.Err(), context.DeadlineExceeded),
		cause:    err,
	}
}

// parsePebbleYamlArchiveScript extracts `scripts.archive` from pebble.yaml
// content. The Go runtime has no YAML dependency and only needs this one hook
// field, so this parses the minimal subset Electron's full parser accepts for
// it: an inline (optionally quoted) scalar or a literal/folded block scalar.
func parsePebbleYamlArchiveScript(content string) string {
	lines := strings.Split(strings.ReplaceAll(content, "\r\n", "\n"), "\n")
	inScripts := false
	scriptsIndent := -1
	for index := 0; index < len(lines); index++ {
		line := lines[index]
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		indent := len(line) - len(strings.TrimLeft(line, " "))
		if !inScripts {
			if indent == 0 {
				key, rest, found := strings.Cut(trimmed, ":")
				rest = strings.TrimSpace(rest)
				if found && key == "scripts" && (rest == "" || strings.HasPrefix(rest, "#")) {
					inScripts = true
				}
			}
			continue
		}
		if indent == 0 {
			// A new top-level key ends the scripts block.
			return ""
		}
		if scriptsIndent == -1 {
			scriptsIndent = indent
		}
		if indent != scriptsIndent {
			continue
		}
		key, rest, found := strings.Cut(trimmed, ":")
		if !found || strings.TrimSpace(key) != "archive" {
			continue
		}
		value := strings.TrimSpace(rest)
		if value == "|" || value == "|-" || value == "|+" || value == ">" || value == ">-" || value == ">+" {
			return strings.TrimSpace(collectBlockScalar(lines[index+1:], scriptsIndent))
		}
		return strings.TrimSpace(unquoteYamlScalar(value))
	}
	return ""
}

// collectBlockScalar joins the lines of a YAML block scalar that are indented
// deeper than the key. Literal and folded styles are both joined with
// newlines: hook scripts run through `bash -c`/`cmd /c`, where the practical
// meaning of the folded form is the same command sequence.
func collectBlockScalar(lines []string, keyIndent int) string {
	var blockLines []string
	blockIndent := -1
	for _, line := range lines {
		if strings.TrimSpace(line) == "" {
			blockLines = append(blockLines, "")
			continue
		}
		indent := len(line) - len(strings.TrimLeft(line, " "))
		if indent <= keyIndent {
			break
		}
		if blockIndent == -1 {
			blockIndent = indent
		}
		start := blockIndent
		if indent < start {
			start = indent
		}
		blockLines = append(blockLines, line[start:])
	}
	return strings.Join(blockLines, "\n")
}

// unquoteYamlScalar strips one level of matching quotes from an inline scalar
// and drops a trailing YAML comment from plain (unquoted) scalars.
func unquoteYamlScalar(value string) string {
	if len(value) >= 2 {
		if (value[0] == '"' && value[len(value)-1] == '"') || (value[0] == '\'' && value[len(value)-1] == '\'') {
			inner := value[1 : len(value)-1]
			if value[0] == '\'' {
				return strings.ReplaceAll(inner, "''", "'")
			}
			return strings.ReplaceAll(strings.ReplaceAll(inner, `\"`, `"`), `\\`, `\`)
		}
	}
	// Plain scalars end at " #" per YAML comment rules.
	if commentStart := strings.Index(value, " #"); commentStart != -1 {
		return strings.TrimSpace(value[:commentStart])
	}
	return value
}
