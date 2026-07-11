package runtimecore

import (
	"testing"
	"time"
)

func TestHourlyAutomationRRuleMatchesCanonicalScheduleBuilder(t *testing.T) {
	start := time.Date(2026, time.July, 12, 9, 15, 0, 0, time.UTC)
	schedule, err := normalizeAutomationSchedule(AutomationSchedule{
		Kind: AutomationScheduleRrule, Rrule: "FREQ=HOURLY;BYMINUTE=15", DtStart: &start,
	})
	if err != nil {
		t.Fatal(err)
	}
	if next := nextAutomationRunAt(schedule, start, true); next == nil || !next.Equal(start.Add(time.Hour)) {
		t.Fatalf("unexpected hourly occurrence: %v", next)
	}
}
