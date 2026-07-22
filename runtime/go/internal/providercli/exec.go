package providercli

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"
)

// commandTimeout bounds every CLI call. Provider CLIs can hang behind auth
// prompts, credential helpers, or network stalls; runtime calls must stay
// bounded like the git shell-outs in runtimecore.
const commandTimeout = 30 * time.Second

// ErrCLIMissing signals the provider CLI is not on PATH. Callers translate this
// into the same "not installed" surface Electron produces (a load failure, not
// a silent empty result), so the renderer's per-repo aggregator counts a
// genuine failure instead of under-reporting.
var ErrCLIMissing = errors.New("provider cli not found")

// ErrCLIUnauthenticated signals the CLI ran but is not logged in. Mirrors the
// Electron auth-required surface (message points at `gh auth login` / `glab
// auth login`).
var ErrCLIUnauthenticated = errors.New("provider cli not authenticated")

// runCLI executes bin with args in workdir and returns stdout. Missing binary
// and auth failures are classified into the sentinel errors above so HTTP
// callers can map them to stable error codes.
func runCLI(ctx context.Context, bin string, workdir string, args ...string) ([]byte, error) {
	stdout, stderr, err := runCLICapture(ctx, bin, workdir, args...)
	if err == nil {
		return stdout, nil
	}
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, ErrCLIMissing) {
		return nil, err
	}
	combined := strings.TrimSpace(string(stderr) + "\n" + string(stdout))
	if isUnauthenticated(combined) {
		return nil, fmt.Errorf("%w: %s", ErrCLIUnauthenticated, bin)
	}
	if combined == "" {
		return nil, err
	}
	return nil, errors.New(combined)
}

func runCLICapture(ctx context.Context, bin string, workdir string, args ...string) ([]byte, []byte, error) {
	if _, err := exec.LookPath(bin); err != nil {
		return nil, nil, fmt.Errorf("%w: %s", ErrCLIMissing, bin)
	}
	runCtx, cancel := context.WithTimeout(ctx, commandTimeout)
	defer cancel()
	cmd := exec.CommandContext(runCtx, bin, args...)
	// Why: runtime-owned provider calls have no visible stdin; hidden auth or
	// confirmation prompts would otherwise stall until the timeout.
	cmd.Env = append(os.Environ(), "GH_PROMPT_DISABLED=1", "GLAB_PROMPT_DISABLED=1")
	if workdir != "" {
		cmd.Dir = workdir
	}
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	if err == nil {
		return stdout.Bytes(), stderr.Bytes(), nil
	}
	if errors.Is(runCtx.Err(), context.DeadlineExceeded) {
		return stdout.Bytes(), stderr.Bytes(), fmt.Errorf("%w: %s", context.DeadlineExceeded, bin)
	}
	return stdout.Bytes(), stderr.Bytes(), err
}

// isUnauthenticated keeps GitHub and GitLab CLI auth-error classification aligned.
func isUnauthenticated(message string) bool {
	lower := strings.ToLower(message)
	for _, marker := range []string{
		"not logged",
		"not authenticated",
		"authentication required",
		"gh auth login",
		"glab auth login",
		"http 401",
		"401 unauthorized",
	} {
		if strings.Contains(lower, marker) {
			return true
		}
	}
	return false
}
