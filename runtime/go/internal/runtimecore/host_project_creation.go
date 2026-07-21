package runtimecore

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

func (m *Manager) CreateProjectOnHost(ctx context.Context, parentPath, name, kind string) (Project, error) {
	parentPath = strings.TrimSpace(parentPath)
	name = strings.TrimSpace(name)
	if name == "" {
		return Project{}, errors.New("Name cannot be empty")
	}
	if name == "." || name == ".." || strings.ContainsAny(name, "/\\") {
		return Project{}, errors.New(`Name cannot contain slashes or be "." / ".."`)
	}
	if !isAbsoluteForHost(parentPath) {
		return Project{}, errors.New("Parent directory must be an absolute path")
	}
	parentPath, err := normalizeLocalPath(parentPath)
	if err != nil {
		return Project{}, errors.New("Parent directory must be an absolute path")
	}
	targetPath := filepath.Join(parentPath, name)
	for _, project := range m.ListProjects() {
		if pathsEqualForHost(project.Path, targetPath) {
			return project, nil
		}
	}
	if err := os.MkdirAll(parentPath, 0o755); err != nil {
		return Project{}, fmt.Errorf("failed to prepare parent directory: %w", err)
	}
	createdDirectory := false
	if entries, readErr := os.ReadDir(targetPath); readErr == nil {
		if len(entries) > 0 {
			return Project{}, fmt.Errorf("%q already exists at this location and is not empty", name)
		}
	} else if errors.Is(readErr, os.ErrNotExist) {
		if err := os.Mkdir(targetPath, 0o755); err != nil {
			return Project{}, fmt.Errorf("failed to prepare directory: %w", err)
		}
		createdDirectory = true
	} else {
		return Project{}, fmt.Errorf("failed to inspect target directory: %w", readErr)
	}

	provider := "folder"
	if kind != "folder" {
		provider = "git"
		if err := initializeProjectGitRepository(ctx, targetPath); err != nil {
			if createdDirectory {
				_ = os.RemoveAll(targetPath)
			} else {
				_ = os.RemoveAll(filepath.Join(targetPath, ".git"))
			}
			return Project{}, err
		}
	}
	project, err := m.CreateProjectWithMainWorktree(ctx, CreateProjectRequest{Name: name, Path: targetPath, LocationKind: "local", Provider: provider})
	if err != nil && createdDirectory {
		_ = os.RemoveAll(targetPath)
	}
	return project, err
}

func initializeProjectGitRepository(ctx context.Context, targetPath string) error {
	commandCtx, cancel := context.WithTimeout(ctx, gitCommandTimeout)
	output, err := exec.CommandContext(commandCtx, "git", "-C", targetPath, "init").CombinedOutput()
	cancel()
	if err != nil {
		return fmt.Errorf("failed to initialize git repository: %s", commandFailureMessage(output, err))
	}
	commandCtx, cancel = context.WithTimeout(ctx, gitCommandTimeout)
	output, err = exec.CommandContext(commandCtx, "git", "-C", targetPath, "commit", "--allow-empty", "-m", "Initial commit").CombinedOutput()
	cancel()
	if err != nil {
		message := commandFailureMessage(output, err)
		if strings.Contains(message, "Please tell me who you are") || strings.Contains(message, "user.name") || strings.Contains(message, "user.email") {
			return errors.New(`Git author identity is not configured. Run git config --global user.name and user.email, then try again`)
		}
		return fmt.Errorf("failed to create initial commit: %s", message)
	}
	return nil
}

func commandFailureMessage(output []byte, err error) string {
	if message := strings.TrimSpace(string(output)); message != "" {
		return message
	}
	return err.Error()
}

func pathsEqualForHost(left, right string) bool {
	left = filepath.Clean(left)
	right = filepath.Clean(right)
	if filepath.Separator == '\\' {
		return strings.EqualFold(left, right)
	}
	return left == right
}
