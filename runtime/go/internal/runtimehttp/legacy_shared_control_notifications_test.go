package runtimehttp

import (
	"errors"
	"testing"

	"github.com/nebutra/pebble/runtime/go/internal/runtimecore"
)

func journaledTestNotifications(bodies ...string) []runtimecore.JournaledNotification {
	entries := make([]runtimecore.JournaledNotification, 0, len(bodies))
	for index, body := range bodies {
		entries = append(entries, runtimecore.JournaledNotification{
			NotificationEvent: runtimecore.NotificationEvent{
				Type: "notification", Title: "Pebble", Body: body,
			},
			Sequence: uint64(index + 1),
		})
	}
	return entries
}

func TestNotificationReplayAcknowledgesEveryDeliveredEntry(t *testing.T) {
	replay := runtimecore.NotificationReplay{Missed: journaledTestNotifications("one", "two"), Head: 2}
	var written []string
	var acknowledged []uint64
	deliverLegacySharedControlNotificationReplay(
		replay,
		func(entry runtimecore.JournaledNotification) error {
			written = append(written, entry.Body)
			return nil
		},
		func(sequence uint64) { acknowledged = append(acknowledged, sequence) },
	)
	if len(written) != 2 || written[0] != "one" || written[1] != "two" {
		t.Fatalf("unexpected writes: %v", written)
	}
	if len(acknowledged) != 2 || acknowledged[1] != 2 {
		t.Fatalf("unexpected acknowledgements: %v", acknowledged)
	}
}

func TestNotificationReplayStopsAcknowledgingAfterAFailedWrite(t *testing.T) {
	replay := runtimecore.NotificationReplay{Missed: journaledTestNotifications("one", "two", "three"), Head: 3}
	var acknowledged []uint64
	writes := 0
	deliverLegacySharedControlNotificationReplay(
		replay,
		func(runtimecore.JournaledNotification) error {
			writes++
			if writes == 2 {
				return errors.New("socket closed")
			}
			return nil
		},
		func(sequence uint64) { acknowledged = append(acknowledged, sequence) },
	)
	if writes != 2 {
		t.Fatalf("delivery continued past a dead socket: %d writes", writes)
	}
	if len(acknowledged) != 1 || acknowledged[0] != 1 {
		t.Fatalf("the watermark advanced past an undelivered notification: %v", acknowledged)
	}
}

func TestNotificationPayloadCarriesTheSequenceAndReplayFlag(t *testing.T) {
	entry := journaledTestNotifications("one")[0]
	replayed := legacySharedControlNotificationPayload(entry, true)
	if replayed["type"] != "notification" || replayed["sequence"] != uint64(1) || replayed["replayed"] != true {
		t.Fatalf("unexpected replayed payload: %#v", replayed)
	}
	if legacySharedControlNotificationPayload(entry, false)["replayed"] != false {
		t.Fatal("a live notification must not be marked as replayed")
	}
}

func TestNotificationSubscriptionMethodsAreReachableFromMobile(t *testing.T) {
	for _, method := range []string{"notifications.subscribe", "notifications.unsubscribe"} {
		if !legacySharedControlMobileMethodAllowed(method) {
			t.Fatalf("%s is not reachable from a paired phone", method)
		}
	}
}
