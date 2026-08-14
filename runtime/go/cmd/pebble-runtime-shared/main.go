// pebble-runtime-shared builds pebble-runtime as a C shared library for
// in-process hosting (HarmonyOS HAP). SELinux blocks exec of app data and
// even of packaged native libs that are ET_EXEC; only dlopen of ET_DYN works.
//
// Build (OHOS NDK):
//
//	CGO_ENABLED=1 GOOS=linux GOARCH=arm64 \
//	  CC=aarch64-unknown-linux-ohos-clang \
//	  go build -buildmode=c-shared -o libpebble_runtime.so .
package main

/*
#include <stdlib.h>
*/
import "C"

import (
	"context"
	"fmt"
	"os"
	"sync"
	"time"
	"unsafe"

	"github.com/nebutra/pebble/runtime/go/internal/runtimeauth"
	"github.com/nebutra/pebble/runtime/go/internal/runtimecore"
	"github.com/nebutra/pebble/runtime/go/internal/runtimehttp"
)

var (
	mu      sync.Mutex
	cancel  context.CancelFunc
	running bool
	lastErr string
)

//export PebbleRuntimeStart
func PebbleRuntimeStart(listenC, dataDirC, tokenC *C.char) C.int {
	mu.Lock()
	defer mu.Unlock()
	if running {
		return 0
	}
	listen := C.GoString(listenC)
	dataDir := C.GoString(dataDirC)
	token := C.GoString(tokenC)

	unavailable := detectUnavailableTools()
	manager, err := runtimecore.NewManager(dataDir, unavailable)
	if err != nil {
		lastErr = err.Error()
		return 1
	}
	endpoint, err := runtimeauth.EndpointForListen(listen)
	if err != nil {
		manager.Shutdown()
		lastErr = err.Error()
		return 2
	}
	cleanupCredential, err := runtimeauth.Publish(dataDir, endpoint, token)
	if err != nil {
		manager.Shutdown()
		lastErr = err.Error()
		return 3
	}

	ctx, stop := context.WithCancel(context.Background())
	cancel = func() {
		stop()
		cleanupCredential()
		manager.Shutdown()
	}

	errCh := make(chan error, 1)
	go manager.RunAutomationScheduler(ctx, time.Minute)
	go func() {
		err := runtimehttp.StartWithOptions(ctx, listen, manager, runtimehttp.ServerOptions{
			BearerToken: token,
		})
		if err != nil && err != context.Canceled {
			errCh <- err
			return
		}
		errCh <- nil
	}()

	// Wait briefly for bind success / early failure.
	select {
	case err := <-errCh:
		if err != nil {
			cancel()
			cancel = nil
			lastErr = err.Error()
			return 4
		}
		// Server returned immediately without error — treat as stopped.
		cancel()
		cancel = nil
		lastErr = "server exited immediately"
		return 5
	case <-time.After(300 * time.Millisecond):
		// Still running — good enough for bind probe.
	}

	// Drain later exit asynchronously so we can report lastErr.
	go func() {
		err := <-errCh
		mu.Lock()
		defer mu.Unlock()
		if err != nil {
			lastErr = err.Error()
		}
		running = false
		if cancel != nil {
			// already stopped or stopping
		}
	}()

	running = true
	lastErr = ""
	fmt.Fprintf(os.Stderr, "pebble runtime (shared) listening on http://%s\n", listen)
	return 0
}

//export PebbleRuntimeStop
func PebbleRuntimeStop() {
	mu.Lock()
	defer mu.Unlock()
	if cancel != nil {
		cancel()
		cancel = nil
	}
	running = false
}

//export PebbleRuntimeIsRunning
func PebbleRuntimeIsRunning() C.int {
	mu.Lock()
	defer mu.Unlock()
	if running {
		return 1
	}
	return 0
}

//export PebbleRuntimeLastError
func PebbleRuntimeLastError() *C.char {
	mu.Lock()
	defer mu.Unlock()
	if lastErr == "" {
		return nil
	}
	// Caller must free with free().
	return C.CString(lastErr)
}

//export PebbleRuntimeFree
func PebbleRuntimeFree(p *C.char) {
	if p != nil {
		C.free(unsafe.Pointer(p))
	}
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

func main() {}
