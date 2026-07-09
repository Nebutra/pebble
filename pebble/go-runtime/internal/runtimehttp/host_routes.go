package runtimehttp

import (
	"net/http"

	"github.com/tsekaluk/pebble/go-runtime/internal/hostprobe"
)

// handleHostTerminalCapabilities serves the WSL/pwsh/Git-Bash detection the
// desktop shell needs to offer Windows shell profiles. It replaces the Tauri
// bridge's constant-false stub for host.wsl.isAvailable / pwsh / gitBash.
func (s *Server) handleHostTerminalCapabilities(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	writeJSON(w, http.StatusOK, hostprobe.NewProber().Detect())
}
