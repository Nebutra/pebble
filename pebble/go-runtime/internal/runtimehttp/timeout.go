package runtimehttp

import "time"

const shutdownTimeout = 5 * time.Second

// eventStreamHeartbeatInterval keeps idle SSE connections open across proxies and SSH tunnels.
// A var (not const) so tests can shrink it without waiting the full interval.
var eventStreamHeartbeatInterval = 15 * time.Second
