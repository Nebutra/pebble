# Taking the app bridge off the keystroke path

Status: proposed. Scoped to the local terminal data plane. Does not depend on,
and is not blocked by, the Go-to-Rust runtime migration.

## What a keystroke costs today

Desktop, local session, one character typed:

| | Crossing | Cost |
| --- | --- | --- |
| ① | `invoke('write_runtime_pty_input', {sessionId, text, runtimeUrl, bearerToken})` | JS→native, JSON |
| ② | the command's promise resolution | native→JS |
| ③ | Rust → `POST 127.0.0.1:17777/v1/sessions/{id}/input` | HTTP, JSON body, loopback TCP |
| ④ | runtime → SSE event for the shell's echo | Go→Rust, JSON |
| ⑤ | Rust → Tauri `Channel` → `xterm.write` | native→JS, JSON |

Five crossings, four JSON encodes, per character. `runtimeUrl` and
`bearerToken` are constants re-serialized on every keystroke.

The Electron predecessor did the same work in two crossings: `ipcRenderer.send`
to the main process, `node-pty.write` to the fd, `webContents.send` back. No
HTTP, no second process, no per-key JSON.

## Why the measurements all came back clean

Every layer was measured and every layer was fast: 5ms through the user's real
shell, 4ms through the runtime, 0.25ms median renderer work per output chunk,
59fps frame delivery with no dropped frames under a 150-keystroke injection at
human cadence. Nothing is slow because no single layer is slow. The cost is the
five boundaries between them, which no per-layer measurement can see.

## What the in-process migration does not fix

`2026-08-13-local-runtime-in-process-migration.md` removes ③ and ④ by linking
the runtime into the desktop host. It claims this leaves "no serialization on
the keystroke path". That claim is wrong: a runtime linked into the Rust host is
still reached from the renderer by `invoke`, so ①, ②, and ⑤ survive intact.

The two boundaries are orthogonal:

- That plan removes the **Rust↔Go** boundary. It needs the 64k-line migration.
- This plan removes the **WebView↔Rust** boundary for terminal data. It needs
  no Go migration at all, and can land first.

Neither subsumes the other. Both are worth doing.

## The change

Give the terminal its own transport, and keep `invoke` for the control plane.

```
xterm onData → socket.send(frame)      binary, WebKit network process
             → runtime → write(pty)
  pty → runtime → socket frame → xterm.write(Uint8Array)
```

A new loopback endpoint, `/v1/terminal-stream`, speaking the **existing**
`terminalStreamFrame` format from `terminal_stream_protocol.go` — the same 16-byte
header, the same `input`/`output`/`resize`/`subscribe` opcodes the remote
shared-control path already uses, minus the encryption that loopback does not
need.

This is not a new protocol. It is the transport the remote path already runs on,
extended to the one path that was still going through the app bridge. Today an
SSH session's keystrokes cross fewer boundaries than a local one's.

### What it removes

- **JSON on the data plane.** Frames are bytes. Output reaches `xterm.write` as
  a `Uint8Array`, which is what xterm wants anyway — today the runtime encodes
  bytes→UTF-8→JSON string and xterm decodes it back.
- **Auth per keystroke.** The bearer token is presented once at upgrade instead
  of being serialized into every input command.
- **The renderer-side ack/flow-control layer.** It exists because a Tauri
  `Channel` has no backpressure. A socket has `bufferedAmount`.
- **The polling fallback.** `PTY_OUTPUT_POLL_MIN_MS`/`MAX_MS` back off to 250ms
  when push is not connected; a socket either is connected or is not.

### What it cannot remove

WKWebView content always runs in its own process. There is no zero-boundary
option on macOS and this plan does not pretend otherwise. The claim is five
crossings to one, and JSON to bytes — not the elimination of IPC.

## Security

The endpoint is unencrypted, so it must never be reachable off-box. The runtime
can be configured to bind beyond loopback for mobile and remote clients, so
binding is not sufficient evidence: the handler rejects any connection whose
`RemoteAddr` is not loopback, in addition to requiring the bearer token. Both
checks, not either.

## What was measured

Against the real runtime binary, from a browser-style WebSocket client, cost of
handing off one keystroke:

| Transport | p50 | p95 | max |
| --- | --- | --- | --- |
| `POST /v1/sessions/{id}/input` | 1.387ms | 1.689ms | 1.909ms |
| terminal-stream frame | 0.010ms | 0.031ms | 0.044ms |

These are not the same quantity and must not be read as "typing is 139x faster":
the HTTP number is a completed round trip, the socket number is a queued send.
What they do compare honestly is **what the calling thread pays per keystroke**,
which is the part that runs on the WebView's main thread while someone types.
The bytes still cross loopback either way.

The remaining question a Go test cannot answer is whether WebKit will dial a
plain `ws://` loopback socket from a page served on a custom scheme, since
production is `tauri://localhost` rather than `http://`. A standalone WKWebView
serving its page from `pebble://localhost` opened the socket and negotiated the
subprotocol, so the transport holds in the engine that ships.

## Rollout

The socket is an addition, not a replacement. The existing `invoke` path stays
and is used whenever the socket is unavailable — an older runtime without the
endpoint, a refused upgrade, a dropped connection. There is no flag day, and a
transport failure degrades to today's behaviour rather than to a dead terminal.

## How this composes with the runtime migration

When the runtime moves in-process, the socket server moves with it: the endpoint
becomes a loopback listener owned by the desktop host, or a Unix domain socket,
without the renderer changing. The frame format is the seam, and it is the same
seam remote clients already use.
