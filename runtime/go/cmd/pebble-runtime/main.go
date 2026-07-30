package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/nebutra/pebble/runtime/go/internal/runtimeauth"
	"github.com/nebutra/pebble/runtime/go/internal/runtimecore"
	"github.com/nebutra/pebble/runtime/go/internal/runtimehttp"
)

func main() {
	if os.Getenv("PEBBLE_SSH_ASKPASS_MODE") == "1" {
		// Why: the runtime executable is a cross-platform SSH_ASKPASS helper;
		// the credential stays in the child environment and never enters argv.
		fmt.Fprintln(os.Stdout, os.Getenv("PEBBLE_SSH_ASKPASS_SECRET"))
		return
	}
	listen := flag.String("listen", "127.0.0.1:17777", "HTTP listen address")
	dataDir := flag.String("data-dir", runtimeauth.DefaultDataDir(), "runtime data directory")
	token := flag.String("token", os.Getenv("PEBBLE_RUNTIME_TOKEN"), "optional runtime bearer token")
	lanSharedControl := flag.Bool(
		"lan-shared-control",
		false,
		"bind shared-control beyond loopback; control HTTP and localhost-label stay loopback-only",
	)
	flag.Parse()

	unavailable := detectUnavailableTools()
	manager, err := runtimecore.NewManager(*dataDir, unavailable)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	defer manager.Shutdown()
	endpoint, err := runtimeauth.EndpointForListen(*listen)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	cleanupCredential, err := runtimeauth.Publish(*dataDir, endpoint, *token)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	defer cleanupCredential()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	monitorDesktopParent(ctx, stop, os.Getenv("PEBBLE_RUNTIME_PARENT_PID"))

	// Due automations must fire without a desktop shell polling /evaluate.
	go manager.RunAutomationScheduler(ctx, time.Minute)

	fmt.Fprintf(os.Stderr, "pebble runtime listening on http://%s\n", *listen)
	if *lanSharedControl {
		fmt.Fprintln(os.Stderr, "LAN shared-control enabled: pairing WebSocket may be reached off-loopback; control API remains loopback-only")
	}
	if err := runtimehttp.StartWithOptions(ctx, *listen, manager, runtimehttp.ServerOptions{
		BearerToken:                   *token,
		AllowNonLoopbackSharedControl: *lanSharedControl,
	}); err != nil && err != context.Canceled {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func monitorDesktopParent(ctx context.Context, stop context.CancelFunc, rawParentPID string) {
	parentPID, err := strconv.Atoi(rawParentPID)
	if err != nil || parentPID <= 0 {
		return
	}
	go func() {
		// Why: a force-killed desktop cannot run Rust cleanup; platform
		// monitoring must release the runtime port before the next launch.
		if waitForDesktopParentExit(ctx, parentPID) {
			stop()
		}
	}()
}

func detectUnavailableTools() []string {
	tools := []string{"git", "zig", "pnpm"}
	var unavailable []string
	for _, tool := range tools {
		if _, err := execLookPath(tool); err != nil {
			unavailable = append(unavailable, tool)
		}
	}
	return unavailable
}

func execLookPath(file string) (string, error) {
	return syscallExecLookPath(file)
}
