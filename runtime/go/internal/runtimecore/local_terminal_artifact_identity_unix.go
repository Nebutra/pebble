//go:build !windows

package runtimecore

import (
	"errors"
	"fmt"
	"os"
	"syscall"
)

func validateLocalTerminalArtifactFile(info os.FileInfo) error {
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || stat.Nlink > 1 || !info.Mode().IsRegular() {
		return errors.New("terminal_file_grant_stale")
	}
	return nil
}

func localTerminalArtifactIdentity(info os.FileInfo) string {
	stat, _ := info.Sys().(*syscall.Stat_t)
	if stat == nil {
		return ""
	}
	return fmt.Sprintf("%d:%d:%d:%d:%d", stat.Dev, stat.Ino, stat.Nlink, info.Size(), info.ModTime().UnixNano())
}

func replaceLocalTerminalArtifact(source, destination string) error {
	return os.Rename(source, destination)
}
