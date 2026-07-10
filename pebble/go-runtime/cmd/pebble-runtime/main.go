package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/tsekaluk/pebble/go-runtime/internal/runtimecore"
	"github.com/tsekaluk/pebble/go-runtime/internal/runtimehttp"
)

func main() {
	listen := flag.String("listen", "127.0.0.1:17777", "HTTP listen address")
	dataDir := flag.String("data-dir", defaultDataDir(), "runtime data directory")
	token := flag.String("token", os.Getenv("PEBBLE_RUNTIME_TOKEN"), "optional runtime bearer token")
	flag.Parse()

	unavailable := detectUnavailableTools()
	manager, err := runtimecore.NewManager(*dataDir, unavailable)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	defer manager.Shutdown()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// Due automations must fire without a desktop shell polling /evaluate.
	go manager.RunAutomationScheduler(ctx, time.Minute)

	fmt.Fprintf(os.Stderr, "pebble runtime listening on http://%s\n", *listen)
	if err := runtimehttp.StartWithOptions(ctx, *listen, manager, runtimehttp.ServerOptions{
		BearerToken: *token,
	}); err != nil && err != context.Canceled {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func defaultDataDir() string {
	if home, err := os.UserHomeDir(); err == nil {
		return filepath.Join(home, ".pebble")
	}
	return ".pebble"
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
