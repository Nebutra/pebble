//go:build !windows

package runtimeauth

import (
	"errors"
	"os"
	"syscall"
)

func validateCredentialFile(file *os.File) error {
	info, err := file.Stat()
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Mode().Perm()&0o077 != 0 {
		return errors.New("runtime credential file permissions are not owner-only")
	}
	return nil
}

func processAlive(pid int) bool {
	err := syscall.Kill(pid, 0)
	return err == nil || err == syscall.EPERM
}
