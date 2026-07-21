package runtimehttp

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestNestedScanCancelEndpointCancelsActiveContext(t *testing.T) {
	server := &Server{nestedScanCancels: make(map[string]*nestedScanCancellation)}
	ctx, done := server.beginNestedScan(context.Background(), "scan-1")
	defer done()

	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(
		http.MethodPost,
		"/v1/project-groups/scan-nested/cancel",
		bytes.NewBufferString(`{"scanId":"scan-1"}`),
	)
	server.handleProjectGroupScanNestedCancel(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", recorder.Code, recorder.Body.String())
	}
	if ctx.Err() != context.Canceled {
		t.Fatalf("expected active scan context cancellation, got %v", ctx.Err())
	}
}

func TestNestedScanCleanupDoesNotRemoveReplacement(t *testing.T) {
	server := &Server{nestedScanCancels: make(map[string]*nestedScanCancellation)}
	oldContext, finishOld := server.beginNestedScan(context.Background(), "scan-1")
	newContext, finishNew := server.beginNestedScan(context.Background(), "scan-1")
	defer finishNew()

	if oldContext.Err() != context.Canceled {
		t.Fatal("replacement must cancel the previous scan")
	}
	finishOld()
	if !server.cancelNestedScan("scan-1") {
		t.Fatal("old cleanup removed the replacement scan")
	}
	if newContext.Err() != context.Canceled {
		t.Fatal("replacement scan was not canceled")
	}
}
