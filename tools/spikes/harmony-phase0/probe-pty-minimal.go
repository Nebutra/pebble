//go:build unix

// Minimal B1 probe: creack/pty StartWithSize + echo.
// Run on a candidate host (or cross-built binary on device):
//
//	go run ./tools/spikes/harmony-phase0/probe-pty-minimal.go
package main

import (
	"fmt"
	"os"
	"os/exec"
	"time"

	"github.com/creack/pty"
)

func main() {
	cmd := exec.Command("sh", "-c", "printf 'p0-pty-ok\\n'; sleep 0.2")
	f, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: 80, Rows: 24})
	if err != nil {
		fmt.Fprintf(os.Stderr, "FAIL start pty: %v\n", err)
		os.Exit(1)
	}
	defer f.Close()

	buf := make([]byte, 4096)
	deadline := time.Now().Add(3 * time.Second)
	var out []byte
	for time.Now().Before(deadline) {
		_ = f.SetReadDeadline(time.Now().Add(200 * time.Millisecond))
		n, readErr := f.Read(buf)
		if n > 0 {
			out = append(out, buf[:n]...)
			if contains(out, []byte("p0-pty-ok")) {
				fmt.Println("PASS pty echo")
				_ = cmd.Wait()
				os.Exit(0)
			}
		}
		if readErr != nil && !os.IsTimeout(readErr) {
			break
		}
	}
	fmt.Fprintf(os.Stderr, "FAIL did not observe marker; out=%q err_wait=%v\n", out, cmd.Wait())
	os.Exit(2)
}

func contains(haystack, needle []byte) bool {
	if len(needle) == 0 {
		return true
	}
	for i := 0; i+len(needle) <= len(haystack); i++ {
		ok := true
		for j := range needle {
			if haystack[i+j] != needle[j] {
				ok = false
				break
			}
		}
		if ok {
			return true
		}
	}
	return false
}
