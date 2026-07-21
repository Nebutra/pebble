package runtimecore

import (
	"context"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

const sshConfigResolveTimeout = 2 * time.Second

// sshConfigOwnsConnectionReuse reports whether the user's resolved OpenSSH
// config already owns multiplexing. Pebble must not override that socket.
func sshConfigOwnsConnectionReuse(target SshTarget) bool {
	ctx, cancel := context.WithTimeout(context.Background(), sshConfigResolveTimeout)
	defer cancel()

	sshPath, ok := findSystemSshBinary()
	if !ok {
		return false
	}
	args := []string{"-G"}
	if target.Port != 0 && target.Port != 22 {
		args = append(args, "-p", strconv.Itoa(target.Port))
	}
	if target.IdentityFile != "" {
		args = append(args, "-i", target.IdentityFile)
	}
	if target.ProxyCommand != "" {
		args = append(args, "-o", "ProxyCommand="+target.ProxyCommand)
	}
	if target.JumpHost != "" {
		args = append(args, "-J", target.JumpHost)
	}
	output, err := exec.CommandContext(ctx, sshPath, append(args, sshDestination(target))...).Output()
	if err != nil {
		return false
	}
	return resolvedSshConfigOwnsConnectionReuse(string(output))
}

func resolvedSshConfigOwnsConnectionReuse(output string) bool {
	controlMaster := ""
	controlPath := ""
	for _, line := range strings.Split(output, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		switch strings.ToLower(fields[0]) {
		case "controlmaster":
			controlMaster = strings.ToLower(fields[1])
		case "controlpath":
			controlPath = strings.ToLower(fields[1])
		}
	}
	return (controlMaster != "" && controlMaster != "no" && controlMaster != "false") ||
		(controlPath != "" && controlPath != "none")
}
