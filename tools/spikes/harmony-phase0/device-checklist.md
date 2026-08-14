# Harmony Phase 0 — device checklist (fill on OH PC)

Copy results into `docs/reference/investigations/harmony-phase0-gates.md` decision log.

**Device:**  
**API / OS build:**  
**Tester:**  
**Date:**  

Use: Pass | Partial | Fail | Skip

---

## A — Runtime

| ID | Result | Evidence path / notes |
|----|--------|------------------------|
| A1.1 target/ABI | | |
| A1.2 hello | | |
| A1.3 hello-http loopback | | |
| A1.4 sqlite data-dir | | |
| A1.5 full pebble-runtime build | | |
| A2.1 shell spawn runtime | | |
| A2.2 token + parent pid | | |
| A2.3 SIGTERM | | |
| A2.4 background 5–10m | | |
| A2.5 data-dir restart | | |
| A3.1 /v1/status | | |
| A3.2 bearer 401/200 | | |
| A3.3 terminal-capabilities | | |
| A3.4 /v1/projects | | |
| A3.5 /v1/events | | |

**A aggregate:** Pass / Fail  

## B — PTY

| ID | Result | Notes |
|----|--------|-------|
| B1.1 pts | | |
| B1.2 creack/pty | | `probe-pty-minimal` |
| B1.3 resize | | |
| B2.1–B2.4 runtime session | | |
| B3.1 pipe-only | | |
| B3.2 SSH hybrid | | |
| B3.3 remote-only | | |

**B aggregate:** Pass / Partial / Fail  

## C — Workspace

| ID | Result | Notes |
|----|--------|-------|
| C1.1 FS | | |
| C1.2 git version | | |
| C1.3 init/commit | | |
| C1.4 worktree add | | |
| C1.5–C1.6 via /v1 | | |
| C1.7 unavailable tools | | |

**C aggregate:**  

## D — Agents

| ID | Result | Notes |
|----|--------|-------|
| D1.1–D1.3 spawn | | |
| D1.4 agent CLI | | which? |
| D1.5 runtime agent session | | |
| D2.1 ssh client | | |
| D2.2 remote session | | |

**D aggregate:** Local-Pass / Hybrid-Pass / Fail  

## E — UI

| ID | Result | Notes |
|----|--------|-------|
| E1.1 static HTML | | |
| E1.2 web bundle | | |
| E1.3 not Tauri shell | | |
| E1.4 loopback from Web | | |
| E1.5 keyboard/IME | | |
| E1.6 clipboard | | |
| E1.7 scroll | | |
| E1.8 no browser guest | | |

**E aggregate:**  

## G — Shell

| ID | Result | Notes |
|----|--------|-------|
| G1.1 HAP install | | |
| G1.2 embed sidecar+assets | | |
| G1.3 permissions | | |
| G1.4 hilog | | |
| G1.5 resign | | |

**G aggregate:**  

## H — Security

| ID | Result | Notes |
|----|--------|-------|
| H1.1 loopback only | | |
| H1.2 web→127.0.0.1 | | |
| H1.3 token hygiene | | |
| H1.4 LAN policy | | |

## Decision

- [ ] G-Runtime  
- [ ] G-Session  
- [ ] G-Workspace  
- [ ] G-Agent  
- [ ] G-UI  
- [ ] G-Shell  
- [ ] G-Map (offline Pass already)

**Go / No-Go Phase 1:**  

**V1 scope sentence (final):**  
