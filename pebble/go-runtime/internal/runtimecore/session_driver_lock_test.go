package runtimecore

import (
	"context"
	"errors"
	"testing"
)

func newDriverLockTestManager(t *testing.T) *Manager {
	t.Helper()
	manager, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	return manager
}

func startDriverLockTestSession(t *testing.T, manager *Manager) Session {
	t.Helper()
	project, err := manager.CreateProject(CreateProjectRequest{Name: "repo", Path: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	session, err := manager.StartSession(context.Background(), StartSessionRequest{
		ProjectID: project.ID,
		Command:   testSleepCommand(),
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = manager.StopSession(session.ID) })
	return session
}

func TestMobileInputTakesFloorAndLocksDesktop(t *testing.T) {
	manager := newDriverLockTestManager(t)
	session := startDriverLockTestSession(t, manager)

	if driver := manager.GetSessionDriver(session.ID); driver.Kind != "idle" {
		t.Fatalf("expected idle driver before input, got %+v", driver)
	}
	if err := manager.WriteSessionFromClient(session.ID, SessionInputRequest{Text: "ls\n"}, SessionInputSourceMobile, "device-1"); err != nil {
		t.Fatal(err)
	}
	driver := manager.GetSessionDriver(session.ID)
	if driver.Kind != "mobile" || driver.ClientID != "device-1" {
		t.Fatalf("expected mobile driver for device-1, got %+v", driver)
	}
	err := manager.WriteSessionFromClient(session.ID, SessionInputRequest{Text: "x"}, SessionInputSourceDesktop, "")
	if !errors.Is(err, ErrSessionInputLocked) {
		t.Fatalf("expected desktop write to be locked, got %v", err)
	}
	// Legacy sourceless writes keep working (pre-refactor mobile builds).
	if err := manager.WriteSessionFromClient(session.ID, SessionInputRequest{Text: "y"}, "", ""); err != nil {
		t.Fatalf("legacy sourceless write must stay accepted: %v", err)
	}
	if manager.SessionResizeAllowedFor(session.ID, SessionInputSourceDesktop) {
		t.Fatal("desktop resize must be gated while mobile drives")
	}
	if !manager.SessionResizeAllowedFor(session.ID, SessionInputSourceMobile) {
		t.Fatal("mobile resize must stay allowed while mobile drives")
	}
}

func TestReclaimSessionForDesktopReleasesLock(t *testing.T) {
	manager := newDriverLockTestManager(t)
	session := startDriverLockTestSession(t, manager)

	manager.MobileTookSessionFloor(session.ID, "device-1")
	if !manager.ReclaimSessionForDesktop(session.ID) {
		t.Fatal("reclaim while mobile drives must report reclaimed=true")
	}
	if driver := manager.GetSessionDriver(session.ID); driver.Kind != "desktop" {
		t.Fatalf("expected desktop driver after reclaim, got %+v", driver)
	}
	if err := manager.WriteSessionFromClient(session.ID, SessionInputRequest{Text: "z"}, SessionInputSourceDesktop, ""); err != nil {
		t.Fatalf("desktop write must be accepted after reclaim: %v", err)
	}
	// Idempotent: reclaim without a mobile lock reports false.
	if manager.ReclaimSessionForDesktop(session.ID) {
		t.Fatal("second reclaim must report reclaimed=false")
	}
}

func TestSessionDriverTransitionsEmitEvents(t *testing.T) {
	manager := newDriverLockTestManager(t)
	_, events := manager.Subscribe(16)
	manager.MobileTookSessionFloor("sess-x", "device-1")
	// Most-recent-actor wins.
	manager.MobileTookSessionFloor("sess-x", "device-2")
	// Same driver again must not re-emit.
	manager.MobileTookSessionFloor("sess-x", "device-2")
	manager.ReclaimSessionForDesktop("sess-x")

	var drivers []SessionDriverState
	for len(drivers) < 3 {
		select {
		case event := <-events:
			if event.Topic != "session.driver" {
				continue
			}
			payload := event.Payload.(map[string]interface{})
			drivers = append(drivers, payload["driver"].(SessionDriverState))
		default:
			t.Fatalf("expected 3 driver events, got %d", len(drivers))
		}
	}
	if drivers[0].ClientID != "device-1" || drivers[1].ClientID != "device-2" {
		t.Fatalf("unexpected driver sequence: %+v", drivers)
	}
	if drivers[2].Kind != "desktop" {
		t.Fatalf("expected desktop driver last, got %+v", drivers[2])
	}
	select {
	case event := <-events:
		if event.Topic == "session.driver" {
			t.Fatalf("unexpected extra driver event: %+v", event.Payload)
		}
	default:
	}
}
