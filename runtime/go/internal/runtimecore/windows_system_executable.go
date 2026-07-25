//go:build windows

package runtimecore

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

func windowsSystemExecutable(name string) string {
	// Why: service and CI environments can omit System32 from PATH; process-tree
	// cleanup must still invoke the trusted Windows system executable.
	if systemRoot := strings.TrimSpace(os.Getenv("SystemRoot")); systemRoot != "" {
		return filepath.Join(systemRoot, "System32", name)
	}
	if resolved, err := exec.LookPath(name); err == nil {
		return resolved
	}
	return name
}
