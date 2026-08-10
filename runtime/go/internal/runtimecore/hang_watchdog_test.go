package runtimecore

import (
	"testing"
	"time"
)

func TestHangWatchdogReportsAnEpisodeOnceWhileItLasts(t *testing.T) {
	state := hangWatchdogState{}
	threshold := 5 * time.Second

	if observation, _ := state.observe(time.Second, threshold); observation != hangObservationResponsive {
		t.Fatalf("observation = %v, want responsive below the threshold", observation)
	}
	observation, stalled := state.observe(6*time.Second, threshold)
	if observation != hangObservationStarted || stalled != 6*time.Second {
		t.Fatalf("observation = %v (%v), want started at 6s", observation, stalled)
	}
	observation, stalled = state.observe(9*time.Second, threshold)
	if observation != hangObservationContinuing || stalled != 9*time.Second {
		t.Fatalf("observation = %v (%v), want continuing at 9s", observation, stalled)
	}
}

func TestHangWatchdogRecoveryCarriesTheWorstStall(t *testing.T) {
	state := hangWatchdogState{}
	threshold := 5 * time.Second
	state.observe(6*time.Second, threshold)
	state.observe(11*time.Second, threshold)
	// The probe that finally succeeds sees a short stall; what matters to the
	// report is how long the runtime was actually wedged.
	state.observe(7*time.Second, threshold)

	observation, stalled := state.observe(0, threshold)
	if observation != hangObservationRecovered || stalled != 11*time.Second {
		t.Fatalf("observation = %v (%v), want recovered at 11s", observation, stalled)
	}
	if observation, _ := state.observe(0, threshold); observation != hangObservationResponsive {
		t.Fatalf("observation = %v, want responsive after recovery", observation)
	}
}

func TestHangWatchdogTreatsEachEpisodeSeparately(t *testing.T) {
	state := hangWatchdogState{}
	threshold := time.Second
	state.observe(2*time.Second, threshold)
	state.observe(0, threshold)

	observation, stalled := state.observe(3*time.Second, threshold)
	if observation != hangObservationStarted || stalled != 3*time.Second {
		t.Fatalf("observation = %v (%v), want a fresh episode at 3s", observation, stalled)
	}
}

func TestHangWatchdogHistoryStaysBounded(t *testing.T) {
	watchdog := hangWatchdog{}
	for index := 0; index < hangWatchdogHistoryLimit*3; index++ {
		watchdog.begin(time.Now(), time.Duration(index)*time.Second)
	}

	episodes := watchdog.snapshot()
	if len(episodes) != hangWatchdogHistoryLimit {
		t.Fatalf("kept %d episodes, want %d", len(episodes), hangWatchdogHistoryLimit)
	}
	newest := time.Duration(hangWatchdogHistoryLimit*3-1) * time.Second
	if episodes[len(episodes)-1].StalledForMs != newest.Milliseconds() {
		t.Fatalf("newest episode = %dms, want %dms", episodes[len(episodes)-1].StalledForMs, newest.Milliseconds())
	}
}

func TestHangWatchdogObservesARealStateLockStall(t *testing.T) {
	manager, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Shutdown()
	// The production watchdog is already running; restart it at test speed so a
	// full episode takes well under a second.
	go manager.watchForHangs(manager.hangs.restart(), 5*time.Millisecond, 50*time.Millisecond)

	subscription, events := manager.Subscribe(8)
	defer manager.Unsubscribe(subscription)
	manager.mu.Lock()
	time.Sleep(150 * time.Millisecond)
	manager.mu.Unlock()

	select {
	case event := <-events:
		if event.Topic != "runtime.hang" {
			t.Fatalf("topic = %q, want runtime.hang", event.Topic)
		}
		episode, ok := event.Payload.(HangEpisode)
		if !ok {
			t.Fatalf("payload = %#v, want a HangEpisode", event.Payload)
		}
		if !episode.Recovered || episode.StalledForMs < 50 {
			t.Fatalf("episode = %#v, want a recovered episode past the threshold", episode)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the watchdog never announced the stall")
	}
	if len(manager.HangEpisodes()) != 1 {
		t.Fatalf("recorded %d episodes, want 1", len(manager.HangEpisodes()))
	}
}

func TestHangWatchdogIgnoresBriefLockHolds(t *testing.T) {
	manager, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Shutdown()
	go manager.watchForHangs(manager.hangs.restart(), 5*time.Millisecond, 500*time.Millisecond)

	for index := 0; index < 20; index++ {
		manager.mu.Lock()
		time.Sleep(5 * time.Millisecond)
		manager.mu.Unlock()
		time.Sleep(5 * time.Millisecond)
	}

	if episodes := manager.HangEpisodes(); len(episodes) != 0 {
		t.Fatalf("recorded %#v, want no episode for repeated short holds", episodes)
	}
}
