package runtimecore

import (
	"slices"
	"testing"
)

func TestRuntimeStatusAdvertisesSharedControl(t *testing.T) {
	manager, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Contains(manager.Status().Capabilities, CapabilitySharedControl) {
		t.Fatal("expected shared-control runtime capability")
	}
}

func TestLegacySharedControlIdentityAndDevicePersist(t *testing.T) {
	directory := t.TempDir()
	manager, err := NewManager(directory, nil)
	if err != nil {
		t.Fatal(err)
	}
	identity, err := manager.EnsureLegacySharedControlIdentity()
	if err != nil {
		t.Fatal(err)
	}
	pairing, err := manager.CreateLegacySharedControlPairing("Web client", "runtime", false)
	if err != nil {
		t.Fatal(err)
	}

	reloaded, err := NewManager(directory, nil)
	if err != nil {
		t.Fatal(err)
	}
	reloadedIdentity, err := reloaded.EnsureLegacySharedControlIdentity()
	if err != nil {
		t.Fatal(err)
	}
	if reloadedIdentity != identity {
		t.Fatal("expected stable E2EE identity after restart")
	}
	device, valid := reloaded.ValidateLegacySharedControlToken(pairing.DeviceToken)
	if !valid || device.DeviceID != pairing.DeviceID || device.Scope != "runtime" {
		t.Fatalf("unexpected persisted device: %#v", device)
	}
}

func TestLegacySharedControlPairingReusesAndRotatesPendingToken(t *testing.T) {
	manager, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	first, err := manager.CreateLegacySharedControlPairing("first", "mobile", false)
	if err != nil {
		t.Fatal(err)
	}
	reused, err := manager.CreateLegacySharedControlPairing("second", "mobile", false)
	if err != nil {
		t.Fatal(err)
	}
	if reused.DeviceToken != first.DeviceToken {
		t.Fatal("expected pending token reuse")
	}
	rotated, err := manager.CreateLegacySharedControlPairing("third", "mobile", true)
	if err != nil {
		t.Fatal(err)
	}
	if rotated.DeviceToken == first.DeviceToken {
		t.Fatal("expected token rotation")
	}
	if _, valid := manager.ValidateLegacySharedControlToken(first.DeviceToken); valid {
		t.Fatal("expected rotated pending token to be revoked")
	}
}
