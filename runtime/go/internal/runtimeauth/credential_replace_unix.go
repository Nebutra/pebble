//go:build !windows

package runtimeauth

import "os"

func replaceCredentialFile(source, target string) error {
	return os.Rename(source, target)
}
