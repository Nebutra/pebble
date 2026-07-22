package runtimeauth

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestPublishDiscoverAndOwnedCleanup(t *testing.T) {
	directory := t.TempDir()
	cleanup, err := Publish(directory, "http://127.0.0.1:17777", "secret-token")
	if err != nil {
		t.Fatal(err)
	}
	credential, err := Discover(directory)
	if err != nil {
		t.Fatal(err)
	}
	if credential.PID != os.Getpid() || credential.Token != "secret-token" || credential.Endpoint != "http://127.0.0.1:17777" {
		t.Fatalf("unexpected credential: %+v", credential)
	}
	if runtime.GOOS != "windows" {
		info, err := os.Stat(filepath.Join(directory, credentialFileName))
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm() != 0o600 {
			t.Fatalf("credential mode = %o", info.Mode().Perm())
		}
	}
	cleanup()
	if _, err := os.Stat(filepath.Join(directory, credentialFileName)); !os.IsNotExist(err) {
		t.Fatalf("credential survived cleanup: %v", err)
	}
}

func TestCleanupDoesNotRemoveNewerOwner(t *testing.T) {
	directory := t.TempDir()
	cleanup, err := Publish(directory, "http://127.0.0.1:17777", "first-token")
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(directory, credentialFileName)
	replacement := Credential{SchemaVersion: credentialSchema, PID: os.Getpid(), Endpoint: "http://127.0.0.1:17777", Token: "second-token"}
	content, _ := json.Marshal(replacement)
	if err := os.WriteFile(path, content, 0o600); err != nil {
		t.Fatal(err)
	}
	cleanup()
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("newer credential was removed: %v", err)
	}
}

func TestPublishReplacesExistingCredential(t *testing.T) {
	directory := t.TempDir()
	firstCleanup, err := Publish(directory, "http://127.0.0.1:17777", "first-token")
	if err != nil {
		t.Fatal(err)
	}
	secondCleanup, err := Publish(directory, "http://127.0.0.1:18888", "second-token")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(secondCleanup)

	firstCleanup()
	credential, err := Discover(directory)
	if err != nil {
		t.Fatal(err)
	}
	if credential.Endpoint != "http://127.0.0.1:18888" || credential.Token != "second-token" {
		t.Fatalf("unexpected replacement credential: %+v", credential)
	}
}

func TestPublishRejectsNonLoopbackEndpoint(t *testing.T) {
	cleanup, err := Publish(t.TempDir(), "http://192.0.2.1:17777", "secret-token")
	if err == nil {
		cleanup()
		t.Fatal("Publish accepted a non-loopback endpoint")
	}
}

func TestEndpointForListenUsesLoopbackForWildcard(t *testing.T) {
	endpoint, err := EndpointForListen("0.0.0.0:6768")
	if err != nil || endpoint != "http://127.0.0.1:6768" {
		t.Fatalf("endpoint=%q err=%v", endpoint, err)
	}
}
