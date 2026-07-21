//go:build windows

package runtimecore

// controlSocketDirectory is unreachable on Windows in practice — controlSocketPath
// returns ("", false) for windows before ever calling this — but the function
// must still exist so the package builds for a Windows target.
func controlSocketDirectory() (string, bool) {
	return "", false
}

func controlSocketTempDirName() string {
	// Why: platform-neutral tests reference the candidate name before their
	// Windows runtime skip; Windows never creates or uses this directory.
	return "pebble-ssh-disabled"
}
