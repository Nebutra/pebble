package runtimecore

import (
	"testing"
)

func TestClassifyAgentHookPayload(t *testing.T) {
	cases := []struct {
		name    string
		payload string
		want    SessionHookState
		ok      bool
	}{
		{"stop is idle", `{"hook_event_name":"Stop"}`, SessionHookIdle, true},
		{"stop failure is idle", `{"hook_event_name":"StopFailure"}`, SessionHookIdle, true},
		{"permission request", `{"hook_event_name":"PermissionRequest","tool_name":"Bash"}`, SessionHookPermission, true},
		{"notification blocks on user", `{"hook_event_name":"Notification"}`, SessionHookPermission, true},
		{"pre tool use is working", `{"hook_event_name":"PreToolUse","tool_name":"Bash"}`, SessionHookWorking, true},
		{"prompt submit is working", `{"hook_event_name":"UserPromptSubmit"}`, SessionHookWorking, true},
		{"camel case event name", `{"hookEventName":"Stop"}`, SessionHookIdle, true},
		{"explicit state fallback", `{"state":"waiting"}`, SessionHookPermission, true},
		{"explicit done state", `{"state":"done"}`, SessionHookIdle, true},
		{"unknown event ignored", `{"hook_event_name":"SomethingNew"}`, "", false},
		{"invalid json ignored", `not-json`, "", false},
		{"empty payload ignored", `{}`, "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			state, ok := classifyAgentHookPayload(tc.payload)
			if ok != tc.ok || state != tc.want {
				t.Fatalf("classify(%q) = (%q, %v), want (%q, %v)", tc.payload, state, ok, tc.want, tc.ok)
			}
		})
	}
}

func TestIngestAgentHookEventResolvesByLaunchToken(t *testing.T) {
	manager, session := startHookStateTestSession(t, "sleep 30", "launch-token-1")

	result := manager.IngestAgentHookEvent(AgentHookIngestRequest{
		Source:      "claude",
		LaunchToken: "launch-token-1",
		Payload:     `{"hook_event_name":"Stop"}`,
	})
	if !result.Accepted || result.SessionID != session.ID || result.State != SessionHookIdle {
		t.Fatalf("expected accepted idle ingest for session %s, got %#v", session.ID, result)
	}

	snapshot, err := manager.SessionStatus(session.ID)
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.HookAgentState != SessionHookIdle {
		t.Fatalf("expected idle hook state on session, got %q", snapshot.HookAgentState)
	}
}

func TestIngestAgentHookEventResolvesByPaneKey(t *testing.T) {
	manager, session := startHookStateTestSession(t, "sleep 30", "")

	// Session id doubles as pane key when tab/leaf placement is unknown.
	result := manager.IngestAgentHookEvent(AgentHookIngestRequest{
		Source:  "claude",
		PaneKey: session.ID,
		Payload: `{"hook_event_name":"PermissionRequest"}`,
	})
	if !result.Accepted || result.State != SessionHookPermission {
		t.Fatalf("expected permission ingest via pane key, got %#v", result)
	}
}

func TestIngestAgentHookEventReportsUnresolvableSession(t *testing.T) {
	manager, _ := startHookStateTestSession(t, "sleep 30", "")

	result := manager.IngestAgentHookEvent(AgentHookIngestRequest{
		Source:      "claude",
		LaunchToken: "unknown-token",
		Payload:     `{"hook_event_name":"Stop"}`,
	})
	if result.Accepted || result.Reason != "session_not_found" {
		t.Fatalf("expected session_not_found, got %#v", result)
	}

	result = manager.IngestAgentHookEvent(AgentHookIngestRequest{
		Source:      "claude",
		LaunchToken: "unknown-token",
		Payload:     `{"hook_event_name":"NotARealEvent"}`,
	})
	if result.Accepted || result.Reason != "unrecognized_event" {
		t.Fatalf("expected unrecognized_event, got %#v", result)
	}
}

func TestAgentHookSessionEnvStampsElectronCompatibleVariables(t *testing.T) {
	session := &processSession{
		id:          "sess-1",
		tabID:       "tab-1",
		leafID:      "leaf-1",
		worktreeID:  "wt-1",
		launchToken: "tok-1",
	}
	env := agentHookSessionEnv(sessionHookEndpoint{port: 17777, token: "secret"}, session)
	want := map[string]string{
		"PEBBLE_AGENT_HOOK_PORT":    "17777",
		"PEBBLE_AGENT_HOOK_TOKEN":   "secret",
		"PEBBLE_AGENT_HOOK_ENV":     "pebble-go-runtime",
		"PEBBLE_AGENT_HOOK_VERSION": agentHookProtocolVersion,
		"PEBBLE_AGENT_LAUNCH_TOKEN": "tok-1",
		"PEBBLE_PANE_KEY":           "tab-1:leaf-1",
		"PEBBLE_TAB_ID":             "tab-1",
		"PEBBLE_WORKTREE_ID":        "wt-1",
	}
	got := map[string]string{}
	for _, entry := range env {
		for key, value := range want {
			if entry == key+"="+value {
				got[key] = value
			}
		}
	}
	if len(got) != len(want) {
		t.Fatalf("hook env missing entries: got %v from %v", got, env)
	}
}
