package runtimecore

import (
	"sync"
	"time"
)

// The Electron predecessor watched for a wedged main process from a worker
// thread. Pebble's equivalent serialization point is the manager's state lock:
// every request that touches runtime state queues behind it, so a hold that
// outlasts the threshold is what a user experiences as a frozen app.
const (
	hangWatchdogProbeInterval = 250 * time.Millisecond
	hangWatchdogThreshold     = 5 * time.Second
	hangWatchdogHistoryLimit  = 20
)

// HangEpisode is one stretch where the state lock stayed unavailable past the
// threshold. StalledForMs is the longest stall observed during the episode, so
// an episode that is still running reports how bad it is so far.
type HangEpisode struct {
	StartedAt    time.Time `json:"startedAt"`
	StalledForMs int64     `json:"stalledForMs"`
	Recovered    bool      `json:"recovered"`
}

type hangObservation int

const (
	hangObservationResponsive hangObservation = iota
	hangObservationStarted
	hangObservationContinuing
	hangObservationRecovered
)

// hangWatchdogState is the decision half, kept free of clocks and locks: it
// turns "how long has the lock been unavailable" into at most one report per
// episode plus one on recovery.
type hangWatchdogState struct {
	hanging bool
	peak    time.Duration
}

func (s *hangWatchdogState) observe(stall time.Duration, threshold time.Duration) (hangObservation, time.Duration) {
	if stall >= threshold {
		if stall > s.peak {
			s.peak = stall
		}
		if s.hanging {
			return hangObservationContinuing, s.peak
		}
		s.hanging = true
		return hangObservationStarted, s.peak
	}
	if !s.hanging {
		return hangObservationResponsive, 0
	}
	peak := s.peak
	s.hanging = false
	s.peak = 0
	return hangObservationRecovered, peak
}

// hangWatchdog keeps its own mutex: an episode has to stay readable while the
// lock it reports on is the thing that is stuck.
type hangWatchdog struct {
	mu       sync.Mutex
	episodes []HangEpisode
	stop     chan struct{}
}

func (w *hangWatchdog) begin(startedAt time.Time, stalled time.Duration) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.episodes = append(w.episodes, HangEpisode{StartedAt: startedAt, StalledForMs: stalled.Milliseconds()})
	if len(w.episodes) > hangWatchdogHistoryLimit {
		// Copy into a fresh array so trimmed episodes are not kept alive behind
		// a growing offset on a runtime that hangs repeatedly.
		retained := make([]HangEpisode, hangWatchdogHistoryLimit)
		copy(retained, w.episodes[len(w.episodes)-hangWatchdogHistoryLimit:])
		w.episodes = retained
	}
}

func (w *hangWatchdog) update(stalled time.Duration, recovered bool) HangEpisode {
	w.mu.Lock()
	defer w.mu.Unlock()
	if len(w.episodes) == 0 {
		return HangEpisode{}
	}
	current := &w.episodes[len(w.episodes)-1]
	current.StalledForMs = stalled.Milliseconds()
	current.Recovered = recovered
	return *current
}

func (w *hangWatchdog) snapshot() []HangEpisode {
	w.mu.Lock()
	defer w.mu.Unlock()
	return append([]HangEpisode(nil), w.episodes...)
}

// restart stops whatever loop is running and hands back the channel the next
// one should watch, which is what lets a test drive the watchdog at its own
// speed without a second loop racing the production one.
func (w *hangWatchdog) restart() <-chan struct{} {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.stop != nil {
		close(w.stop)
	}
	w.stop = make(chan struct{})
	return w.stop
}

func (w *hangWatchdog) stopWatching() {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.stop != nil {
		close(w.stop)
		w.stop = nil
	}
}

// HangEpisodes reports what the watchdog has seen. It deliberately avoids the
// state lock so a caller can still read it while that lock is wedged.
func (m *Manager) HangEpisodes() []HangEpisode {
	return m.hangs.snapshot()
}

func (m *Manager) startHangWatchdog() {
	go m.watchForHangs(m.hangs.restart(), hangWatchdogProbeInterval, hangWatchdogThreshold)
}

// watchForHangs takes its timings as arguments so tests can drive a full
// episode without waiting out the production threshold.
func (m *Manager) watchForHangs(stop <-chan struct{}, interval time.Duration, threshold time.Duration) {
	state := hangWatchdogState{}
	acknowledged := time.Now()
	started := time.Time{}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-stop:
			return
		case <-ticker.C:
		}
		now := time.Now()
		// A read lock that can be taken means no writer is holding or waiting,
		// which is the only state in which queued requests make progress.
		if m.mu.TryRLock() {
			m.mu.RUnlock()
			acknowledged = now
		}
		observation, stalled := state.observe(now.Sub(acknowledged), threshold)
		switch observation {
		case hangObservationStarted:
			started = acknowledged
			m.hangs.begin(started, stalled)
		case hangObservationContinuing:
			m.hangs.update(stalled, false)
		case hangObservationRecovered:
			episode := m.hangs.update(stalled, true)
			// Why: emit takes the state lock, so an episode can only be
			// announced once that lock is free again.
			m.emit("runtime.hang", episode)
		}
	}
}
