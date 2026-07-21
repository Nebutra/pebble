package runtimecore

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func newSshTestManager(t *testing.T) (*Manager, string) {
	t.Helper()
	dir := t.TempDir()
	manager, err := NewManager(dir, nil)
	if err != nil {
		t.Fatal(err)
	}
	return manager, dir
}

func TestSshTargetCreateDefaultsAndPersistence(t *testing.T) {
	manager, dir := newSshTestManager(t)
	created, err := manager.CreateSshTarget(SshTargetInput{Label: "  ", Host: "example.com", Username: "deploy"})
	if err != nil {
		t.Fatal(err)
	}
	if created.Port != 22 {
		t.Fatalf("expected default port 22, got %d", created.Port)
	}
	if created.Source != "manual" {
		t.Fatalf("expected default source manual, got %q", created.Source)
	}
	if created.Label != "example.com" {
		t.Fatalf("expected label to fall back to host, got %q", created.Label)
	}
	if created.ConfigHost != "example.com" {
		t.Fatalf("expected configHost to fall back to host, got %q", created.ConfigHost)
	}

	reloaded, err := NewManager(dir, nil)
	if err != nil {
		t.Fatal(err)
	}
	targets := reloaded.ListSshTargets()
	if len(targets) != 1 || targets[0].ID != created.ID {
		t.Fatalf("expected persisted target %s, got %+v", created.ID, targets)
	}
}

func TestSshTargetRequiresHost(t *testing.T) {
	manager, _ := newSshTestManager(t)
	if _, err := manager.CreateSshTarget(SshTargetInput{Label: "no host"}); err == nil {
		t.Fatal("expected error when host is missing")
	}
}

func TestSshTargetUpdateIsSparse(t *testing.T) {
	manager, _ := newSshTestManager(t)
	created, err := manager.CreateSshTarget(SshTargetInput{Host: "a.example", Username: "root", Port: 2200})
	if err != nil {
		t.Fatal(err)
	}
	newLabel := "renamed"
	updated, err := manager.UpdateSshTarget(created.ID, SshTargetUpdate{Label: &newLabel})
	if err != nil {
		t.Fatal(err)
	}
	if updated.Label != "renamed" {
		t.Fatalf("expected label to update, got %q", updated.Label)
	}
	if updated.Port != 2200 {
		t.Fatalf("expected omitted port to be preserved, got %d", updated.Port)
	}
	if updated.Username != "root" {
		t.Fatalf("expected omitted username to be preserved, got %q", updated.Username)
	}
}

func TestSshTargetDeleteRemoves(t *testing.T) {
	manager, _ := newSshTestManager(t)
	created, err := manager.CreateSshTarget(SshTargetInput{Host: "gone.example"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.DeleteSshTarget(created.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := manager.DeleteSshTarget(created.ID); err == nil {
		t.Fatal("expected ErrNotFound on second delete")
	}
	if len(manager.ListSshTargets()) != 0 {
		t.Fatalf("expected empty list after delete")
	}
}

func TestSshTargetDeleteStopsOwnedSessionsAndPreservesOtherHosts(t *testing.T) {
	manager, _ := newSshTestManager(t)
	removedTarget, _ := manager.CreateSshTarget(SshTargetInput{Host: "removed.example"})
	preservedTarget, _ := manager.CreateSshTarget(SshTargetInput{Host: "preserved.example"})
	removedProject, _ := manager.CreateProject(CreateProjectRequest{
		Name: "removed", Path: "/srv/removed", LocationKind: "ssh", HostID: removedTarget.ID,
	})
	preservedProject, _ := manager.CreateProject(CreateProjectRequest{
		Name: "preserved", Path: "/srv/preserved", LocationKind: "ssh", HostID: preservedTarget.ID,
	})
	now := time.Now().UTC()
	manager.mu.Lock()
	manager.sessions["removed-session"] = &processSession{
		id: "removed-session", projectID: removedProject.ID, status: SessionRunning,
		startedAt: now, updatedAt: now, stateChanged: make(chan struct{}),
	}
	manager.sessions["preserved-session"] = &processSession{
		id: "preserved-session", projectID: preservedProject.ID, status: SessionRunning,
		startedAt: now, updatedAt: now, stateChanged: make(chan struct{}),
	}
	manager.mu.Unlock()
	manager.cacheSshRelayWorker(removedTarget.ID, sshRelayWorkerDeployment{
		connectionKey: sshRelayConnectionKey(removedTarget),
		platform:      relayPlatform{goos: "linux", goarch: "amd64"},
		path:          remoteRelayWorkerPath,
	})

	if _, err := manager.DeleteSshTarget(removedTarget.ID); err != nil {
		t.Fatal(err)
	}
	if manager.sessions["removed-session"].status != SessionStopped {
		t.Fatal("deleting an SSH target left its session running")
	}
	if manager.sessions["preserved-session"].status != SessionRunning {
		t.Fatal("deleting an SSH target stopped another host's session")
	}
	if _, ok := manager.GetSshTarget(preservedTarget.ID); !ok {
		t.Fatal("deleting an SSH target removed another host")
	}
	if _, ok := manager.cachedSshRelayWorker(removedTarget.ID, removedTarget); ok {
		t.Fatal("deleting an SSH target retained its relay deployment cache")
	}
}

func TestSshTargetDeleteRetainsTargetWhenSessionTerminationFails(t *testing.T) {
	manager, _ := newSshTestManager(t)
	target, _ := manager.CreateSshTarget(SshTargetInput{Host: "retry.example"})
	project, _ := manager.CreateProject(CreateProjectRequest{
		Name: "retry", Path: "/srv/retry", LocationKind: "ssh", HostID: target.ID,
	})
	now := time.Now().UTC()
	session := &processSession{
		id: "retry-session", projectID: project.ID, status: SessionRunning,
		startedAt: now, updatedAt: now, stateChanged: make(chan struct{}),
		killProcess: func() error { return errors.New("kill failed") },
	}
	manager.mu.Lock()
	manager.sessions[session.id] = session
	manager.mu.Unlock()

	if _, err := manager.DeleteSshTarget(target.ID); err == nil {
		t.Fatal("expected deletion to fail while its SSH session is still live")
	}
	if _, ok := manager.GetSshTarget(target.ID); !ok {
		t.Fatal("failed SSH cleanup deleted target metadata")
	}
	if session.snapshot().Status != SessionRunning {
		t.Fatal("failed process kill was published as a stopped session")
	}

	session.mu.Lock()
	session.killProcess = nil
	session.mu.Unlock()
	if _, err := manager.DeleteSshTarget(target.ID); err != nil {
		t.Fatalf("retry after recoverable SSH cleanup failure: %v", err)
	}
}

func TestSshTargetListHidesRuntimeOwned(t *testing.T) {
	manager, _ := newSshTestManager(t)
	if _, err := manager.CreateSshTarget(SshTargetInput{
		Host:  "owned.example",
		Owner: map[string]interface{}{"type": "on-demand-runtime", "runtimeId": "vm-1"},
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := manager.CreateSshTarget(SshTargetInput{Host: "visible.example"}); err != nil {
		t.Fatal(err)
	}
	targets := manager.ListSshTargets()
	if len(targets) != 1 || targets[0].Host != "visible.example" {
		t.Fatalf("expected runtime-owned target hidden, got %+v", targets)
	}
}

// writeFakeSsh writes a fake ssh binary that exits with the given code and
// prints the given stderr, so the probe can be tested without a real host.
func writeFakeSsh(t *testing.T, exitCode int, stderr string) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("fake ssh fixture uses a POSIX shell script")
	}
	dir := t.TempDir()
	path := filepath.Join(dir, "ssh")
	script := "#!/bin/sh\n"
	if stderr != "" {
		script += "echo " + shellQuote(stderr) + " 1>&2\n"
	}
	script += "exit " + itoa(exitCode) + "\n"
	if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestSshTargetProbeSuccess(t *testing.T) {
	manager, _ := newSshTestManager(t)
	created, err := manager.CreateSshTarget(SshTargetInput{Host: "reachable.example", Username: "deploy"})
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("PEBBLE_SYSTEM_SSH_PATH", writeFakeSsh(t, 0, ""))
	result, err := manager.ProbeSshTarget(context.Background(), created.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !result.Success || result.Status != "connected" {
		t.Fatalf("expected connected success, got %+v", result)
	}
}

func TestSshTargetProbeAuthFailure(t *testing.T) {
	manager, _ := newSshTestManager(t)
	created, err := manager.CreateSshTarget(SshTargetInput{Host: "locked.example", Username: "deploy"})
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("PEBBLE_SYSTEM_SSH_PATH", writeFakeSsh(t, 255, "deploy@locked.example: Permission denied (publickey)."))
	result, err := manager.ProbeSshTarget(context.Background(), created.ID)
	if err != nil {
		t.Fatal(err)
	}
	if result.Success {
		t.Fatalf("expected probe failure, got %+v", result)
	}
	if result.Status != "auth-failed" {
		t.Fatalf("expected auth-failed status, got %q", result.Status)
	}
	if !strings.Contains(result.Error, "Permission denied") {
		t.Fatalf("expected error detail forwarded, got %q", result.Error)
	}
}

func TestSshTargetProbeUsesCachedCredentialThroughAskpass(t *testing.T) {
	manager, _ := newSshTestManager(t)
	created, err := manager.CreateSshTarget(SshTargetInput{
		Host: "locked.example", Username: "deploy", IdentityFile: "/keys/id_ed25519",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.SeedSshCredential(created.ID, SshCredentialKindPassphrase, "not-in-argv"); err != nil {
		t.Fatal(err)
	}
	capture := t.TempDir()
	t.Setenv("PEBBLE_SYSTEM_SSH_PATH", writeCapturingSsh(t, capture))
	result, err := manager.ProbeSshTarget(context.Background(), created.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !result.Success {
		t.Fatalf("credential probe failed: %+v", result)
	}
	args, _ := os.ReadFile(filepath.Join(capture, "args"))
	if strings.Contains(string(args), "not-in-argv") {
		t.Fatal("credential leaked into probe argv")
	}
	if !strings.Contains(string(args), "BatchMode=no") ||
		!strings.Contains(string(args), "PasswordAuthentication=yes") ||
		!strings.Contains(string(args), "NumberOfPasswordPrompts=1") {
		t.Fatalf("probe did not enable one askpass attempt: %s", args)
	}
	secret, _ := os.ReadFile(filepath.Join(capture, "secret"))
	if string(secret) != "not-in-argv" {
		t.Fatal("probe did not receive cached credential through its environment")
	}
}

func TestSshTargetProbeMissingBinary(t *testing.T) {
	manager, _ := newSshTestManager(t)
	created, err := manager.CreateSshTarget(SshTargetInput{Host: "x.example"})
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("PEBBLE_SYSTEM_SSH_PATH", filepath.Join(t.TempDir(), "does-not-exist"))
	result, err := manager.ProbeSshTarget(context.Background(), created.ID)
	if err != nil {
		t.Fatal(err)
	}
	if result.Success {
		t.Fatalf("expected failure when ssh cannot execute, got %+v", result)
	}
}

func TestSshTargetProbeUnknownTarget(t *testing.T) {
	manager, _ := newSshTestManager(t)
	if _, err := manager.ProbeSshTarget(context.Background(), "missing"); err != ErrNotFound {
		t.Fatalf("expected ErrNotFound, got %v", err)
	}
}

func TestImportSshTargetsFromConfig(t *testing.T) {
	manager, _ := newSshTestManager(t)
	home := t.TempDir()
	t.Setenv("HOME", home)
	if runtime.GOOS == "windows" {
		t.Setenv("USERPROFILE", home)
	}
	sshDir := filepath.Join(home, ".ssh")
	if err := os.MkdirAll(sshDir, 0o700); err != nil {
		t.Fatal(err)
	}
	config := "Host prod\n  HostName prod.internal\n  User deploy\n  Port 2222\n  IdentityFile ~/.ssh/id_prod\n\nHost *\n  ForwardAgent yes\n"
	if err := os.WriteFile(filepath.Join(sshDir, "config"), []byte(config), 0o600); err != nil {
		t.Fatal(err)
	}

	changed, err := manager.ImportSshTargetsFromConfig()
	if err != nil {
		t.Fatal(err)
	}
	if len(changed) != 1 {
		t.Fatalf("expected 1 imported target (wildcard skipped), got %d: %+v", len(changed), changed)
	}
	imported := changed[0]
	if imported.Host != "prod.internal" || imported.Port != 2222 || imported.Username != "deploy" {
		t.Fatalf("unexpected imported fields: %+v", imported)
	}
	if imported.Source != "ssh-config" {
		t.Fatalf("expected source ssh-config, got %q", imported.Source)
	}
	if !strings.HasPrefix(imported.IdentityFile, home) {
		t.Fatalf("expected identity file home-expanded, got %q", imported.IdentityFile)
	}

	// Re-import is a no-op when nothing changed.
	again, err := manager.ImportSshTargetsFromConfig()
	if err != nil {
		t.Fatal(err)
	}
	if len(again) != 0 {
		t.Fatalf("expected repeat import to be a no-op, got %+v", again)
	}
}

func TestImportSshTargetsPreservesManual(t *testing.T) {
	manager, _ := newSshTestManager(t)
	home := t.TempDir()
	t.Setenv("HOME", home)
	if runtime.GOOS == "windows" {
		t.Setenv("USERPROFILE", home)
	}
	// A manual target owns the alias "prod"; import must not overwrite it.
	manual, err := manager.CreateSshTarget(SshTargetInput{Label: "prod", ConfigHost: "prod", Host: "manual.host", Username: "me"})
	if err != nil {
		t.Fatal(err)
	}
	sshDir := filepath.Join(home, ".ssh")
	if err := os.MkdirAll(sshDir, 0o700); err != nil {
		t.Fatal(err)
	}
	config := "Host prod\n  HostName config.host\n  User other\n"
	if err := os.WriteFile(filepath.Join(sshDir, "config"), []byte(config), 0o600); err != nil {
		t.Fatal(err)
	}
	changed, err := manager.ImportSshTargetsFromConfig()
	if err != nil {
		t.Fatal(err)
	}
	if len(changed) != 0 {
		t.Fatalf("expected manual target to block import, got %+v", changed)
	}
	current, _ := manager.GetSshTarget(manual.ID)
	if current.Host != "manual.host" {
		t.Fatalf("manual target was clobbered: %+v", current)
	}
}

func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", `'"'"'`) + "'"
}

func itoa(value int) string {
	if value == 0 {
		return "0"
	}
	negative := value < 0
	if negative {
		value = -value
	}
	var digits []byte
	for value > 0 {
		digits = append([]byte{byte('0' + value%10)}, digits...)
		value /= 10
	}
	if negative {
		digits = append([]byte{'-'}, digits...)
	}
	return string(digits)
}
