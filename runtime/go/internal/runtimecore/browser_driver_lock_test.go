package runtimecore

import "testing"

func TestBrowserDriverLifecycleAndOwnership(t *testing.T) {
	manager, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	tab, err := manager.CreateBrowserTab(CreateBrowserTabRequest{URL: "https://example.com"})
	if err != nil {
		t.Fatal(err)
	}
	manager.MobileTookBrowserFloor(tab.ID, "phone-1")
	if driver := manager.GetBrowserDriver(tab.ID); driver.Kind != "mobile" || driver.ClientID != "phone-1" {
		t.Fatalf("unexpected mobile driver: %+v", driver)
	}
	manager.ReleaseMobileBrowserFloor(tab.ID, "stale-phone")
	if driver := manager.GetBrowserDriver(tab.ID); driver.Kind != "mobile" {
		t.Fatalf("stale client released active driver: %+v", driver)
	}
	reclaimed, err := manager.ReclaimBrowserForDesktop(tab.ID)
	if err != nil || !reclaimed {
		t.Fatalf("reclaim = %v, %v", reclaimed, err)
	}
	manager.ReleaseMobileBrowserFloor(tab.ID, "phone-1")
	if driver := manager.GetBrowserDriver(tab.ID); driver.Kind != "desktop" {
		t.Fatalf("old stream overwrote desktop reclaim: %+v", driver)
	}
}

func TestBrowserDriverEmitsNativeRuntimeEvents(t *testing.T) {
	manager, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	tab, err := manager.CreateBrowserTab(CreateBrowserTabRequest{URL: "https://example.com"})
	if err != nil {
		t.Fatal(err)
	}
	_, events := manager.Subscribe(4)
	manager.MobileTookBrowserFloor(tab.ID, "phone-1")
	event := <-events
	if event.Topic != "browser.driver" {
		t.Fatalf("topic = %q", event.Topic)
	}
}
