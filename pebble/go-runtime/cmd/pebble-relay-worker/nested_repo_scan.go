package main

import (
	"context"
	"errors"
	"flag"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/tsekaluk/pebble/go-runtime/internal/runtimecore"
)

// nestedScanPostInterval throttles partial progress posts: streaming liveness
// matters for long walks, but every snapshot is a full HTTP round trip.
const nestedScanPostInterval = time.Second

// nestedScanOverallTimeout bounds the whole command even if the caller passes
// an unbounded scan timeout; matches the runtime's 30s scan-timeout ceiling
// with headroom for the final post.
const nestedScanOverallTimeout = 45 * time.Second

// runScanNested runs the shared nested-repo scan on the remote host and posts
// the result to the runtime gateway, mirroring Electron's SSH folder scan for
// relay-only connections. Partial snapshots stream while the walk runs so the
// desktop's scan-progress listeners stay live.
func runScanNested(args []string, client *http.Client, output io.Writer) error {
	fs := flag.NewFlagSet("scan-nested", flag.ExitOnError)
	endpoint := fs.String("endpoint", "http://127.0.0.1:17777", "runtime endpoint")
	token := fs.String("token", os.Getenv("PEBBLE_RUNTIME_TOKEN"), "runtime bearer token")
	hostID := fs.String("host", "", "runtime ssh host id")
	scanPath := fs.String("path", "", "remote folder to scan")
	scanID := fs.String("scan-id", "", "desktop scan id for streaming progress")
	maxDepth := fs.Float64("max-depth", 0, "maximum scan depth (0 uses the runtime default)")
	maxRepos := fs.Float64("max-repos", 0, "maximum repos to report (0 uses the runtime default)")
	timeoutMs := fs.Float64("timeout-ms", 15_000, "scan timeout in milliseconds")
	_ = fs.Parse(args)
	if strings.TrimSpace(*hostID) == "" {
		return errors.New("host is required")
	}
	if strings.TrimSpace(*scanPath) == "" {
		return errors.New("path is required")
	}
	req := runtimecore.NestedRepoScanRequest{
		Path:    strings.TrimSpace(*scanPath),
		Options: runtimecore.NestedRepoScanOptions{TimeoutMs: timeoutMs},
	}
	if *maxDepth > 0 {
		req.Options.MaxDepth = maxDepth
	}
	if *maxRepos > 0 {
		req.Options.MaxRepos = maxRepos
	}
	ctx, cancel := context.WithTimeout(context.Background(), nestedScanOverallTimeout)
	defer cancel()
	lastPostAt := time.Time{}
	onProgress := func(snapshot runtimecore.NestedRepoScanResult) {
		if time.Since(lastPostAt) < nestedScanPostInterval {
			return
		}
		lastPostAt = time.Now()
		// Partial posts are best-effort liveness; the final post below is the
		// one that must succeed.
		_ = postJSON(client, io.Discard, *endpoint, *token, "/v1/project-groups/remote-nested-scans",
			nestedScanUpdate(*hostID, *scanID, req.Path, true, snapshot))
	}
	scan, err := runtimecore.ScanNestedReposOnHost(ctx, req, onProgress)
	if err != nil {
		return err
	}
	return postJSON(client, output, *endpoint, *token, "/v1/project-groups/remote-nested-scans",
		nestedScanUpdate(*hostID, *scanID, req.Path, false, scan))
}

func nestedScanUpdate(
	hostID string,
	scanID string,
	scanPath string,
	partial bool,
	scan runtimecore.NestedRepoScanResult,
) runtimecore.UpdateRemoteNestedRepoScanRequest {
	return runtimecore.UpdateRemoteNestedRepoScanRequest{
		HostID:  strings.TrimSpace(hostID),
		ScanID:  strings.TrimSpace(scanID),
		Path:    scanPath,
		Partial: partial,
		Scan:    scan,
	}
}
