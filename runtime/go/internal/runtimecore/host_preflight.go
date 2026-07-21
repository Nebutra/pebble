package runtimecore

import (
	"context"
	"os/exec"
	"time"

	"github.com/nebutra/pebble/runtime/go/internal/providerrest"
)

type HostPreflightCommandStatus struct {
	Installed     bool `json:"installed"`
	Authenticated bool `json:"authenticated,omitempty"`
}

type HostPreflightStatus struct {
	Git         HostPreflightCommandStatus `json:"git"`
	GitHub      HostPreflightCommandStatus `json:"gh"`
	GitLab      HostPreflightCommandStatus `json:"glab"`
	Bitbucket   HostRESTPreflightStatus    `json:"bitbucket"`
	AzureDevOps HostRESTPreflightStatus    `json:"azureDevOps"`
	Gitea       HostRESTPreflightStatus    `json:"gitea"`
}

type HostRESTPreflightStatus struct {
	Configured      bool    `json:"configured"`
	Authenticated   bool    `json:"authenticated"`
	Account         *string `json:"account"`
	BaseURL         *string `json:"baseUrl,omitempty"`
	TokenConfigured bool    `json:"tokenConfigured,omitempty"`
}

func DetectHostPreflight() HostPreflightStatus {
	gitInstalled := hostCommandInstalled("git")
	ghInstalled, ghAuthenticated := hostProviderAuthStatus("gh")
	glabInstalled, glabAuthenticated := hostProviderAuthStatus("glab")
	bitbucket := providerrest.BitbucketConfigFromEnv()
	azure := providerrest.AzureDevOpsConfigFromEnv()
	gitea := providerrest.GiteaConfigFromEnv()
	bitbucketConfigured := bitbucket.AccessToken != "" || (bitbucket.Email != "" && bitbucket.APIToken != "")
	azureConfigured := azure.AccessToken != "" || azure.PAT != ""
	giteaConfigured := gitea.Token != ""
	return HostPreflightStatus{
		Git:         HostPreflightCommandStatus{Installed: gitInstalled},
		GitHub:      HostPreflightCommandStatus{Installed: ghInstalled, Authenticated: ghAuthenticated},
		GitLab:      HostPreflightCommandStatus{Installed: glabInstalled, Authenticated: glabAuthenticated},
		Bitbucket:   HostRESTPreflightStatus{Configured: bitbucketConfigured, Authenticated: bitbucketConfigured, Account: optionalHostPreflightString(bitbucket.Email), TokenConfigured: bitbucketConfigured},
		AzureDevOps: HostRESTPreflightStatus{Configured: azureConfigured, Authenticated: azureConfigured, Account: optionalHostPreflightString(azure.Username), BaseURL: optionalHostPreflightString(azure.APIBaseURL), TokenConfigured: azureConfigured},
		Gitea:       HostRESTPreflightStatus{Configured: giteaConfigured, Authenticated: giteaConfigured, BaseURL: optionalHostPreflightString(gitea.APIBaseURL), TokenConfigured: giteaConfigured},
	}
}

func optionalHostPreflightString(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}

func hostCommandInstalled(command string) bool {
	_, err := exec.LookPath(command)
	return err == nil
}

func hostProviderAuthStatus(command string) (bool, bool) {
	path, err := exec.LookPath(command)
	if err != nil {
		return false, false
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return true, exec.CommandContext(ctx, path, "auth", "status").Run() == nil
}

func HostAgentRefreshResult() map[string]interface{} {
	return map[string]interface{}{
		"agents": DetectHostAgents(), "addedPathSegments": []string{},
		"shellHydrationOk": true, "pathSource": "shell_hydrate", "pathFailureReason": "none",
	}
}
