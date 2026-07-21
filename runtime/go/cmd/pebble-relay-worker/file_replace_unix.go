//go:build !windows

package main

import "os"

func replaceRelayUpload(source, target string) error {
	return os.Rename(source, target)
}
