//go:build !windows

package runtimecore

import "os"

func syncStoreDirectory(dir string) error {
	file, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer file.Close()
	return file.Sync()
}
