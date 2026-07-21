package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"flag"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
)

type projectCloneEvent struct {
	Type    string `json:"type"`
	Phase   string `json:"phase,omitempty"`
	Percent int    `json:"percent,omitempty"`
	Path    string `json:"path,omitempty"`
	Name    string `json:"name,omitempty"`
	Error   string `json:"error,omitempty"`
}

func runProjectCloneJSON(args []string, output io.Writer) error {
	fs := flag.NewFlagSet("project-clone-json", flag.ContinueOnError)
	fs.SetOutput(output)
	remoteURL := fs.String("url", "", "git clone URL")
	destination := fs.String("destination", "", "absolute remote parent directory")
	if err := fs.Parse(args); err != nil {
		return err
	}
	url := strings.TrimSpace(*remoteURL)
	parent, err := expandCloneDestination(*destination)
	if err != nil {
		return err
	}
	name, err := cloneRepositoryName(url)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(parent, 0o755); err != nil {
		return err
	}
	clonePath := filepath.Join(parent, name)
	if !pathInsideRoot(parent, clonePath) {
		return errors.New("clone path escapes destination")
	}
	command := exec.Command("git", "clone", "--progress", "--", url, clonePath)
	stderr, err := command.StderrPipe()
	if err != nil {
		return err
	}
	if err := command.Start(); err != nil {
		return err
	}
	encoder := json.NewEncoder(output)
	scanner := bufio.NewScanner(stderr)
	scanner.Split(splitCloneProgressOutput)
	var tail string
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		tail = trimCloneErrorTail(tail + "\n" + line)
		if phase, percent, ok := parseCloneProgressOutput(line); ok {
			if err := encoder.Encode(projectCloneEvent{Type: "progress", Phase: phase, Percent: percent}); err != nil {
				_ = command.Process.Kill()
				return err
			}
		}
	}
	waitErr := command.Wait()
	if waitErr != nil {
		message := strings.TrimSpace(tail)
		if message == "" {
			message = waitErr.Error()
		}
		_ = encoder.Encode(projectCloneEvent{Type: "error", Error: message})
		return errors.New(message)
	}
	return encoder.Encode(projectCloneEvent{Type: "complete", Path: clonePath, Name: name})
}

func expandCloneDestination(value string) (string, error) {
	destination := strings.TrimSpace(value)
	if destination == "~" || strings.HasPrefix(destination, "~/") || strings.HasPrefix(destination, "~\\") {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		if destination == "~" {
			destination = home
		} else {
			destination = filepath.Join(home, destination[2:])
		}
	}
	if !filepath.IsAbs(destination) {
		return "", errors.New("clone destination must be absolute")
	}
	return filepath.Clean(destination), nil
}

func cloneRepositoryName(remoteURL string) (string, error) {
	value := strings.TrimSpace(strings.TrimRight(remoteURL, "/"))
	if value == "" {
		return "", errors.New("clone url is required")
	}
	if index := strings.LastIndex(value, ":"); index >= 0 && !strings.Contains(value[index+1:], "/") {
		value = value[index+1:]
	}
	name := filepath.Base(strings.ReplaceAll(value, "\\", "/"))
	name = strings.TrimSuffix(name, ".git")
	if name == "" || name == "." || name == ".." || strings.ContainsAny(name, "/\\") {
		return "", errors.New("unable to derive repository name")
	}
	return name, nil
}

func splitCloneProgressOutput(data []byte, atEOF bool) (int, []byte, error) {
	for index, value := range data {
		if value == '\r' || value == '\n' {
			return index + 1, data[:index], nil
		}
	}
	if atEOF && len(data) > 0 {
		return len(data), data, nil
	}
	return 0, nil, nil
}

func parseCloneProgressOutput(line string) (string, int, bool) {
	separator := strings.Index(line, ":")
	if separator <= 0 {
		return "", 0, false
	}
	phase := strings.TrimSpace(line[:separator])
	fields := strings.Fields(strings.TrimSpace(line[separator+1:]))
	if len(fields) == 0 || !strings.HasSuffix(fields[0], "%") {
		return "", 0, false
	}
	percent, err := strconv.Atoi(strings.TrimSuffix(fields[0], "%"))
	return phase, percent, err == nil && percent >= 0 && percent <= 100
}

func trimCloneErrorTail(value string) string {
	if len(value) <= 4096 {
		return value
	}
	return value[len(value)-4096:]
}
