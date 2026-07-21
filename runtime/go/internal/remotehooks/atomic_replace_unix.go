//go:build !windows

package remotehooks

import "os"

func replaceAtomicFile(source, target string) error {
	return os.Rename(source, target)
}
