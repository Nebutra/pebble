//go:build !windows

package runtimecore

import "os"

func replaceRemoteWorkspaceFile(source, target string) error {
	return os.Rename(source, target)
}
