package runtimehttp

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/nebutra/pebble/runtime/go/internal/runtimecore"
)

func TestLegacySharedControlEmulatorQueuesNativeActionAndWaits(t *testing.T) {
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	device, err := manager.RegisterEmulatorDevice(runtimecore.RegisterEmulatorDeviceRequest{
		Name: "Pixel", Platform: "android",
	})
	if err != nil {
		t.Fatal(err)
	}
	session, err := manager.AttachEmulator(runtimecore.AttachEmulatorRequest{DeviceID: device.ID})
	if err != nil {
		t.Fatal(err)
	}
	server := NewServer(manager)
	type outcome struct {
		result interface{}
		err    error
	}
	done := make(chan outcome, 1)
	go func() {
		result, handled, err := server.runLegacySharedControlEmulatorMethod(
			context.Background(),
			"emulator.tap",
			json.RawMessage(`{"device":"`+device.ID+`","x":0.25,"y":0.75}`),
		)
		if !handled && err == nil {
			err = errTestEmulatorMethodNotHandled
		}
		done <- outcome{result: result, err: err}
	}()

	var action runtimecore.ComputerAction
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		actions := manager.ListComputerActions(runtimecore.ComputerActionQueued, "emulator.tap")
		if len(actions) > 0 {
			action = actions[0]
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if action.ID == "" || action.Target != session.ID || action.Payload["deviceId"] != device.ID {
		t.Fatalf("unexpected queued action: %+v", action)
	}
	_, err = manager.UpdateComputerAction(action.ID, runtimecore.UpdateComputerActionRequest{
		Status: runtimecore.ComputerActionCompleted,
		Result: map[string]interface{}{"ok": true},
	})
	if err != nil {
		t.Fatal(err)
	}
	select {
	case result := <-done:
		if result.err != nil {
			t.Fatal(result.err)
		}
		if payload, ok := result.result.(map[string]interface{}); !ok || payload["ok"] != true {
			t.Fatalf("unexpected completion: %#v", result.result)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("emulator method did not return provider completion")
	}
}

func TestLegacySharedControlEmulatorListsAndRejectsInvalidExec(t *testing.T) {
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	server := NewServer(manager)
	result, handled, err := server.runLegacySharedControlEmulatorMethod(context.Background(), "emulator.listDevices", nil)
	if !handled || err != nil {
		t.Fatalf("list devices: handled=%v err=%v", handled, err)
	}
	if devices, ok := result.([]runtimecore.EmulatorDevice); !ok || len(devices) != 0 {
		t.Fatalf("unexpected devices: %#v", result)
	}
	if _, handled, err := server.runLegacySharedControlEmulatorMethod(context.Background(), "emulator.exec", json.RawMessage(`{"command":"id"}`)); !handled || err == nil {
		t.Fatalf("exec command strings must be rejected: handled=%v err=%v", handled, err)
	}
	if !legacySharedControlMobileMethodAllowed("emulator.tap") || !legacySharedControlMobileMethodAllowed("emulator.ax") || !legacySharedControlMobileMethodAllowed("emulator.exec") {
		t.Fatal("mobile emulator allowlist does not match native provider coverage")
	}
}

func TestLegacySharedControlEmulatorExecQueuesBoundedArgv(t *testing.T) {
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	device, err := manager.RegisterEmulatorDevice(runtimecore.RegisterEmulatorDeviceRequest{
		Name: "Pixel", Platform: "android",
	})
	if err != nil {
		t.Fatal(err)
	}
	session, err := manager.AttachEmulator(runtimecore.AttachEmulatorRequest{DeviceID: device.ID})
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() {
		_, handled, runErr := NewServer(manager).runLegacySharedControlEmulatorMethod(
			context.Background(),
			"emulator.exec",
			json.RawMessage(`{"device":"`+device.ID+`","argv":["printf","%s","one; argument"],"timeoutMs":2500}`),
		)
		if !handled && runErr == nil {
			runErr = errTestEmulatorMethodNotHandled
		}
		done <- runErr
	}()

	action := waitForQueuedEmulatorAction(t, manager, "emulator.exec")
	argv, ok := action.Payload["argv"].([]interface{})
	if !ok || len(argv) != 3 || argv[2] != "one; argument" {
		t.Fatalf("exec argv boundaries were not preserved: %#v", action.Payload["argv"])
	}
	if action.Target != session.ID || action.Payload["deviceId"] != device.ID || action.Payload["timeoutMs"] != 2500 {
		t.Fatalf("unexpected exec action payload: %+v", action)
	}
	_, err = manager.UpdateComputerAction(action.ID, runtimecore.UpdateComputerActionRequest{
		Status: runtimecore.ComputerActionCompleted,
		Result: map[string]interface{}{"stdout": "ok"},
	})
	if err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("exec method did not return provider completion")
	}
}

func TestLegacySharedControlEmulatorExecRejectsPayloadLimits(t *testing.T) {
	server := NewServer(nil)
	oversizedArg := strings.Repeat("x", legacyEmulatorExecMaxArgBytes+1)
	tests := []json.RawMessage{
		json.RawMessage(`{"argv":[]}`),
		json.RawMessage(`{"argv":["id"],"timeoutMs":99}`),
		json.RawMessage(`{"argv":["` + oversizedArg + `"]}`),
		json.RawMessage(`{"argv":["id"],"padding":"` + strings.Repeat("x", legacyEmulatorExecMaxPayloadBytes) + `"}`),
	}
	for _, raw := range tests {
		if _, handled, err := server.runLegacySharedControlEmulatorMethod(context.Background(), "emulator.exec", raw); !handled || err == nil {
			t.Fatalf("expected bounded exec rejection for %s: handled=%v err=%v", raw, handled, err)
		}
	}
}

func TestLegacySharedControlEmulatorAccessibilityQueuesNativeAction(t *testing.T) {
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	device, err := manager.RegisterEmulatorDevice(runtimecore.RegisterEmulatorDeviceRequest{
		Name: "Pixel", Platform: "android",
	})
	if err != nil {
		t.Fatal(err)
	}
	session, err := manager.AttachEmulator(runtimecore.AttachEmulatorRequest{DeviceID: device.ID})
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() {
		_, handled, err := NewServer(manager).runLegacySharedControlEmulatorMethod(
			context.Background(), "emulator.ax", json.RawMessage(`{"device":"`+device.ID+`"}`),
		)
		if !handled && err == nil {
			err = errTestEmulatorMethodNotHandled
		}
		done <- err
	}()

	action := waitForQueuedEmulatorAction(t, manager, "emulator.ax")
	if action.Target != session.ID || action.Payload["command"] != "ax" {
		t.Fatalf("unexpected accessibility action: %+v", action)
	}
	_, err = manager.UpdateComputerAction(action.ID, runtimecore.UpdateComputerActionRequest{
		Status: runtimecore.ComputerActionCompleted,
		Result: map[string]interface{}{"children": []interface{}{}},
	})
	if err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("accessibility method did not return provider completion")
	}
}

func waitForQueuedEmulatorAction(t *testing.T, manager *runtimecore.Manager, kind string) runtimecore.ComputerAction {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		actions := manager.ListComputerActions(runtimecore.ComputerActionQueued, kind)
		if len(actions) > 0 {
			return actions[0]
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for queued %s action", kind)
	return runtimecore.ComputerAction{}
}

func TestLegacySharedControlEmulatorWaitStopsWhenConnectionCloses(t *testing.T) {
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	device, err := manager.RegisterEmulatorDevice(runtimecore.RegisterEmulatorDeviceRequest{
		Name: "Pixel", Platform: "android",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.AttachEmulator(runtimecore.AttachEmulatorRequest{DeviceID: device.ID}); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	started := time.Now()
	_, handled, err := NewServer(manager).runLegacySharedControlEmulatorMethod(
		ctx, "emulator.tap", json.RawMessage(`{"device":"`+device.ID+`","x":0.25,"y":0.75}`),
	)
	if !handled || !errors.Is(err, context.Canceled) {
		t.Fatalf("expected canceled native action wait, handled=%v err=%v", handled, err)
	}
	if time.Since(started) > time.Second {
		t.Fatal("canceled emulator action wait did not return promptly")
	}
	action := manager.ListComputerActions(runtimecore.ComputerActionFailed, "emulator.tap")
	if len(action) != 1 || !strings.Contains(action[0].Error, "context canceled") {
		t.Fatalf("canceled request did not cancel its queued native action: %#v", action)
	}
}

var errTestEmulatorMethodNotHandled = &testEmulatorError{}

type testEmulatorError struct{}

func (*testEmulatorError) Error() string { return "emulator method was not handled" }
