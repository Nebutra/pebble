package runtimehttp

import (
	"context"
	"net/http"
	"strings"
	"time"

	"github.com/nebutra/pebble/runtime/go/internal/runtimecore"
)

func (s *Server) handleEphemeralVMRecipes(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	projectID := strings.TrimSpace(r.URL.Query().Get("projectId"))
	if projectID == "" {
		writeError(w, http.StatusBadRequest, "projectId is required")
		return
	}
	writeJSON(w, http.StatusOK, s.manager.ListEphemeralVMRecipes(projectID))
}

func (s *Server) handleEphemeralVMRuntimes(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	runtimes, err := s.manager.ListEphemeralVMRuntimes()
	if err != nil {
		writeRuntimeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, runtimes)
}

func (s *Server) handleEphemeralVMProvision(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var input runtimecore.EphemeralVMProvisionRequest
	if !decodeJSON(w, r, &input) {
		return
	}
	writeJSON(w, http.StatusOK, s.manager.ProvisionEphemeralVM(r.Context(), input))
}

func (s *Server) handleEphemeralVMCancel(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var input struct {
		ProvisionID string `json:"provisionId"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"cancelled": s.manager.CancelEphemeralVMProvision(input.ProvisionID)})
}

func (s *Server) handleEphemeralVMAction(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	action := strings.TrimPrefix(r.URL.Path, "/v1/ephemeral-vm/")
	var input struct {
		RuntimeID            string `json:"runtimeId"`
		WorkspaceID          string `json:"workspaceId"`
		RuntimeEnvironmentID string `json:"runtimeEnvironmentId"`
		SshTargetID          string `json:"sshTargetId"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	if action == "attach" {
		record, err := s.manager.AttachEphemeralVMWorkspace(input.RuntimeID, input.WorkspaceID)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, record)
		return
	}
	if action == "connection" {
		record, err := s.manager.SetEphemeralVMConnection(input.RuntimeID, input.RuntimeEnvironmentID, input.SshTargetID)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, record)
		return
	}
	if action == "cleanup-command" {
		payload, command, disabled, err := s.manager.EphemeralVMCleanupDetails(input.RuntimeID)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		response := map[string]interface{}{"runtimeId": input.RuntimeID, "command": command, "payloadJson": payload, "cleanupDisabled": disabled}
		if disabled {
			response["command"] = nil
			response["message"] = "Destroy is disabled or not configured."
		}
		writeJSON(w, http.StatusOK, response)
		return
	}
	runtimeID := input.RuntimeID
	if runtimeID == "" && input.WorkspaceID != "" {
		record, err := s.manager.FindEphemeralVMRuntimeByWorkspace(input.WorkspaceID)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		if record == nil {
			writeJSON(w, http.StatusOK, nil)
			return
		}
		runtimeID = record.ID
	}
	if runtimeID == "" {
		writeError(w, http.StatusBadRequest, "runtimeId or workspaceId is required")
		return
	}
	mode := map[string]string{"cleanup": "destroy", "suspend": "suspend", "resume": "resume"}[action]
	if mode == "" {
		writeError(w, http.StatusNotFound, "ephemeral VM action not found")
		return
	}
	commandContext, cancel := context.WithTimeout(r.Context(), 30*time.Minute)
	defer cancel()
	record, err := s.manager.RunEphemeralVMLifecycle(commandContext, runtimeID, mode)
	if err != nil {
		writeRuntimeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, record)
}

func (s *Server) handleEphemeralVMRecipeCatalog(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	writeJSON(w, http.StatusOK, s.manager.ListEphemeralVMRecipeCatalog())
}

func (s *Server) handleEphemeralVMDoctor(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var input struct {
		ProjectID string `json:"projectId"`
		RecipeID  string `json:"recipeId"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	if strings.TrimSpace(input.ProjectID) == "" || strings.TrimSpace(input.RecipeID) == "" {
		writeError(w, http.StatusBadRequest, "projectId and recipeId are required")
		return
	}
	writeJSON(w, http.StatusOK, s.manager.DoctorEphemeralVMRecipe(input.ProjectID, input.RecipeID))
}
