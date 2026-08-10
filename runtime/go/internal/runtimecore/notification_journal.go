package runtimecore

import "sync"

// Why: a phone that was asleep or off-network is exactly the client a
// notification matters most to, but the relay only ever pushed live events —
// anything dispatched while the socket was down was gone. Every dispatched
// notification now keeps a sequence in a bounded journal so a reconnecting
// device can ask for what it missed.
const notificationJournalCapacity = 256

// JournaledNotification embeds the event so the relay payload keeps the shape
// clients already parse and only gains the sequence they de-duplicate on.
type JournaledNotification struct {
	NotificationEvent
	Sequence uint64 `json:"sequence"`
}

// NotificationReplay is what a reconnecting device receives before live events
// resume. Truncated says the journal had already dropped part of what the
// device was owed, so it should not treat Missed as complete.
type NotificationReplay struct {
	Missed    []JournaledNotification `json:"missed"`
	Head      uint64                  `json:"head"`
	Truncated bool                    `json:"truncated"`
}

type notificationJournal struct {
	mu        sync.Mutex
	entries   []JournaledNotification
	head      uint64
	delivered map[string]uint64
}

func (j *notificationJournal) record(event NotificationEvent) JournaledNotification {
	j.mu.Lock()
	defer j.mu.Unlock()
	j.head++
	entry := JournaledNotification{NotificationEvent: event, Sequence: j.head}
	j.entries = append(j.entries, entry)
	if len(j.entries) > notificationJournalCapacity {
		// Reslicing alone would keep the dropped entries alive behind a growing
		// offset, so the retained window is copied into a fresh backing array.
		retained := make([]JournaledNotification, notificationJournalCapacity)
		copy(retained, j.entries[len(j.entries)-notificationJournalCapacity:])
		j.entries = retained
	}
	return entry
}

func (j *notificationJournal) replay(deviceID string, since *uint64) NotificationReplay {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.delivered == nil {
		j.delivered = make(map[string]uint64)
	}
	watermark, known := j.delivered[deviceID]
	if since != nil {
		watermark = *since
	} else if !known {
		// A device the journal has never delivered to missed nothing — replaying
		// the whole buffer to a freshly paired phone would just be noise. Record
		// the head now so its next reconnect is measured from here.
		j.delivered[deviceID] = j.head
		return NotificationReplay{Missed: []JournaledNotification{}, Head: j.head}
	}
	replay := NotificationReplay{Missed: []JournaledNotification{}, Head: j.head}
	if len(j.entries) > 0 {
		// An oldest entry newer than the next sequence the device expects means
		// the gap between them was trimmed away; say so rather than let the device
		// believe it caught up.
		replay.Truncated = watermark+1 < j.entries[0].Sequence
	}
	for _, entry := range j.entries {
		if entry.Sequence > watermark {
			replay.Missed = append(replay.Missed, entry)
		}
	}
	return replay
}

func (j *notificationJournal) acknowledge(deviceID string, sequence uint64) {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.delivered == nil {
		j.delivered = make(map[string]uint64)
	}
	// Why: the watermark records what the transport actually took, so it only
	// moves forward and never over a notification the device was not handed.
	if sequence > j.delivered[deviceID] {
		j.delivered[deviceID] = sequence
	}
}

func (j *notificationJournal) forget(deviceID string) {
	j.mu.Lock()
	defer j.mu.Unlock()
	delete(j.delivered, deviceID)
}

// NotificationReplayFor reports the notifications deviceID has not been handed
// yet. A nil since resumes from the device's own watermark; a non-nil one lets
// a client that persisted its own position override it.
func (m *Manager) NotificationReplayFor(deviceID string, since *uint64) NotificationReplay {
	return m.notifications.replay(deviceID, since)
}

// AckNotificationDelivery advances deviceID's watermark, and must only be
// called once the notification has actually been written to that device.
func (m *Manager) AckNotificationDelivery(deviceID string, sequence uint64) {
	m.notifications.acknowledge(deviceID, sequence)
}
