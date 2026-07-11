//go:build windows

package runtimecore

// controlSocketDirectory is unreachable on Windows in practice — controlSocketPath
// returns ("", false) for windows before ever calling this — but the function
// must still exist so the package builds for a Windows target.
func controlSocketDirectory() (string, bool) {
	return "", false
}
