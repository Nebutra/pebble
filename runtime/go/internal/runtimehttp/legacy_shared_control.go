package runtimehttp

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/nebutra/pebble/runtime/go/internal/runtimecore"
)

type legacySharedControlHello struct {
	Type         string `json:"type"`
	PublicKeyB64 string `json:"publicKeyB64"`
}

type legacySharedControlAuth struct {
	Type        string `json:"type"`
	DeviceToken string `json:"deviceToken"`
}

type legacySharedControlRequest struct {
	ID          string          `json:"id"`
	DeviceToken string          `json:"deviceToken"`
	Method      string          `json:"method"`
	Params      json.RawMessage `json:"params"`
}

type legacySharedControlPairingRequest struct {
	Name   string `json:"name"`
	Scope  string `json:"scope"`
	Rotate bool   `json:"rotate"`
}

type legacySharedControlResponse struct {
	ID        string                       `json:"id"`
	OK        bool                         `json:"ok"`
	Result    interface{}                  `json:"result"`
	Error     *legacySharedControlRPCError `json:"error,omitempty"`
	Streaming bool                         `json:"streaming,omitempty"`
	Meta      map[string]string            `json:"_meta"`
}

type legacySharedControlRPCError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type legacySharedControlSubscription struct {
	RequestID      string
	SubscriptionID string
	Kind           string
	WorktreeID     string
	TerminalID     string
	StreamID       uint32
	Binary         bool
	Cancel         context.CancelFunc
}

type legacySharedControlIncoming struct {
	Request *legacySharedControlRequest
	Frame   *terminalStreamFrame
}

type legacySharedControlTerminalCreateParams struct {
	WorktreeID, Cwd, AgentKind, TabID, LeafID, LaunchToken, Prompt, Surface string
	AfterTabID, TargetGroupID, ClientMutationID                             string
	Command, Environment                                                    []string
	Cols, Rows                                                              int
	Ephemeral, Activate                                                     bool
}

func (s *Server) handleLegacySharedControlPairing(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var request legacySharedControlPairingRequest
	if !decodeJSON(w, r, &request) {
		return
	}
	material, err := s.manager.CreateLegacySharedControlPairing(request.Name, request.Scope, request.Rotate)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, material)
}

func (s *Server) handleLegacySharedControlPairings(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	writeJSON(w, http.StatusOK, s.manager.ListLegacySharedControlDevices())
}

func (s *Server) handleLegacySharedControlPairingByDeviceID(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodDelete {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	deviceID := strings.TrimSpace(strings.TrimPrefix(r.URL.Path, "/v1/shared-control/pairings/"))
	if deviceID == "" {
		writeError(w, http.StatusBadRequest, "device id is required")
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"revoked": s.manager.RevokeLegacySharedControlDevice(deviceID)})
}

func (s *Server) handleLegacySharedControl(w http.ResponseWriter, r *http.Request) {
	if !isWebSocketUpgrade(r) {
		writeError(w, http.StatusUpgradeRequired, "websocket upgrade required")
		return
	}
	conn, err := upgradeWebSocket(w, r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	defer conn.close()
	keypair, err := s.manager.EnsureLegacySharedControlIdentity()
	if err != nil {
		return
	}
	secretKey, err := runtimecore.DecodeLegacySharedControlSecret(keypair)
	if err != nil {
		return
	}
	sharedKey, device, ok := s.authenticateLegacySharedControl(conn, secretKey)
	if !ok {
		return
	}
	s.manager.TouchLegacySharedControlDevice(device.DeviceID)
	s.serveLegacySharedControl(conn, sharedKey, device)
}

func (s *Server) authenticateLegacySharedControl(conn *websocketConn, secretKey *[32]byte) (*[32]byte, runtimecore.LegacySharedControlDevice, bool) {
	rawHello, err := conn.readText(true)
	if err != nil {
		return nil, runtimecore.LegacySharedControlDevice{}, false
	}
	var hello legacySharedControlHello
	if json.Unmarshal([]byte(rawHello), &hello) != nil || hello.Type != "e2ee_hello" {
		return nil, runtimecore.LegacySharedControlDevice{}, false
	}
	sharedKey, err := deriveLegacySharedControlKey(hello.PublicKeyB64, secretKey)
	if err != nil || conn.writeText(`{"type":"e2ee_ready"}`) != nil {
		return nil, runtimecore.LegacySharedControlDevice{}, false
	}
	encryptedAuth, err := conn.readText(true)
	if err != nil {
		return nil, runtimecore.LegacySharedControlDevice{}, false
	}
	authJSON, err := decryptLegacySharedControlText(encryptedAuth, sharedKey)
	if err != nil {
		return nil, runtimecore.LegacySharedControlDevice{}, false
	}
	var auth legacySharedControlAuth
	if json.Unmarshal(authJSON, &auth) != nil || auth.Type != "e2ee_auth" {
		_ = writeLegacySharedControlEncrypted(conn, sharedKey, map[string]interface{}{"type": "e2ee_error", "error": map[string]string{"code": "bad_auth"}})
		return nil, runtimecore.LegacySharedControlDevice{}, false
	}
	device, valid := s.manager.ValidateLegacySharedControlToken(auth.DeviceToken)
	if !valid {
		_ = writeLegacySharedControlEncrypted(conn, sharedKey, map[string]interface{}{"type": "e2ee_error", "error": map[string]string{"code": "unauthorized"}})
		return nil, runtimecore.LegacySharedControlDevice{}, false
	}
	if writeLegacySharedControlEncrypted(conn, sharedKey, map[string]string{"type": "e2ee_authenticated"}) != nil {
		return nil, runtimecore.LegacySharedControlDevice{}, false
	}
	return sharedKey, device, true
}

func (s *Server) serveLegacySharedControl(conn *websocketConn, sharedKey *[32]byte, device runtimecore.LegacySharedControlDevice) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	incoming := make(chan legacySharedControlIncoming, 16)
	errorsChannel := make(chan error, 1)
	go func() {
		readLegacySharedControlRequests(conn, sharedKey, incoming, errorsChannel)
		// Why: hijacked WebSockets do not inherit HTTP disconnect cancellation;
		// cancel relay work as soon as the connection reader exits.
		cancel()
	}()
	subscriberID, events := s.manager.Subscribe(128)
	defer s.manager.Unsubscribe(subscriberID)
	subscriptions := make(map[string]legacySharedControlSubscription)
	nextStreamID := uint32(1)
	for {
		select {
		case message, open := <-incoming:
			if !open {
				return
			}
			if message.Frame != nil {
				s.handleLegacySharedControlBinaryFrame(*message.Frame, device, subscriptions)
				continue
			}
			if message.Request == nil {
				continue
			}
			request := *message.Request
			if request.DeviceToken != "" && request.DeviceToken != device.Token {
				s.writeLegacySharedControlError(conn, sharedKey, request.ID, "unauthorized", "Device token mismatch")
				continue
			}
			if request.Method == "terminal.wait" {
				// Why: a long-poll wait must not pause terminal output or other RPCs
				// sharing this encrypted connection.
				go s.handleLegacySharedControlWait(ctx, conn, sharedKey, device, request)
				continue
			}
			if request.Method == "browser.screencast" {
				s.startLegacySharedControlBrowserScreencast(ctx, conn, sharedKey, device, request, subscriptions)
				continue
			}
			if request.Method == "notebook.runPythonCell" {
				// Why: a Python cell must not block terminal/files RPCs on the same
				// encrypted connection, and disconnect should terminate its process tree.
				go s.handleLegacySharedControlNotebook(ctx, conn, sharedKey, device, request)
				continue
			}
			if request.Method == "aiVault.listSessions" {
				// Why: transcript discovery can parse thousands of files; it must not
				// stall interactive terminal traffic sharing the encrypted channel.
				go s.handleLegacySharedControlAiVault(ctx, conn, sharedKey, device, request)
				continue
			}
			if request.Method == "workspaceCleanup.scan" || request.Method == "workspaceCleanup.processes" {
				// Why: git inspection can take seconds; keep terminal and file RPCs
				// responsive while connection cancellation still stops the scan.
				go s.handleLegacySharedControlWorkspaceCleanup(ctx, conn, sharedKey, device, request)
				continue
			}
			s.handleLegacySharedControlRequest(ctx, conn, sharedKey, device, request, subscriptions, &nextStreamID)
		case event, open := <-events:
			if !open {
				return
			}
			for _, subscription := range subscriptions {
				s.writeLegacySharedControlSubscriptionEvent(conn, sharedKey, subscription, event)
			}
		case <-errorsChannel:
			return
		}
	}
}

func readLegacySharedControlRequests(conn *websocketConn, sharedKey *[32]byte, incoming chan<- legacySharedControlIncoming, errorsChannel chan<- error) {
	defer close(incoming)
	for {
		opcode, encrypted, err := conn.readMessage(true)
		if err != nil {
			errorsChannel <- err
			return
		}
		if opcode == 0x2 {
			plaintext, err := decryptLegacySharedControlBytes(encrypted, sharedKey)
			if err != nil {
				errorsChannel <- err
				return
			}
			frame, err := decodeTerminalStreamFrame(plaintext)
			if err != nil {
				errorsChannel <- err
				return
			}
			incoming <- legacySharedControlIncoming{Frame: &frame}
			continue
		}
		if opcode != 0x1 {
			errorsChannel <- errors.New("unsupported shared-control websocket message")
			return
		}
		plaintext, err := decryptLegacySharedControlText(string(encrypted), sharedKey)
		if err != nil {
			errorsChannel <- err
			return
		}
		var request legacySharedControlRequest
		if err := json.Unmarshal(plaintext, &request); err != nil {
			errorsChannel <- err
			return
		}
		incoming <- legacySharedControlIncoming{Request: &request}
	}
}

func (s *Server) handleLegacySharedControlRequest(ctx context.Context, conn *websocketConn, sharedKey *[32]byte, device runtimecore.LegacySharedControlDevice, request legacySharedControlRequest, subscriptions map[string]legacySharedControlSubscription, nextStreamID *uint32) {
	if strings.TrimSpace(request.ID) == "" || strings.TrimSpace(request.Method) == "" {
		s.writeLegacySharedControlError(conn, sharedKey, request.ID, "bad_request", "Missing request id or method")
		return
	}
	if device.Scope == "mobile" && !legacySharedControlMobileMethodAllowed(request.Method) {
		s.writeLegacySharedControlError(conn, sharedKey, request.ID, "forbidden", "Method is not available to mobile clients")
		return
	}
	if result, handled, err := s.runLegacySharedControlHostCapabilityMethod(request.Method, request.Params); handled {
		if err != nil {
			s.writeLegacySharedControlError(conn, sharedKey, request.ID, "host_capability_failed", err.Error())
			return
		}
		_ = s.writeLegacySharedControlSuccess(conn, sharedKey, request.ID, result, false)
		return
	}
	if result, handled, err := s.runLegacySharedControlAgentTrustMethod(request.Method, request.Params); handled {
		if err != nil {
			s.writeLegacySharedControlError(conn, sharedKey, request.ID, "agent_trust_failed", err.Error())
			return
		}
		_ = s.writeLegacySharedControlSuccess(conn, sharedKey, request.ID, result, false)
		return
	}
	if result, handled, err := s.runLegacySharedControlWorkspaceMutation(request.Method, request.Params); handled {
		if err != nil {
			s.writeLegacySharedControlError(conn, sharedKey, request.ID, "workspace_operation_failed", err.Error())
			return
		}
		_ = s.writeLegacySharedControlSuccess(conn, sharedKey, request.ID, result, false)
		return
	}
	if result, handled, err := s.runLegacySharedControlFileMethod(ctx, request.Method, request.Params); handled {
		if err != nil {
			s.writeLegacySharedControlError(conn, sharedKey, request.ID, "file_operation_failed", err.Error())
			return
		}
		_ = s.writeLegacySharedControlSuccess(conn, sharedKey, request.ID, result, false)
		return
	}
	if result, handled, err := s.runLegacySharedControlHostedReviewMethod(request.Method, request.Params); handled {
		if err != nil {
			s.writeLegacySharedControlError(conn, sharedKey, request.ID, "hosted_review_failed", err.Error())
			return
		}
		_ = s.writeLegacySharedControlSuccess(conn, sharedKey, request.ID, result, false)
		return
	}
	if result, handled, err := s.runLegacySharedControlWorkItemMethod(request.Method, request.Params); handled {
		if err != nil {
			s.writeLegacySharedControlError(conn, sharedKey, request.ID, "work_item_failed", err.Error())
			return
		}
		_ = s.writeLegacySharedControlSuccess(conn, sharedKey, request.ID, result, false)
		return
	}
	if result, handled, err := s.runLegacySharedControlGitHubProjectMethod(request.Method, request.Params); handled {
		if err != nil {
			s.writeLegacySharedControlError(conn, sharedKey, request.ID, "github_project_failed", err.Error())
			return
		}
		_ = s.writeLegacySharedControlSuccess(conn, sharedKey, request.ID, result, false)
		return
	}
	if result, handled, err := s.runLegacySharedControlEmulatorMethod(ctx, request.Method, request.Params); handled {
		if err != nil {
			s.writeLegacySharedControlError(conn, sharedKey, request.ID, "emulator_failed", err.Error())
			return
		}
		_ = s.writeLegacySharedControlSuccess(conn, sharedKey, request.ID, result, false)
		return
	}
	if result, handled, err := s.runLegacySharedControlOrchestrationMethod(request.Method, request.Params); handled {
		if err != nil {
			s.writeLegacySharedControlError(conn, sharedKey, request.ID, "orchestration_failed", err.Error())
			return
		}
		_ = s.writeLegacySharedControlSuccess(conn, sharedKey, request.ID, result, false)
		return
	}
	switch request.Method {
	case "status.get":
		status := s.manager.Status()
		capabilities := make([]string, 0, len(status.Capabilities)+1)
		for _, capability := range status.Capabilities {
			capabilities = append(capabilities, string(capability))
		}
		capabilities = append(capabilities, "browser.screencast.v1")
		_ = s.writeLegacySharedControlSuccess(conn, sharedKey, request.ID, map[string]interface{}{
			"version": status.Version, "startedAt": status.StartedAt, "uptimeSeconds": status.UptimeSeconds,
			"capabilities": capabilities, "unavailableTools": status.UnavailableTools,
		}, false)
	case "preflight.check":
		_ = s.writeLegacySharedControlSuccess(conn, sharedKey, request.ID, runtimecore.DetectHostPreflight(), false)
	case "preflight.detectAgents":
		_ = s.writeLegacySharedControlSuccess(conn, sharedKey, request.ID, runtimecore.DetectHostAgents(), false)
	case "preflight.refreshAgents":
		_ = s.writeLegacySharedControlSuccess(conn, sharedKey, request.ID, runtimecore.HostAgentRefreshResult(), false)
	case "repo.list":
		projects := s.manager.ListProjects()
		repos := make([]map[string]interface{}, 0, len(projects))
		for _, project := range projects {
			repos = append(repos, runtimeRPCProject(project))
		}
		_ = s.writeLegacySharedControlSuccess(conn, sharedKey, request.ID, map[string]interface{}{"repos": repos}, false)
	case "worktree.list":
		var params struct {
			Repo      string `json:"repo"`
			ProjectID string `json:"projectId"`
			Limit     int    `json:"limit"`
		}
		_ = json.Unmarshal(request.Params, &params)
		projectID := firstNonEmpty(strings.TrimSpace(params.Repo), strings.TrimSpace(params.ProjectID))
		worktrees := s.manager.ListWorktrees(projectID)
		if params.Limit > 0 && len(worktrees) > params.Limit {
			worktrees = worktrees[:params.Limit]
		}
		projected := make([]map[string]interface{}, 0, len(worktrees))
		for _, worktree := range worktrees {
			projected = append(projected, runtimeRPCWorktree(worktree))
		}
		_ = s.writeLegacySharedControlSuccess(conn, sharedKey, request.ID, map[string]interface{}{"worktrees": projected}, false)
	case "projectGroup.list":
		_ = s.writeLegacySharedControlSuccess(conn, sharedKey, request.ID, map[string]interface{}{
			"groups": s.manager.ListProjectGroups(),
		}, false)
	case "folderWorkspace.list":
		_ = s.writeLegacySharedControlSuccess(conn, sharedKey, request.ID, map[string]interface{}{
			"folderWorkspaces": s.manager.ListFolderWorkspaces(),
		}, false)
	case "worktree.lineageList":
		_ = s.writeLegacySharedControlSuccess(conn, sharedKey, request.ID, s.manager.ListWorktreeLineage(), false)
	case "accounts.list":
		_ = s.writeLegacySharedControlSuccess(conn, sharedKey, request.ID, json.RawMessage(s.manager.GetAccountsSnapshot()), false)
	case "accounts.subscribe":
		subscriptionID := "accounts-" + request.ID
		subscriptions[subscriptionID] = legacySharedControlSubscription{RequestID: request.ID, SubscriptionID: subscriptionID, Kind: "accounts"}
		_ = s.writeLegacySharedControlSuccess(conn, sharedKey, request.ID, map[string]interface{}{"type": "ready", "subscriptionId": subscriptionID, "snapshot": json.RawMessage(s.manager.GetAccountsSnapshot())}, true)
	case "accounts.unsubscribe":
		var params struct {
			SubscriptionID string `json:"subscriptionId"`
		}
		if json.Unmarshal(request.Params, &params) != nil || params.SubscriptionID == "" {
			s.writeLegacySharedControlError(conn, sharedKey, request.ID, "bad_request", "Missing subscriptionId")
			return
		}
		if subscription, exists := subscriptions[params.SubscriptionID]; exists {
			delete(subscriptions, params.SubscriptionID)
			_ = s.writeLegacySharedControlSuccess(conn, sharedKey, subscription.RequestID, map[string]string{"type": "end"}, true)
		}
		_ = s.writeLegacySharedControlSuccess(conn, sharedKey, request.ID, map[string]bool{"unsubscribed": true}, false)
	case "session.tabs.list":
		worktreeID, valid := readLegacySharedControlWorktree(request.Params)
		if !valid {
			s.writeLegacySharedControlError(conn, sharedKey, request.ID, "bad_request", "Missing worktree")
			return
		}
		_ = s.writeLegacySharedControlSuccess(conn, sharedKey, request.ID, s.manager.SessionTabsSnapshot(worktreeID), false)
	case "session.tabs.listAll":
		_ = s.writeLegacySharedControlSuccess(conn, sharedKey, request.ID, map[string]interface{}{"snapshots": s.manager.AllSessionTabsSnapshots()}, false)
	case "session.tabs.createTerminal":
		session, params, err := s.startLegacySharedControlTerminal(request.Params)
		if err != nil {
			s.writeLegacySharedControlError(conn, sharedKey, request.ID, "terminal_create_failed", err.Error())
			return
		}
		if _, err := s.manager.PlaceCreatedSessionTab(params.WorktreeID, sessionTabsResponseID(session.TabID, session.ID, "tab-"), params.TargetGroupID, params.AfterTabID, params.Activate); err != nil {
			_, _ = s.manager.StopSession(session.ID)
			s.writeLegacySharedControlError(conn, sharedKey, request.ID, "tab_place_failed", err.Error())
			return
		}
		snapshot := s.manager.SessionTabsSnapshot(params.WorktreeID)
		tab := legacySharedControlSnapshotTab(snapshot, session.ID)
		_ = s.writeLegacySharedControlSuccess(conn, sharedKey, request.ID, map[string]interface{}{"tab": tab, "publicationEpoch": snapshot["publicationEpoch"], "snapshotVersion": snapshot["snapshotVersion"]}, false)
	case "session.tabs.activate", "session.tabs.close":
		worktreeID, valid := readLegacySharedControlWorktree(request.Params)
		var params struct {
			TabID string `json:"tabId"`
		}
		if !valid || json.Unmarshal(request.Params, &params) != nil || strings.TrimSpace(params.TabID) == "" {
			s.writeLegacySharedControlError(conn, sharedKey, request.ID, "bad_request", "Missing worktree or tabId")
			return
		}
		if request.Method == "session.tabs.activate" {
			if _, err := s.manager.ActivateSessionTab(worktreeID, params.TabID); err != nil {
				s.writeLegacySharedControlError(conn, sharedKey, request.ID, "tab_not_found", err.Error())
				return
			}
		} else if _, err := s.manager.CloseSessionTab(worktreeID, params.TabID); err != nil {
			s.writeLegacySharedControlError(conn, sharedKey, request.ID, "tab_not_found", err.Error())
			return
		}
		_ = s.writeLegacySharedControlSuccess(conn, sharedKey, request.ID, s.manager.SessionTabsSnapshot(worktreeID), false)
	case "session.tabs.updatePaneLayout":
		worktreeID, valid := readLegacySharedControlWorktree(request.Params)
		var params struct {
			TabID          string            `json:"tabId"`
			Root           interface{}       `json:"root"`
			ExpandedLeafID interface{}       `json:"expandedLeafId"`
			TitlesByLeafID map[string]string `json:"titlesByLeafId"`
		}
		if !valid || json.Unmarshal(request.Params, &params) != nil || strings.TrimSpace(params.TabID) == "" {
			s.writeLegacySharedControlError(conn, sharedKey, request.ID, "bad_request", "Missing worktree or tabId")
			return
		}
		paneLayout, err := json.Marshal(map[string]interface{}{"root": params.Root, "expandedLeafId": params.ExpandedLeafID, "titlesByLeafId": params.TitlesByLeafID})
		if err != nil {
			s.writeLegacySharedControlError(conn, sharedKey, request.ID, "bad_request", "Invalid pane layout")
			return
		}
		if _, err := s.manager.UpdateSessionTabPaneLayout(worktreeID, params.TabID, paneLayout); err != nil {
			s.writeLegacySharedControlError(conn, sharedKey, request.ID, "tab_not_found", err.Error())
			return
		}
		_ = s.writeLegacySharedControlSuccess(conn, sharedKey, request.ID, map[string]bool{"updated": true}, false)
	case "session.tabs.setTabProps":
		worktreeID, valid := readLegacySharedControlWorktree(request.Params)
		var input map[string]interface{}
		if !valid || json.Unmarshal(request.Params, &input) != nil {
			s.writeLegacySharedControlError(conn, sharedKey, request.ID, "bad_request", "Invalid tab props")
			return
		}
		tabID, _ := input["tabId"].(string)
		props := make(map[string]interface{})
		for _, key := range []string{"color", "isPinned", "viewMode"} {
			if value, exists := input[key]; exists {
				props[key] = value
			}
		}
		if strings.TrimSpace(tabID) == "" || !validLegacySharedControlTabProps(props) {
			s.writeLegacySharedControlError(conn, sharedKey, request.ID, "bad_request", "Invalid tab props")
			return
		}
		encoded, _ := json.Marshal(props)
		if _, err := s.manager.SetSessionTabProps(worktreeID, tabID, encoded); err != nil {
			s.writeLegacySharedControlError(conn, sharedKey, request.ID, "tab_not_found", err.Error())
			return
		}
		_ = s.writeLegacySharedControlSuccess(conn, sharedKey, request.ID, map[string]bool{"updated": true}, false)
	case "session.tabs.move":
		worktreeID, valid := readLegacySharedControlWorktree(request.Params)
		var params struct {
			Kind, TabID, TargetGroupID, SplitDirection string
			TabOrder                                   []string
			Index                                      *int
		}
		if !valid || json.Unmarshal(request.Params, &params) != nil || !validLegacySharedControlTabMove(params.Kind, params.TabID, params.TargetGroupID, params.SplitDirection, params.TabOrder, params.Index) {
			s.writeLegacySharedControlError(conn, sharedKey, request.ID, "bad_request", "Invalid session tab move")
			return
		}
		_, err := s.manager.MoveSessionTab(worktreeID, runtimecore.MoveSessionTabRequest{Kind: params.Kind, TabID: params.TabID, TargetGroupID: params.TargetGroupID, SplitDirection: params.SplitDirection, TabOrder: params.TabOrder, Index: params.Index})
		if err != nil {
			s.writeLegacySharedControlError(conn, sharedKey, request.ID, "tab_move_failed", err.Error())
			return
		}
		_ = s.writeLegacySharedControlSuccess(conn, sharedKey, request.ID, map[string]bool{"moved": true}, false)
	case "session.tabs.subscribe":
		worktreeID, valid := readLegacySharedControlWorktree(request.Params)
		if !valid {
			s.writeLegacySharedControlError(conn, sharedKey, request.ID, "bad_request", "Missing worktree")
			return
		}
		subscriptionID := "session.tabs-" + request.ID
		subscriptions[subscriptionID] = legacySharedControlSubscription{RequestID: request.ID, SubscriptionID: subscriptionID, Kind: "session.tabs", WorktreeID: worktreeID}
		initial := s.manager.SessionTabsSnapshot(worktreeID)
		initial["type"] = "snapshot"
		_ = s.writeLegacySharedControlSuccess(conn, sharedKey, request.ID, initial, true)
	case "session.tabs.subscribeAll":
		subscriptionID := "session.tabs.all-" + request.ID
		subscriptions[subscriptionID] = legacySharedControlSubscription{RequestID: request.ID, SubscriptionID: subscriptionID, Kind: "session.tabs.all"}
		_ = s.writeLegacySharedControlSuccess(conn, sharedKey, request.ID, map[string]interface{}{"type": "snapshots", "snapshots": s.manager.AllSessionTabsSnapshots()}, true)
	case "session.tabs.unsubscribe", "session.tabs.unsubscribeAll":
		var params struct {
			SubscriptionID string `json:"subscriptionId"`
			Worktree       string `json:"worktree"`
		}
		_ = json.Unmarshal(request.Params, &params)
		for key, subscription := range subscriptions {
			matchesID := params.SubscriptionID != "" && (params.SubscriptionID == subscription.RequestID || params.SubscriptionID == subscription.SubscriptionID)
			matchesScope := params.SubscriptionID == "" && ((request.Method == "session.tabs.unsubscribeAll" && subscription.Kind == "session.tabs.all") || (request.Method == "session.tabs.unsubscribe" && subscription.Kind == "session.tabs" && (params.Worktree == "" || normalizeLegacyWorktreeSelector(params.Worktree) == subscription.WorktreeID)))
			if !matchesID && !matchesScope {
				continue
			}
			delete(subscriptions, key)
			_ = s.writeLegacySharedControlSuccess(conn, sharedKey, subscription.RequestID, map[string]string{"type": "end"}, true)
		}
		_ = s.writeLegacySharedControlSuccess(conn, sharedKey, request.ID, map[string]bool{"unsubscribed": true}, false)
	case "terminal.read":
		terminalID, valid := readLegacySharedControlTerminal(request.Params)
		if !valid {
			s.writeLegacySharedControlError(conn, sharedKey, request.ID, "bad_request", "Missing terminal handle")
			return
		}
		cursor, limit, err := readLegacySharedControlTranscriptRequest(request.Params)
		if err != nil {
			s.writeLegacySharedControlError(conn, sharedKey, request.ID, "bad_request", err.Error())
			return
		}
		read, err := s.manager.ReadSessionTranscript(terminalID, cursor, limit)
		if err != nil {
			s.writeLegacySharedControlError(conn, sharedKey, request.ID, "not_found", err.Error())
			return
		}
		status, err := s.manager.SessionStatus(terminalID)
		if err != nil {
			s.writeLegacySharedControlError(conn, sharedKey, request.ID, "not_found", err.Error())
			return
		}
		_ = s.writeLegacySharedControlSuccess(conn, sharedKey, request.ID, map[string]interface{}{
			"terminal": legacySharedControlTerminalReadResult(terminalID, status.Status, read),
		}, false)
	case "terminal.create":
		session, params, err := s.startLegacySharedControlTerminal(request.Params)
		if err != nil {
			s.writeLegacySharedControlError(conn, sharedKey, request.ID, "terminal_create_failed", err.Error())
			return
		}
		_ = s.writeLegacySharedControlSuccess(conn, sharedKey, request.ID, map[string]interface{}{"terminal": legacySharedControlTerminalCreateResult(session, params.Surface)}, false)
	case "terminal.list":
		worktreeID, limit := readLegacySharedControlTerminalList(request.Params)
		terminals := make([]map[string]interface{}, 0)
		totalCount := 0
		for _, session := range s.manager.ListSessions() {
			if worktreeID != "" && session.WorktreeID != worktreeID {
				continue
			}
			totalCount++
			if len(terminals) < limit {
				terminals = append(terminals, legacySharedControlTerminalSummary(session))
			}
		}
		_ = s.writeLegacySharedControlSuccess(conn, sharedKey, request.ID, map[string]interface{}{"terminals": terminals, "totalCount": totalCount, "truncated": totalCount > len(terminals)}, false)
	case "terminal.resolveActive":
		worktreeID, _ := readLegacySharedControlWorktree(request.Params)
		var active *runtimecore.Session
		for _, session := range s.manager.ListSessions() {
			if (worktreeID != "" && session.WorktreeID != worktreeID) || !legacySharedControlSessionLive(session) {
				continue
			}
			if active == nil || session.UpdatedAt.After(active.UpdatedAt) {
				copy := session
				active = &copy
			}
		}
		var handle interface{}
		if active != nil {
			handle = active.ID
		}
		_ = s.writeLegacySharedControlSuccess(conn, sharedKey, request.ID, map[string]interface{}{"handle": handle}, false)
	case "terminal.show":
		terminalID, valid := readLegacySharedControlTerminal(request.Params)
		if !valid {
			s.writeLegacySharedControlError(conn, sharedKey, request.ID, "bad_request", "Missing terminal handle")
			return
		}
		session, err := s.manager.SessionStatus(terminalID)
		if err != nil {
			s.writeLegacySharedControlError(conn, sharedKey, request.ID, "not_found", err.Error())
			return
		}
		terminal := legacySharedControlTerminalSummary(session)
		terminal["paneRuntimeId"] = legacySharedControlPaneRuntimeID(session.LeafID)
		terminal["rendererGraphEpoch"] = session.UpdatedAt.UnixMilli()
		_ = s.writeLegacySharedControlSuccess(conn, sharedKey, request.ID, map[string]interface{}{"terminal": terminal}, false)
	case "terminal.inspectProcess":
		terminalID, valid := readLegacySharedControlTerminal(request.Params)
		if !valid {
			s.writeLegacySharedControlError(conn, sharedKey, request.ID, "bad_request", "Missing terminal handle")
			return
		}
		session, err := s.manager.SessionStatus(terminalID)
		if err != nil {
			s.writeLegacySharedControlError(conn, sharedKey, request.ID, "not_found", err.Error())
			return
		}
		var foreground interface{}
		if legacySharedControlSessionLive(session) {
			if session.ForegroundProcess != nil {
				foreground = *session.ForegroundProcess
			} else if len(session.Command) > 0 {
				foreground = filepath.Base(session.Command[0])
			}
		}
		_ = s.writeLegacySharedControlSuccess(conn, sharedKey, request.ID, map[string]interface{}{"process": map[string]interface{}{"foregroundProcess": foreground, "hasChildProcesses": session.HasChildProcesses}}, false)
	case "terminal.stop", "terminal.stopExact":
		result, err := s.stopLegacySharedControlTerminals(request.Method, request.Params)
		if err != nil {
			s.writeLegacySharedControlError(conn, sharedKey, request.ID, "bad_request", err.Error())
			return
		}
		_ = s.writeLegacySharedControlSuccess(conn, sharedKey, request.ID, result, false)
	case "terminal.split":
		terminalID, valid := readLegacySharedControlTerminal(request.Params)
		var params struct {
			Direction string      `json:"direction"`
			Command   string      `json:"command"`
			Env       interface{} `json:"env"`
		}
		if !valid || json.Unmarshal(request.Params, &params) != nil || (params.Direction != "" && params.Direction != "vertical" && params.Direction != "horizontal") {
			s.writeLegacySharedControlError(conn, sharedKey, request.ID, "bad_request", "Invalid terminal split parameters")
			return
		}
		source, err := s.manager.SessionStatus(terminalID)
		if err != nil || !legacySharedControlSessionLive(source) {
			s.writeLegacySharedControlError(conn, sharedKey, request.ID, "terminal_gone", "Source terminal is not running")
			return
		}
		command := legacySharedControlShellCommand(params.Command)
		if len(command) == 0 {
			command = append([]string(nil), source.Command...)
		}
		tabID := sessionTabsResponseID(source.TabID, source.ID, "tab-")
		created, err := s.manager.StartSession(context.Background(), runtimecore.StartSessionRequest{ProjectID: source.ProjectID, WorktreeID: source.WorktreeID, Cwd: source.Cwd, Command: command, AgentKind: source.AgentKind, TabID: tabID, LeafID: "leaf-" + randomID(), Cols: source.Cols, Rows: source.Rows, Environment: legacySharedControlEnvironment(params.Env)})
		if err != nil {
			s.writeLegacySharedControlError(conn, sharedKey, request.ID, "terminal_split_failed", err.Error())
			return
		}
		if _, err := s.manager.SplitSessionTabPane(source.WorktreeID, tabID, source.LeafID, source.ID, created.LeafID, created.ID, params.Direction); err != nil {
			_, _ = s.manager.StopSession(created.ID)
			s.writeLegacySharedControlError(conn, sharedKey, request.ID, "terminal_split_layout_failed", err.Error())
			return
		}
		_ = s.writeLegacySharedControlSuccess(conn, sharedKey, request.ID, map[string]interface{}{"split": map[string]interface{}{"handle": created.ID, "tabId": tabID, "paneRuntimeId": legacySharedControlPaneRuntimeID(created.LeafID)}}, false)
	case "terminal.rename":
		terminalID, valid := readLegacySharedControlTerminal(request.Params)
		var params struct {
			Title *string `json:"title"`
		}
		if !valid || json.Unmarshal(request.Params, &params) != nil {
			s.writeLegacySharedControlError(conn, sharedKey, request.ID, "bad_request", "Invalid terminal rename parameters")
			return
		}
		session, err := s.manager.SessionStatus(terminalID)
		if err != nil {
			s.writeLegacySharedControlError(conn, sharedKey, request.ID, "not_found", err.Error())
			return
		}
		tabID := sessionTabsResponseID(session.TabID, session.ID, "tab-")
		props, _ := json.Marshal(map[string]interface{}{"customTitle": params.Title})
		if _, err := s.manager.SetSessionTabProps(session.WorktreeID, tabID, props); err != nil {
			s.writeLegacySharedControlError(conn, sharedKey, request.ID, "rename_failed", err.Error())
			return
		}
		_ = s.writeLegacySharedControlSuccess(conn, sharedKey, request.ID, map[string]interface{}{"rename": map[string]interface{}{"handle": session.ID, "tabId": tabID, "title": params.Title}}, false)
	case "terminal.setDisplayMode":
		result, err := s.setLegacySharedControlDisplayMode(request.Params)
		if err != nil {
			s.writeLegacySharedControlError(conn, sharedKey, request.ID, "bad_request", err.Error())
			return
		}
		_ = s.writeLegacySharedControlSuccess(conn, sharedKey, request.ID, result, false)
	case "terminal.resizeForClient":
		result, err := s.resizeLegacySharedControlTerminalForClient(request.Params)
		if err != nil {
			s.writeLegacySharedControlError(conn, sharedKey, request.ID, "bad_request", err.Error())
			return
		}
		_ = s.writeLegacySharedControlSuccess(conn, sharedKey, request.ID, result, false)
	case "terminal.restoreFit":
		terminalID, valid := readLegacySharedControlTerminal(request.Params)
		if !valid {
			s.writeLegacySharedControlError(conn, sharedKey, request.ID, "bad_request", "Missing terminal handle")
			return
		}
		if _, err := s.manager.SessionStatus(terminalID); err != nil {
			s.writeLegacySharedControlError(conn, sharedKey, request.ID, "not_found", err.Error())
			return
		}
		restored, err := s.manager.ReclaimSessionFitForDesktop(terminalID)
		if err != nil {
			s.writeLegacySharedControlError(conn, sharedKey, request.ID, "terminal_resize_failed", err.Error())
			return
		}
		_ = s.writeLegacySharedControlSuccess(conn, sharedKey, request.ID, map[string]bool{"restored": restored}, false)
	case "terminal.getDisplayMode":
		terminalID, valid := readLegacySharedControlTerminal(request.Params)
		if !valid {
			s.writeLegacySharedControlError(conn, sharedKey, request.ID, "bad_request", "Missing terminal handle")
			return
		}
		if _, err := s.manager.SessionStatus(terminalID); err != nil {
			s.writeLegacySharedControlError(conn, sharedKey, request.ID, "not_found", err.Error())
			return
		}
		driver := s.manager.GetSessionDriver(terminalID)
		phoneFitted := driver.Kind == "mobile"
		mode := "desktop"
		if phoneFitted {
			mode = "auto"
		}
		_ = s.writeLegacySharedControlSuccess(conn, sharedKey, request.ID, map[string]interface{}{"mode": mode, "isPhoneFitted": phoneFitted}, false)
	case "browser.tabList":
		_ = s.writeLegacySharedControlSuccess(conn, sharedKey, request.ID, map[string]interface{}{"tabs": s.manager.ListBrowserTabs()}, false)
	case "browser.profileList":
		_ = s.writeLegacySharedControlSuccess(conn, sharedKey, request.ID, map[string]interface{}{"profiles": s.manager.ListBrowserProfiles()}, false)
	case "browser.profileCreate":
		var params runtimecore.CreateBrowserProfileRequest
		if json.Unmarshal(request.Params, &params) != nil {
			s.writeLegacySharedControlError(conn, sharedKey, request.ID, "bad_request", "Invalid browser profile parameters")
			return
		}
		profile, err := s.manager.CreateBrowserProfile(params)
		if err != nil {
			s.writeLegacySharedControlError(conn, sharedKey, request.ID, "browser_error", err.Error())
			return
		}
		_ = s.writeLegacySharedControlSuccess(conn, sharedKey, request.ID, map[string]interface{}{"profile": profile}, false)
	case "browser.profileDelete":
		var params struct {
			ProfileID string `json:"profileId"`
		}
		if json.Unmarshal(request.Params, &params) != nil || strings.TrimSpace(params.ProfileID) == "" {
			s.writeLegacySharedControlError(conn, sharedKey, request.ID, "bad_request", "Missing browser profile ID")
			return
		}
		profile, err := s.manager.DeleteBrowserProfile(params.ProfileID)
		if err != nil {
			s.writeLegacySharedControlError(conn, sharedKey, request.ID, "browser_profile_not_found", err.Error())
			return
		}
		_ = s.writeLegacySharedControlSuccess(conn, sharedKey, request.ID, map[string]interface{}{"deleted": true, "profile": profile}, false)
	case "browser.tabShow", "browser.tabCurrent":
		tab, err := s.resolveLegacySharedControlBrowserTab(request.Method, request.Params)
		if err != nil {
			s.writeLegacySharedControlError(conn, sharedKey, request.ID, "browser_tab_not_found", err.Error())
			return
		}
		_ = s.writeLegacySharedControlSuccess(conn, sharedKey, request.ID, map[string]interface{}{"tab": tab}, false)
	case "browser.tabCreate":
		var params struct {
			URL        string `json:"url"`
			WorktreeID string `json:"worktree"`
			ProfileID  string `json:"profileId"`
		}
		if json.Unmarshal(request.Params, &params) != nil {
			s.writeLegacySharedControlError(conn, sharedKey, request.ID, "bad_request", "Invalid browser tab parameters")
			return
		}
		if strings.TrimSpace(params.URL) == "" {
			params.URL = "about:blank"
		}
		tab, err := s.manager.CreateBrowserTab(runtimecore.CreateBrowserTabRequest{URL: params.URL, WorktreeID: strings.TrimSpace(params.WorktreeID), ProfileID: strings.TrimSpace(params.ProfileID)})
		if err != nil {
			s.writeLegacySharedControlError(conn, sharedKey, request.ID, "browser_error", err.Error())
			return
		}
		_ = s.writeLegacySharedControlSuccess(conn, sharedKey, request.ID, map[string]string{"browserPageId": tab.ID}, false)
	case "browser.tabClose":
		tab, err := s.resolveLegacySharedControlBrowserTab("browser.tabShow", request.Params)
		if err != nil {
			s.writeLegacySharedControlError(conn, sharedKey, request.ID, "browser_tab_not_found", err.Error())
			return
		}
		if _, err := s.manager.DeleteBrowserTab(tab.ID); err != nil {
			s.writeLegacySharedControlError(conn, sharedKey, request.ID, "browser_error", err.Error())
			return
		}
		_ = s.writeLegacySharedControlSuccess(conn, sharedKey, request.ID, map[string]bool{"closed": true}, false)
	case "browser.goto", "browser.back", "browser.forward", "browser.reload", "browser.screenshot",
		"browser.fullScreenshot", "browser.pdf", "browser.snapshot", "browser.click", "browser.dblclick",
		"browser.fill", "browser.type", "browser.focus", "browser.clear", "browser.keypress", "browser.keyDown", "browser.keyUp", "browser.scroll",
		"browser.scrollIntoView", "browser.select", "browser.check", "browser.hover", "browser.selectAll",
		"browser.drag", "browser.upload", "browser.get", "browser.is", "browser.find", "browser.keyboardInsertText",
		"browser.wait", "browser.capture.start", "browser.capture.stop", "browser.console", "browser.network",
		"browser.intercept.enable", "browser.intercept.disable", "browser.intercept.list", "browser.geolocation",
		"browser.setMedia", "browser.download", "browser.harStart", "browser.harStop", "browser.profilerStart", "browser.profilerStop", "browser.pushState",
		"browser.storage.local.get", "browser.storage.local.set", "browser.storage.local.clear",
		"browser.storage.session.get", "browser.storage.session.set", "browser.storage.session.clear",
		"browser.highlight", "browser.mouseMove", "browser.mouseDown", "browser.mouseUp", "browser.mouseClick", "browser.mouseWheel",
		"browser.clipboardRead", "browser.clipboardWrite", "browser.clipboardCopy", "browser.clipboardPaste",
		"browser.initScriptAdd", "browser.initScriptRemove",
		"browser.eval", "browser.viewport", "browser.setHeaders", "browser.setOffline", "browser.setCredentials",
		"browser.cookie.get", "browser.cookie.set", "browser.cookie.delete", "browser.cookie.clear",
		"browser.dialogAccept", "browser.dialogDismiss":
		result, err := s.runLegacySharedControlBrowserCommand(request.Method, request.Params)
		if err != nil {
			s.writeLegacySharedControlError(conn, sharedKey, request.ID, "browser_error", err.Error())
			return
		}
		_ = s.writeLegacySharedControlSuccess(conn, sharedKey, request.ID, result, false)
	case "terminal.agentStatus", "terminal.isRunningAgent":
		terminalID, valid := readLegacySharedControlTerminal(request.Params)
		if !valid {
			s.writeLegacySharedControlError(conn, sharedKey, request.ID, "bad_request", "Missing terminal handle")
			return
		}
		session, err := s.manager.SessionStatus(terminalID)
		if err != nil {
			s.writeLegacySharedControlError(conn, sharedKey, request.ID, "not_found", err.Error())
			return
		}
		runningAgent := session.AgentKind != "" && (session.Status == runtimecore.SessionStarting || session.Status == runtimecore.SessionRunning)
		if request.Method == "terminal.isRunningAgent" {
			_ = s.writeLegacySharedControlSuccess(conn, sharedKey, request.ID, map[string]bool{"isRunningAgent": runningAgent}, false)
			return
		}
		var agentStatus interface{}
		if runningAgent {
			agentStatus = string(session.HookAgentState)
			if agentStatus == "" {
				agentStatus = "working"
			}
		}
		_ = s.writeLegacySharedControlSuccess(conn, sharedKey, request.ID, map[string]interface{}{"agentStatus": map[string]interface{}{"handle": terminalID, "isRunningAgent": runningAgent, "status": agentStatus}}, false)
	case "terminal.resolvePane":
		var params struct {
			PaneKey string `json:"paneKey"`
		}
		if json.Unmarshal(request.Params, &params) != nil || strings.TrimSpace(params.PaneKey) == "" {
			s.writeLegacySharedControlError(conn, sharedKey, request.ID, "bad_request", "Missing paneKey")
			return
		}
		var resolved interface{}
		for _, session := range s.manager.ListSessions() {
			if session.Status == runtimecore.SessionStopped || session.TabID+":"+session.LeafID != params.PaneKey {
				continue
			}
			resolved = map[string]interface{}{"handle": session.ID, "tabId": session.TabID, "leafId": session.LeafID, "ptyId": session.ID}
			break
		}
		_ = s.writeLegacySharedControlSuccess(conn, sharedKey, request.ID, map[string]interface{}{"terminal": resolved}, false)
	case "terminal.focus":
		terminalID, valid := readLegacySharedControlTerminal(request.Params)
		if !valid {
			s.writeLegacySharedControlError(conn, sharedKey, request.ID, "bad_request", "Missing terminal handle")
			return
		}
		session, err := s.manager.SessionStatus(terminalID)
		if err != nil {
			s.writeLegacySharedControlError(conn, sharedKey, request.ID, "not_found", err.Error())
			return
		}
		tabID := sessionTabsResponseID(session.TabID, session.ID, "tab-")
		if _, err := s.manager.ActivateSessionTab(session.WorktreeID, tabID); err != nil {
			s.writeLegacySharedControlError(conn, sharedKey, request.ID, "terminal_focus_failed", err.Error())
			return
		}
		_ = s.writeLegacySharedControlSuccess(conn, sharedKey, request.ID, map[string]interface{}{"focus": map[string]interface{}{"handle": session.ID, "tabId": tabID, "worktreeId": session.WorktreeID}}, false)
	case "terminal.clearBuffer":
		terminalID, valid := readLegacySharedControlTerminal(request.Params)
		if !valid {
			s.writeLegacySharedControlError(conn, sharedKey, request.ID, "bad_request", "Missing terminal handle")
			return
		}
		cleared, err := s.manager.ClearSessionBuffer(terminalID)
		if err != nil {
			s.writeLegacySharedControlError(conn, sharedKey, request.ID, "not_found", err.Error())
			return
		}
		_ = s.writeLegacySharedControlSuccess(conn, sharedKey, request.ID, map[string]interface{}{"clear": map[string]interface{}{"handle": terminalID, "status": legacySharedControlTerminalStatus(cleared.Status)}}, false)
	case "terminal.close":
		terminalID, valid := readLegacySharedControlTerminal(request.Params)
		if !valid {
			s.writeLegacySharedControlError(conn, sharedKey, request.ID, "bad_request", "Missing terminal handle")
			return
		}
		stopped, err := s.manager.StopSession(terminalID)
		if err != nil {
			s.writeLegacySharedControlError(conn, sharedKey, request.ID, "not_found", err.Error())
			return
		}
		tabID := stopped.TabID
		if tabID == "" {
			tabID = "tab-" + terminalID
		}
		_ = s.writeLegacySharedControlSuccess(conn, sharedKey, request.ID, map[string]interface{}{"close": map[string]interface{}{"handle": terminalID, "tabId": tabID, "ptyKilled": true}}, false)
	case "terminal.updateViewport":
		terminalID, valid := readLegacySharedControlTerminal(request.Params)
		if !valid {
			s.writeLegacySharedControlError(conn, sharedKey, request.ID, "bad_request", "Missing terminal handle")
			return
		}
		var params struct {
			Viewport struct {
				Cols int `json:"cols"`
				Rows int `json:"rows"`
			} `json:"viewport"`
		}
		if json.Unmarshal(request.Params, &params) != nil || params.Viewport.Cols < 1 || params.Viewport.Rows < 1 {
			s.writeLegacySharedControlError(conn, sharedKey, request.ID, "bad_request", "Invalid viewport")
			return
		}
		resized, err := s.manager.ResizeSession(terminalID, runtimecore.SessionResizeRequest{Cols: params.Viewport.Cols, Rows: params.Viewport.Rows, Source: string(runtimecore.SessionInputSourceMobile)})
		if err != nil {
			s.writeLegacySharedControlError(conn, sharedKey, request.ID, "terminal_resize_failed", err.Error())
			return
		}
		_ = s.writeLegacySharedControlSuccess(conn, sharedKey, request.ID, map[string]interface{}{"cols": resized.Cols, "rows": resized.Rows, "mode": "mobile"}, false)
	case "terminal.send":
		terminalID, valid := readLegacySharedControlTerminal(request.Params)
		if !valid {
			s.writeLegacySharedControlError(conn, sharedKey, request.ID, "bad_request", "Missing terminal handle")
			return
		}
		var params struct {
			Text      string `json:"text"`
			Enter     bool   `json:"enter"`
			Interrupt bool   `json:"interrupt"`
		}
		_ = json.Unmarshal(request.Params, &params)
		text := params.Text
		if params.Interrupt {
			text = "\x03" + text
		}
		if err := s.manager.WriteSession(terminalID, runtimecore.SessionInputRequest{Text: text, AppendNewline: params.Enter, Source: string(runtimecore.SessionInputSourceMobile)}); err != nil {
			s.writeLegacySharedControlError(conn, sharedKey, request.ID, "terminal_write_failed", err.Error())
			return
		}
		bytesWritten := len([]byte(text))
		if params.Enter {
			bytesWritten++
		}
		_ = s.writeLegacySharedControlSuccess(conn, sharedKey, request.ID, map[string]interface{}{"send": map[string]interface{}{"handle": terminalID, "accepted": true, "bytesWritten": bytesWritten}}, false)
	case "terminal.subscribe":
		terminalID, valid := readLegacySharedControlTerminal(request.Params)
		if !valid {
			s.writeLegacySharedControlError(conn, sharedKey, request.ID, "bad_request", "Missing terminal handle")
			return
		}
		tail, err := s.manager.TailSession(terminalID, 2000)
		if err != nil {
			s.writeLegacySharedControlError(conn, sharedKey, request.ID, "not_found", err.Error())
			return
		}
		transcript, err := s.manager.ReadSessionTranscript(terminalID, nil, 2000)
		if err != nil {
			s.writeLegacySharedControlError(conn, sharedKey, request.ID, "not_found", err.Error())
			return
		}
		binaryStream := readLegacySharedControlBinaryCapability(request.Params)
		streamID := uint32(0)
		if binaryStream {
			streamID = *nextStreamID
			*nextStreamID++
		}
		subscriptionID := "terminal-" + request.ID
		subscription := legacySharedControlSubscription{RequestID: request.ID, SubscriptionID: subscriptionID, Kind: "terminal", TerminalID: terminalID, StreamID: streamID, Binary: binaryStream}
		subscriptions[subscriptionID] = subscription
		_ = s.writeLegacySharedControlSuccess(conn, sharedKey, request.ID, map[string]interface{}{
			"type":      "subscribed",
			"streamId":  nullableLegacySharedControlStreamID(streamID),
			"lines":     transcript.Tail,
			"truncated": transcript.Truncated || transcript.Limited,
		}, true)
		if binaryStream {
			s.writeLegacySharedControlTerminalSnapshot(conn, sharedKey, subscription, tail.Chunks, "scrollback", "", 0)
		}
	case "terminal.unsubscribe":
		var params struct {
			SubscriptionID string `json:"subscriptionId"`
		}
		_ = json.Unmarshal(request.Params, &params)
		for key, subscription := range subscriptions {
			if subscription.Kind != "terminal" || (params.SubscriptionID != "" && params.SubscriptionID != subscription.SubscriptionID && params.SubscriptionID != subscription.TerminalID && params.SubscriptionID != subscription.RequestID) {
				continue
			}
			delete(subscriptions, key)
			_ = s.writeLegacySharedControlSuccess(conn, sharedKey, subscription.RequestID, map[string]string{"type": "end"}, true)
		}
		_ = s.writeLegacySharedControlSuccess(conn, sharedKey, request.ID, map[string]bool{"unsubscribed": true}, false)
	case "browser.screencast.unsubscribe":
		var params struct {
			SubscriptionID string `json:"subscriptionId"`
		}
		_ = json.Unmarshal(request.Params, &params)
		unsubscribed := false
		for key, subscription := range subscriptions {
			if subscription.Kind != "browser.screencast" || (params.SubscriptionID != "" && params.SubscriptionID != subscription.SubscriptionID && params.SubscriptionID != subscription.RequestID) {
				continue
			}
			subscription.Cancel()
			delete(subscriptions, key)
			unsubscribed = true
		}
		_ = s.writeLegacySharedControlSuccess(conn, sharedKey, request.ID, map[string]bool{"unsubscribed": unsubscribed}, false)
	default:
		s.writeLegacySharedControlError(conn, sharedKey, request.ID, "method_not_found", "Unknown RPC method")
	}
}

func legacySharedControlMobileMethodAllowed(method string) bool {
	switch method {
	case "status.get", "accounts.list", "accounts.subscribe", "accounts.unsubscribe",
		"session.tabs.list", "session.tabs.listAll", "session.tabs.subscribe",
		"session.tabs.subscribeAll", "session.tabs.unsubscribe", "session.tabs.unsubscribeAll",
		"terminal.read", "terminal.list", "terminal.send", "terminal.subscribe", "terminal.unsubscribe",
		"terminal.agentStatus", "terminal.isRunningAgent", "terminal.clearBuffer", "terminal.close", "terminal.updateViewport",
		"terminal.resolvePane", "terminal.focus", "terminal.create", "terminal.wait", "terminal.resolveActive", "terminal.show", "terminal.inspectProcess", "terminal.stop", "terminal.stopExact", "terminal.split", "terminal.rename", "terminal.setDisplayMode", "terminal.getDisplayMode", "terminal.resizeForClient", "terminal.restoreFit", "session.tabs.activate", "session.tabs.close",
		"browser.tabList", "browser.tabShow", "browser.tabCurrent", "browser.tabCreate", "browser.tabClose", "browser.profileList", "browser.profileCreate", "browser.profileDelete",
		"browser.goto", "browser.back", "browser.forward", "browser.reload", "browser.screenshot", "browser.fullScreenshot", "browser.pdf", "browser.snapshot", "browser.click", "browser.dblclick", "browser.fill", "browser.type", "browser.focus", "browser.clear", "browser.keypress", "browser.keyDown", "browser.keyUp", "browser.scroll", "browser.scrollIntoView", "browser.select", "browser.check", "browser.hover", "browser.selectAll", "browser.drag", "browser.upload", "browser.get", "browser.is", "browser.find", "browser.keyboardInsertText", "browser.wait", "browser.capture.start", "browser.capture.stop", "browser.console", "browser.network", "browser.harStart", "browser.harStop", "browser.profilerStart", "browser.profilerStop", "browser.intercept.enable", "browser.intercept.disable", "browser.intercept.list", "browser.geolocation", "browser.setMedia", "browser.download", "browser.pushState", "browser.storage.local.get", "browser.storage.local.set", "browser.storage.local.clear", "browser.storage.session.get", "browser.storage.session.set", "browser.storage.session.clear", "browser.highlight", "browser.mouseMove", "browser.mouseDown", "browser.mouseUp", "browser.mouseClick", "browser.mouseWheel", "browser.clipboardRead", "browser.clipboardWrite", "browser.clipboardCopy", "browser.clipboardPaste", "browser.initScriptAdd", "browser.initScriptRemove", "browser.eval", "browser.viewport", "browser.setHeaders", "browser.setOffline", "browser.setCredentials", "browser.cookie.get", "browser.cookie.set", "browser.cookie.delete", "browser.cookie.clear", "browser.dialogAccept", "browser.dialogDismiss",
		"browser.screencast", "browser.screencast.unsubscribe",
		"emulator.list", "emulator.listDevices", "emulator.listSimulators", "emulator.availability", "emulator.attach",
		"emulator.tap", "emulator.gesture", "emulator.type", "emulator.button", "emulator.rotate", "emulator.install", "emulator.launch", "emulator.logcat", "emulator.ax",
		"emulator.exec",
		"orchestration.dispatchShow",
		"session.tabs.createTerminal", "session.tabs.updatePaneLayout", "session.tabs.setTabProps", "session.tabs.move":
		return true
	default:
		return false
	}
}

func (s *Server) startLegacySharedControlBrowserScreencast(parent context.Context, conn *websocketConn, sharedKey *[32]byte, device runtimecore.LegacySharedControlDevice, request legacySharedControlRequest, subscriptions map[string]legacySharedControlSubscription) {
	var params struct {
		Page               string `json:"page"`
		Format             string `json:"format"`
		Quality            int    `json:"quality"`
		MinFrameIntervalMS int    `json:"minFrameIntervalMs"`
	}
	if json.Unmarshal(request.Params, &params) != nil {
		s.writeLegacySharedControlError(conn, sharedKey, request.ID, "bad_request", "Invalid browser screencast parameters")
		return
	}
	tab, err := s.resolveLegacySharedControlBrowserTab("browser.tabShow", request.Params)
	if err != nil {
		s.writeLegacySharedControlError(conn, sharedKey, request.ID, "browser_tab_not_found", err.Error())
		return
	}
	format := "jpeg"
	if params.Format == "png" {
		format = "png"
	}
	quality := params.Quality
	if quality <= 0 || quality > 100 {
		quality = 70
	}
	interval := time.Duration(params.MinFrameIntervalMS) * time.Millisecond
	if interval < 16*time.Millisecond {
		interval = 16 * time.Millisecond
	}
	if interval > 10*time.Second {
		interval = 10 * time.Second
	}
	ctx, cancel := context.WithCancel(parent)
	subscriptionID := "browser-screencast:" + tab.ID + ":" + randomID()
	sink := s.browserScreencasts.register(subscriptionID)
	startParams := mustLegacySharedControlJSON(map[string]interface{}{
		"page": tab.ID, "subscriptionId": subscriptionID, "format": format,
		"quality": quality, "minFrameIntervalMs": interval.Milliseconds(),
	})
	if _, err := s.runLegacySharedControlBrowserCommandContext(ctx, "browser.screencastStart", startParams); err != nil {
		s.browserScreencasts.unregister(subscriptionID, sink)
		cancel()
		s.writeLegacySharedControlError(conn, sharedKey, request.ID, "browser_error", err.Error())
		return
	}
	s.manager.MobileTookBrowserFloor(tab.ID, device.DeviceID)
	stop := func() {
		cancel()
		go func() {
			_, _ = s.runLegacySharedControlBrowserCommand("browser.screencastStop", mustLegacySharedControlJSON(map[string]interface{}{
				"page": tab.ID, "subscriptionId": subscriptionID,
			}))
		}()
	}
	subscriptions[subscriptionID] = legacySharedControlSubscription{RequestID: request.ID, SubscriptionID: subscriptionID, Kind: "browser.screencast", Cancel: stop}
	_ = s.writeLegacySharedControlSuccess(conn, sharedKey, request.ID, map[string]interface{}{"type": "ready", "subscriptionId": subscriptionID, "browserPageId": tab.ID, "tab": tab}, true)
	go s.streamLegacySharedControlBrowserFrames(ctx, conn, sharedKey, subscriptionID, tab.ID, device.DeviceID, sink)
}

func (s *Server) streamLegacySharedControlBrowserFrames(ctx context.Context, conn *websocketConn, sharedKey *[32]byte, subscriptionID, browserPageID, clientID string, sink *browserScreencastFrameSink) {
	defer s.browserScreencasts.unregister(subscriptionID, sink)
	defer s.manager.ReleaseMobileBrowserFloor(browserPageID, clientID)
	for {
		select {
		case <-ctx.Done():
			return
		case frame := <-sink.frames:
			if writeLegacySharedControlEncryptedBinary(conn, sharedKey, frame) != nil {
				return
			}
		}
	}
}

func encodeLegacySharedControlBrowserFrame(seq uint32, format string, image []byte, capturedAt time.Time) ([]byte, error) {
	metadata, err := json.Marshal(map[string]interface{}{"timestamp": float64(capturedAt.UnixMilli()) / 1000})
	if err != nil {
		return nil, err
	}
	frame := make([]byte, 16+len(metadata)+len(image))
	frame[0], frame[1], frame[2] = 0x62, 1, 1
	if format == "png" {
		frame[3] = 2
	} else {
		frame[3] = 1
	}
	binary.LittleEndian.PutUint32(frame[4:8], seq)
	binary.LittleEndian.PutUint32(frame[8:12], uint32(len(metadata)))
	copy(frame[16:], metadata)
	copy(frame[16+len(metadata):], image)
	return frame, nil
}

func mustLegacySharedControlJSON(value interface{}) json.RawMessage {
	encoded, _ := json.Marshal(value)
	return encoded
}

func writeLegacySharedControlEncryptedBinary(conn *websocketConn, sharedKey *[32]byte, plaintext []byte) error {
	encrypted, err := encryptLegacySharedControlBytes(plaintext, sharedKey)
	if err != nil {
		return err
	}
	return conn.writeBinary(encrypted)
}

func (s *Server) resolveLegacySharedControlBrowserTab(method string, raw json.RawMessage) (runtimecore.BrowserTab, error) {
	var params struct {
		Page string `json:"page"`
	}
	_ = json.Unmarshal(raw, &params)
	tabs := s.manager.ListBrowserTabs()
	if method == "browser.tabCurrent" && strings.TrimSpace(params.Page) == "" && len(tabs) > 0 {
		return tabs[len(tabs)-1], nil
	}
	pageID := strings.TrimSpace(params.Page)
	for _, tab := range tabs {
		if tab.ID == pageID {
			return tab, nil
		}
	}
	return runtimecore.BrowserTab{}, errors.New("browser tab was not found")
}

func (s *Server) runLegacySharedControlBrowserCommand(method string, raw json.RawMessage) (interface{}, error) {
	return s.runLegacySharedControlBrowserCommandContext(context.Background(), method, raw)
}

func (s *Server) runLegacySharedControlBrowserCommandContext(ctx context.Context, method string, raw json.RawMessage) (interface{}, error) {
	var params map[string]interface{}
	if json.Unmarshal(raw, &params) != nil {
		return nil, errors.New("invalid browser command parameters")
	}
	pageID, _ := params["page"].(string)
	if strings.TrimSpace(pageID) == "" {
		tab, err := s.resolveLegacySharedControlBrowserTab("browser.tabCurrent", raw)
		if err != nil {
			return nil, err
		}
		pageID = tab.ID
	}
	command := legacySharedControlBrowserCommandName(method)
	delete(params, "page")
	action, err := s.manager.QueueBrowserCommand(pageID, runtimecore.BrowserCommandRequest{Command: command, Payload: params})
	if err != nil {
		return nil, err
	}
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		default:
		}
		current, err := s.manager.GetComputerAction(action.ID)
		if err != nil {
			return nil, err
		}
		switch current.Status {
		case runtimecore.ComputerActionCompleted:
			if current.Result == nil {
				return map[string]interface{}{}, nil
			}
			return current.Result, nil
		case runtimecore.ComputerActionFailed:
			if current.Error != "" {
				return nil, errors.New(current.Error)
			}
			return nil, errors.New("browser command failed")
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(25 * time.Millisecond):
		}
	}
	return nil, errors.New("browser command timed out")
}

func legacySharedControlBrowserCommandName(method string) string {
	command := strings.TrimPrefix(method, "browser.")
	switch command {
	case "back":
		return "goBack"
	case "forward":
		return "goForward"
	case "capture.start":
		return "captureStart"
	case "capture.stop":
		return "captureStop"
	case "intercept.enable":
		return "interceptEnable"
	case "intercept.disable":
		return "interceptDisable"
	case "intercept.list":
		return "interceptList"
	case "storage.local.get":
		return "storageLocalGet"
	case "storage.local.set":
		return "storageLocalSet"
	case "storage.local.clear":
		return "storageLocalClear"
	case "storage.session.get":
		return "storageSessionGet"
	case "storage.session.set":
		return "storageSessionSet"
	case "storage.session.clear":
		return "storageSessionClear"
	case "cookie.get":
		return "cookieGet"
	case "cookie.set":
		return "cookieSet"
	case "cookie.delete":
		return "cookieDelete"
	case "cookie.clear":
		return "cookieClear"
	default:
		return command
	}
}

func (s *Server) writeLegacySharedControlSubscriptionEvent(conn *websocketConn, sharedKey *[32]byte, subscription legacySharedControlSubscription, event runtimecore.RuntimeEvent) {
	switch subscription.Kind {
	case "accounts":
		if event.Topic == "accounts.changed" {
			_ = s.writeLegacySharedControlSuccess(conn, sharedKey, subscription.RequestID, map[string]interface{}{"type": "snapshot", "snapshot": event.Payload}, true)
		}
	case "session.tabs":
		if event.Topic != "session.status" && event.Topic != "session.tabs.layout" {
			return
		}
		snapshot := s.manager.SessionTabsSnapshot(subscription.WorktreeID)
		snapshot["type"] = "updated"
		_ = s.writeLegacySharedControlSuccess(conn, sharedKey, subscription.RequestID, snapshot, true)
	case "session.tabs.all":
		worktreeID := legacySharedControlEventWorktreeID(event)
		if worktreeID == "" {
			return
		}
		snapshot := s.manager.SessionTabsSnapshot(worktreeID)
		snapshot["type"] = "updated"
		_ = s.writeLegacySharedControlSuccess(conn, sharedKey, subscription.RequestID, snapshot, true)
	case "terminal":
		if event.Topic == "session.output" {
			sessionID, chunk := legacySharedControlOutputEvent(event)
			if sessionID == subscription.TerminalID && chunk != "" {
				if subscription.Binary {
					for _, frame := range legacySharedControlTerminalOutputFrames(subscription.StreamID, uint64(event.Timestamp.UnixNano()), []byte(chunk)) {
						_ = writeLegacySharedControlBinary(conn, sharedKey, frame)
					}
				} else {
					_ = s.writeLegacySharedControlSuccess(conn, sharedKey, subscription.RequestID, map[string]interface{}{"type": "data", "chunk": chunk}, true)
				}
			}
			return
		}
		if event.Topic == "session.status" {
			session, valid := legacySharedControlSessionEvent(event)
			if !valid || session.ID != subscription.TerminalID {
				return
			}
			if session.Status == runtimecore.SessionExited || session.Status == runtimecore.SessionFailed || session.Status == runtimecore.SessionStopped {
				_ = s.writeLegacySharedControlSuccess(conn, sharedKey, subscription.RequestID, map[string]string{"type": "end"}, true)
				return
			}
			if subscription.Binary {
				payload, _ := json.Marshal(map[string]interface{}{"cols": session.Cols, "rows": session.Rows, "displayMode": "desktop", "reason": "runtime-resize"})
				_ = writeLegacySharedControlBinary(conn, sharedKey, terminalStreamFrame{Opcode: terminalStreamResized, StreamID: subscription.StreamID, Seq: uint64(event.Timestamp.UnixNano()), Payload: payload})
				if tail, err := s.manager.TailSession(subscription.TerminalID, 2000); err == nil {
					s.writeLegacySharedControlTerminalSnapshot(conn, sharedKey, subscription, tail.Chunks, "resized", "runtime-resize", uint64(event.Timestamp.UnixNano())+1)
				}
			}
		}
	}
}

func (s *Server) handleLegacySharedControlBinaryFrame(frame terminalStreamFrame, device runtimecore.LegacySharedControlDevice, subscriptions map[string]legacySharedControlSubscription) {
	var subscription *legacySharedControlSubscription
	var subscriptionKey string
	for key, candidate := range subscriptions {
		if candidate.Binary && candidate.StreamID == frame.StreamID {
			copy := candidate
			subscription = &copy
			subscriptionKey = key
			break
		}
	}
	if subscription == nil {
		return
	}
	switch frame.Opcode {
	case terminalStreamInput:
		if len(frame.Payload) > 0 {
			_ = s.manager.WriteSessionFromClient(subscription.TerminalID, runtimecore.SessionInputRequest{Text: string(frame.Payload), Source: string(runtimecore.SessionInputSourceMobile)}, runtimecore.SessionInputSourceMobile, device.DeviceID)
		}
	case terminalStreamResize:
		var viewport struct {
			Cols int `json:"cols"`
			Rows int `json:"rows"`
		}
		if json.Unmarshal(frame.Payload, &viewport) == nil && viewport.Cols > 0 && viewport.Rows > 0 {
			_, _ = s.manager.ResizeSession(subscription.TerminalID, runtimecore.SessionResizeRequest{Cols: viewport.Cols, Rows: viewport.Rows, Source: string(runtimecore.SessionInputSourceMobile)})
		}
	case terminalStreamUnsubscribe:
		delete(subscriptions, subscriptionKey)
	}
}

func (s *Server) writeLegacySharedControlTerminalSnapshot(conn *websocketConn, sharedKey *[32]byte, subscription legacySharedControlSubscription, chunks []runtimecore.OutputChunk, kind, reason string, startSeq uint64) {
	status, _ := s.manager.SessionStatus(subscription.TerminalID)
	data, truncated := legacySharedControlSnapshotBytes(chunks)
	displayMode := "desktop"
	if screen, err := s.manager.SessionScreenSnapshot(subscription.TerminalID); err == nil && screen.Alternate {
		// Why: raw TUI history contains cursor rewrites rather than a restorable
		// frame. Mobile clients need the emulator's final screen in alt mode.
		data = []byte(screen.ANSI)
		status.Cols, status.Rows = screen.Cols, screen.Rows
		displayMode = "auto"
		truncated = false
	}
	metadataValue := map[string]interface{}{"kind": kind, "cols": status.Cols, "rows": status.Rows, "cwd": status.Cwd, "displayMode": displayMode, "truncated": truncated, "truncatedByByteBudget": truncated}
	if reason != "" {
		metadataValue["reason"] = reason
	}
	metadata, _ := json.Marshal(metadataValue)
	_ = writeLegacySharedControlBinary(conn, sharedKey, terminalStreamFrame{Opcode: terminalStreamSnapshotStart, StreamID: subscription.StreamID, Seq: startSeq, Payload: metadata})
	seq := startSeq + 1
	for len(data) > 0 {
		size := legacySharedControlTerminalStreamChunkBytes
		if len(data) < size {
			size = len(data)
		} else {
			for size > 0 && !utf8.Valid(data[:size]) {
				size--
			}
			if size == 0 {
				size = legacySharedControlTerminalStreamChunkBytes
			}
		}
		_ = writeLegacySharedControlBinary(conn, sharedKey, terminalStreamFrame{Opcode: terminalStreamSnapshotChunk, StreamID: subscription.StreamID, Seq: seq, Payload: data[:size]})
		seq++
		data = data[size:]
	}
	_ = writeLegacySharedControlBinary(conn, sharedKey, terminalStreamFrame{Opcode: terminalStreamSnapshotEnd, StreamID: subscription.StreamID, Seq: seq})
}

const (
	legacySharedControlMobileSnapshotBudget     = 512 * 1024
	legacySharedControlTerminalStreamChunkBytes = 48 * 1024
)

func legacySharedControlTerminalOutputFrames(streamID uint32, startSeq uint64, data []byte) []terminalStreamFrame {
	frames := make([]terminalStreamFrame, 0, (len(data)+legacySharedControlTerminalStreamChunkBytes-1)/legacySharedControlTerminalStreamChunkBytes)
	for len(data) > 0 {
		size := legacySharedControlTerminalStreamChunkBytes
		if len(data) < size {
			size = len(data)
		} else {
			for size > 0 && !utf8.Valid(data[:size]) {
				size--
			}
			if size == 0 {
				size = legacySharedControlTerminalStreamChunkBytes
			}
		}
		frames = append(frames, terminalStreamFrame{
			Opcode: terminalStreamOutput, StreamID: streamID, Seq: startSeq + uint64(len(frames)), Payload: append([]byte(nil), data[:size]...),
		})
		data = data[size:]
	}
	return frames
}

func legacySharedControlSnapshotBytes(chunks []runtimecore.OutputChunk) ([]byte, bool) {
	var output strings.Builder
	for _, chunk := range chunks {
		output.WriteString(chunk.Content)
	}
	return terminalSnapshotSuffix([]byte(output.String()), legacySharedControlMobileSnapshotBudget)
}

func writeLegacySharedControlBinary(conn *websocketConn, sharedKey *[32]byte, frame terminalStreamFrame) error {
	encrypted, err := encryptLegacySharedControlBytes(encodeTerminalStreamFrame(frame), sharedKey)
	if err != nil {
		return err
	}
	return conn.writeBinary(encrypted)
}

func readLegacySharedControlBinaryCapability(raw json.RawMessage) bool {
	var params struct {
		Capabilities struct {
			TerminalBinaryStream int `json:"terminalBinaryStream"`
		} `json:"capabilities"`
	}
	return json.Unmarshal(raw, &params) == nil && params.Capabilities.TerminalBinaryStream == 1
}

func nullableLegacySharedControlStreamID(streamID uint32) interface{} {
	if streamID == 0 {
		return nil
	}
	return streamID
}

func readLegacySharedControlTerminal(raw json.RawMessage) (string, bool) {
	var params struct {
		Terminal string `json:"terminal"`
		Handle   string `json:"handle"`
		PtyID    string `json:"ptyId"`
	}
	if json.Unmarshal(raw, &params) != nil {
		return "", false
	}
	value := params.Terminal
	if value == "" {
		value = params.Handle
	}
	if value == "" {
		value = params.PtyID
	}
	value = strings.TrimSpace(value)
	return value, value != ""
}

func readLegacySharedControlTailLimit(raw json.RawMessage) int {
	var params struct {
		Limit int `json:"limit"`
	}
	_ = json.Unmarshal(raw, &params)
	if params.Limit < 1 {
		return 200
	}
	if params.Limit > 2000 {
		return 2000
	}
	return params.Limit
}

func readLegacySharedControlTranscriptRequest(raw json.RawMessage) (*uint64, int, error) {
	var params struct {
		Cursor json.RawMessage `json:"cursor"`
	}
	if err := json.Unmarshal(raw, &params); err != nil {
		return nil, 0, errors.New("invalid terminal read parameters")
	}
	limit := readLegacySharedControlTailLimit(raw)
	if len(params.Cursor) == 0 || string(params.Cursor) == "null" {
		return nil, limit, nil
	}
	var encoded string
	if json.Unmarshal(params.Cursor, &encoded) == nil {
		parsed, err := strconv.ParseUint(encoded, 10, 64)
		if err != nil {
			return nil, 0, errors.New("terminal cursor must be a non-negative integer")
		}
		return &parsed, limit, nil
	}
	var parsed uint64
	if err := json.Unmarshal(params.Cursor, &parsed); err != nil {
		return nil, 0, errors.New("terminal cursor must be a non-negative integer")
	}
	return &parsed, limit, nil
}

func legacySharedControlTerminalReadResult(terminalID string, status runtimecore.SessionStatus, read runtimecore.TerminalTranscriptRead) map[string]interface{} {
	return map[string]interface{}{
		"handle":            terminalID,
		"status":            legacySharedControlTerminalStatus(status),
		"tail":              read.Tail,
		"truncated":         read.Truncated,
		"limited":           read.Limited,
		"oldestCursor":      read.OldestCursor,
		"nextCursor":        read.NextCursor,
		"latestCursor":      read.LatestCursor,
		"returnedLineCount": read.ReturnedLineCount,
	}
}

func readLegacySharedControlTerminalList(raw json.RawMessage) (string, int) {
	var params struct {
		Worktree string `json:"worktree"`
		Limit    int    `json:"limit"`
	}
	_ = json.Unmarshal(raw, &params)
	limit := params.Limit
	if limit < 1 {
		limit = 200
	}
	if limit > 10000 {
		limit = 10000
	}
	return normalizeLegacyWorktreeSelector(params.Worktree), limit
}

func legacySharedControlTerminalSummary(session runtimecore.Session) map[string]interface{} {
	tabID := session.TabID
	if tabID == "" {
		tabID = "pty:" + session.ID
	}
	leafID := session.LeafID
	if leafID == "" {
		leafID = tabID
	}
	live := session.Status == runtimecore.SessionStarting || session.Status == runtimecore.SessionRunning
	return map[string]interface{}{
		"handle": session.ID, "ptyId": session.ID, "worktreeId": session.WorktreeID,
		"worktreePath": session.Cwd, "branch": "", "tabId": tabID, "leafId": leafID,
		"title": sessionTabsTerminalTitleForRPC(session), "connected": live, "writable": live,
		"lastOutputAt": session.UpdatedAt.UnixMilli(), "preview": "",
	}
}

func legacySharedControlSessionLive(session runtimecore.Session) bool {
	return session.Status == runtimecore.SessionStarting || session.Status == runtimecore.SessionRunning
}

func legacySharedControlPaneRuntimeID(leafID string) int {
	end := len(leafID)
	start := end
	for start > 0 && leafID[start-1] >= '0' && leafID[start-1] <= '9' {
		start--
	}
	if start == end {
		return 0
	}
	value, _ := strconv.Atoi(leafID[start:end])
	return value
}

func (s *Server) stopLegacySharedControlTerminals(method string, raw json.RawMessage) (map[string]interface{}, error) {
	var params struct {
		Worktree       string   `json:"worktree"`
		ExpectedPtyIDs []string `json:"expectedPtyIds"`
		TargetOnly     bool     `json:"targetOnly"`
	}
	if json.Unmarshal(raw, &params) != nil {
		return nil, errors.New("invalid terminal stop parameters")
	}
	worktreeID := normalizeLegacyWorktreeSelector(params.Worktree)
	live := make([]runtimecore.Session, 0)
	for _, session := range s.manager.ListSessions() {
		if legacySharedControlSessionLive(session) && (worktreeID == "" || session.WorktreeID == worktreeID) {
			live = append(live, session)
		}
	}
	liveIDs := make([]string, 0, len(live))
	for _, session := range live {
		liveIDs = append(liveIDs, session.ID)
	}
	sort.Strings(liveIDs)
	targets := live
	if method == "terminal.stopExact" {
		expected := make(map[string]bool, len(params.ExpectedPtyIDs))
		for _, id := range params.ExpectedPtyIDs {
			if id = strings.TrimSpace(id); id != "" {
				expected[id] = true
			}
		}
		expectedLive := len(expected) > 0
		for id := range expected {
			expectedLive = expectedLive && containsLegacySharedControlString(liveIDs, id)
		}
		exact := expectedLive && len(expected) == len(liveIDs)
		if (!params.TargetOnly && !exact) || (params.TargetOnly && !expectedLive) {
			return map[string]interface{}{"stopped": 0, "stoppedPtyIds": []string{}, "livePtyIds": liveIDs, "postStopVerified": false}, nil
		}
		targets = make([]runtimecore.Session, 0, len(expected))
		for _, session := range live {
			if expected[session.ID] {
				targets = append(targets, session)
			}
		}
	}
	stoppedIDs := make([]string, 0, len(targets))
	stopErrors := make([]string, 0)
	for _, session := range targets {
		if _, err := s.manager.StopSession(session.ID); err == nil {
			stoppedIDs = append(stoppedIDs, session.ID)
		} else {
			stopErrors = append(stopErrors, session.ID+": "+err.Error())
		}
	}
	sort.Strings(stoppedIDs)
	remainingIDs := make([]string, 0)
	for _, session := range s.manager.ListSessions() {
		if legacySharedControlSessionLive(session) && (worktreeID == "" || session.WorktreeID == worktreeID) {
			remainingIDs = append(remainingIDs, session.ID)
		}
	}
	sort.Strings(remainingIDs)
	postStopVerified := len(stopErrors) == 0
	if method == "terminal.stopExact" && params.TargetOnly {
		for _, target := range targets {
			postStopVerified = postStopVerified && !containsLegacySharedControlString(remainingIDs, target.ID)
		}
	} else {
		postStopVerified = postStopVerified && len(remainingIDs) == 0
	}
	result := map[string]interface{}{
		"stopped":          len(stoppedIDs),
		"stoppedPtyIds":    stoppedIDs,
		"livePtyIds":       liveIDs,
		"postStopVerified": postStopVerified,
	}
	if len(remainingIDs) > 0 {
		result["remainingLivePtyIds"] = remainingIDs
	}
	if !postStopVerified {
		if len(stopErrors) > 0 {
			result["postStopFailure"] = "terminal_stop_failed: " + strings.Join(stopErrors, "; ")
		} else {
			result["postStopFailure"] = "terminal_exact_stop_still_live"
		}
	}
	return result, nil
}

func containsLegacySharedControlString(values []string, candidate string) bool {
	for _, value := range values {
		if value == candidate {
			return true
		}
	}
	return false
}

func (s *Server) setLegacySharedControlDisplayMode(raw json.RawMessage) (map[string]interface{}, error) {
	terminalID, valid := readLegacySharedControlTerminal(raw)
	var params struct {
		Mode   string `json:"mode"`
		Client struct {
			ID   string `json:"id"`
			Type string `json:"type"`
		} `json:"client"`
		Viewport struct {
			Cols int `json:"cols"`
			Rows int `json:"rows"`
		} `json:"viewport"`
	}
	if !valid || json.Unmarshal(raw, &params) != nil || (params.Mode != "auto" && params.Mode != "desktop") {
		return nil, errors.New("invalid terminal display mode")
	}
	if _, err := s.manager.SessionStatus(terminalID); err != nil {
		return nil, err
	}
	if params.Mode == "desktop" {
		s.manager.ReclaimSessionForDesktop(terminalID)
		return map[string]interface{}{"mode": "desktop"}, nil
	}
	if params.Viewport.Cols != 0 || params.Viewport.Rows != 0 {
		if params.Viewport.Cols < 20 || params.Viewport.Cols > 240 || params.Viewport.Rows < 8 || params.Viewport.Rows > 120 {
			return nil, errors.New("invalid terminal viewport")
		}
		if _, err := s.manager.ResizeSession(terminalID, runtimecore.SessionResizeRequest{Cols: params.Viewport.Cols, Rows: params.Viewport.Rows, Source: string(runtimecore.SessionInputSourceMobile)}); err != nil {
			return nil, err
		}
	}
	if params.Client.Type == "mobile" && strings.TrimSpace(params.Client.ID) != "" {
		s.manager.MobileTookSessionFloor(terminalID, strings.TrimSpace(params.Client.ID))
	}
	return map[string]interface{}{"mode": "auto"}, nil
}

func (s *Server) resizeLegacySharedControlTerminalForClient(raw json.RawMessage) (map[string]interface{}, error) {
	terminalID, valid := readLegacySharedControlTerminal(raw)
	var params struct {
		Mode     string `json:"mode"`
		ClientID string `json:"clientId"`
		Cols     int    `json:"cols"`
		Rows     int    `json:"rows"`
	}
	if !valid || json.Unmarshal(raw, &params) != nil || strings.TrimSpace(params.ClientID) == "" {
		return nil, errors.New("invalid terminal resize parameters")
	}
	if _, err := s.manager.SessionStatus(terminalID); err != nil {
		return nil, err
	}
	clientID := strings.TrimSpace(params.ClientID)
	if params.Mode == "mobile-fit" {
		if params.Cols < 1 || params.Rows < 1 {
			return nil, errors.New("invalid_dimensions")
		}
		resized, override, err := s.manager.ApplyMobileSessionFit(terminalID, clientID, params.Cols, params.Rows)
		if err != nil {
			return nil, err
		}
		return map[string]interface{}{"terminal": map[string]interface{}{"handle": terminalID, "cols": resized.Cols, "rows": resized.Rows, "previousCols": override.PreviousCols, "previousRows": override.PreviousRows, "mode": "mobile-fit"}}, nil
	}
	if params.Mode != "restore" {
		return nil, errors.New("invalid terminal resize mode")
	}
	override, exists := s.manager.GetSessionFitOverride(terminalID)
	if !exists {
		return nil, errors.New("no_active_override")
	}
	if override.ClientID != clientID {
		return nil, errors.New("not_override_owner")
	}
	resized, err := s.manager.ResizeSession(terminalID, runtimecore.SessionResizeRequest{Cols: override.PreviousCols, Rows: override.PreviousRows, Source: string(runtimecore.SessionInputSourceMobile)})
	if err != nil {
		return nil, err
	}
	s.manager.ClearSessionFitOverride(terminalID)
	s.manager.ReclaimSessionForDesktop(terminalID)
	return map[string]interface{}{"terminal": map[string]interface{}{"handle": terminalID, "cols": resized.Cols, "rows": resized.Rows, "previousCols": nil, "previousRows": nil, "mode": "desktop-fit"}}, nil
}

func sessionTabsTerminalTitleForRPC(session runtimecore.Session) string {
	if len(session.Command) > 0 {
		return strings.Join(session.Command, " ")
	}
	if session.AgentKind != "" {
		return session.AgentKind
	}
	return "Terminal"
}

func (s *Server) handleLegacySharedControlWait(ctx context.Context, conn *websocketConn, sharedKey *[32]byte, device runtimecore.LegacySharedControlDevice, request legacySharedControlRequest) {
	if device.Scope == "mobile" && !legacySharedControlMobileMethodAllowed(request.Method) {
		s.writeLegacySharedControlError(conn, sharedKey, request.ID, "forbidden", "Method is not available to mobile clients")
		return
	}
	terminalID, valid := readLegacySharedControlTerminal(request.Params)
	var params struct {
		Condition string   `json:"for"`
		TimeoutMs *float64 `json:"timeoutMs"`
	}
	if !valid || json.Unmarshal(request.Params, &params) != nil {
		s.writeLegacySharedControlError(conn, sharedKey, request.ID, "bad_request", "Missing terminal handle")
		return
	}
	wait, err := s.manager.WaitSession(ctx, terminalID, runtimecore.SessionWaitRequest{Condition: params.Condition, TimeoutMs: params.TimeoutMs})
	if err != nil {
		s.writeLegacySharedControlError(conn, sharedKey, request.ID, "terminal_wait_failed", err.Error())
		return
	}
	result := map[string]interface{}{"handle": terminalID, "condition": wait.Condition, "satisfied": wait.Satisfied, "status": legacySharedControlTerminalStatus(wait.Status), "exitCode": wait.ExitCode}
	if wait.HookAgentState == runtimecore.SessionHookPermission {
		result["blockedReason"] = "permission"
	}
	_ = s.writeLegacySharedControlSuccess(conn, sharedKey, request.ID, map[string]interface{}{"wait": result}, false)
}

func readLegacySharedControlTerminalCreate(raw json.RawMessage) (legacySharedControlTerminalCreateParams, error) {
	var params struct {
		Worktree, WorktreeID, Cwd, Command, AgentKind, TabID, LeafID string
		LaunchToken, Prompt, Surface, AfterTabID, TargetGroupID      string
		ClientMutationID                                             string `json:"clientMutationId"`
		Activate                                                     *bool
		LaunchAgent                                                  interface{} `json:"launchAgent"`
		Env                                                          interface{} `json:"env"`
		Cols, Rows                                                   int
	}
	if json.Unmarshal(raw, &params) != nil {
		return legacySharedControlTerminalCreateParams{}, errors.New("Invalid terminal create parameters")
	}
	worktreeID := normalizeLegacyWorktreeSelector(params.Worktree)
	if worktreeID == "" {
		worktreeID = normalizeLegacyWorktreeSelector(params.WorktreeID)
	}
	if worktreeID == "" {
		return legacySharedControlTerminalCreateParams{}, errors.New("Missing worktree")
	}
	command := legacySharedControlShellCommand(params.Command)
	agentKind := strings.TrimSpace(params.AgentKind)
	if agentKind == "" {
		switch value := params.LaunchAgent.(type) {
		case string:
			agentKind = strings.TrimSpace(value)
		case map[string]interface{}:
			agentKind, _ = value["id"].(string)
		}
	}
	tabID := strings.TrimSpace(params.TabID)
	if tabID == "" {
		tabID = "tab-" + randomID()
	}
	leafID := strings.TrimSpace(params.LeafID)
	if leafID == "" {
		leafID = "leaf-" + randomID()
	}
	activate := params.Activate == nil || *params.Activate
	return legacySharedControlTerminalCreateParams{WorktreeID: worktreeID, Cwd: strings.TrimSpace(params.Cwd), Command: command, AgentKind: agentKind, TabID: tabID, LeafID: leafID, LaunchToken: strings.TrimSpace(params.LaunchToken), Prompt: params.Prompt, Surface: params.Surface, AfterTabID: strings.TrimSpace(params.AfterTabID), TargetGroupID: strings.TrimSpace(params.TargetGroupID), ClientMutationID: strings.TrimSpace(params.ClientMutationID), Environment: legacySharedControlEnvironment(params.Env), Cols: params.Cols, Rows: params.Rows, Ephemeral: strings.HasPrefix(worktreeID, "ephemeral-setup-terminal:"), Activate: activate}, nil
}

func (s *Server) startLegacySharedControlTerminal(raw json.RawMessage) (runtimecore.Session, legacySharedControlTerminalCreateParams, error) {
	params, err := readLegacySharedControlTerminalCreate(raw)
	if err != nil {
		return runtimecore.Session{}, params, err
	}
	if params.ClientMutationID != "" && params.LaunchToken == "" {
		params.LaunchToken = "shared-control-mutation:" + params.ClientMutationID
		if existing, ok := s.manager.FindSessionByLaunchToken(params.WorktreeID, params.LaunchToken); ok {
			return existing, params, nil
		}
	}
	start := runtimecore.StartSessionRequest{WorktreeID: params.WorktreeID, Cwd: params.Cwd, Command: params.Command, AgentKind: params.AgentKind, TabID: params.TabID, LeafID: params.LeafID, LaunchToken: params.LaunchToken, Prompt: params.Prompt, Cols: params.Cols, Rows: params.Rows, Environment: params.Environment}
	if params.Ephemeral {
		start.Ephemeral = true
	} else {
		for _, worktree := range s.manager.ListWorktrees("") {
			if worktree.ID == params.WorktreeID {
				start.ProjectID = worktree.ProjectID
				if start.Cwd == "" {
					start.Cwd = worktree.Path
				}
				break
			}
		}
		if start.ProjectID == "" {
			return runtimecore.Session{}, params, errors.New("terminal worktree is not available")
		}
	}
	session, err := s.manager.StartSession(context.Background(), start)
	return session, params, err
}

func legacySharedControlShellCommand(command string) []string {
	command = strings.TrimSpace(command)
	if command == "" {
		return nil
	}
	if runtime.GOOS == "windows" {
		return []string{"cmd.exe", "/d", "/s", "/c", command}
	}
	return []string{"/bin/sh", "-lc", command}
}

func legacySharedControlEnvironment(value interface{}) []string {
	result := make([]string, 0)
	switch env := value.(type) {
	case []interface{}:
		for _, item := range env {
			if text, ok := item.(string); ok && strings.Contains(text, "=") {
				result = append(result, text)
			}
		}
	case map[string]interface{}:
		for key, rawValue := range env {
			if text, ok := rawValue.(string); ok && key != "" && !strings.ContainsAny(key, "=\x00") {
				result = append(result, key+"="+text)
			}
		}
	}
	return result
}

func validLegacySharedControlTabProps(props map[string]interface{}) bool {
	if color, exists := props["color"]; exists {
		if color != nil {
			text, ok := color.(string)
			if !ok || len(text) > 64 {
				return false
			}
		}
	}
	if pinned, exists := props["isPinned"]; exists {
		if _, ok := pinned.(bool); !ok {
			return false
		}
	}
	if mode, exists := props["viewMode"]; exists && mode != "terminal" && mode != "chat" {
		return false
	}
	return true
}

func validLegacySharedControlTabMove(kind, tabID, targetGroupID, direction string, tabOrder []string, index *int) bool {
	if strings.TrimSpace(tabID) == "" || strings.TrimSpace(targetGroupID) == "" {
		return false
	}
	switch kind {
	case "reorder":
		return len(tabOrder) > 0
	case "move-to-group":
		return index == nil || *index >= 0
	case "split":
		return direction == "left" || direction == "right" || direction == "up" || direction == "down"
	default:
		return false
	}
}

func legacySharedControlTerminalCreateResult(session runtimecore.Session, surface string) map[string]interface{} {
	if surface != "background" {
		surface = "visible"
	}
	return map[string]interface{}{"handle": session.ID, "tabId": sessionTabsResponseID(session.TabID, session.ID, "tab-"), "paneKey": sessionTabsResponseID(session.LeafID, session.ID, "leaf-"), "ptyId": session.ID, "worktreeId": session.WorktreeID, "title": sessionTabsTerminalTitleForRPC(session), "surface": surface}
}

func legacySharedControlSnapshotTab(snapshot map[string]interface{}, terminalID string) interface{} {
	tabs, _ := snapshot["tabs"].([]map[string]interface{})
	for _, tab := range tabs {
		if tab["terminal"] == terminalID || tab["ptyId"] == terminalID {
			return tab
		}
	}
	return nil
}

func randomID() string {
	var bytes [12]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(bytes[:])
}

func legacySharedControlTerminalStatus(status runtimecore.SessionStatus) string {
	if status == runtimecore.SessionStarting || status == runtimecore.SessionRunning {
		return "running"
	}
	return "exited"
}

func sessionTabsResponseID(value, fallback, prefix string) string {
	if value = strings.TrimSpace(value); value != "" {
		return value
	}
	return prefix + fallback
}

func legacySharedControlOutputEvent(event runtimecore.RuntimeEvent) (string, string) {
	encoded, err := json.Marshal(event.Payload)
	if err != nil {
		return "", ""
	}
	var payload struct {
		Session struct {
			ID string `json:"id"`
		} `json:"session"`
		Chunk runtimecore.OutputChunk `json:"chunk"`
	}
	if json.Unmarshal(encoded, &payload) != nil {
		return "", ""
	}
	return payload.Session.ID, payload.Chunk.Content
}

func legacySharedControlSessionEvent(event runtimecore.RuntimeEvent) (runtimecore.Session, bool) {
	encoded, err := json.Marshal(event.Payload)
	if err != nil {
		return runtimecore.Session{}, false
	}
	var session runtimecore.Session
	if json.Unmarshal(encoded, &session) != nil || session.ID == "" {
		return runtimecore.Session{}, false
	}
	return session, true
}

func readLegacySharedControlWorktree(raw json.RawMessage) (string, bool) {
	var params struct {
		Worktree   string `json:"worktree"`
		WorktreeID string `json:"worktreeId"`
	}
	if json.Unmarshal(raw, &params) != nil {
		return "", false
	}
	value := params.Worktree
	if value == "" {
		value = params.WorktreeID
	}
	value = normalizeLegacyWorktreeSelector(value)
	return value, value != ""
}

func normalizeLegacyWorktreeSelector(value string) string {
	return strings.TrimPrefix(strings.TrimSpace(value), "id:")
}

func legacySharedControlEventWorktreeID(event runtimecore.RuntimeEvent) string {
	encoded, err := json.Marshal(event.Payload)
	if err != nil {
		return ""
	}
	var payload struct {
		WorktreeID string `json:"worktreeId"`
	}
	if json.Unmarshal(encoded, &payload) != nil {
		return ""
	}
	return payload.WorktreeID
}

func writeLegacySharedControlEncrypted(conn *websocketConn, sharedKey *[32]byte, payload interface{}) error {
	encoded, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	encrypted, err := encryptLegacySharedControlText(encoded, sharedKey)
	if err != nil {
		return err
	}
	return conn.writeText(encrypted)
}

func (s *Server) writeLegacySharedControlSuccess(conn *websocketConn, sharedKey *[32]byte, id string, result interface{}, streaming bool) error {
	return writeLegacySharedControlEncrypted(conn, sharedKey, legacySharedControlResponse{ID: id, OK: true, Result: result, Streaming: streaming, Meta: map[string]string{"runtimeId": s.manager.LegacySharedControlRuntimeID()}})
}

func (s *Server) writeLegacySharedControlError(conn *websocketConn, sharedKey *[32]byte, id, code, message string) {
	if id == "" {
		id = "unknown"
	}
	_ = writeLegacySharedControlEncrypted(conn, sharedKey, legacySharedControlResponse{ID: id, OK: false, Error: &legacySharedControlRPCError{Code: code, Message: message}, Meta: map[string]string{"runtimeId": s.manager.LegacySharedControlRuntimeID()}})
}
