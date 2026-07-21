package runtimecore

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const remoteWorkspaceSchemaVersion = 1
const remoteWorkspaceMaxBytes = 16 * 1024 * 1024
const remoteWorkspacePresenceTTL = 2 * time.Minute

type RemoteWorkspaceSession map[string]any

type RemoteWorkspaceSnapshot struct {
	Namespace     string                 `json:"namespace"`
	Revision      int64                  `json:"revision"`
	UpdatedAt     int64                  `json:"updatedAt"`
	SchemaVersion int                    `json:"schemaVersion"`
	Session       RemoteWorkspaceSession `json:"session"`
}

type RemoteWorkspacePatchRequest struct {
	Namespace    string               `json:"namespace"`
	BaseRevision int64                `json:"baseRevision"`
	ClientID     string               `json:"clientId"`
	Patch        RemoteWorkspacePatch `json:"patch"`
}

type RemoteWorkspacePatch struct {
	Kind    string                 `json:"kind"`
	Session RemoteWorkspaceSession `json:"session"`
}

type RemoteWorkspacePatchResult struct {
	OK       bool                     `json:"ok"`
	Reason   string                   `json:"reason,omitempty"`
	Snapshot *RemoteWorkspaceSnapshot `json:"snapshot,omitempty"`
	Message  string                   `json:"message,omitempty"`
}

type RemoteWorkspacePresenceRequest struct {
	Namespace  string `json:"namespace"`
	ClientID   string `json:"clientId"`
	ClientName string `json:"clientName"`
}

type RemoteWorkspaceConnectedClient struct {
	ClientID   string `json:"clientId"`
	Name       string `json:"name"`
	LastSeenAt int64  `json:"lastSeenAt"`
}

type RemoteWorkspacePresenceResult struct {
	Clients []RemoteWorkspaceConnectedClient `json:"clients"`
}

type remoteWorkspaceDocument struct {
	Snapshot RemoteWorkspaceSnapshot                   `json:"snapshot"`
	Clients  map[string]RemoteWorkspaceConnectedClient `json:"clients,omitempty"`
}

func ReadRemoteWorkspace(root, namespace string) (RemoteWorkspaceSnapshot, error) {
	path, err := remoteWorkspaceDocumentPath(root, namespace)
	if err != nil {
		return RemoteWorkspaceSnapshot{}, err
	}
	document, err := readRemoteWorkspaceDocument(path, namespace)
	return document.Snapshot, err
}

func PatchRemoteWorkspace(root string, req RemoteWorkspacePatchRequest) (RemoteWorkspacePatchResult, error) {
	if req.Patch.Kind != "replace-session" || req.Patch.Session == nil {
		return RemoteWorkspacePatchResult{}, errors.New("unsupported remote workspace patch")
	}
	path, err := remoteWorkspaceDocumentPath(root, req.Namespace)
	if err != nil {
		return RemoteWorkspacePatchResult{}, err
	}
	var result RemoteWorkspacePatchResult
	err = withRemoteWorkspaceLock(path, func() error {
		document, readErr := readRemoteWorkspaceDocument(path, req.Namespace)
		if readErr != nil {
			return readErr
		}
		if document.Snapshot.Revision != req.BaseRevision {
			result = RemoteWorkspacePatchResult{Reason: "stale-revision", Snapshot: &document.Snapshot}
			return nil
		}
		document.Snapshot.Revision++
		document.Snapshot.UpdatedAt = time.Now().UnixMilli()
		document.Snapshot.Session = req.Patch.Session
		if err := writeRemoteWorkspaceDocument(path, document); err != nil {
			return err
		}
		result = RemoteWorkspacePatchResult{OK: true, Snapshot: &document.Snapshot}
		return nil
	})
	return result, err
}

func TouchRemoteWorkspacePresence(root string, req RemoteWorkspacePresenceRequest) (RemoteWorkspacePresenceResult, error) {
	if strings.TrimSpace(req.ClientID) == "" || len(req.ClientID) > 200 {
		return RemoteWorkspacePresenceResult{}, errors.New("invalid remote workspace client id")
	}
	path, err := remoteWorkspaceDocumentPath(root, req.Namespace)
	if err != nil {
		return RemoteWorkspacePresenceResult{}, err
	}
	result := RemoteWorkspacePresenceResult{Clients: []RemoteWorkspaceConnectedClient{}}
	err = withRemoteWorkspaceLock(path, func() error {
		document, readErr := readRemoteWorkspaceDocument(path, req.Namespace)
		if readErr != nil {
			return readErr
		}
		now := time.Now()
		for id, client := range document.Clients {
			if now.Sub(time.UnixMilli(client.LastSeenAt)) > remoteWorkspacePresenceTTL {
				delete(document.Clients, id)
			}
		}
		name := strings.Join(strings.Fields(req.ClientName), " ")
		if name == "" {
			name = "Unknown device"
		}
		if len(name) > 80 {
			name = name[:80]
		}
		document.Clients[req.ClientID] = RemoteWorkspaceConnectedClient{ClientID: req.ClientID, Name: name, LastSeenAt: now.UnixMilli()}
		if err := writeRemoteWorkspaceDocument(path, document); err != nil {
			return err
		}
		for _, client := range document.Clients {
			result.Clients = append(result.Clients, client)
		}
		sort.Slice(result.Clients, func(i, j int) bool { return result.Clients[i].ClientID < result.Clients[j].ClientID })
		return nil
	})
	return result, err
}

func remoteWorkspaceDocumentPath(root, namespace string) (string, error) {
	namespace = strings.TrimSpace(namespace)
	if namespace == "" || len(namespace) > 128 {
		return "", errors.New("invalid remote workspace namespace")
	}
	hash := sha256.Sum256([]byte(namespace))
	return filepath.Join(root, ".pebble", "workspaces", hex.EncodeToString(hash[:16])+".json"), nil
}

func readRemoteWorkspaceDocument(path, namespace string) (remoteWorkspaceDocument, error) {
	empty := remoteWorkspaceDocument{
		Snapshot: RemoteWorkspaceSnapshot{Namespace: namespace, SchemaVersion: remoteWorkspaceSchemaVersion, Session: RemoteWorkspaceSession{}},
		Clients:  map[string]RemoteWorkspaceConnectedClient{},
	}
	info, err := os.Stat(path)
	if errors.Is(err, os.ErrNotExist) {
		return empty, nil
	}
	if err != nil {
		return empty, err
	}
	if info.Size() > remoteWorkspaceMaxBytes {
		return empty, errors.New("remote workspace state is too large")
	}
	content, err := os.ReadFile(path)
	if err != nil {
		return empty, err
	}
	if err := json.Unmarshal(content, &empty); err != nil {
		return remoteWorkspaceDocument{}, errors.New("remote workspace state is invalid")
	}
	if empty.Snapshot.Namespace != namespace {
		return remoteWorkspaceDocument{}, errors.New("remote workspace namespace mismatch")
	}
	if empty.Snapshot.Session == nil {
		empty.Snapshot.Session = RemoteWorkspaceSession{}
	}
	if empty.Clients == nil {
		empty.Clients = map[string]RemoteWorkspaceConnectedClient{}
	}
	return empty, nil
}

func writeRemoteWorkspaceDocument(path string, document remoteWorkspaceDocument) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	content, err := json.Marshal(document)
	if err != nil {
		return err
	}
	if len(content) > remoteWorkspaceMaxBytes {
		return errors.New("remote workspace state is too large")
	}
	temporary := path + ".tmp-" + strconvUnixNano()
	if err := os.WriteFile(temporary, content, 0o600); err != nil {
		return err
	}
	if err := replaceRemoteWorkspaceFile(temporary, path); err != nil {
		_ = os.Remove(temporary)
		return err
	}
	return nil
}

func withRemoteWorkspaceLock(path string, run func() error) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	lock := path + ".lock"
	deadline := time.Now().Add(5 * time.Second)
	for {
		err := os.Mkdir(lock, 0o700)
		if err == nil {
			defer os.Remove(lock)
			return run()
		}
		if !errors.Is(err, os.ErrExist) {
			return err
		}
		if info, statErr := os.Stat(lock); statErr == nil && time.Since(info.ModTime()) > 30*time.Second {
			_ = os.RemoveAll(lock)
			continue
		}
		if time.Now().After(deadline) {
			return errors.New("timed out locking remote workspace state")
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func strconvUnixNano() string { return time.Now().Format("20060102150405.000000000") }
