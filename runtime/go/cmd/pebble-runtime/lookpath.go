package main

import "os/exec"

func syscallExecLookPath(file string) (string, error) {
	return exec.LookPath(file)
}
