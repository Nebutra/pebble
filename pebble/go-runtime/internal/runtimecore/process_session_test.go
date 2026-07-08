package runtimecore

import "runtime"

func testEchoCommand() []string {
	if runtime.GOOS == "windows" {
		return []string{"cmd.exe", "/c", "echo", "pebble"}
	}
	return []string{"/bin/sh", "-c", "printf 'pebble\n'"}
}

func testSleepCommand() []string {
	if runtime.GOOS == "windows" {
		return []string{"cmd.exe", "/c", "ping", "-n", "10", "127.0.0.1", ">", "NUL"}
	}
	return []string{"/bin/sh", "-c", "sleep 10"}
}
