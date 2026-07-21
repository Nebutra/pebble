package providerrest

// ReviewProviderCapabilities reports the REST provider selected by the same
// remote parsers used for list/create/update operations.
type ReviewProviderCapabilities struct {
	Provider      string
	Authenticated bool
}

func DetectReviewProviderCapabilities(remoteURL string) (ReviewProviderCapabilities, bool) {
	if parseBitbucketRepoRef(remoteURL) != nil {
		config := BitbucketConfigFromEnv()
		return ReviewProviderCapabilities{
			Provider: "bitbucket",
			Authenticated: config.AccessToken != "" ||
				(config.Email != "" && config.APIToken != ""),
		}, true
	}
	if parseAzureDevOpsRepoRef(remoteURL) != nil {
		config := AzureDevOpsConfigFromEnv()
		return ReviewProviderCapabilities{
			Provider:      "azure-devops",
			Authenticated: config.AccessToken != "" || config.PAT != "",
		}, true
	}
	if parseGiteaRepoRef(remoteURL) != nil {
		return ReviewProviderCapabilities{
			Provider:      "gitea",
			Authenticated: GiteaConfigFromEnv().Token != "",
		}, true
	}
	return ReviewProviderCapabilities{}, false
}
