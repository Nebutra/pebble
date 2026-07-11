package runtimecore

import "testing"

func TestRunSshExternalAutomationValidatesBeforeSsh(t *testing.T) {
	manager, _ := newSshTestManager(t)
	target, err := manager.CreateSshTarget(SshTargetInput{Label: "Remote", Host: "example.invalid"})
	if err != nil {
		t.Fatal(err)
	}
	_, err = manager.RunSshExternalAutomation(t.Context(), target.ID, SshExternalAutomationRequest{Version: 1, Operation: "shell", Provider: "hermes"})
	if err == nil || err.Error() != "unsupported external automation operation" {
		t.Fatalf("unexpected operation error: %v", err)
	}
	_, err = manager.RunSshExternalAutomation(t.Context(), target.ID, SshExternalAutomationRequest{Version: 1, Operation: "list", Provider: "unknown"})
	if err == nil || err.Error() != "unsupported external automation provider" {
		t.Fatalf("unexpected provider error: %v", err)
	}
}
