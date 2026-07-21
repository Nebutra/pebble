package runtimecore

import (
	"path/filepath"
	"runtime"
	"strings"
)

func normalizeLocalPath(path string) (string, error) {
	if path == "" {
		return "", ErrInvalidPath
	}
	return filepath.Abs(path)
}

func isAbsoluteForHost(path string) bool {
	if path == "" {
		return false
	}
	if filepath.IsAbs(path) {
		return true
	}
	if strings.HasPrefix(path, "/") || strings.HasPrefix(path, `\\`) {
		return true
	}
	if len(path) >= 3 && path[1] == ':' && (path[2] == '\\' || path[2] == '/') {
		return true
	}
	if runtime.GOOS == "windows" {
		return filepath.IsAbs(path)
	}
	return false
}
