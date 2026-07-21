package runtimecore

import (
	"context"
	"runtime"
	"testing"
	"time"
)

func TestExecuteProviderTextGenerationPlanRunsArgvWithoutShell(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell fixture is Unix-only")
	}
	stdin := "native prompt"
	result := ExecuteProviderTextGenerationPlan(context.Background(), ProviderTextGenerationPlan{
		LaneKey: "commit:local:/tmp", Target: ProviderTextGenerationTarget{Kind: "local"},
		Cwd: t.TempDir(), Binary: "/bin/sh", Args: []string{"-c", "read value; printf 'generated:%s' \"$value\""}, StdinPayload: &stdin,
		TimeoutMs: 5_000, MaxOutput: 4096,
	})
	if result.SpawnError != nil || result.ExitCode == nil || *result.ExitCode != 0 || result.Stdout != "generated:native prompt" {
		t.Fatalf("unexpected result: %+v", result)
	}
}

func TestExecuteProviderTextGenerationPlanHonorsCancellation(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell fixture is Unix-only")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	started := time.Now()
	result := ExecuteProviderTextGenerationPlan(ctx, ProviderTextGenerationPlan{
		LaneKey: "commit:local:/tmp", Target: ProviderTextGenerationTarget{Kind: "local"},
		Cwd: t.TempDir(), Binary: "/bin/sh", Args: []string{"-c", "sleep 30"}, TimeoutMs: 60_000, MaxOutput: 4096,
	})
	if time.Since(started) > 2*time.Second || result.ExitCode == nil {
		t.Fatalf("cancellation did not stop process promptly: %+v", result)
	}
}

func TestExecuteProviderTextGenerationPlanRejectsRelativeCwd(t *testing.T) {
	result := ExecuteProviderTextGenerationPlan(context.Background(), ProviderTextGenerationPlan{
		LaneKey: "commit", Target: ProviderTextGenerationTarget{Kind: "local"}, Cwd: "relative", Binary: "agent",
	})
	if result.SpawnError == nil || *result.SpawnError != "invalid_request" {
		t.Fatalf("expected safe invalid request, got %+v", result)
	}
}
