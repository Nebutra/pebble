package runtimecore

import "testing"

func TestPublishNotificationBroadcastsToMobileRelay(t *testing.T) {
	manager, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	id, events := manager.Subscribe(1)
	defer manager.Unsubscribe(id)
	event := NotificationEvent{
		Type: "notification", Source: "terminal-bell", Title: "Pebble", Body: "Build done",
	}
	if err := manager.PublishNotification(event); err != nil {
		t.Fatal(err)
	}
	published := <-events
	if published.Topic != "notification.dispatched" {
		t.Fatalf("unexpected topic %q", published.Topic)
	}
	projected, ok := manager.MobileRelayEvent(published, []ProjectionKind{ProjectionFiles})
	if !ok || projected.Topic != "notification.dispatched" {
		t.Fatal("notification was filtered by the mobile projection diet")
	}
}

func TestPublishNotificationRejectsMalformedEvents(t *testing.T) {
	manager, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if manager.PublishNotification(NotificationEvent{Type: "notification"}) == nil {
		t.Fatal("expected missing notification content to fail")
	}
	if manager.PublishNotification(NotificationEvent{Type: "dismiss"}) == nil {
		t.Fatal("expected missing dismiss id to fail")
	}
}
