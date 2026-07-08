# Pebble 工程架构与 Go/Rust/Zig/Tauri/RN 重写分析

生成日期：2026-07-06

本报告基于 `/Users/tseka_luk/workspace/code/forks/pebble` 的只读代码分析和 6 路子代理并行审计结果整理。目标不是复述源码，而是给后续用 Go + Rust + Zig + Tauri + React Native 重写时提供模块边界、风险排序和迁移路线。

## 1. 结论摘要

Pebble 不是一个普通 Electron 桌面壳。它更像一个“本地/远程 agent runtime 平台”：

- 桌面端当前是 Electron + React + Vite。Electron main 承担服务编排、PTY、SSH relay、browser/CDP、computer-use、emulator、Git/provider、runtime RPC、安全边界和持久化。
- 前端不是轻页面，而是厚客户端工作台。React/Zustand 管 workspace、worktree、tab/split、terminal/browser/editor/emulator、right sidebar、settings、tasks 等 UI 状态。
- CLI 是外部控制面。`pebble` CLI 基本不直接做业务，只解析命令、推断上下文，然后通过 Runtime RPC 调正在运行的 Pebble runtime。
- 移动端已经是 Expo/React Native。它不是独立 IDE，而是 pairing 后通过 WebSocket + E2EE 控制桌面/serve runtime，订阅 terminal、browser screencast、source-control、file preview 等能力。
- SSH 远程能力依赖 `src/relay`。relay 是部署到远端的 Node daemon，负责 PTY/FS/Git/agent hook/remote CLI，支持断线 grace period 和 Unix socket reconnect。
- agent 集成不是 SDK 嵌入，而是 TUI 进程编排：`TUI_AGENT_CONFIG` 定义命令和 prompt 注入，PTY 承载进程，hook/OSC/foreground process 识别状态。
- 最大迁移风险是 browser。当前 browser 深度依赖 Electron `WebContents`、`<webview>`、CDP debugger、offscreen `BrowserWindow`、download/permission/session/profile 语义。Tauri WebView 不能自然等价替换。

重写策略应先固化协议和边界，再替换实现。不要直接把 `src/main/index.ts` 或 `PebbleRuntimeService` 整体翻译成某门语言。

## 2. 当前工程结构

仓库不是标准 pnpm workspace。根项目、mobile 项目和 mobile 本地包各有自己的 `package.json`/lockfile：

- 根桌面/CLI/runtime：`package.json`
- 移动端：`mobile/package.json`
- 移动端本地 Expo 模块：`mobile/packages/expo-two-way-audio/package.json`

主要目录职责：

| 路径 | 职责 |
| --- | --- |
| `src/main` | Electron 主进程，也是 runtime composition root |
| `src/preload` | renderer 与 Electron main 之间的 `window.api` IPC 合约 |
| `src/renderer` | React 桌面/Web 工作台 |
| `src/shared` | 跨 main/renderer/CLI/mobile/relay 的类型、协议、工具函数 |
| `src/cli` | packaged `pebble` CLI |
| `src/relay` | 通过 SSH 部署到远端的 relay daemon |
| `mobile` | Expo/React Native companion app |
| `native` | computer-use 平台 provider，macOS Swift、Linux Python、Windows PowerShell |
| `config` | 构建、校验、打包脚本 |
| `resources` | 图标、平台资源、打包资源 |
| `tests/e2e` | Electron Playwright E2E |

关键入口：

- 根包 main/bin：`package.json:7`、`package.json:11`
- Electron main：`src/main/index.ts`
- Preload 合约：`src/preload/index.ts`、`src/preload/api-types.ts`
- Renderer 入口：`src/renderer/src/main.tsx`
- Web 入口：`src/renderer/src/web/main.tsx`
- CLI 入口：`src/cli/index.ts`
- Runtime RPC server：`src/main/runtime/runtime-rpc.ts`
- Runtime RPC method manifest：`src/main/runtime/rpc/methods/index.ts`
- Relay 入口：`src/relay/relay.ts`
- Mobile root：`mobile/app/_layout.tsx`

## 3. 构建、发布与 CI

根项目使用：

- Node 24
- pnpm 10.24.0
- TypeScript 5.9
- `electron-vite`
- `electron-builder`
- `tsgo`
- `oxlint` / `oxfmt`
- Vitest + Playwright

构建脚本分层明显：

- `build:relay`：构建远端 relay
- `build:cli`：构建 packaged CLI
- `build:electron-vite`：构建 Electron main/preload/renderer
- `build:web`：构建 Web client 到 `out/web`
- `build:desktop`：桌面主包
- `build:native` / `build:computer-macos`：native helper
- `build:release`：release 路径

`electron.vite.config.ts` 对 main 进程有多个 Rollup 入口：

- `src/main/index.ts`
- `src/main/daemon/daemon-entry.ts`
- `src/main/computer/sidecar-entry.ts`
- `src/main/speech/stt-worker.ts`
- `src/main/warp-themes/warp-theme-parser-worker.ts`
- `src/main/runtime/file-watcher-worker.ts`
- `src/main/agent-hooks/managed-agent-hook-controls.ts`

这说明当前 Electron main 实际上打包了多个进程/worker 入口。

发布边界也不能忽略：

- Windows：NSIS + SignPath。
- macOS：dmg/zip、hardened runtime、notarization，release 受 `PEBBLE_MAC_RELEASE` 控制。
- Linux：可执行/package 名称是 `pebble`，并包含 headless serve 依赖。
- Release workflow 先创建 draft，再构建 artifacts，最后校验 required assets、telemetry constants、update manifests 后 publish。

重写到 Tauri 时，Tauri updater、签名、公证、Linux 命名、Homebrew/update manifest、draft-until-complete 发布门禁都需要等价设计。

## 4. 运行时架构

### 4.1 Electron main 是当前 composition root

`src/main/index.ts` 做了大量服务装配：

- persistence `Store`
- stats / usage store
- Claude/Codex/OpenCode account 和 rate limit 服务
- telemetry/observability
- daemon PTY provider
- runtime service
- runtime RPC server
- browser bridge / emulator bridge
- automation service
- keybinding service
- tray/menu/window lifecycle
- mobile handlers

它不是“窗口启动文件”，而是整个产品的进程编排中心。

### 4.2 `PebbleRuntimeService` 是领域状态核心

`src/main/runtime/pebble-runtime.ts` 是当前最重要也最耦合的类。它承载：

- worktree/repo/folder workspace 管理
- Git 操作路由
- terminal handle 和 PTY 注册
- mobile session tabs/terminal/browser graph
- browser/emulator/runtime capabilities
- orchestration 长轮询和 worker lifecycle
- Linear/GitHub/GitLab/Jira 上下文
- terminal output、cwd、foreground agent 追踪

Go 服务化前，应先拆出明确 service：

- `RepoService`
- `WorktreeService`
- `GitExecutionService`
- `WorkspaceLineageService`
- `TerminalSessionService`
- `OrchestrationService`
- `ExternalTaskService`
- `ProviderService`

不要把整个 `PebbleRuntimeService` 直接翻译成 Go 或 Rust。

### 4.3 Runtime RPC 是最适合固化的协议边界

Runtime RPC 当前已经比 Electron IPC 更像真正 API：

- `defineMethod` / `defineStreamingMethod` 绑定 method、Zod params、handler。
- `RpcDispatcher` 统一参数校验、streaming、错误 envelope。
- 本地 socket/named pipe 使用 runtime metadata + auth token。
- WebSocket 使用 device token + E2EE。
- mobile scope 有 method allowlist。
- long-poll 命令有 keepalive 和连接槽位控制。

关键文件：

- `src/main/runtime/rpc/core.ts`
- `src/main/runtime/rpc/dispatcher.ts`
- `src/main/runtime/rpc/methods/index.ts`
- `src/main/runtime/runtime-rpc.ts`
- `src/shared/protocol-version.ts`
- `src/shared/runtime-rpc-envelope.ts`
- `src/shared/runtime-types.ts`

重写建议：先把 Runtime RPC 提炼成 IDL/codegen。控制面可用 JSON Schema、protobuf/Buf 或自定义 schema，terminal/browser screencast 等高频流保持专用二进制帧。

## 5. 前端工作台

桌面前端是 React 19 + Zustand + Tailwind v4 + Radix/shadcn + xterm + Monaco + TipTap。

### 5.1 UI 路由

没有 React Router。页面由 Zustand 中的 `activeView` 驱动，主要 view 包括：

- terminal/workbench
- settings
- tasks
- activity
- automations
- space
- skills
- mobile

`App.tsx` 懒加载主要页面和 modal。Terminal workbench 常驻但可隐藏，避免频繁销毁 terminal/browser/emulator surface。

### 5.2 状态管理

全局 Zustand store 在 `src/renderer/src/store/index.ts`，由多个 slice 组合：

- repo/worktree
- terminal
- tabs
- UI/settings/keybindings
- GitHub/GitLab/Linear/Jira
- editor
- browser
- SSH
- agent status
- diff comments
- runtime status
- workspace cleanup
- usage/rate limit

`tabs` slice 是统一 tab/split 模型。terminal/browser/editor/emulator 都挂在统一工作台模型上。

### 5.3 Workbench

中央工作台承载：

- terminal pane
- browser pane
- editor/file preview
- emulator pane
- tab group / split layout

一个重要实现细节：terminal/browser pane 在 worktree 层只渲染一次，通过 overlay/CSS anchor 定位到对应 group，避免 xterm remount 和 webview reload。这是迁移到 Tauri 时必须保留的交互语义。

### 5.4 `window.api` 是迁移关键

renderer 不直接访问 Node，而是通过 preload 暴露 `window.api`。Web client 也有 `installWebPreloadApi` 模拟同一 API。

这给 Tauri 迁移提供了天然边界：

1. 先保留 React/Zustand UI。
2. 在 Tauri 侧实现同名 command/event bridge。
3. 逐步把 Electron preload 替换成 generated TS client。
4. Terminal/browser/emulator 作为独立 native plugin/sidecar 后移。

## 6. Agent 与 Terminal 体系

### 6.1 Agent 抽象不是 SDK，而是 TUI 进程

Pebble 把各类 agent 当成：

- 可检测命令
- 可启动命令
- 可注入 prompt 的 TUI
- 可通过 hook/OSC/title/foreground process 判断状态的终端进程

核心链路：

`TUI_AGENT_CONFIG` -> startup/draft/resume plan -> `pty:spawn` -> `IPtyProvider` -> agent hooks/OSC -> runtime RPC/orchestration/automation -> persistence

### 6.2 Agent 配置层

`src/shared/tui-agent-config.ts` 定义 30 多种 TUI agent：

- Claude / Claude Agent Teams / OpenClaude
- Codex
- OpenCode
- Gemini
- Cursor
- Copilot
- Grok
- Devin
- Pi / OMP
- Aider / Goose / Amp / Kilo / Kiro / Crush / Auggie / Cline / Codebuff / Command Code / Continue / Droid / Kimi / Mistral Vibe / Qwen / Rovo / Hermes / OpenClaw / Ante 等

配置字段包括：

- `detectCmd`
- `detectCmdAliases`
- `launchCmd`
- `launchCmdByPlatform`
- `expectedProcess`
- `promptInjectionMode`
- `draftPromptFlag`
- `draftPromptEnvVar`
- `preflightTrust`
- `draftPasteReadySignal`

prompt 注入模式：

- `argv`
- `flag-prompt`
- `flag-prompt-interactive`
- `flag-interactive`
- `stdin-after-start`

### 6.3 Hook adapter

不同 agent 的 hook 写入方式各不相同：

- Claude/OpenClaude：写 Claude settings 和 shell hook。
- Codex：管理 `hooks.json` 和 `config.toml` trust entries。
- OpenCode：通过 `OPENCODE_CONFIG_DIR` overlay 注入 plugin。
- Gemini：配置 `BeforeAgent/AfterAgent/BeforeTool/AfterTool`。
- Cursor：写 `~/.cursor/hooks.json`，并处理 Cursor 的 trust marker。
- Copilot/Grok/Devin/Hermes/Kimi/Droid/Command Code 等各有 hook service。

统一 hook server 在 `src/main/agent-hooks/server.ts`，本地只监听 `127.0.0.1`，使用 token header，远端 hook 事件经 relay 回来后仍会 normalize。

### 6.4 PTY Provider

`IPtyProvider` 是 terminal/agent runner 的核心接口，覆盖：

- spawn
- attach
- write
- resize
- signal
- cwd
- foreground process
- serialize / revive
- list
- default shell

实现分布：

- 本地 provider：`src/main/providers/local-pty-provider.ts`
- daemon adapter：`src/main/daemon/daemon-pty-adapter.ts`
- SSH provider：`src/main/providers/ssh-pty-provider.ts`
- provider types：`src/main/providers/types.ts`

本地 PTY 被拆到 Electron 外部 daemon。daemon 负责 session 续命、reattach、cold restore、history/checkpoint。当前依赖 `node-pty` 和 `@xterm/headless`。

重写建议：

- Go 可优先承接 daemon/remote runner/SSH orchestration。
- Rust 更适合定义 typed trait、安全状态机、SQLite/append-log、E2EE。
- Zig 只用于小型低层 shim，例如 forkpty/ConPTY/spawn guard/二进制 frame codec，不建议写完整 runtime。

## 7. CLI、Repo、Worktree 与 Provider

### 7.1 CLI 是薄控制面

`src/cli/index.ts` 做参数解析、help、远端选择、runtime client 初始化。命令 spec 分组：

- core
- project
- file
- automation
- browser
- orchestration
- computer
- environment
- agent hooks
- diagnostics
- linear
- vm
- emulator

本地 runtime 走 metadata/socket；远端 runtime 走 pairing WebSocket。`environment/serve/agent/vm` 等命令会抑制远端选择，避免被 `PEBBLE_PAIRING_CODE` 等环境变量误路由。

### 7.2 Worktree create/remove 是高风险状态机

当前 worktree create 分三条路径：

- folder workspace：写 metadata 并建 terminal。
- SSH repo：走 `createManagedRemoteWorktree`。
- 本地 Git repo：解析 base/branch/path、处理 sparse/push target、`git worktree add`、写 meta、运行 hooks、创建 terminal/default tabs。

Worktree remove 需要处理：

- folder workspace
- SSH provider
- 本地 Git
- orphan cleanup
- Windows long path/stale registration
- branch preserve
- PTY teardown
- metadata cleanup

Go 化建议改成事务式 pipeline：

1. `ValidateIntent`
2. `ResolveRepoHost`
3. `ResolveBase`
4. `AllocateBranchPath`
5. `ExecuteGit`
6. `PersistMetadata`
7. `ProvisionTerminals/Hooks`
8. `Notify`

remove 也应有 operation log 和补偿逻辑，保证断线、Windows 文件占用、SSH 不可用时可恢复。

### 7.3 Git provider 和 forge provider 要分开

当前有两类 provider：

1. Git execution provider：本地/SSH/WSL 路由 `git status/diff/stage/push/pull/worktree`。
2. Forge provider：GitHub/GitLab/Bitbucket/Azure DevOps/Gitea 的 PR/MR/issue/check/comment/review API。

现在 `WorktreeMeta` 中仍有 provider-specific 字段：

- `linkedGitHubPR`
- `linkedGitLabMR`
- `linkedBitbucketPR`
- `linkedAzureDevOpsPR`
- `linkedGiteaPR`
- Linear/Jira links

重写建议：

- 迁移为 `ExternalArtifactRef[]` 或 `primaryReview: { provider, host, repoRef, kind, number, url }`。
- `ProjectProviderIdentity` 从 GitHub-only 扩展为 `RepositoryIdentity { provider, host, namespace, repo, projectKey? }`。
- Forge provider 用 capability model：`reviews.read/create`、`issues.read/write`、`checks.read`、`comments.write`。
- GitHub/GitLab/Bitbucket/Azure/Gitea 差异留在 provider adapter，不泄漏到业务层。

## 8. Orchestration 与 Automation

### 8.1 Orchestration

Orchestration 是 runtime 内置多 agent 协调层，不是 LLM 自动规划器。它提供：

- messages
- tasks
- dispatch contexts
- decision gates
- coordinator runs

消息类型包括：

- `status`
- `dispatch`
- `worker_done`
- `merge_ready`
- `escalation`
- `handoff`
- `decision_gate`
- `heartbeat`

任务状态包括：

- `pending`
- `ready`
- `dispatched`
- `completed`
- `failed`
- `blocked`

DB 使用 SQLite/WAL，schema 在 `src/main/runtime/orchestration/db.ts`，当前 schema version 为 5。

关键行为：

- group address fan-out 会为每个收件人创建消息。
- `worker_done` / `heartbeat` 禁止发到 group。
- lifecycle authority 是 `taskId + dispatchId + assignee`，防止旧 worker 完成新 dispatch。
- `check --wait` 是 runtime 长轮询，需要 keepalive 和 long-poll 槽位控制。

Go 服务化时，Orchestration 是较适合优先抽出的模块。保留 `dispatchId`，不要退化为只按 `taskId` 完成。

### 8.2 Automation

Automation 类型覆盖 pending/dispatching/dispatched/completed/skipped/failed 等 run 状态。`AutomationService` 支持：

- manual run
- precheck
- renderer dispatch
- headless dispatch
- 本地 shell 和 SSH exec precheck

与 Orchestration 不同，Automation 更像定时/外部动作触发器，需与 worktree/terminal/runtime graph 联动。

## 9. Mobile 与 Remote Runtime

移动端已经是 Expo/RN：

- Expo Router
- React 19
- RN 0.83
- Reanimated
- WebView
- SVG
- Zustand
- Zod
- tweetnacl

移动端 pairing：

- `pebble://pair?code=...`
- offer 包含 endpoint、deviceToken、server public key
- WebSocket 默认端口 `6768`
- E2EE 使用 tweetnacl Curve25519 + XSalsa20-Poly1305
- 先明文 `e2ee_hello`，再加密 `e2ee_auth`

移动端不是直接打开网页或执行本地 agent，而是通过 RPC 控制 desktop/serve runtime：

- terminal subscribe/input/resize
- source-control
- file preview/edit
- mobile session tabs
- browser screencast
- browser touch -> mouse/keyboard RPC
- account/status/notifications

RN 重写/延续建议：

- 保留 Expo/RN UI。
- 抽出生成式 transport client，替换手写 mirrored protocol。
- 保留 connection recovery 行为：auth retry budget、stream replay、foreground notify、terminal binary frame、browser screencast frame。
- 可复用 shared data model 和 selectors，但不要尝试复用 DOM JSX、Tailwind class、Radix/shadcn、xterm DOM、Monaco、Electron webview。

## 10. SSH Relay 与远端执行

`src/relay` 是 SSH 远端 daemon：

- Electron 通过 SCP/SSH exec 部署启动。
- stdio 使用自定义 framed JSON-RPC。
- 断线后进入 grace period。
- relay 继续保留 PTY。
- 新连接通过 `--connect` 桥接到旧 relay 的 Unix socket。
- 支持多 client attach。

relay frame：

- header 长度 13 字节
- message type：regular / handshake / keepalive
- 单帧默认上限 16MB
- 有 seq/ack
- dispatcher 管 per-client decoder、abort、pending requests、keepalive

SSH session 成功后注册：

- remote PTY provider
- remote filesystem provider
- remote Git provider
- remote agent hook relay
- remote `pebble` CLI shim
- plugin overlay

重写优先级很高。Go 或 Rust 静态二进制可显著降低远端 Node/npm/native deps 复杂度。无论用 Go 还是 Rust，都必须复刻：

- grace/reconnect 语义
- frame seq/ack
- keepalive
- request cancel/abort
- PTY 保活
- remote path semantics
- SIGHUP/断线存活
- remote hook replay
- provider registration

## 11. Browser/CDP

Browser 是 Tauri 迁移的最大风险。

当前能力：

- 桌面 renderer `<webview>` guest
- headless/offscreen `BrowserWindow`
- `BrowserManager` 统一注册 WebContents
- Electron `webContents.debugger` CDP command
- CDP WS proxy，兼容 Chrome DevTools 风格 `/json/version`、`/json/list`、target websocket
- screenshot/PDF/insertText/navigation/reload 兼容处理
- browser session/profile/cookie import
- permission/download/popup/load failure 事件
- anti-detection script
- mobile viewport/device metrics
- mobile browser screencast：`Page.startScreencast` + fallback screenshot
- Design Mode / grab payload / DOM/CSS/screenshot capture

Tauri WebView/WKWebView/WebView2 不能直接提供等价 `WebContents.debugger`。可选路线：

1. 保留外部 Chromium/CEF/agent-browser 作为 browser subsystem。
2. Tauri 只负责 UI 壳，browser 作为独立 sidecar/service。
3. 短期保留 Electron browser 后端，等核心 runtime 迁移后再单独评估。

不建议把 RN WebView 当作 desktop browser automation 替代品。移动 browser 当前只是桌面 screencast client。

## 12. Computer-use 与 Native

computer-use 当前 RPC 面：

- `computer.capabilities`
- `listApps`
- `listWindows`
- `getAppState`
- `click`
- `scroll`
- `drag`
- `typeText`
- `pressKey`
- `hotkey`
- `pasteText`
- `setValue`

主进程 fork `computer-sidecar.js`，sidecar 再选择 provider：

- macOS 14+：Swift helper app，独立 TCC 身份。
- Linux：Python + AT-SPI + GDK/xdotool/wl-copy/xclip/xsel。
- Windows：PowerShell + UIAutomationClient + Win32 user32 + System.Drawing。

macOS helper 不应合并进主进程。TCC/Accessibility/Screen Recording 需要独立签名 app/helper 身份。重写时应保持 sidecar/provider 抽象，逐平台替换实现：

- macOS：Swift/ObjC 调 AX、ScreenCaptureKit、CGEvent 最稳。
- Linux：可逐步换 Rust/Go + AT-SPI/DBus，但先保持 JSON operation contract。
- Windows：可用 `windows-rs` UI Automation + GDI/DXGI 截图逐步替换 PowerShell。

## 13. Emulator

Emulator RPC 覆盖：

- list/attach
- tap/gesture/type/button/rotate/exec
- kill/shutdown
- install/launch
- permissions
- accessibility tree
- logcat

`EmulatorBridge` 维护 per-worktree active session，并路由到 backend：

- iOS backend：macOS only，`xcrun simctl` + `serve-sim`，MJPEG/WS helper。
- Android backend：Android SDK discovery、adb/emulator、scrcpy H.264 stream、uiautomator、logcat、permissions。

这块迁移相对 browser 更平滑，因为核心仍是外部工具 orchestration。Rust 或 Go 负责进程、端口、frame registry、device/session state 即可。Zig 不适合作为 orchestration 层。

## 14. 技术栈与轮子盘点

建议保留：

- React/Zustand UI
- Tailwind v4 + shadcn/Radix + lucide
- Monaco
- TipTap
- xterm 前端渲染
- Expo/RN
- Vitest/Playwright/oxlint/oxfmt
- Zod 作为迁移期边界校验

短期封装后替换：

- Electron IPC/preload
- `node-pty`
- `ssh2`
- JSON persistence
- `@parcel/watcher`
- Node relay
- computer-use script provider

谨慎保留或单独评估：

- `agent-browser`
- Electron WebContents/CDP browser backend
- `sherpa-onnx`
- `serve-sim`
- `scrcpy`

不建议重造：

- terminal renderer
- 富文本/Markdown/编辑器基础设施
- UI primitives
- 移动端导航和基础 RN 栈

必须抽象/重造：

- Runtime RPC/IPC schema
- relay protocol 实现
- PTY provider trait
- worktree transaction pipeline
- provider capability model
- credential broker
- persistence migration

## 15. Go/Rust/Zig/Tauri/RN 职责建议

### Go

适合：

- SSH relay daemon
- remote runner
- CLI
- Git/FS/port/exec orchestration
- Orchestration service
- Worktree service pipeline
- WebSocket/Unix/named-pipe RPC server
- 外部 provider API 聚合

注意：

- 不要把 OS keychain/GUI/TCC/browser WebContents 逻辑塞进 Go。
- 远端不要保存 Linear/Jira/GitHub 等敏感 token，优先走本地 credential broker。

### Rust

适合：

- Tauri core
- secure storage/keychain bridge
- SQLite persistence/migrations
- typed runtime RPC schema
- PTY provider trait 和本地实现
- file watcher
- E2EE/session/auth 边界
- computer-use Windows/Linux native provider
- emulator process/frame registry

注意：

- 若 Rust 和 Go 并存，要先定义进程边界和协议，不要在同一职责上重复实现。

### Zig

适合：

- forkpty/ConPTY 小型 shim
- process spawn/guard
- shell-ready wrapper
- 高性能 binary frame codec
- 小型 C ABI native helper

不适合：

- 完整 runtime
- SSH/GUI/browser orchestration
- provider API 业务层

### Tauri

适合：

- 桌面壳
- 窗口/托盘/菜单/快捷键
- updater/packaging
- Rust command/event bridge
- React renderer 宿主

风险：

- Electron `<webview>`/WebContents/CDP
- preload/contextBridge 合约迁移
- app userData/path 语义
- BrowserWindow/offscreen browser
- platform packaging parity

### React Native

适合：

- 保留现有 mobile companion UX
- terminal/source-control/file/browser remote control UI
- 通过 generated client 使用 runtime RPC

注意：

- 不要把 RN WebView 当 desktop browser automation 替代品。
- 保留 connection recovery 和 stream replay 语义。

## 16. 推荐迁移路线

### 阶段 0：冻结协议和行为

- 抽取 Runtime RPC schema。
- 抽取 terminal stream frame、browser screencast frame、pairing/E2EE、protocol version。
- 给 TS/Rust/Go/RN 生成 client/server 类型。
- 建立兼容测试：desktop CLI、web client、mobile、SSH relay。

### 阶段 1：拆服务边界

- 在 TS 内先把 `PebbleRuntimeService` 拆成领域 facade。
- 明确 `RepoService`、`WorktreeService`、`TerminalSessionService`、`OrchestrationService` 等接口。
- Electron main 保持 adapter，避免业务继续堆到 `index.ts` 和 `pebble-runtime.ts`。

### 阶段 2：重写 relay

- 用 Go 或 Rust 实现 wire-compatible relay。
- 保持 framed JSON-RPC、seq/ack、keepalive、grace、reconnect。
- 先让 Electron main 仍可连接新 relay。
- 再替换远端 PTY/FS/Git provider。

### 阶段 3：Worktree/Git/Orchestration 服务化

- Worktree create/remove 事务化。
- Orchestration 迁到 Go + SQLite append/event model。
- Provider capability model 落地。
- 外部服务 token 通过 credential broker 获取。

### 阶段 4：PTY/native 替换

- 本地 PTY provider trait 固化。
- Rust/Zig 替代 `node-pty` 的低层能力。
- 保留 xterm 前端。
- 验证 Windows ConPTY、macOS/Linux forkpty、WSL、SSH、cold restore、history replay。

### 阶段 5：Tauri 壳

- React renderer 原样跑在 Tauri。
- 实现 `window.api` 兼容 bridge。
- 先迁移 settings/tasks/skills/mobile pairing 等非 terminal/browser 高风险页面。
- 再迁移 terminal/emulator。
- browser 单独保留 Electron/CEF/agent-browser 后端，最后评估。

### 阶段 6：Persistence 与发布体系

- JSON store -> SQLite/migrations。
- 保留导入、备份、回滚。
- Tauri packaging 对齐 Windows/macOS/Linux。
- 重建 update manifest、Homebrew、draft release、required assets 校验。

## 17. 关键风险清单

1. Browser 等价性：Electron WebContents/CDP 是最大风险，不能低估。
2. SSH relay 行为：grace/reconnect/PTY 保活/remote path 语义必须完全复刻。
3. Worktree side effects：Git、metadata、terminal、hooks、provider links 必须事务化。
4. Agent hooks：各家 CLI 配置差异大，应保留插件式 adapter。
5. Credentials：不要把 Electron safeStorage 的 token 简单迁到 Go daemon 明文存储。
6. Mobile compatibility：protocol version、E2EE、stream replay、auth retry 是行为契约。
7. Packaging：发布系统是产品能力，不只是 CI 脚本。
8. Cross-platform：Windows long path/ConPTY/PowerShell、Linux `pebble`、macOS TCC/notarization 都要一等处理。

## 18. 下一步建议

建议后续把重写拆成 5 个设计文档：

1. `runtime-rpc-idl.md`：协议、schema、版本兼容、codegen。
2. `relay-v2.md`：Go/Rust relay wire compatibility、PTY/FS/Git provider。
3. `worktree-service.md`：事务式 worktree create/remove、provider refs、lineage。
4. `tauri-shell.md`：Tauri bridge、React 保留策略、Electron browser 风险处理。
5. `native-capabilities.md`：PTY、computer-use、emulator、browser sidecar 的语言分工。

最务实的第一刀是：协议冻结 + relay v2。它收益最大，风险可控，也不会被 Tauri browser 等高风险点拖住。
