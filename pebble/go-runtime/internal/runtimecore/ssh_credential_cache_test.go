package runtimecore

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func seedPassphraseTarget(t *testing.T, manager *Manager) SshTarget {
	t.Helper()
	created, err := manager.CreateSshTarget(SshTargetInput{Host: "cache.example", Username: "deploy"})
	if err != nil {
		t.Fatal(err)
	}
	required := true
	updated, err := manager.UpdateSshTarget(created.ID, SshTargetUpdate{LastRequiredPassphrase: &required})
	if err != nil {
		t.Fatal(err)
	}
	return updated
}

func TestSshCredentialCacheMissThenHit(t *testing.T) {
	manager, _ := newSshTestManager(t)
	target := seedPassphraseTarget(t, manager)

	status, err := manager.SshCredentialStatus(target.ID)
	if err != nil {
		t.Fatal(err)
	}
	if status.Cached || !status.PromptRequired {
		t.Fatalf("expected miss with prompt required, got %+v", status)
	}

	status, err = manager.SeedSshCredential(target.ID, SshCredentialKindPassphrase, "hunter2-passphrase")
	if err != nil {
		t.Fatal(err)
	}
	if !status.Cached || status.PromptRequired {
		t.Fatalf("expected hit without prompt after seed, got %+v", status)
	}

	passphrase, password, ok := manager.CachedSshCredential(target.ID)
	if !ok || passphrase != "hunter2-passphrase" || password != "" {
		t.Fatalf("unexpected cached credential ok=%v", ok)
	}
}

func TestSshCredentialCacheKeepsPassphraseAndPassword(t *testing.T) {
	manager, _ := newSshTestManager(t)
	target := seedPassphraseTarget(t, manager)

	if _, err := manager.SeedSshCredential(target.ID, SshCredentialKindPassphrase, "key-passphrase"); err != nil {
		t.Fatal(err)
	}
	if _, err := manager.SeedSshCredential(target.ID, SshCredentialKindPassword, "login-password"); err != nil {
		t.Fatal(err)
	}
	passphrase, password, ok := manager.CachedSshCredential(target.ID)
	if !ok || passphrase != "key-passphrase" || password != "login-password" {
		t.Fatal("expected both credential kinds to coexist like Electron's per-connection cache")
	}
}

func TestSshCredentialCacheNoPromptWhenNeverRequired(t *testing.T) {
	manager, _ := newSshTestManager(t)
	created, err := manager.CreateSshTarget(SshTargetInput{Host: "agent.example"})
	if err != nil {
		t.Fatal(err)
	}
	status, err := manager.SshCredentialStatus(created.ID)
	if err != nil {
		t.Fatal(err)
	}
	if status.Cached || status.PromptRequired {
		t.Fatalf("target without lastRequiredPassphrase must never prompt, got %+v", status)
	}
}

func TestSshCredentialCacheInvalidateOnAuthFailure(t *testing.T) {
	manager, _ := newSshTestManager(t)
	target := seedPassphraseTarget(t, manager)
	if _, err := manager.SeedSshCredential(target.ID, SshCredentialKindPassphrase, "stale-passphrase"); err != nil {
		t.Fatal(err)
	}

	// Explicit invalidation (desktop reports auth failure / disconnect).
	status := manager.ClearSshCredential(target.ID)
	if status.Cached || !status.PromptRequired {
		t.Fatalf("expected cleared credential to re-require prompt, got %+v", status)
	}
	if _, _, ok := manager.CachedSshCredential(target.ID); ok {
		t.Fatal("expected credential to be dropped after invalidation")
	}
	// Idempotent: clearing again must not error or resurrect anything.
	if status = manager.ClearSshCredential(target.ID); status.Cached {
		t.Fatalf("expected repeated clear to stay empty, got %+v", status)
	}
}

func TestSshCredentialCacheClearedOnTargetRemoval(t *testing.T) {
	manager, _ := newSshTestManager(t)
	target := seedPassphraseTarget(t, manager)
	if _, err := manager.SeedSshCredential(target.ID, SshCredentialKindPassword, "remove-me"); err != nil {
		t.Fatal(err)
	}
	if _, err := manager.DeleteSshTarget(target.ID); err != nil {
		t.Fatal(err)
	}
	if _, _, ok := manager.CachedSshCredential(target.ID); ok {
		t.Fatal("expected credential to be purged with its target")
	}
	if _, err := manager.SshCredentialStatus(target.ID); err != ErrNotFound {
		t.Fatalf("expected ErrNotFound after removal, got %v", err)
	}
}

func TestSshCredentialCacheUnknownTarget(t *testing.T) {
	manager, _ := newSshTestManager(t)
	if _, err := manager.SeedSshCredential("ssh-missing", SshCredentialKindPassphrase, "x"); err != ErrNotFound {
		t.Fatalf("expected ErrNotFound seeding unknown target, got %v", err)
	}
	if _, err := manager.SshCredentialStatus("ssh-missing"); err != ErrNotFound {
		t.Fatalf("expected ErrNotFound reading unknown target, got %v", err)
	}
}

// TestSshCredentialNeverPersisted is the security gate from the migration
// contract: a seeded passphrase must never appear in the on-disk state file,
// even across saves and a fresh Manager load.
func TestSshCredentialNeverPersisted(t *testing.T) {
	manager, dir := newSshTestManager(t)
	target := seedPassphraseTarget(t, manager)
	const secret = "super-secret-passphrase-XYZZY"
	if _, err := manager.SeedSshCredential(target.ID, SshCredentialKindPassphrase, secret); err != nil {
		t.Fatal(err)
	}
	// Force state writes after the seed so any accidental serialization of the
	// cache would land on disk.
	label := "renamed"
	if _, err := manager.UpdateSshTarget(target.ID, SshTargetUpdate{Label: &label}); err != nil {
		t.Fatal(err)
	}

	err := filepath.Walk(dir, func(path string, info os.FileInfo, walkErr error) error {
		if walkErr != nil || info.IsDir() {
			return walkErr
		}
		data, readErr := os.ReadFile(path)
		if readErr != nil {
			return readErr
		}
		if strings.Contains(string(data), secret) {
			t.Fatalf("state file %s contains the seeded passphrase", path)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}

	// A fresh process never sees the credential: memory-only lifetime.
	reloaded, err := NewManager(dir, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, ok := reloaded.CachedSshCredential(target.ID); ok {
		t.Fatal("expected credential cache to be empty after restart")
	}
}
