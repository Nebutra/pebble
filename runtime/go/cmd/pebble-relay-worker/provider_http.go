package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"

	"github.com/nebutra/pebble/runtime/go/internal/runtimecore"
	"github.com/nebutra/pebble/runtime/go/internal/runtimehttp"
)

func runProviderHTTPJSON(input io.Reader, output io.Writer) error {
	var envelope struct {
		Root    string                           `json:"root"`
		Request runtimecore.ProviderRelayRequest `json:"request"`
	}
	if err := json.NewDecoder(io.LimitReader(input, 16*1024*1024+1)).Decode(&envelope); err != nil {
		return err
	}
	stateDir, err := os.MkdirTemp("", "pebble-provider-relay-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(stateDir)
	manager, err := runtimecore.NewManager(stateDir, nil)
	if err != nil {
		return err
	}
	project, err := manager.CreateProject(runtimecore.CreateProjectRequest{
		Name: "Remote provider workspace", Path: strings.TrimSpace(envelope.Root),
		LocationKind: "local", Provider: "git",
	})
	if err != nil {
		return err
	}
	request, err := rewriteProviderRelayRequest(envelope.Request, project.ID)
	if err != nil {
		return err
	}
	recorder := httptest.NewRecorder()
	runtimehttp.NewServer(manager).ServeHTTP(recorder, request)
	response := runtimecore.ProviderRelayResponse{
		Status:  recorder.Code,
		Headers: map[string]string{"Content-Type": recorder.Header().Get("Content-Type")},
		Body:    recorder.Body.Bytes(),
	}
	return json.NewEncoder(output).Encode(response)
}

func rewriteProviderRelayRequest(input runtimecore.ProviderRelayRequest, projectID string) (*http.Request, error) {
	if !strings.HasPrefix(input.Path, "/v1/providers/") {
		return nil, errors.New("provider relay path is outside the provider API")
	}
	query, err := url.ParseQuery(input.RawQuery)
	if err != nil {
		return nil, err
	}
	query.Set("projectId", projectID)
	query.Del("worktreeId")
	body := input.Body
	if len(body) > 0 && (strings.Contains(input.Headers["Content-Type"], "application/json") || body[0] == '{') {
		var payload map[string]any
		if json.Unmarshal(body, &payload) == nil {
			payload["projectId"] = projectID
			delete(payload, "worktreeId")
			body, err = json.Marshal(payload)
			if err != nil {
				return nil, err
			}
		}
	}
	request := httptest.NewRequest(input.Method, input.Path+"?"+query.Encode(), bytes.NewReader(body))
	for key, value := range input.Headers {
		request.Header.Set(key, value)
	}
	return request, nil
}
