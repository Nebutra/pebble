package main

import (
	"errors"
	"flag"
	"io"
	"net/http"
	"os"
	"os/exec"
	"strings"

	"github.com/tsekaluk/pebble/go-runtime/internal/runtimecore"
)

// runAgentDetect probes the remote host's PATH for the desktop's TUI agent
// catalog and posts the detected agent ids to the runtime gateway, mirroring
// Electron's SSH detectRemoteAgents for relay-only connections.
//
// Why the catalog is a request parameter: the agent list lives in
// src/shared/tui-agent-config.ts and changes often; the desktop passes it per
// invocation so this worker never drifts from the renderer's catalog.
func runAgentDetect(args []string, client *http.Client, output io.Writer) error {
	fs := flag.NewFlagSet("agent-detect", flag.ExitOnError)
	endpoint := fs.String("endpoint", "http://127.0.0.1:17777", "runtime endpoint")
	token := fs.String("token", os.Getenv("PEBBLE_RUNTIME_TOKEN"), "runtime bearer token")
	hostID := fs.String("host", "", "runtime ssh host id")
	agents := fs.String("agents", "", "agent catalog: comma-separated id=command[|alias...] entries")
	_ = fs.Parse(args)
	if strings.TrimSpace(*hostID) == "" {
		return errors.New("host is required")
	}
	catalog, err := parseAgentCatalog(*agents)
	if err != nil {
		return err
	}
	payload := runtimecore.UpdateRemoteAgentDetectionRequest{
		HostID: *hostID,
		Agents: detectAgentsOnPath(catalog, exec.LookPath),
	}
	return postJSON(client, output, *endpoint, *token, "/v1/remote-hosts/agent-detections", payload)
}

type agentCatalogEntry struct {
	ID       string
	Commands []string
}

// parseAgentCatalog reads `id=command[|alias...]` entries. A bare `id` probes
// the id itself as the command name.
func parseAgentCatalog(spec string) ([]agentCatalogEntry, error) {
	spec = strings.TrimSpace(spec)
	if spec == "" {
		return nil, errors.New("agents catalog is required")
	}
	var catalog []agentCatalogEntry
	for _, raw := range strings.Split(spec, ",") {
		raw = strings.TrimSpace(raw)
		if raw == "" {
			continue
		}
		id, commandSpec, hasCommands := strings.Cut(raw, "=")
		id = strings.TrimSpace(id)
		if id == "" {
			return nil, errors.New("agent catalog entry is missing an id")
		}
		var commands []string
		if hasCommands {
			for _, command := range strings.Split(commandSpec, "|") {
				if command = strings.TrimSpace(command); command != "" {
					commands = append(commands, command)
				}
			}
		}
		if len(commands) == 0 {
			commands = []string{id}
		}
		catalog = append(catalog, agentCatalogEntry{ID: id, Commands: commands})
	}
	if len(catalog) == 0 {
		return nil, errors.New("agents catalog is required")
	}
	return catalog, nil
}

func detectAgentsOnPath(catalog []agentCatalogEntry, lookPath func(string) (string, error)) []string {
	detected := make([]string, 0, len(catalog))
	for _, entry := range catalog {
		for _, command := range entry.Commands {
			if _, err := lookPath(command); err == nil {
				detected = append(detected, entry.ID)
				break
			}
		}
	}
	return detected
}
