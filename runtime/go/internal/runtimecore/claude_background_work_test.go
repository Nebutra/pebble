package runtimecore

import "testing"

func TestClaudeOwnsRunningBackgroundWork(t *testing.T) {
	cases := []struct {
		name    string
		payload string
		want    bool
	}{
		{
			name:    "no background fields at all",
			payload: `{"hook_event_name":"Stop"}`,
			want:    false,
		},
		{
			name:    "empty background collections",
			payload: `{"hook_event_name":"Stop","background_tasks":[],"session_crons":[]}`,
			want:    false,
		},
		{
			name:    "running background shell",
			payload: `{"background_tasks":[{"type":"shell","status":"running"}]}`,
			want:    true,
		},
		{
			name:    "every task finished",
			payload: `{"background_tasks":[{"type":"shell","status":"completed"},{"type":"subagent","status":"failed"}]}`,
			want:    false,
		},
		{
			name:    "terminal status casing and padding",
			payload: `{"background_tasks":[{"type":"shell","status":"  Completed "}]}`,
			want:    false,
		},
		{
			name:    "unknown status label fails active",
			payload: `{"background_tasks":[{"type":"shell","status":"quiescing"}]}`,
			want:    true,
		},
		{
			name:    "missing status fails active",
			payload: `{"background_tasks":[{"type":"shell"}]}`,
			want:    true,
		},
		{
			name:    "unreadable task entry fails active",
			payload: `{"background_tasks":["not-an-object"]}`,
			want:    true,
		},
		{
			name:    "teammate row never pins the pane",
			payload: `{"background_tasks":[{"type":"teammate","status":"running"}]}`,
			want:    false,
		},
		{
			name:    "teammate row does not mask a live sibling",
			payload: `{"background_tasks":[{"type":"teammate","status":"running"},{"type":"shell","status":"running"}]}`,
			want:    true,
		},
		{
			name:    "session cron outlives the turn",
			payload: `{"background_tasks":[],"session_crons":[{"id":"cron-1"}]}`,
			want:    true,
		},
		{
			name:    "malformed payload is not evidence of work",
			payload: `not json`,
			want:    false,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := claudeOwnsRunningBackgroundWork(tc.payload); got != tc.want {
				t.Fatalf("claudeOwnsRunningBackgroundWork(%s) = %v, want %v", tc.payload, got, tc.want)
			}
		})
	}
}

func TestClassifyAgentHookPayloadStopWithBackgroundWork(t *testing.T) {
	cases := []struct {
		name    string
		payload string
		want    SessionHookState
	}{
		{
			name:    "plain stop is idle",
			payload: `{"hook_event_name":"Stop"}`,
			want:    SessionHookIdle,
		},
		{
			name:    "stop with a running background shell stays working",
			payload: `{"hook_event_name":"Stop","background_tasks":[{"type":"shell","status":"running"}]}`,
			want:    SessionHookWorking,
		},
		{
			name:    "stop failure with a session cron stays working",
			payload: `{"hook_event_name":"StopFailure","session_crons":[{"id":"cron-1"}]}`,
			want:    SessionHookWorking,
		},
		{
			name:    "stop with only finished tasks is idle",
			payload: `{"hook_event_name":"Stop","background_tasks":[{"type":"shell","status":"exited"}]}`,
			want:    SessionHookIdle,
		},
		{
			// Why: SubagentStop is a droid/copilot event; Claude never registers it,
			// so it keeps the plain idle mapping and skips the background gate.
			name:    "subagent stop ignores background work",
			payload: `{"hook_event_name":"SubagentStop","background_tasks":[{"type":"shell","status":"running"}]}`,
			want:    SessionHookIdle,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := classifyAgentHookPayload(tc.payload)
			if !ok {
				t.Fatalf("classifyAgentHookPayload(%s) was not recognized", tc.payload)
			}
			if got != tc.want {
				t.Fatalf("classifyAgentHookPayload(%s) = %q, want %q", tc.payload, got, tc.want)
			}
		})
	}
}
