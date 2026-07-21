package runtimecore

import "testing"

func TestSplitRemoteTrackingBaseRejectsUnsafeRefs(t *testing.T) {
	remote, branch, ok := splitRemoteTrackingBase("refs/remotes/origin/main")
	if !ok || remote != "origin" || branch != "main" {
		t.Fatalf("unexpected split %q %q %v", remote, branch, ok)
	}
	for _, value := range []string{"main", "refs/heads/main", "origin/../main", "/main", "origin/"} {
		if _, _, valid := splitRemoteTrackingBase(value); valid {
			t.Errorf("expected %q to be rejected", value)
		}
	}
}
