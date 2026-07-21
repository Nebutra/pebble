package runtimehttp

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/nebutra/pebble/runtime/go/internal/runtimecore"
)

func TestBrowserDriverSnapshotAndDesktopReclaimRoutes(t *testing.T) {
	manager, err := runtimecore.NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	tab, err := manager.CreateBrowserTab(runtimecore.CreateBrowserTabRequest{URL: "https://example.com"})
	if err != nil {
		t.Fatal(err)
	}
	manager.MobileTookBrowserFloor(tab.ID, "phone-1")
	server := NewServer(manager)

	recorder := httptest.NewRecorder()
	server.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/v1/browser/drivers", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("snapshot status = %d", recorder.Code)
	}
	var snapshots []map[string]interface{}
	if err := json.Unmarshal(recorder.Body.Bytes(), &snapshots); err != nil || len(snapshots) != 1 {
		t.Fatalf("invalid snapshots: %#v, %v", snapshots, err)
	}

	recorder = httptest.NewRecorder()
	server.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, "/v1/browser/tabs/"+tab.ID+"/reclaim-desktop", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("reclaim status = %d: %s", recorder.Code, recorder.Body.String())
	}
	if driver := manager.GetBrowserDriver(tab.ID); driver.Kind != "desktop" {
		t.Fatalf("driver after reclaim: %+v", driver)
	}
}
