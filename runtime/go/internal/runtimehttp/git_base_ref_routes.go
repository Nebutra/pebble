package runtimehttp

import (
	"encoding/json"
	"net/http"
	"strconv"
)

type gitReviewStartRequest struct {
	ProjectID         string `json:"projectId"`
	Kind              string `json:"kind"`
	Number            int    `json:"number"`
	Head              string `json:"head"`
	Base              string `json:"base"`
	IsCrossRepository bool   `json:"isCrossRepository"`
}

func (s *Server) handleGitBaseRefDefault(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	result, err := s.manager.SshGitBaseRefDefault(r.URL.Query().Get("projectId"))
	if err != nil {
		writeRuntimeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) handleGitReviewStart(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var request gitReviewStartRequest
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	result, err := s.manager.ResolveSshGitReviewStart(
		request.ProjectID, request.Kind, request.Number, request.Head, request.Base, request.IsCrossRepository,
	)
	if err != nil {
		writeRuntimeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) handleGitBaseRefSearch(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	result, err := s.manager.SearchSshGitBaseRefs(r.URL.Query().Get("projectId"), r.URL.Query().Get("query"), limit)
	if err != nil {
		writeRuntimeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}
