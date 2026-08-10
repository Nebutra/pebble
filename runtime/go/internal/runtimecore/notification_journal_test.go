package runtimecore

import "testing"

func publishTestNotification(t *testing.T, manager *Manager, body string) {
	t.Helper()
	err := manager.PublishNotification(NotificationEvent{
		Type: "notification", Source: "terminal-bell", Title: "Pebble", Body: body,
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestPublishNotificationCarriesASequence(t *testing.T) {
	manager, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	id, events := manager.Subscribe(2)
	defer manager.Unsubscribe(id)
	publishTestNotification(t, manager, "first")
	publishTestNotification(t, manager, "second")
	for _, want := range []uint64{1, 2} {
		entry, ok := (<-events).Payload.(JournaledNotification)
		if !ok || entry.Sequence != want {
			t.Fatalf("expected sequence %d, got %#v", want, entry)
		}
	}
}

func TestNotificationReplayStartsLiveForAnUnknownDevice(t *testing.T) {
	manager, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	publishTestNotification(t, manager, "before the phone ever paired")
	replay := manager.NotificationReplayFor("device-new", nil)
	if len(replay.Missed) != 0 || replay.Truncated || replay.Head != 1 {
		t.Fatalf("a never-seen device should start live: %#v", replay)
	}
	publishTestNotification(t, manager, "after pairing")
	resumed := manager.NotificationReplayFor("device-new", nil)
	if len(resumed.Missed) != 1 || resumed.Missed[0].Body != "after pairing" {
		t.Fatalf("the device should now be owed what followed: %#v", resumed)
	}
}

func TestNotificationReplayReturnsWhatTheDeviceMissedWhileDisconnected(t *testing.T) {
	manager, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	manager.NotificationReplayFor("device-a", nil)
	publishTestNotification(t, manager, "missed one")
	publishTestNotification(t, manager, "missed two")
	replay := manager.NotificationReplayFor("device-a", nil)
	if len(replay.Missed) != 2 || replay.Missed[0].Body != "missed one" || replay.Missed[1].Body != "missed two" {
		t.Fatalf("unexpected replay: %#v", replay)
	}
	if replay.Head != 2 || replay.Truncated {
		t.Fatalf("unexpected replay bounds: %#v", replay)
	}
}

func TestNotificationWatermarkDoesNotAdvancePastUndeliveredEntries(t *testing.T) {
	manager, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	manager.NotificationReplayFor("device-a", nil)
	for _, body := range []string{"one", "two", "three"} {
		publishTestNotification(t, manager, body)
	}
	// Only the first replayed entry reached the device before the socket died.
	manager.AckNotificationDelivery("device-a", 1)
	replay := manager.NotificationReplayFor("device-a", nil)
	if len(replay.Missed) != 2 || replay.Missed[0].Body != "two" || replay.Missed[1].Body != "three" {
		t.Fatalf("undelivered notifications were skipped: %#v", replay)
	}
}

func TestNotificationWatermarkOnlyMovesForward(t *testing.T) {
	manager, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	manager.NotificationReplayFor("device-a", nil)
	for _, body := range []string{"one", "two"} {
		publishTestNotification(t, manager, body)
	}
	manager.AckNotificationDelivery("device-a", 2)
	manager.AckNotificationDelivery("device-a", 1)
	if replay := manager.NotificationReplayFor("device-a", nil); len(replay.Missed) != 0 {
		t.Fatalf("a late acknowledgement rewound the watermark: %#v", replay)
	}
}

func TestNotificationReplayHonoursAClientSuppliedWatermark(t *testing.T) {
	manager, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, body := range []string{"one", "two", "three"} {
		publishTestNotification(t, manager, body)
	}
	since := uint64(2)
	replay := manager.NotificationReplayFor("device-a", &since)
	if len(replay.Missed) != 1 || replay.Missed[0].Body != "three" {
		t.Fatalf("client watermark was ignored: %#v", replay)
	}
}

func TestNotificationReplayReportsTruncationWhenTheJournalRolledOver(t *testing.T) {
	manager, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	manager.NotificationReplayFor("device-a", nil)
	for index := 0; index <= notificationJournalCapacity; index++ {
		publishTestNotification(t, manager, "flood")
	}
	replay := manager.NotificationReplayFor("device-a", nil)
	if !replay.Truncated {
		t.Fatal("a device behind the retained window must be told its replay is incomplete")
	}
	if len(replay.Missed) != notificationJournalCapacity {
		t.Fatalf("expected the retained window, got %d entries", len(replay.Missed))
	}
}

func TestRevokingADeviceForgetsItsWatermark(t *testing.T) {
	manager, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	device, err := manager.CreateLegacySharedControlPairing("Phone", "mobile", false)
	if err != nil {
		t.Fatal(err)
	}
	manager.NotificationReplayFor(device.DeviceID, nil)
	publishTestNotification(t, manager, "owed")
	if !manager.RevokeLegacySharedControlDevice(device.DeviceID) {
		t.Fatal("expected the device to be revoked")
	}
	if replay := manager.NotificationReplayFor(device.DeviceID, nil); len(replay.Missed) != 0 {
		t.Fatalf("a revoked device kept its backlog: %#v", replay)
	}
}
