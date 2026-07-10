package runtimecore

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"sort"
	"strings"
	"time"

	"github.com/teambition/rrule-go"
)

type AutomationScheduleKind string

const (
	AutomationScheduleManual   AutomationScheduleKind = "manual"
	AutomationScheduleInterval AutomationScheduleKind = "interval"
	AutomationScheduleCron     AutomationScheduleKind = "cron"
	AutomationScheduleEvent    AutomationScheduleKind = "event"
	AutomationScheduleRrule    AutomationScheduleKind = "rrule"
)

type AutomationActionKind string

const (
	AutomationActionCreateTask     AutomationActionKind = "createTask"
	AutomationActionSendMessage    AutomationActionKind = "sendMessage"
	AutomationActionDispatchTask   AutomationActionKind = "dispatchTask"
	AutomationActionStartAgentRun  AutomationActionKind = "startAgentRun"
	AutomationActionComputerAction AutomationActionKind = "computerAction"
)

type AutomationRunStatus string

const (
	AutomationRunQueued    AutomationRunStatus = "queued"
	AutomationRunCompleted AutomationRunStatus = "completed"
	AutomationRunFailed    AutomationRunStatus = "failed"
	// AutomationRunSkippedPrecheck mirrors Electron's skipped_precheck status:
	// the schedule fired but the precheck gate did not pass, so no action ran.
	AutomationRunSkippedPrecheck AutomationRunStatus = "skipped_precheck"
)

// AutomationRendererPayloadKey is the reserved action-payload envelope the
// desktop shell uses to round-trip renderer-only automation fields (prompt,
// agent, workspace mode). The runtime strips it before decoding native action
// requests and forwards it untouched on dispatch events.
const AutomationRendererPayloadKey = "pebbleAutomation"

type AutomationRunReason string

const (
	AutomationRunManual   AutomationRunReason = "manual"
	AutomationRunSchedule AutomationRunReason = "schedule"
	AutomationRunEvent    AutomationRunReason = "event"
)

type AutomationSchedule struct {
	Kind            AutomationScheduleKind `json:"kind"`
	IntervalSeconds int64                  `json:"intervalSeconds,omitempty"`
	Cron            string                 `json:"cron,omitempty"`
	EventTopic      string                 `json:"eventTopic,omitempty"`
	Timezone        string                 `json:"timezone,omitempty"`
	// Rrule is an RFC 5545 recurrence rule string (e.g. "FREQ=WEEKLY;BYDAY=MO,WE;INTERVAL=2").
	// Supported subset mirrors the Electron reference path: DAILY/WEEKLY/MONTHLY frequencies with
	// INTERVAL/BYDAY/UNTIL/COUNT — the practical range the product's schedule builder emits.
	Rrule string `json:"rrule,omitempty"`
	// DtStart anchors the recurrence; occurrences are computed relative to it, not to Timezone
	// (rrule-go operates in the time.Time's own location, so DtStart must carry the intended zone).
	DtStart *time.Time `json:"dtstart,omitempty"`
}

type AutomationAction struct {
	Kind    AutomationActionKind   `json:"kind"`
	Payload map[string]interface{} `json:"payload,omitempty"`
}

type Automation struct {
	ID          string             `json:"id"`
	Name        string             `json:"name"`
	Description string             `json:"description,omitempty"`
	Enabled     bool               `json:"enabled"`
	Schedule    AutomationSchedule `json:"schedule"`
	Action      AutomationAction   `json:"action"`
	// Precheck gates scheduled runs only; manual/event triggers bypass it,
	// matching the Electron automation service.
	Precheck        *AutomationPrecheck `json:"precheck,omitempty"`
	LastTriggeredAt *time.Time          `json:"lastTriggeredAt,omitempty"`
	NextRunAt       *time.Time          `json:"nextRunAt,omitempty"`
	CreatedAt       time.Time           `json:"createdAt"`
	UpdatedAt       time.Time           `json:"updatedAt"`
}

type CreateAutomationRequest struct {
	Name        string              `json:"name"`
	Description string              `json:"description,omitempty"`
	Enabled     bool                `json:"enabled,omitempty"`
	Schedule    AutomationSchedule  `json:"schedule"`
	Action      AutomationAction    `json:"action"`
	Precheck    *AutomationPrecheck `json:"precheck,omitempty"`
}

type UpdateAutomationRequest struct {
	Name        string              `json:"name,omitempty"`
	Description string              `json:"description,omitempty"`
	Enabled     *bool               `json:"enabled,omitempty"`
	Schedule    *AutomationSchedule `json:"schedule,omitempty"`
	Action      *AutomationAction   `json:"action,omitempty"`
	// Precheck with an empty command clears the stored precheck; nil leaves it
	// unchanged.
	Precheck *AutomationPrecheck `json:"precheck,omitempty"`
}

type TriggerAutomationRequest struct {
	Reason  AutomationRunReason    `json:"reason,omitempty"`
	Payload map[string]interface{} `json:"payload,omitempty"`
}

type EvaluateAutomationsRequest struct {
	Now *time.Time `json:"now,omitempty"`
}

type AutomationRun struct {
	ID               string                 `json:"id"`
	AutomationID     string                 `json:"automationId"`
	Reason           AutomationRunReason    `json:"reason"`
	Status           AutomationRunStatus    `json:"status"`
	Payload          map[string]interface{} `json:"payload,omitempty"`
	TaskID           string                 `json:"taskId,omitempty"`
	MessageID        string                 `json:"messageId,omitempty"`
	DispatchID       string                 `json:"dispatchId,omitempty"`
	AgentRunID       string                 `json:"agentRunId,omitempty"`
	ComputerActionID string                 `json:"computerActionId,omitempty"`
	// PrecheckResult records whether a scheduled run's precheck passed (run
	// proceeded) or failed (run recorded as skipped_precheck).
	PrecheckResult *AutomationPrecheckResult `json:"precheckResult,omitempty"`
	// DispatchState is the desktop renderer's reported dispatch outcome for
	// runs whose real work happens in a renderer-driven workspace session.
	DispatchState *AutomationDispatchState `json:"dispatchState,omitempty"`
	Error         string                   `json:"error,omitempty"`
	CreatedAt     time.Time                `json:"createdAt"`
	UpdatedAt     time.Time                `json:"updatedAt"`
}

func (m *Manager) CreateAutomation(req CreateAutomationRequest) (Automation, error) {
	name := strings.TrimSpace(req.Name)
	if name == "" {
		return Automation{}, errors.New("automation name is required")
	}
	schedule, err := normalizeAutomationSchedule(req.Schedule)
	if err != nil {
		return Automation{}, err
	}
	action, err := normalizeAutomationAction(req.Action)
	if err != nil {
		return Automation{}, err
	}
	now := time.Now().UTC()
	automation := Automation{
		ID:          newID("auto"),
		Name:        name,
		Description: strings.TrimSpace(req.Description),
		Enabled:     req.Enabled,
		Schedule:    schedule,
		Action:      action,
		Precheck:    normalizeAutomationPrecheck(req.Precheck),
		NextRunAt:   nextAutomationRunAt(schedule, now, req.Enabled),
		CreatedAt:   now,
		UpdatedAt:   now,
	}
	m.mu.Lock()
	m.automations[automation.ID] = automation
	err = m.saveLocked()
	m.mu.Unlock()
	if err != nil {
		return Automation{}, err
	}
	m.emit("automation.changed", automation)
	return automation, nil
}

func (m *Manager) UpdateAutomation(id string, req UpdateAutomationRequest) (Automation, error) {
	m.mu.Lock()
	automation, ok := m.automations[id]
	if !ok {
		m.mu.Unlock()
		return Automation{}, ErrNotFound
	}
	if name := strings.TrimSpace(req.Name); name != "" {
		automation.Name = name
	}
	if req.Description != "" {
		automation.Description = strings.TrimSpace(req.Description)
	}
	if req.Enabled != nil {
		automation.Enabled = *req.Enabled
	}
	scheduleChanged := false
	if req.Schedule != nil {
		schedule, err := normalizeAutomationSchedule(*req.Schedule)
		if err != nil {
			m.mu.Unlock()
			return Automation{}, err
		}
		automation.Schedule = schedule
		scheduleChanged = true
	}
	if req.Action != nil {
		action, err := normalizeAutomationAction(*req.Action)
		if err != nil {
			m.mu.Unlock()
			return Automation{}, err
		}
		automation.Action = action
	}
	if req.Precheck != nil {
		automation.Precheck = normalizeAutomationPrecheck(req.Precheck)
	}
	now := time.Now().UTC()
	if req.Enabled != nil || scheduleChanged {
		automation.NextRunAt = nextAutomationRunAt(automation.Schedule, now, automation.Enabled)
	}
	automation.UpdatedAt = now
	m.automations[id] = automation
	err := m.saveLocked()
	m.mu.Unlock()
	if err != nil {
		return Automation{}, err
	}
	m.emit("automation.changed", automation)
	return automation, nil
}

func (m *Manager) DeleteAutomation(id string) (Automation, error) {
	m.mu.Lock()
	automation, ok := m.automations[id]
	if !ok {
		m.mu.Unlock()
		return Automation{}, ErrNotFound
	}
	delete(m.automations, id)
	err := m.saveLocked()
	m.mu.Unlock()
	if err != nil {
		return Automation{}, err
	}
	m.emit("automation.changed", map[string]interface{}{"deleted": automation})
	return automation, nil
}

func (m *Manager) ListAutomations() []Automation {
	m.mu.RLock()
	defer m.mu.RUnlock()
	automations := make([]Automation, 0, len(m.automations))
	for _, automation := range m.automations {
		automations = append(automations, automation)
	}
	sort.Slice(automations, func(i, j int) bool {
		return automations[i].CreatedAt.Before(automations[j].CreatedAt)
	})
	return automations
}

func (m *Manager) TriggerAutomation(ctx context.Context, id string, req TriggerAutomationRequest) (AutomationRun, error) {
	return m.triggerAutomationAt(ctx, id, req, time.Now().UTC())
}

func (m *Manager) triggerAutomationAt(ctx context.Context, id string, req TriggerAutomationRequest, triggerTime time.Time) (AutomationRun, error) {
	m.mu.RLock()
	automation, ok := m.automations[id]
	m.mu.RUnlock()
	if !ok {
		return AutomationRun{}, ErrNotFound
	}
	if !automation.Enabled {
		return AutomationRun{}, errors.New("automation is disabled")
	}
	reason := req.Reason
	if reason == "" {
		reason = AutomationRunManual
	}
	if !isAutomationRunReason(reason) {
		return AutomationRun{}, errors.New("invalid automation run reason")
	}
	payload := mergedAutomationPayload(automation.Action.Payload, req.Payload)
	now := triggerTime.UTC()
	run := AutomationRun{
		ID:           newID("autorun"),
		AutomationID: automation.ID,
		Reason:       reason,
		Status:       AutomationRunQueued,
		Payload:      payload,
		CreatedAt:    now,
		UpdatedAt:    now,
	}
	automation.LastTriggeredAt = &now
	automation.NextRunAt = nextAutomationRunAt(automation.Schedule, now, automation.Enabled)
	automation.UpdatedAt = now

	m.mu.Lock()
	m.automations[automation.ID] = automation
	m.automationRuns[run.ID] = run
	err := m.saveLocked()
	m.mu.Unlock()
	if err != nil {
		return AutomationRun{}, err
	}
	m.emit("automation.changed", map[string]interface{}{
		"automation": automation,
		"run":        run,
	})
	// Precheck gates scheduled triggers only, mirroring Electron: manual runs
	// were requested explicitly by a person and must not be gated.
	if reason == AutomationRunSchedule && automation.Precheck != nil {
		result := m.evaluateAutomationPrecheck(ctx, automation)
		run.PrecheckResult = &result
		if !automationPrecheckPassed(result) {
			run.Status = AutomationRunSkippedPrecheck
			run.Error = formatAutomationPrecheckFailure(result)
			run.UpdatedAt = time.Now().UTC()
			return m.saveAutomationRun(run)
		}
	}
	// Tell any connected desktop shell that an automation wants workspace work
	// (renderer dispatch). Native action execution below is the headless path.
	m.emit("automation.dispatch.requested", map[string]interface{}{
		"automation": automation,
		"run":        run,
	})
	return m.executeAutomationRun(ctx, automation, run)
}

// evaluateAutomationPrecheck resolves the precheck cwd and runs the bounded
// shell command; an unresolvable cwd is a precheck failure, not a crash.
func (m *Manager) evaluateAutomationPrecheck(ctx context.Context, automation Automation) AutomationPrecheckResult {
	precheck := *automation.Precheck
	cwd, err := m.resolveAutomationPrecheckCwd(automation)
	if err != nil {
		return failedAutomationPrecheckResult(precheck, time.Now().UTC(), err.Error())
	}
	return runAutomationPrecheck(ctx, precheck, cwd)
}

func (m *Manager) EvaluateScheduledAutomations(ctx context.Context, now time.Time) ([]AutomationRun, error) {
	due := m.dueAutomations(now.UTC())
	runs := make([]AutomationRun, 0, len(due))
	for _, automation := range due {
		run, err := m.triggerAutomationAt(ctx, automation.ID, TriggerAutomationRequest{Reason: AutomationRunSchedule}, now)
		if err != nil {
			return runs, err
		}
		runs = append(runs, run)
	}
	return runs, nil
}

// RunAutomationScheduler evaluates due scheduled automations every interval
// until ctx is canceled. Why: headless runtimes have no desktop shell polling
// the evaluate endpoint, so the runtime itself must tick — the native
// equivalent of Electron's AutomationService interval timer.
func (m *Manager) RunAutomationScheduler(ctx context.Context, interval time.Duration) {
	if interval <= 0 {
		interval = time.Minute
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if _, err := m.EvaluateScheduledAutomations(ctx, time.Now().UTC()); err != nil {
				// Run-level failures are already recorded on the run; this
				// surfaces storage-level evaluation errors without crashing.
				m.emit("automation.scheduler.error", map[string]interface{}{"error": err.Error()})
			}
		}
	}
}

func (m *Manager) ListAutomationRuns(automationID string) []AutomationRun {
	m.mu.RLock()
	defer m.mu.RUnlock()
	automationID = strings.TrimSpace(automationID)
	runs := make([]AutomationRun, 0, len(m.automationRuns))
	for _, run := range m.automationRuns {
		if automationID != "" && run.AutomationID != automationID {
			continue
		}
		runs = append(runs, run)
	}
	sort.Slice(runs, func(i, j int) bool {
		return runs[i].CreatedAt.Before(runs[j].CreatedAt)
	})
	return runs
}

func (m *Manager) dueAutomations(now time.Time) []Automation {
	m.mu.RLock()
	defer m.mu.RUnlock()
	due := make([]Automation, 0)
	for _, automation := range m.automations {
		if !automation.Enabled || automation.NextRunAt == nil {
			continue
		}
		if automation.NextRunAt.After(now) {
			continue
		}
		due = append(due, automation)
	}
	sort.Slice(due, func(i, j int) bool {
		return due[i].NextRunAt.Before(*due[j].NextRunAt)
	})
	return due
}

func (m *Manager) executeAutomationRun(ctx context.Context, automation Automation, run AutomationRun) (AutomationRun, error) {
	switch automation.Action.Kind {
	case AutomationActionCreateTask:
		var req CreateTaskRequest
		if err := decodeAutomationPayload(run.Payload, &req); err != nil {
			return m.failAutomationRun(run, err)
		}
		task, err := m.CreateTask(req)
		if err != nil {
			return m.failAutomationRun(run, err)
		}
		run.TaskID = task.ID
	case AutomationActionSendMessage:
		var req SendMessageRequest
		if err := decodeAutomationPayload(run.Payload, &req); err != nil {
			return m.failAutomationRun(run, err)
		}
		message, err := m.SendMessage(req)
		if err != nil {
			return m.failAutomationRun(run, err)
		}
		run.MessageID = message.ID
	case AutomationActionDispatchTask:
		var req DispatchTaskRequest
		if err := decodeAutomationPayload(run.Payload, &req); err != nil {
			return m.failAutomationRun(run, err)
		}
		dispatch, err := m.DispatchTask(req)
		if err != nil {
			return m.failAutomationRun(run, err)
		}
		run.DispatchID = dispatch.ID
	case AutomationActionStartAgentRun:
		var req StartAgentRunRequest
		if err := decodeAutomationPayload(run.Payload, &req); err != nil {
			return m.failAutomationRun(run, err)
		}
		agentRun, err := m.StartAgentRun(ctx, req)
		if err != nil {
			return m.failAutomationRun(run, err)
		}
		run.AgentRunID = agentRun.ID
	case AutomationActionComputerAction:
		var req CreateComputerActionRequest
		if err := decodeAutomationPayload(run.Payload, &req); err != nil {
			return m.failAutomationRun(run, err)
		}
		action, err := m.CreateComputerAction(req)
		if err != nil {
			return m.failAutomationRun(run, err)
		}
		run.ComputerActionID = action.ID
	default:
		return m.failAutomationRun(run, errors.New("unsupported automation action"))
	}
	return m.completeAutomationRun(run)
}

func (m *Manager) completeAutomationRun(run AutomationRun) (AutomationRun, error) {
	run.Status = AutomationRunCompleted
	run.UpdatedAt = time.Now().UTC()
	return m.saveAutomationRun(run)
}

func (m *Manager) failAutomationRun(run AutomationRun, cause error) (AutomationRun, error) {
	run.Status = AutomationRunFailed
	run.Error = cause.Error()
	run.UpdatedAt = time.Now().UTC()
	saved, err := m.saveAutomationRun(run)
	if err != nil {
		return AutomationRun{}, err
	}
	return saved, nil
}

func (m *Manager) saveAutomationRun(run AutomationRun) (AutomationRun, error) {
	m.mu.Lock()
	if _, ok := m.automationRuns[run.ID]; !ok {
		m.mu.Unlock()
		return AutomationRun{}, ErrNotFound
	}
	m.automationRuns[run.ID] = run
	err := m.saveLocked()
	m.mu.Unlock()
	if err != nil {
		return AutomationRun{}, err
	}
	m.emit("automation.changed", run)
	return run, nil
}

func normalizeAutomationSchedule(schedule AutomationSchedule) (AutomationSchedule, error) {
	schedule.Kind = AutomationScheduleKind(strings.TrimSpace(string(schedule.Kind)))
	if schedule.Kind == "" {
		schedule.Kind = AutomationScheduleManual
	}
	schedule.Cron = strings.TrimSpace(schedule.Cron)
	schedule.EventTopic = strings.TrimSpace(schedule.EventTopic)
	schedule.Timezone = strings.TrimSpace(schedule.Timezone)
	schedule.Rrule = strings.TrimSpace(schedule.Rrule)
	switch schedule.Kind {
	case AutomationScheduleManual:
		schedule.IntervalSeconds = 0
		schedule.Cron = ""
		schedule.EventTopic = ""
		schedule.Rrule = ""
		schedule.DtStart = nil
	case AutomationScheduleInterval:
		if schedule.IntervalSeconds <= 0 {
			return AutomationSchedule{}, errors.New("automation interval seconds must be positive")
		}
		schedule.Cron = ""
		schedule.EventTopic = ""
		schedule.Rrule = ""
		schedule.DtStart = nil
	case AutomationScheduleRrule:
		if schedule.Rrule == "" {
			return AutomationSchedule{}, errors.New("automation rrule is required")
		}
		dtStart, err := resolveAutomationDtStart(schedule)
		if err != nil {
			return AutomationSchedule{}, err
		}
		if _, err := buildAutomationRRule(schedule.Rrule, dtStart); err != nil {
			return AutomationSchedule{}, err
		}
		schedule.DtStart = &dtStart
		schedule.IntervalSeconds = 0
		schedule.Cron = ""
		schedule.EventTopic = ""
	default:
		return AutomationSchedule{}, errors.New("unsupported automation schedule kind")
	}
	return schedule, nil
}

// resolveAutomationDtStart defaults DtStart to now (in the schedule's timezone, if any) so
// callers can omit it for "starts immediately" schedules, matching the interval trigger's
// implicit start-from-creation behavior.
func resolveAutomationDtStart(schedule AutomationSchedule) (time.Time, error) {
	loc := time.UTC
	if schedule.Timezone != "" {
		resolved, err := time.LoadLocation(schedule.Timezone)
		if err != nil {
			return time.Time{}, errors.New("invalid automation schedule timezone")
		}
		loc = resolved
	}
	if schedule.DtStart != nil {
		return schedule.DtStart.In(loc), nil
	}
	return time.Now().In(loc), nil
}

// buildAutomationRRule parses the RFC 5545 recurrence string and restricts it to the practical
// subset the schedule builder emits (DAILY/WEEKLY/MONTHLY with INTERVAL/BYDAY/UNTIL/COUNT) so
// obscure RFC corners (e.g. BYSETPOS, secondly frequencies) fail fast with a clear error.
func buildAutomationRRule(rruleStr string, dtStart time.Time) (*rrule.RRule, error) {
	option, err := rrule.StrToROptionInLocation(rruleStr, dtStart.Location())
	if err != nil {
		return nil, errors.New("invalid automation rrule: " + err.Error())
	}
	switch option.Freq {
	case rrule.DAILY, rrule.WEEKLY, rrule.MONTHLY:
	default:
		return nil, errors.New("unsupported automation rrule frequency (supported: DAILY, WEEKLY, MONTHLY)")
	}
	option.Dtstart = dtStart
	rule, err := rrule.NewRRule(*option)
	if err != nil {
		return nil, errors.New("invalid automation rrule: " + err.Error())
	}
	return rule, nil
}

func normalizeAutomationAction(action AutomationAction) (AutomationAction, error) {
	action.Kind = AutomationActionKind(strings.TrimSpace(string(action.Kind)))
	if !isAutomationActionKind(action.Kind) {
		return AutomationAction{}, errors.New("invalid automation action kind")
	}
	action.Payload = cloneMap(action.Payload)
	return action, nil
}

func nextAutomationRunAt(schedule AutomationSchedule, from time.Time, enabled bool) *time.Time {
	if !enabled {
		return nil
	}
	switch schedule.Kind {
	case AutomationScheduleInterval:
		if schedule.IntervalSeconds <= 0 {
			return nil
		}
		next := from.UTC().Add(time.Duration(schedule.IntervalSeconds) * time.Second)
		return &next
	case AutomationScheduleRrule:
		return nextAutomationRruleOccurrence(schedule, from)
	default:
		return nil
	}
}

// nextAutomationRruleOccurrence finds the earliest occurrence strictly after `from`, reusing the
// dtstart resolved at schedule-normalization time so timezone handling stays consistent between
// create/update and each re-evaluation after a run fires.
func nextAutomationRruleOccurrence(schedule AutomationSchedule, from time.Time) *time.Time {
	if schedule.Rrule == "" || schedule.DtStart == nil {
		return nil
	}
	rule, err := buildAutomationRRule(schedule.Rrule, *schedule.DtStart)
	if err != nil {
		return nil
	}
	next := rule.After(from.In(schedule.DtStart.Location()), false)
	if next.IsZero() {
		return nil
	}
	utc := next.UTC()
	return &utc
}

func mergedAutomationPayload(base map[string]interface{}, override map[string]interface{}) map[string]interface{} {
	merged := cloneMap(base)
	if merged == nil {
		merged = make(map[string]interface{})
	}
	for key, value := range override {
		merged[key] = value
	}
	return merged
}

func decodeAutomationPayload(payload map[string]interface{}, target interface{}) error {
	// The renderer envelope is metadata for dispatch events, not action input;
	// stripping it keeps DisallowUnknownFields strict for real payload keys.
	if _, ok := payload[AutomationRendererPayloadKey]; ok {
		stripped := make(map[string]interface{}, len(payload))
		for key, value := range payload {
			if key != AutomationRendererPayloadKey {
				stripped[key] = value
			}
		}
		payload = stripped
	}
	content, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	decoder := json.NewDecoder(bytes.NewReader(content))
	decoder.DisallowUnknownFields()
	return decoder.Decode(target)
}

func isAutomationActionKind(kind AutomationActionKind) bool {
	switch kind {
	case AutomationActionCreateTask, AutomationActionSendMessage, AutomationActionDispatchTask, AutomationActionStartAgentRun, AutomationActionComputerAction:
		return true
	default:
		return false
	}
}

func isAutomationRunReason(reason AutomationRunReason) bool {
	switch reason {
	case AutomationRunManual, AutomationRunSchedule, AutomationRunEvent:
		return true
	default:
		return false
	}
}
