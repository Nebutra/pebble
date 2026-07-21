package runtimecore

import (
	"sync"
	"testing"
)

func TestRemoteWorkspacePatchUsesRevisionCompareAndSwap(t *testing.T) {
	root := t.TempDir()
	first, err := PatchRemoteWorkspace(root, RemoteWorkspacePatchRequest{
		Namespace: "target-a", BaseRevision: 0, ClientID: "client-a",
		Patch: RemoteWorkspacePatch{Kind: "replace-session", Session: RemoteWorkspaceSession{"activeTabId": "tab-a"}},
	})
	if err != nil || !first.OK || first.Snapshot == nil || first.Snapshot.Revision != 1 {
		t.Fatalf("unexpected first patch: %#v %v", first, err)
	}
	stale, err := PatchRemoteWorkspace(root, RemoteWorkspacePatchRequest{
		Namespace: "target-a", BaseRevision: 0, ClientID: "client-b",
		Patch: RemoteWorkspacePatch{Kind: "replace-session", Session: RemoteWorkspaceSession{"activeTabId": "tab-b"}},
	})
	if err != nil || stale.OK || stale.Reason != "stale-revision" || stale.Snapshot == nil || stale.Snapshot.Revision != 1 {
		t.Fatalf("expected stale revision: %#v %v", stale, err)
	}
}

func TestRemoteWorkspaceConcurrentPatchHasSingleWinner(t *testing.T) {
	root := t.TempDir()
	results := make(chan RemoteWorkspacePatchResult, 2)
	var group sync.WaitGroup
	for _, tab := range []string{"tab-a", "tab-b"} {
		group.Add(1)
		go func(tab string) {
			defer group.Done()
			result, _ := PatchRemoteWorkspace(root, RemoteWorkspacePatchRequest{
				Namespace: "target-a", BaseRevision: 0, ClientID: tab,
				Patch: RemoteWorkspacePatch{Kind: "replace-session", Session: RemoteWorkspaceSession{"activeTabId": tab}},
			})
			results <- result
		}(tab)
	}
	group.Wait()
	close(results)
	winners := 0
	for result := range results {
		if result.OK {
			winners++
		}
	}
	if winners != 1 {
		t.Fatalf("expected exactly one revision winner, got %d", winners)
	}
}

func TestRemoteWorkspacePresenceTracksClients(t *testing.T) {
	root := t.TempDir()
	for _, client := range []string{"client-a", "client-b"} {
		if _, err := TouchRemoteWorkspacePresence(root, RemoteWorkspacePresenceRequest{Namespace: "target-a", ClientID: client, ClientName: client}); err != nil {
			t.Fatal(err)
		}
	}
	result, err := TouchRemoteWorkspacePresence(root, RemoteWorkspacePresenceRequest{Namespace: "target-a", ClientID: "client-a", ClientName: "This device"})
	if err != nil || len(result.Clients) != 2 {
		t.Fatalf("unexpected presence: %#v %v", result, err)
	}
}
