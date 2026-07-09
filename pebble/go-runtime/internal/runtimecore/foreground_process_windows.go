//go:build windows

package runtimecore

// foregroundProcessSupported is false on Windows: there is no tcgetpgrp/process-
// group model, and the pipe-backed sessions have no console handle to inspect.
// Resolving the Windows console foreground process is deferred until the runtime
// grows real PTY (ConPTY) sessions.
const foregroundProcessSupported = false

// foregroundProcessUnsupportedReason is surfaced on the session status so the
// renderer can tell "not supported here" apart from "no foreground detected".
const foregroundProcessUnsupportedReason = "windows foreground process detection requires ConPTY sessions (not yet implemented)"

// resolveForegroundProcessName is a no-op on Windows.
func resolveForegroundProcessName(_ int) (string, bool) {
	return "", false
}
