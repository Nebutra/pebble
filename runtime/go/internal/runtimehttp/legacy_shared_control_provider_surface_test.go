package runtimehttp

import "testing"

func TestLegacySharedControlProviderSurfaceIncludesProviderDetailMethods(t *testing.T) {
	methods := []string{
		"github.prForBranch",
		"github.prFileContents",
		"gitlab.jobTrace",
		"gitlab.retryJob",
	}
	for _, method := range methods {
		if !legacySharedControlWorkItemMethod(method) {
			t.Errorf("expected %q to be handled by paired runtime control", method)
		}
	}
}
