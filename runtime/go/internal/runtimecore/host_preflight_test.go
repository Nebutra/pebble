package runtimecore

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestDetectHostPreflightUsesRuntimeHostCommandsAndProviderEnvironment(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("preflight fixture uses POSIX executable scripts")
	}
	bin := t.TempDir()
	writeCommand := func(name, body string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(bin, name), []byte("#!/bin/sh\n"+body+"\n"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	writeCommand("git", "exit 0")
	writeCommand("gh", "exit 0")
	writeCommand("glab", "exit 1")
	t.Setenv("PATH", bin)
	t.Setenv("PEBBLE_BITBUCKET_EMAIL", "dev@example.com")
	t.Setenv("PEBBLE_BITBUCKET_API_TOKEN", "secret")
	t.Setenv("PEBBLE_AZURE_DEVOPS_USERNAME", "dev")
	t.Setenv("PEBBLE_AZURE_DEVOPS_PAT", "secret")
	t.Setenv("PEBBLE_AZURE_DEVOPS_API_BASE_URL", "https://dev.azure.com/acme")
	t.Setenv("PEBBLE_GITEA_TOKEN", "secret")
	t.Setenv("PEBBLE_GITEA_API_BASE_URL", "https://git.example.com")

	status := DetectHostPreflight()
	if !status.Git.Installed || !status.GitHub.Installed || !status.GitHub.Authenticated {
		t.Fatalf("unexpected git/GitHub status: %#v", status)
	}
	if !status.GitLab.Installed || status.GitLab.Authenticated {
		t.Fatalf("unexpected GitLab status: %#v", status.GitLab)
	}
	if !status.Bitbucket.Configured || !status.AzureDevOps.TokenConfigured || !status.Gitea.Authenticated {
		t.Fatalf("REST provider configuration was not detected: %#v", status)
	}
	if status.AzureDevOps.BaseURL == nil || *status.AzureDevOps.BaseURL != "https://dev.azure.com/acme" {
		t.Fatalf("unexpected Azure DevOps base URL: %#v", status.AzureDevOps)
	}
	if status.Gitea.BaseURL == nil || *status.Gitea.BaseURL != "https://git.example.com/api/v1" {
		t.Fatalf("unexpected Gitea base URL: %#v", status.Gitea)
	}
}
