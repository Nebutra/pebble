//go:build windows

package runtimecore

import (
	"errors"
	"fmt"
	"os"
)

func validateLocalTerminalArtifactFile(info os.FileInfo) error {
	if !info.Mode().IsRegular() {
		return errors.New("terminal_file_grant_stale")
	}
	return nil
}

func localTerminalArtifactIdentity(info os.FileInfo) string {
	return fmt.Sprintf("%d:%d", info.Size(), info.ModTime().UnixNano())
}

func replaceLocalTerminalArtifact(source, destination string) error {
	if err := os.Remove(destination); err != nil {
		return err
	}
	return os.Rename(source, destination)
}
