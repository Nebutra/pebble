package runtimecore

import (
	"encoding/json"
	"reflect"
	"testing"
)

func TestAccountsSnapshotPersistsAndProjectsToMobile(t *testing.T) {
	dir := t.TempDir()
	manager, err := NewManager(dir, nil)
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := manager.SetAccountsSnapshot(AccountsSnapshot{
		Claude:     json.RawMessage(`{"accounts":[{"id":"claude-1"}],"activeAccountId":"claude-1"}`),
		Codex:      json.RawMessage(`{"accounts":[],"activeAccountId":null}`),
		RateLimits: json.RawMessage(`{"claude":{"status":"ready"},"codex":null}`),
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshot) == 0 {
		t.Fatal("expected stored accounts snapshot")
	}
	projected := manager.MobileRelaySnapshot([]ProjectionKind{ProjectionAccounts}, 0)
	if string(projected.Accounts) != string(snapshot) {
		t.Fatalf("mobile projection mismatch: %s", projected.Accounts)
	}

	reloaded, err := NewManager(dir, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !sameJSON(reloaded.GetAccountsSnapshot(), snapshot) {
		t.Fatal("accounts snapshot did not survive runtime restart")
	}
}

func sameJSON(left, right json.RawMessage) bool {
	var leftValue interface{}
	var rightValue interface{}
	return json.Unmarshal(left, &leftValue) == nil &&
		json.Unmarshal(right, &rightValue) == nil &&
		reflect.DeepEqual(leftValue, rightValue)
}

func TestAccountsSnapshotRejectsNonObjectFields(t *testing.T) {
	manager, err := NewManager(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	_, err = manager.SetAccountsSnapshot(AccountsSnapshot{
		Claude:     json.RawMessage(`[]`),
		Codex:      json.RawMessage(`{}`),
		RateLimits: json.RawMessage(`{}`),
	})
	if err == nil {
		t.Fatal("expected non-object account field to be rejected")
	}
}
