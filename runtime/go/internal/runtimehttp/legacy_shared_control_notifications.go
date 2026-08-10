package runtimehttp

import (
	"encoding/json"

	"github.com/nebutra/pebble/runtime/go/internal/runtimecore"
)

func (s *Server) startLegacySharedControlNotifications(
	conn *websocketConn,
	sharedKey *[32]byte,
	device runtimecore.LegacySharedControlDevice,
	request legacySharedControlRequest,
	subscriptions map[string]legacySharedControlSubscription,
) {
	var params struct {
		Since *uint64 `json:"since"`
	}
	if len(request.Params) > 0 && json.Unmarshal(request.Params, &params) != nil {
		s.writeLegacySharedControlError(conn, sharedKey, request.ID, "bad_request", "Invalid since")
		return
	}
	subscriptionID := "notifications-" + request.ID
	subscriptions[subscriptionID] = legacySharedControlSubscription{
		RequestID:      request.ID,
		SubscriptionID: subscriptionID,
		Kind:           "notifications",
		DeviceID:       device.DeviceID,
	}
	replay := s.manager.NotificationReplayFor(device.DeviceID, params.Since)
	_ = s.writeLegacySharedControlSuccess(conn, sharedKey, request.ID, map[string]interface{}{
		"type":           "ready",
		"subscriptionId": subscriptionID,
		"head":           replay.Head,
		"truncated":      replay.Truncated,
	}, true)
	deliverLegacySharedControlNotificationReplay(
		replay,
		func(entry runtimecore.JournaledNotification) error {
			return s.writeLegacySharedControlSuccess(
				conn, sharedKey, request.ID, legacySharedControlNotificationPayload(entry, true), true,
			)
		},
		func(sequence uint64) { s.manager.AckNotificationDelivery(device.DeviceID, sequence) },
	)
}

// Why: the watermark may only advance for a notification the socket actually
// took, so the backlog is written and acknowledged one entry at a time — a
// failed write leaves that entry and everything after it owed to the next
// reconnect instead of being marked delivered in bulk.
func deliverLegacySharedControlNotificationReplay(
	replay runtimecore.NotificationReplay,
	write func(entry runtimecore.JournaledNotification) error,
	acknowledge func(sequence uint64),
) {
	for _, entry := range replay.Missed {
		if write(entry) != nil {
			return
		}
		acknowledge(entry.Sequence)
	}
}

// Delivery is at-least-once: a notification published between the journal read
// and the first live event arrives on both paths, and the sequence is what lets
// the device drop the duplicate.
func legacySharedControlNotificationPayload(
	entry runtimecore.JournaledNotification,
	replayed bool,
) map[string]interface{} {
	return map[string]interface{}{
		"type":         "notification",
		"sequence":     entry.Sequence,
		"replayed":     replayed,
		"notification": entry,
	}
}

func (s *Server) writeLegacySharedControlNotificationEvent(
	conn *websocketConn,
	sharedKey *[32]byte,
	subscription legacySharedControlSubscription,
	event runtimecore.RuntimeEvent,
) {
	if event.Topic != "notification.dispatched" {
		return
	}
	entry, ok := event.Payload.(runtimecore.JournaledNotification)
	if !ok {
		return
	}
	// A live event lost to a full subscriber channel or a half-open socket has to
	// stay owed, so the watermark moves only once the write reports success.
	if s.writeLegacySharedControlSuccess(
		conn, sharedKey, subscription.RequestID, legacySharedControlNotificationPayload(entry, false), true,
	) == nil {
		s.manager.AckNotificationDelivery(subscription.DeviceID, entry.Sequence)
	}
}
