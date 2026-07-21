package providerrest

import "testing"

func TestDetectReviewProviderCapabilities(t *testing.T) {
	t.Setenv("PEBBLE_BITBUCKET_ACCESS_TOKEN", "bitbucket-token")
	t.Setenv("PEBBLE_AZURE_DEVOPS_TOKEN", "azure-token")
	t.Setenv("PEBBLE_GITEA_TOKEN", "gitea-token")

	tests := []struct {
		name     string
		remote   string
		provider string
	}{
		{name: "bitbucket", remote: "git@bitbucket.org:team/repo.git", provider: "bitbucket"},
		{name: "azure devops", remote: "git@ssh.dev.azure.com:v3/org/project/repo", provider: "azure-devops"},
		{name: "gitea", remote: "git@git.example.com:owner/repo.git", provider: "gitea"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			result, ok := DetectReviewProviderCapabilities(test.remote)
			if !ok || result.Provider != test.provider || !result.Authenticated {
				t.Fatalf("unexpected capabilities: %+v, detected=%v", result, ok)
			}
		})
	}
}

func TestDetectReviewProviderCapabilitiesRequiresCredentials(t *testing.T) {
	t.Setenv("PEBBLE_GITEA_TOKEN", "")
	result, ok := DetectReviewProviderCapabilities("https://git.example.com/owner/repo.git")
	if !ok || result.Provider != "gitea" || result.Authenticated {
		t.Fatalf("unexpected capabilities: %+v, detected=%v", result, ok)
	}
}

func TestDetectReviewProviderCapabilitiesDoesNotClaimCLIProviders(t *testing.T) {
	for _, remote := range []string{
		"git@github.com:owner/repo.git",
		"git@gitlab.com:owner/repo.git",
	} {
		if result, ok := DetectReviewProviderCapabilities(remote); ok {
			t.Fatalf("unexpected REST provider for %q: %+v", remote, result)
		}
	}
}
