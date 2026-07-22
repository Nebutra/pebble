package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/nebutra/pebble/runtime/go/internal/runtimeauth"
)

func TestResolveRuntimeAuthDiscoversRunningLocalRuntime(t *testing.T) {
	dataDir := t.TempDir()
	t.Setenv("PEBBLE_RUNTIME_DATA_DIR", dataDir)
	cleanup, err := runtimeauth.Publish(dataDir, "http://127.0.0.1:18888", "secret")
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup()

	endpoint, token := resolveRuntimeAuth("http://127.0.0.1:17777", "", false, false)
	if endpoint != "http://127.0.0.1:18888" || token != "secret" {
		t.Fatalf("unexpected discovered runtime auth endpoint=%q token=%q", endpoint, token)
	}
}

func TestResolveRuntimeAuthPreservesExplicitAndServeConfiguration(t *testing.T) {
	dataDir := t.TempDir()
	t.Setenv("PEBBLE_RUNTIME_DATA_DIR", dataDir)
	cleanup, err := runtimeauth.Publish(dataDir, "http://127.0.0.1:18888", "discovered")
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup()

	endpoint, token := resolveRuntimeAuth("http://127.0.0.1:19999", "", true, false)
	if endpoint != "http://127.0.0.1:19999" || token != "" {
		t.Fatalf("explicit endpoint was overwritten: endpoint=%q token=%q", endpoint, token)
	}
	endpoint, token = resolveRuntimeAuth("http://127.0.0.1:17777", "explicit", false, false)
	if endpoint != "http://127.0.0.1:17777" || token != "explicit" {
		t.Fatalf("explicit token was overwritten: endpoint=%q token=%q", endpoint, token)
	}
	endpoint, token = resolveRuntimeAuth("http://127.0.0.1:17777", "", false, true)
	if endpoint != "http://127.0.0.1:17777" || token != "" {
		t.Fatalf("serve configuration used desktop credentials: endpoint=%q token=%q", endpoint, token)
	}
}

func TestSplitCommandPreservesQuotedScript(t *testing.T) {
	got := splitCommand(`/bin/sh -c "printf 'agent-run-ok\n'"`)
	want := []string{"/bin/sh", "-c", "printf 'agent-run-ok\\n'"}
	if len(got) != len(want) {
		t.Fatalf("expected %d fields, got %d: %#v", len(want), len(got), got)
	}
	for index := range want {
		if got[index] != want[index] {
			t.Fatalf("field %d: expected %q, got %q", index, want[index], got[index])
		}
	}
}

func TestSplitCommandFallsBackOnUnterminatedQuote(t *testing.T) {
	got := splitCommand(`/bin/sh -c "printf`)
	if len(got) != 3 {
		t.Fatalf("unexpected fallback fields: %#v", got)
	}
}

func TestControlClientAddsBearerToken(t *testing.T) {
	var gotAuth string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer server.Close()

	err := run(controlClient{endpoint: server.URL, token: "secret", http: server.Client()}, []string{"status"})
	if err != nil {
		t.Fatal(err)
	}
	if gotAuth != "Bearer secret" {
		t.Fatalf("unexpected authorization header %q", gotAuth)
	}
}

func TestRunEventsStreamsServerSentEvents(t *testing.T) {
	var gotPath string
	var gotAccept string
	var gotAuth string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAccept = r.Header.Get("Accept")
		gotAuth = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte("id: evt_1\nevent: project.changed\ndata: {\"topic\":\"project.changed\"}\n\n"))
	}))
	defer server.Close()

	output, err := captureStdout(t, func() error {
		return run(controlClient{endpoint: server.URL, token: "secret", http: server.Client()}, []string{
			"events",
			"--limit",
			"1",
		})
	})
	if err != nil {
		t.Fatal(err)
	}
	if gotPath != "/v1/events" || gotAccept != "text/event-stream" || gotAuth != "Bearer secret" {
		t.Fatalf("unexpected event stream request path=%q accept=%q auth=%q", gotPath, gotAccept, gotAuth)
	}
	if !strings.Contains(output, `"topic": "project.changed"`) {
		t.Fatalf("unexpected event output %q", output)
	}
}

func TestRunGitDiffBuildsDiffRequest(t *testing.T) {
	var gotPath string
	var gotQuery string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotQuery = r.URL.RawQuery
		_, _ = w.Write([]byte(`{"patch":""}`))
	}))
	defer server.Close()

	err := run(controlClient{endpoint: server.URL, http: server.Client()}, []string{
		"git",
		"diff",
		"--project",
		"proj 1",
		"--path",
		"README.md",
		"--cached",
	})
	if err != nil {
		t.Fatal(err)
	}
	if gotPath != "/v1/source-control/diff" {
		t.Fatalf("unexpected path %q", gotPath)
	}
	if gotQuery != "cached=true&path=README.md&projectId=proj+1" {
		t.Fatalf("unexpected query %q", gotQuery)
	}
}

func TestRunSourceControlListBuildsFilteredRequest(t *testing.T) {
	var gotPath string
	var gotQuery string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotQuery = r.URL.RawQuery
		_, _ = w.Write([]byte(`[]`))
	}))
	defer server.Close()

	err := run(controlClient{endpoint: server.URL, http: server.Client()}, []string{
		"source-control",
		"list",
		"--project",
		"repo",
		"--workspace",
		"wt",
	})
	if err != nil {
		t.Fatal(err)
	}
	if gotPath != "/v1/source-control" {
		t.Fatalf("unexpected path %q", gotPath)
	}
	if gotQuery != "projectId=repo&workspaceId=wt" {
		t.Fatalf("unexpected query %q", gotQuery)
	}
}

func TestRunSourceControlUpdateBuildsProjectionRequest(t *testing.T) {
	var gotPath string
	var gotBody string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		body, _ := io.ReadAll(r.Body)
		gotBody = string(body)
		_, _ = w.Write([]byte(`{"syncStatus":"dirty"}`))
	}))
	defer server.Close()

	err := run(controlClient{endpoint: server.URL, http: server.Client()}, []string{
		"source-control",
		"update",
		"--project",
		"proj_1",
		"--branch",
		"feature",
		"--ahead",
		"2",
		"--change",
		"M:src/main.ts",
		"--change",
		"??:notes:todo.md",
	})
	if err != nil {
		t.Fatal(err)
	}
	if gotPath != "/v1/source-control/projections" {
		t.Fatalf("unexpected path %q", gotPath)
	}
	if !strings.Contains(gotBody, `"repositoryId":"proj_1"`) ||
		!strings.Contains(gotBody, `"workspaceId":"proj_1"`) ||
		!strings.Contains(gotBody, `"syncStatus":"dirty"`) ||
		!strings.Contains(gotBody, `"path":"src/main.ts"`) ||
		!strings.Contains(gotBody, `"status":"modified"`) ||
		!strings.Contains(gotBody, `"path":"notes:todo.md"`) ||
		!strings.Contains(gotBody, `"status":"untracked"`) {
		t.Fatalf("unexpected body %q", gotBody)
	}
}

func TestParseSourceControlChangesNormalizesStatuses(t *testing.T) {
	changes, err := parseSourceControlChanges([]string{
		"added:README.md",
		"D:src/old.ts",
		"!:cache.bin",
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(changes) != 3 {
		t.Fatalf("expected 3 changes, got %#v", changes)
	}
	if changes[0]["status"] != "added" || changes[1]["status"] != "deleted" || changes[2]["status"] != "ignored" {
		t.Fatalf("unexpected normalized statuses: %#v", changes)
	}
	if _, err := parseSourceControlChanges([]string{"unknown:file.txt"}); err == nil {
		t.Fatal("expected unsupported status error")
	}
}

func TestRunMobileRelayProjectionBuildsFilteredRequest(t *testing.T) {
	var gotPath string
	var gotQuery string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotQuery = r.URL.RawQuery
		_, _ = w.Write([]byte(`{"receivedAt":"2026-07-07T00:00:00Z"}`))
	}))
	defer server.Close()

	err := run(controlClient{endpoint: server.URL, http: server.Client()}, []string{
		"mobile-relay",
		"projection",
		"--projections",
		"browser,files",
		"--output-limit",
		"5",
	})
	if err != nil {
		t.Fatal(err)
	}
	if gotPath != "/v1/mobile-relay/projection" {
		t.Fatalf("unexpected path %q", gotPath)
	}
	if gotQuery != "outputLimit=5&projections=browser%2Cfiles" {
		t.Fatalf("unexpected query %q", gotQuery)
	}
}

func TestRunEmulatorCommandBuildsPayloadRequest(t *testing.T) {
	var gotPath string
	var gotBody string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		body, _ := io.ReadAll(r.Body)
		gotBody = string(body)
		_, _ = w.Write([]byte(`{"kind":"emulator.tap"}`))
	}))
	defer server.Close()

	err := run(controlClient{endpoint: server.URL, http: server.Client()}, []string{
		"emulator",
		"command",
		"--session",
		"session 1",
		"--command",
		"tap",
		"--payload-json",
		`{"x":12,"y":34}`,
	})
	if err != nil {
		t.Fatal(err)
	}
	if gotPath != "/v1/emulator/sessions/session 1/commands" {
		t.Fatalf("unexpected path %q", gotPath)
	}
	if !strings.Contains(gotBody, `"command":"tap"`) ||
		!strings.Contains(gotBody, `"x":12`) ||
		!strings.Contains(gotBody, `"y":34`) {
		t.Fatalf("unexpected body %q", gotBody)
	}
}

func TestRunProjectDeleteBuildsDeleteRequest(t *testing.T) {
	var gotMethod string
	var gotPath string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod = r.Method
		gotPath = r.URL.Path
		_, _ = w.Write([]byte(`{"id":"proj_1"}`))
	}))
	defer server.Close()

	err := run(controlClient{endpoint: server.URL, http: server.Client()}, []string{
		"project",
		"delete",
		"--id",
		"proj_1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if gotMethod != http.MethodDelete || gotPath != "/v1/projects/proj_1" {
		t.Fatalf("unexpected request %s %s", gotMethod, gotPath)
	}
}

func TestRunAgentProfileDeleteBuildsDeleteRequest(t *testing.T) {
	var gotMethod string
	var gotPath string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod = r.Method
		gotPath = r.URL.Path
		_, _ = w.Write([]byte(`{"id":"agent_1"}`))
	}))
	defer server.Close()

	err := run(controlClient{endpoint: server.URL, http: server.Client()}, []string{
		"agent",
		"profile-delete",
		"--id",
		"agent_1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if gotMethod != http.MethodDelete || gotPath != "/v1/agents/profiles/agent_1" {
		t.Fatalf("unexpected request %s %s", gotMethod, gotPath)
	}
}

func TestRunAgentRunStopBuildsDeleteRequest(t *testing.T) {
	var gotMethod string
	var gotPath string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod = r.Method
		gotPath = r.URL.Path
		_, _ = w.Write([]byte(`{"id":"arun_1"}`))
	}))
	defer server.Close()

	err := run(controlClient{endpoint: server.URL, http: server.Client()}, []string{
		"agent",
		"run-stop",
		"--id",
		"arun_1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if gotMethod != http.MethodDelete || gotPath != "/v1/agents/runs/arun_1" {
		t.Fatalf("unexpected request %s %s", gotMethod, gotPath)
	}
}

func captureStdout(t *testing.T, run func() error) (string, error) {
	t.Helper()
	readPipe, writePipe, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	original := os.Stdout
	os.Stdout = writePipe
	defer func() {
		os.Stdout = original
		_ = readPipe.Close()
	}()

	runErr := run()
	_ = writePipe.Close()
	content, readErr := io.ReadAll(readPipe)
	if readErr != nil {
		t.Fatal(readErr)
	}
	return string(content), runErr
}

func TestRunDispatchUpdateBuildsPatchRequest(t *testing.T) {
	var gotMethod string
	var gotPath string
	var gotBody string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod = r.Method
		gotPath = r.URL.Path
		body, _ := io.ReadAll(r.Body)
		gotBody = string(body)
		_, _ = w.Write([]byte(`{"id":"disp_1"}`))
	}))
	defer server.Close()

	err := run(controlClient{endpoint: server.URL, http: server.Client()}, []string{
		"dispatch",
		"update",
		"--id",
		"disp_1",
		"--status",
		"completed",
	})
	if err != nil {
		t.Fatal(err)
	}
	if gotMethod != http.MethodPatch || gotPath != "/v1/orchestration/dispatches/disp_1" {
		t.Fatalf("unexpected request %s %s", gotMethod, gotPath)
	}
	if gotBody != `{"status":"completed"}` {
		t.Fatalf("unexpected body %q", gotBody)
	}
}

func TestRunAutomationAddBuildsCreateRequest(t *testing.T) {
	var gotMethod string
	var gotPath string
	var gotBody string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod = r.Method
		gotPath = r.URL.Path
		body, _ := io.ReadAll(r.Body)
		gotBody = string(body)
		_, _ = w.Write([]byte(`{"id":"auto_1"}`))
	}))
	defer server.Close()

	err := run(controlClient{endpoint: server.URL, http: server.Client()}, []string{
		"automation",
		"add",
		"--name",
		"nightly",
		"--schedule",
		"interval",
		"--interval-seconds",
		"60",
		"--action",
		"createTask",
		"--payload",
		`{"title":"sync"}`,
	})
	if err != nil {
		t.Fatal(err)
	}
	if gotMethod != http.MethodPost || gotPath != "/v1/automations" {
		t.Fatalf("unexpected request %s %s", gotMethod, gotPath)
	}
	if !strings.Contains(gotBody, `"kind":"interval"`) ||
		!strings.Contains(gotBody, `"intervalSeconds":60`) ||
		!strings.Contains(gotBody, `"kind":"createTask"`) ||
		!strings.Contains(gotBody, `"title":"sync"`) {
		t.Fatalf("unexpected body %q", gotBody)
	}
}

func TestRunAutomationAddBuildsRruleScheduleRequest(t *testing.T) {
	var gotBody string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		gotBody = string(body)
		_, _ = w.Write([]byte(`{"id":"auto_2"}`))
	}))
	defer server.Close()

	err := run(controlClient{endpoint: server.URL, http: server.Client()}, []string{
		"automation",
		"add",
		"--name",
		"weekday standup",
		"--schedule",
		"rrule",
		"--rrule",
		"FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR",
		"--dtstart",
		"2026-01-05T09:00:00Z",
		"--action",
		"createTask",
		"--payload",
		`{"title":"standup"}`,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(gotBody, `"kind":"rrule"`) ||
		!strings.Contains(gotBody, `"rrule":"FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"`) ||
		!strings.Contains(gotBody, `"dtstart":"2026-01-05T09:00:00Z"`) {
		t.Fatalf("unexpected body %q", gotBody)
	}
}

func TestRunAutomationAddRejectsInvalidDtstart(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("server should not be called for an invalid --dtstart")
	}))
	defer server.Close()

	err := run(controlClient{endpoint: server.URL, http: server.Client()}, []string{
		"automation",
		"add",
		"--name",
		"bad",
		"--schedule",
		"rrule",
		"--rrule",
		"FREQ=DAILY",
		"--dtstart",
		"not-a-date",
		"--action",
		"createTask",
	})
	if err == nil {
		t.Fatal("expected error for invalid --dtstart")
	}
}

func TestRunAutomationTriggerBuildsRunRequest(t *testing.T) {
	var gotMethod string
	var gotPath string
	var gotBody string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod = r.Method
		gotPath = r.URL.Path
		body, _ := io.ReadAll(r.Body)
		gotBody = string(body)
		_, _ = w.Write([]byte(`{"id":"autorun_1"}`))
	}))
	defer server.Close()

	err := run(controlClient{endpoint: server.URL, http: server.Client()}, []string{
		"automation",
		"trigger",
		"--id",
		"auto_1",
		"--reason",
		"event",
		"--payload",
		`{"title":"from event"}`,
	})
	if err != nil {
		t.Fatal(err)
	}
	if gotMethod != http.MethodPost || gotPath != "/v1/automations/auto_1/runs" {
		t.Fatalf("unexpected request %s %s", gotMethod, gotPath)
	}
	if !strings.Contains(gotBody, `"reason":"event"`) ||
		!strings.Contains(gotBody, `"title":"from event"`) {
		t.Fatalf("unexpected body %q", gotBody)
	}
}

func TestRunExternalTaskUpsertBuildsProviderNeutralRequest(t *testing.T) {
	var gotMethod string
	var gotPath string
	var gotBody string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod = r.Method
		gotPath = r.URL.Path
		body, _ := io.ReadAll(r.Body)
		gotBody = string(body)
		_, _ = w.Write([]byte(`{"id":"ext_1"}`))
	}))
	defer server.Close()

	err := run(controlClient{endpoint: server.URL, http: server.Client()}, []string{
		"external-task",
		"upsert",
		"--provider",
		"gitlab",
		"--external-id",
		"mr-42",
		"--title",
		"review runtime",
		"--kind",
		"review",
		"--repository",
		"repo_1",
		"--review-kind",
		"merge_request",
		"--metadata",
		`{"labels":["runtime"]}`,
	})
	if err != nil {
		t.Fatal(err)
	}
	if gotMethod != http.MethodPost || gotPath != "/v1/external-tasks" {
		t.Fatalf("unexpected request %s %s", gotMethod, gotPath)
	}
	if !strings.Contains(gotBody, `"provider":"gitlab"`) ||
		!strings.Contains(gotBody, `"externalId":"mr-42"`) ||
		!strings.Contains(gotBody, `"reviewKind":"merge_request"`) {
		t.Fatalf("unexpected body %q", gotBody)
	}
}

func TestRunExternalTaskListBuildsFilteredRequest(t *testing.T) {
	var gotPath string
	var gotQuery string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotQuery = r.URL.RawQuery
		_, _ = w.Write([]byte(`[]`))
	}))
	defer server.Close()

	err := run(controlClient{endpoint: server.URL, http: server.Client()}, []string{
		"external-task",
		"list",
		"--provider",
		"linear",
		"--task",
		"task_1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if gotPath != "/v1/external-tasks" || gotQuery != "provider=linear&taskId=task_1" {
		t.Fatalf("unexpected request %s?%s", gotPath, gotQuery)
	}
}

func TestRunFileReadBuildsReadRequest(t *testing.T) {
	var gotPath string
	var gotQuery string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotQuery = r.URL.RawQuery
		_, _ = w.Write([]byte(`{"content":""}`))
	}))
	defer server.Close()

	err := run(controlClient{endpoint: server.URL, http: server.Client()}, []string{
		"file",
		"read",
		"--project",
		"proj_1",
		"--path",
		"docs/readme.md",
		"--max-bytes",
		"4096",
	})
	if err != nil {
		t.Fatal(err)
	}
	if gotPath != "/v1/files/read" || gotQuery != "maxBytes=4096&path=docs%2Freadme.md&projectId=proj_1" {
		t.Fatalf("unexpected request %s?%s", gotPath, gotQuery)
	}
}

func TestRunFileWriteBuildsWriteRequest(t *testing.T) {
	var gotMethod string
	var gotPath string
	var gotBody string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod = r.Method
		gotPath = r.URL.Path
		body, _ := io.ReadAll(r.Body)
		gotBody = string(body)
		_, _ = w.Write([]byte(`{"path":"docs/readme.md"}`))
	}))
	defer server.Close()

	err := run(controlClient{endpoint: server.URL, http: server.Client()}, []string{
		"file",
		"write",
		"--project",
		"proj_1",
		"--path",
		"docs/readme.md",
		"--content",
		"hello",
		"--create-dirs",
	})
	if err != nil {
		t.Fatal(err)
	}
	if gotMethod != http.MethodPost || gotPath != "/v1/files/write" {
		t.Fatalf("unexpected request %s %s", gotMethod, gotPath)
	}
	if !strings.Contains(gotBody, `"projectId":"proj_1"`) ||
		!strings.Contains(gotBody, `"path":"docs/readme.md"`) ||
		!strings.Contains(gotBody, `"createDirs":true`) {
		t.Fatalf("unexpected body %q", gotBody)
	}
}

func TestRunFileContentUpdateBuildsSnapshotRequest(t *testing.T) {
	var gotPath string
	var gotBody string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		body, _ := io.ReadAll(r.Body)
		gotBody = string(body)
		_, _ = w.Write([]byte(`{"path":"README.md"}`))
	}))
	defer server.Close()

	err := run(controlClient{endpoint: server.URL, http: server.Client()}, []string{
		"file",
		"content-update",
		"--project",
		"proj_remote",
		"--path",
		"README.md",
		"--content",
		"remote",
	})
	if err != nil {
		t.Fatal(err)
	}
	if gotPath != "/v1/files/content-snapshots" {
		t.Fatalf("unexpected path %q", gotPath)
	}
	if !strings.Contains(gotBody, `"projectId":"proj_remote"`) ||
		!strings.Contains(gotBody, `"path":"README.md"`) ||
		!strings.Contains(gotBody, `"content":"remote"`) {
		t.Fatalf("unexpected body %q", gotBody)
	}
}

func TestRunReleaseArtifactBuildsArtifactRequest(t *testing.T) {
	var gotMethod string
	var gotPath string
	var gotBody string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod = r.Method
		gotPath = r.URL.Path
		body, _ := io.ReadAll(r.Body)
		gotBody = string(body)
		_, _ = w.Write([]byte(`{"id":"rel_1"}`))
	}))
	defer server.Close()

	err := run(controlClient{endpoint: server.URL, http: server.Client()}, []string{
		"release",
		"artifact",
		"--id",
		"rel_1",
		"--platform",
		"windows",
		"--kind",
		"appArchive",
		"--name",
		"nsis",
		"--uri",
		"file://pebble.exe",
		"--signed",
	})
	if err != nil {
		t.Fatal(err)
	}
	if gotMethod != http.MethodPost || gotPath != "/v1/releases/rel_1/artifacts" {
		t.Fatalf("unexpected request %s %s", gotMethod, gotPath)
	}
	if !strings.Contains(gotBody, `"platform":"windows"`) ||
		!strings.Contains(gotBody, `"kind":"appArchive"`) ||
		!strings.Contains(gotBody, `"signed":true`) {
		t.Fatalf("unexpected body %q", gotBody)
	}
}

func TestRunReleasePublishBuildsPublishRequest(t *testing.T) {
	var gotPath string
	var gotBody string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		body, _ := io.ReadAll(r.Body)
		gotBody = string(body)
		_, _ = w.Write([]byte(`{"status":"published"}`))
	}))
	defer server.Close()

	err := run(controlClient{endpoint: server.URL, http: server.Client()}, []string{
		"release",
		"publish",
		"--id",
		"rel_1",
		"--force",
	})
	if err != nil {
		t.Fatal(err)
	}
	if gotPath != "/v1/releases/rel_1/publish" || gotBody != `{"force":true}` {
		t.Fatalf("unexpected request %s body %q", gotPath, gotBody)
	}
}

func TestRunReleaseManifestBuildsManifestRequest(t *testing.T) {
	var gotMethod string
	var gotPath string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod = r.Method
		gotPath = r.URL.Path
		_, _ = w.Write([]byte(`{"releaseId":"rel_1"}`))
	}))
	defer server.Close()

	err := run(controlClient{endpoint: server.URL, http: server.Client()}, []string{
		"release",
		"manifest",
		"--id",
		"rel_1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if gotMethod != http.MethodGet || gotPath != "/v1/releases/rel_1/manifest" {
		t.Fatalf("unexpected request %s %s", gotMethod, gotPath)
	}
}

func TestRunSettingsSetBuildsSettingRequest(t *testing.T) {
	var gotPath string
	var gotBody string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		body, _ := io.ReadAll(r.Body)
		gotBody = string(body)
		_, _ = w.Write([]byte(`{"id":"setting"}`))
	}))
	defer server.Close()

	err := run(controlClient{endpoint: server.URL, http: server.Client()}, []string{
		"settings",
		"set",
		"--key",
		"workbench.density",
		"--value",
		`{"value":"compact"}`,
	})
	if err != nil {
		t.Fatal(err)
	}
	if gotPath != "/v1/settings" ||
		!strings.Contains(gotBody, `"key":"workbench.density"`) ||
		!strings.Contains(gotBody, `"value":"compact"`) {
		t.Fatalf("unexpected request %s body %q", gotPath, gotBody)
	}
}

func TestRunSettingsKeybindingSetBuildsKeybindingRequest(t *testing.T) {
	var gotPath string
	var gotBody string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		body, _ := io.ReadAll(r.Body)
		gotBody = string(body)
		_, _ = w.Write([]byte(`{"id":"keybinding"}`))
	}))
	defer server.Close()

	err := run(controlClient{endpoint: server.URL, http: server.Client()}, []string{
		"settings",
		"keybinding-set",
		"--command",
		"command.palette",
		"--accelerator",
		"CmdOrCtrl+Shift+P",
		"--context",
		"workbench",
	})
	if err != nil {
		t.Fatal(err)
	}
	if gotPath != "/v1/settings/keybindings" ||
		!strings.Contains(gotBody, `"command":"command.palette"`) ||
		!strings.Contains(gotBody, `"accelerator":"CmdOrCtrl+Shift+P"`) {
		t.Fatalf("unexpected request %s body %q", gotPath, gotBody)
	}
}

func TestRunWorktreeDeleteBuildsDeleteRequest(t *testing.T) {
	var gotMethod string
	var gotPath string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod = r.Method
		gotPath = r.URL.Path
		_, _ = w.Write([]byte(`{"id":"wt_1"}`))
	}))
	defer server.Close()

	err := run(controlClient{endpoint: server.URL, http: server.Client()}, []string{
		"worktree",
		"delete",
		"--id",
		"wt_1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if gotMethod != http.MethodDelete || gotPath != "/v1/worktrees/wt_1" {
		t.Fatalf("unexpected request %s %s", gotMethod, gotPath)
	}
}

func TestRunComputerClaimBuildsClaimRequest(t *testing.T) {
	var gotPath string
	var gotBody string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		body, _ := io.ReadAll(r.Body)
		gotBody = string(body)
		_, _ = w.Write([]byte(`[]`))
	}))
	defer server.Close()

	err := run(controlClient{endpoint: server.URL, http: server.Client()}, []string{
		"computer",
		"claim",
		"--kind-prefix",
		"browser.",
		"--limit",
		"2",
	})
	if err != nil {
		t.Fatal(err)
	}
	if gotPath != "/v1/computer/actions/claim" {
		t.Fatalf("unexpected path %q", gotPath)
	}
	if gotBody != `{"kindPrefix":"browser.","limit":2}` {
		t.Fatalf("unexpected body %q", gotBody)
	}
}

func TestRunComputerQueueBuildsPayloadRequest(t *testing.T) {
	var gotPath string
	var gotBody string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		body, _ := io.ReadAll(r.Body)
		gotBody = string(body)
		_, _ = w.Write([]byte(`{"id":"cact_1"}`))
	}))
	defer server.Close()

	err := run(controlClient{endpoint: server.URL, http: server.Client()}, []string{
		"computer",
		"queue",
		"--kind",
		"native.open",
		"--target",
		"window_1",
		"--payload-json",
		`{"path":"/tmp/report.txt"}`,
	})
	if err != nil {
		t.Fatal(err)
	}
	if gotPath != "/v1/computer/actions" {
		t.Fatalf("unexpected path %q", gotPath)
	}
	if !strings.Contains(gotBody, `"kind":"native.open"`) ||
		!strings.Contains(gotBody, `"target":"window_1"`) ||
		!strings.Contains(gotBody, `"path":"/tmp/report.txt"`) {
		t.Fatalf("unexpected body %q", gotBody)
	}
}

func TestRunComputerQueueRejectsNullPayload(t *testing.T) {
	err := run(controlClient{}, []string{
		"computer",
		"queue",
		"--kind",
		"native.open",
		"--payload-json",
		`null`,
	})
	if err == nil || !strings.Contains(err.Error(), "JSON value must be an object") {
		t.Fatalf("expected null payload to be rejected, got %v", err)
	}
}

func TestRunFileTreeUpdateRejectsNullEntries(t *testing.T) {
	err := run(controlClient{}, []string{
		"file",
		"tree-update",
		"--project",
		"proj_1",
		"--entries",
		`null`,
	})
	if err == nil || !strings.Contains(err.Error(), "JSON value must be an array") {
		t.Fatalf("expected null entries to be rejected, got %v", err)
	}
}

func TestRunFileTreeUpdateBlankEntriesSendEmptyArray(t *testing.T) {
	var gotBody string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		gotBody = string(body)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer server.Close()

	err := run(controlClient{endpoint: server.URL, http: server.Client()}, []string{
		"file",
		"tree-update",
		"--project",
		"proj_1",
		"--entries",
		"",
	})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(gotBody, `"entries":[]`) {
		t.Fatalf("expected empty entries array, got %q", gotBody)
	}
}

func TestRunBrowserCloseBuildsDeleteRequest(t *testing.T) {
	var gotMethod string
	var gotPath string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod = r.Method
		gotPath = r.URL.Path
		_, _ = w.Write([]byte(`{"id":"tab_1"}`))
	}))
	defer server.Close()

	err := run(controlClient{endpoint: server.URL, http: server.Client()}, []string{
		"browser",
		"close",
		"--id",
		"tab_1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if gotMethod != http.MethodDelete || gotPath != "/v1/browser/tabs/tab_1" {
		t.Fatalf("unexpected request %s %s", gotMethod, gotPath)
	}
}

func TestRunBrowserCommandBuildsCommandRequest(t *testing.T) {
	var gotMethod string
	var gotPath string
	var gotBody string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod = r.Method
		gotPath = r.URL.Path
		body, _ := io.ReadAll(r.Body)
		gotBody = string(body)
		_, _ = w.Write([]byte(`{"id":"cact_1"}`))
	}))
	defer server.Close()

	err := run(controlClient{endpoint: server.URL, http: server.Client()}, []string{
		"browser",
		"command",
		"--id",
		"tab 1",
		"--command",
		"reload",
	})
	if err != nil {
		t.Fatal(err)
	}
	if gotMethod != http.MethodPost || gotPath != "/v1/browser/tabs/tab 1/commands" {
		t.Fatalf("unexpected request %s %s", gotMethod, gotPath)
	}
	if gotBody != `{"command":"reload"}` {
		t.Fatalf("unexpected body %q", gotBody)
	}
}

func TestRunBrowserUpdateBuildsScreenshotRequest(t *testing.T) {
	var gotMethod string
	var gotPath string
	var gotBody string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod = r.Method
		gotPath = r.URL.Path
		body, _ := io.ReadAll(r.Body)
		gotBody = string(body)
		_, _ = w.Write([]byte(`{"id":"tab_1"}`))
	}))
	defer server.Close()

	err := run(controlClient{endpoint: server.URL, http: server.Client()}, []string{
		"browser",
		"update",
		"--id",
		"tab_1",
		"--status",
		"ready",
		"--screenshot-uri",
		"file:///tmp/tab.png",
		"--screenshot-captured-at",
		"2026-07-07T03:04:05Z",
	})
	if err != nil {
		t.Fatal(err)
	}
	if gotMethod != http.MethodPatch || gotPath != "/v1/browser/tabs/tab_1" {
		t.Fatalf("unexpected request %s %s", gotMethod, gotPath)
	}
	if !strings.Contains(gotBody, `"screenshotUri":"file:///tmp/tab.png"`) ||
		!strings.Contains(gotBody, `"screenshotCapturedAt":"2026-07-07T03:04:05Z"`) ||
		!strings.Contains(gotBody, `"status":"ready"`) {
		t.Fatalf("unexpected body %q", gotBody)
	}
}

func TestRunBrowserPermissionSetBuildsPermissionRequest(t *testing.T) {
	var gotMethod string
	var gotPath string
	var gotBody string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod = r.Method
		gotPath = r.URL.Path
		body, _ := io.ReadAll(r.Body)
		gotBody = string(body)
		_, _ = w.Write([]byte(`{"id":"bperm_1"}`))
	}))
	defer server.Close()

	err := run(controlClient{endpoint: server.URL, http: server.Client()}, []string{
		"browser",
		"permission-set",
		"--profile",
		"bprof_1",
		"--origin",
		"https://example.test",
		"--name",
		"camera",
		"--state",
		"granted",
	})
	if err != nil {
		t.Fatal(err)
	}
	if gotMethod != http.MethodPost || gotPath != "/v1/browser/permissions" {
		t.Fatalf("unexpected request %s %s", gotMethod, gotPath)
	}
	if gotBody != `{"name":"camera","origin":"https://example.test","profileId":"bprof_1","state":"granted"}` {
		t.Fatalf("unexpected body %q", gotBody)
	}
}

func TestRunBrowserDownloadUpdateBuildsPatchRequest(t *testing.T) {
	var gotMethod string
	var gotPath string
	var gotBody string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod = r.Method
		gotPath = r.URL.Path
		body, _ := io.ReadAll(r.Body)
		gotBody = string(body)
		_, _ = w.Write([]byte(`{"id":"bdl_1"}`))
	}))
	defer server.Close()

	err := run(controlClient{endpoint: server.URL, http: server.Client()}, []string{
		"browser",
		"download-update",
		"--id",
		"bdl_1",
		"--status",
		"completed",
		"--filename",
		"archive.zip",
		"--path",
		"/tmp/archive.zip",
		"--bytes-received",
		"120",
		"--total-bytes",
		"512",
	})
	if err != nil {
		t.Fatal(err)
	}
	if gotMethod != http.MethodPatch || gotPath != "/v1/browser/downloads/bdl_1" {
		t.Fatalf("unexpected request %s %s", gotMethod, gotPath)
	}
	if !strings.Contains(gotBody, `"filename":"archive.zip"`) ||
		!strings.Contains(gotBody, `"path":"/tmp/archive.zip"`) ||
		!strings.Contains(gotBody, `"status":"completed"`) ||
		!strings.Contains(gotBody, `"bytesReceived":120`) ||
		!strings.Contains(gotBody, `"totalBytes":512`) {
		t.Fatalf("unexpected body %q", gotBody)
	}
}

func TestRunBrowserDownloadStartBuildsCommandRequest(t *testing.T) {
	var gotMethod string
	var gotPath string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod = r.Method
		gotPath = r.URL.Path
		_, _ = w.Write([]byte(`{"id":"cact_1"}`))
	}))
	defer server.Close()

	err := run(controlClient{endpoint: server.URL, http: server.Client()}, []string{
		"browser",
		"download-start",
		"--id",
		"bdl_1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if gotMethod != http.MethodPost || gotPath != "/v1/browser/downloads/bdl_1/commands/start" {
		t.Fatalf("unexpected request %s %s", gotMethod, gotPath)
	}
}

func TestRunEmulatorDetachBuildsDeleteRequest(t *testing.T) {
	var gotMethod string
	var gotPath string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod = r.Method
		gotPath = r.URL.Path
		_, _ = w.Write([]byte(`{"active":false}`))
	}))
	defer server.Close()

	err := run(controlClient{endpoint: server.URL, http: server.Client()}, []string{
		"emulator",
		"detach",
		"--id",
		"emus_1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if gotMethod != http.MethodDelete || gotPath != "/v1/emulator/sessions/emus_1" {
		t.Fatalf("unexpected request %s %s", gotMethod, gotPath)
	}
}

func TestRunEmulatorCommandBuildsCommandRequest(t *testing.T) {
	var gotMethod string
	var gotPath string
	var gotBody string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod = r.Method
		gotPath = r.URL.Path
		body, _ := io.ReadAll(r.Body)
		gotBody = string(body)
		_, _ = w.Write([]byte(`{"id":"cact_1"}`))
	}))
	defer server.Close()

	err := run(controlClient{endpoint: server.URL, http: server.Client()}, []string{
		"emulator",
		"command",
		"--session",
		"emus_1",
		"--command",
		"screenshot",
	})
	if err != nil {
		t.Fatal(err)
	}
	if gotMethod != http.MethodPost || gotPath != "/v1/emulator/sessions/emus_1/commands" {
		t.Fatalf("unexpected request %s %s", gotMethod, gotPath)
	}
	if gotBody != `{"command":"screenshot"}` {
		t.Fatalf("unexpected body %q", gotBody)
	}
}

func TestRunProviderRegisterBuildsProviderRequest(t *testing.T) {
	var gotPath string
	var gotBody string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		body, _ := io.ReadAll(r.Body)
		gotBody = string(body)
		_, _ = w.Write([]byte(`{"id":"browser:tauri-webview"}`))
	}))
	defer server.Close()

	err := run(controlClient{endpoint: server.URL, http: server.Client()}, []string{
		"provider",
		"register",
		"--subsystem",
		"browser",
		"--name",
		"tauri-webview",
		"--capabilities",
		"tabs,screenshots",
	})
	if err != nil {
		t.Fatal(err)
	}
	if gotPath != "/v1/providers" {
		t.Fatalf("unexpected path %q", gotPath)
	}
	if !strings.Contains(gotBody, `"subsystem":"browser"`) ||
		!strings.Contains(gotBody, `"capabilities":["tabs","screenshots"]`) {
		t.Fatalf("unexpected body %q", gotBody)
	}
}
