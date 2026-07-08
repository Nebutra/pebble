import {
  AgentProjection,
  AutomationProjection,
  BrowserDownloadProjection,
  BrowserProjection,
  ComputerActionProjection,
  DispatchProjection,
  EmulatorDeviceProjection,
  EmulatorSessionProjection,
  ExternalTaskProjection,
  FileProjection,
  KeybindingProjection,
  MessageProjection,
  MobileRelayServerMessage,
  ProviderProjection,
  ReleaseProjection,
  RuntimeEvent,
  RuntimeFileContent,
  SettingProjection,
  SourceControlProjection,
  TaskProjection,
  TerminalOutputLine,
  TerminalProjection,
} from '@/relay/relay-protocol'

type FileContentServerMessage = Extract<MobileRelayServerMessage, { type: 'file.content' }>

export interface RuntimeProjectionState {
  terminals: TerminalProjection[]
  agents: AgentProjection[]
  sourceControl: SourceControlProjection[]
  browser: BrowserProjection[]
  browserDownloads: BrowserDownloadProjection[]
  files: FileProjection[]
  tasks: TaskProjection[]
  messages: MessageProjection[]
  dispatches: DispatchProjection[]
  automations: AutomationProjection[]
  externalTasks: ExternalTaskProjection[]
  releases: ReleaseProjection[]
  providers: ProviderProjection[]
  computerActions: ComputerActionProjection[]
  emulatorDevices: EmulatorDeviceProjection[]
  emulatorSessions: EmulatorSessionProjection[]
  settings: SettingProjection[]
  keybindings: KeybindingProjection[]
  fileContents: Record<string, RuntimeFileContent>
  activeFileContent?: RuntimeFileContent
  lastSnapshotAt?: string
  lastEventAt?: string
  lastFileRequestId?: string
  lastError?: string
}

export function createEmptyProjectionState(): RuntimeProjectionState {
  return {
    terminals: [],
    agents: [],
    sourceControl: [],
    browser: [],
    browserDownloads: [],
    files: [],
    tasks: [],
    messages: [],
    dispatches: [],
    automations: [],
    externalTasks: [],
    releases: [],
    providers: [],
    computerActions: [],
    emulatorDevices: [],
    emulatorSessions: [],
    settings: [],
    keybindings: [],
    fileContents: {},
  }
}

export function applyRelayServerMessage(
  state: RuntimeProjectionState,
  message: MobileRelayServerMessage,
): RuntimeProjectionState {
  switch (message.type) {
    case 'projection.snapshot':
      return {
        terminals: message.payload.terminals,
        agents: message.payload.agents,
        sourceControl: message.payload.sourceControl,
        browser: message.payload.browser,
        browserDownloads: message.payload.browserDownloads,
        files: message.payload.files,
        tasks: message.payload.tasks,
        messages: message.payload.messages,
        dispatches: message.payload.dispatches,
        automations: message.payload.automations,
        externalTasks: message.payload.externalTasks,
        releases: message.payload.releases,
        providers: message.payload.providers,
        computerActions: message.payload.computerActions,
        emulatorDevices: message.payload.emulatorDevices,
        emulatorSessions: message.payload.emulatorSessions,
        settings: message.payload.settings,
        keybindings: message.payload.keybindings,
        fileContents: state.fileContents,
        activeFileContent: state.activeFileContent,
        lastSnapshotAt: message.payload.receivedAt,
        lastEventAt: state.lastEventAt,
      }
    case 'file.content':
      return applyFileContentMessage(state, message.payload)
    case 'runtime.event':
      return applyRuntimeEvent(state, message.payload)
    case 'error':
      return {
        ...state,
        lastError: message.payload.message,
      }
    default:
      return state
  }
}

export function runtimeFileContentKey(
  projectId: string,
  worktreeId: string | undefined,
  path: string,
): string {
  return `${projectId}:${worktreeId ?? ''}:${path}`
}

function applyRuntimeEvent(
  state: RuntimeProjectionState,
  event: RuntimeEvent,
): RuntimeProjectionState {
  switch (event.topic) {
    case 'session.output':
      return applySessionOutputEvent(state, event)
    case 'session.status':
      return applySessionStatusEvent(state, event)
    case 'agent.changed':
      return applyAgentEvent(state, event)
    case 'source-control.changed':
      return applySourceControlEvent(state, event)
    case 'browser.changed':
      return applyBrowserEvent(state, event)
    case 'file.changed':
      return applyFileEvent(state, event)
    case 'orchestration.changed':
      return applyOrchestrationEvent(state, event)
    case 'automation.changed':
      return applyAutomationEvent(state, event)
    case 'external-task.changed':
      return applyExternalTaskEvent(state, event)
    case 'release.changed':
      return applyReleaseEvent(state, event)
    case 'provider.changed':
      return applyProviderEvent(state, event)
    case 'computer.changed':
      return applyComputerEvent(state, event)
    case 'emulator.changed':
      return applyEmulatorEvent(state, event)
    case 'settings.changed':
      return applySettingsEvent(state, event)
    default:
      return {
        ...state,
        lastEventAt: event.timestamp,
      }
  }
}

function applyFileContentMessage(
  state: RuntimeProjectionState,
  payload: FileContentServerMessage['payload'],
): RuntimeProjectionState {
  if (!isRuntimeFileContent(payload.content)) {
    return state
  }

  const content = payload.content
  const key = runtimeFileContentKey(content.projectId, content.worktreeId, content.path)

  return {
    ...state,
    fileContents: {
      ...state.fileContents,
      [key]: content,
    },
    activeFileContent: content,
    lastFileRequestId: payload.requestId,
    lastError: undefined,
  }
}

function applySessionOutputEvent(
  state: RuntimeProjectionState,
  event: RuntimeEvent,
): RuntimeProjectionState {
  const payload = event.payload
  const sessionId = readString(payload.sessionId)
  const text = readString(payload.text)

  if (sessionId === null || text === null) {
    return {
      ...state,
      lastEventAt: event.timestamp,
    }
  }

  const outputLine: TerminalOutputLine = {
    id: readString(payload.lineId) ?? event.id,
    stream:
      payload.stream === 'stderr' || payload.stream === 'system' ? payload.stream : 'stdout',
    text,
    timestamp: event.timestamp,
  }

  const existingTerminal = state.terminals.find((terminal) => terminal.sessionId === sessionId)
  const nextTerminal =
    existingTerminal ??
    createTerminalProjectionFromEvent(sessionId, payload, event.timestamp)

  return {
    ...state,
    terminals: upsertTerminalProjection(state.terminals, {
      ...nextTerminal,
      output: [...nextTerminal.output, outputLine].slice(-200),
      updatedAt: event.timestamp,
    }),
    lastEventAt: event.timestamp,
  }
}

function applySessionStatusEvent(
  state: RuntimeProjectionState,
  event: RuntimeEvent,
): RuntimeProjectionState {
  const payload = event.payload
  const sessionId = readString(payload.sessionId)

  if (sessionId === null) {
    return {
      ...state,
      lastEventAt: event.timestamp,
    }
  }

  const existingTerminal = state.terminals.find((terminal) => terminal.sessionId === sessionId)
  const nextTerminal =
    existingTerminal ??
    createTerminalProjectionFromEvent(sessionId, payload, event.timestamp)

  return {
    ...state,
    terminals: upsertTerminalProjection(state.terminals, {
      ...nextTerminal,
      status: readTerminalStatus(payload.status) ?? nextTerminal.status,
      inputEnabled: readBoolean(payload.inputEnabled) ?? nextTerminal.inputEnabled,
      lastExitCode: readNumber(payload.lastExitCode) ?? nextTerminal.lastExitCode,
      updatedAt: event.timestamp,
    }),
    lastEventAt: event.timestamp,
  }
}

function applyAgentEvent(
  state: RuntimeProjectionState,
  event: RuntimeEvent,
): RuntimeProjectionState {
  const projections = readProjectionList(event.payload, 'agents', isAgentProjection)

  if (projections.length === 0) {
    return {
      ...state,
      lastEventAt: event.timestamp,
    }
  }

  return {
    ...state,
    agents: projections,
    lastEventAt: event.timestamp,
  }
}

function applySourceControlEvent(
  state: RuntimeProjectionState,
  event: RuntimeEvent,
): RuntimeProjectionState {
  const projections = readProjectionList(event.payload, 'sourceControl', isSourceControlProjection)

  if (projections.length === 0) {
    return {
      ...state,
      lastEventAt: event.timestamp,
    }
  }

  return {
    ...state,
    sourceControl: projections,
    lastEventAt: event.timestamp,
  }
}

function applyBrowserEvent(
  state: RuntimeProjectionState,
  event: RuntimeEvent,
): RuntimeProjectionState {
  const projections = readProjectionList(event.payload, 'browser', isBrowserProjection)
  const downloads = readProjectionList(
    event.payload,
    'browserDownloads',
    isBrowserDownloadProjection,
  )

  if (projections.length === 0 && downloads.length === 0) {
    return {
      ...state,
      lastEventAt: event.timestamp,
    }
  }

  return {
    ...state,
    browser: projections,
    browserDownloads: downloads,
    lastEventAt: event.timestamp,
  }
}

function applyFileEvent(
  state: RuntimeProjectionState,
  event: RuntimeEvent,
): RuntimeProjectionState {
  const projections = readProjectionList(event.payload, 'files', isFileProjection)

  if (projections.length === 0) {
    return {
      ...state,
      lastEventAt: event.timestamp,
    }
  }

  return {
    ...state,
    files: projections,
    lastEventAt: event.timestamp,
  }
}

function applyAutomationEvent(
  state: RuntimeProjectionState,
  event: RuntimeEvent,
): RuntimeProjectionState {
  const projections = readProjectionList(event.payload, 'automations', isAutomationProjection)

  if (projections.length === 0) {
    return {
      ...state,
      lastEventAt: event.timestamp,
    }
  }

  return {
    ...state,
    automations: projections,
    lastEventAt: event.timestamp,
  }
}

function applyOrchestrationEvent(
  state: RuntimeProjectionState,
  event: RuntimeEvent,
): RuntimeProjectionState {
  const tasks = readProjectionList(event.payload, 'tasks', isTaskProjection)
  const messages = readProjectionList(event.payload, 'messages', isMessageProjection)
  const dispatches = readProjectionList(event.payload, 'dispatches', isDispatchProjection)

  if (tasks.length === 0 && messages.length === 0 && dispatches.length === 0) {
    return {
      ...state,
      lastEventAt: event.timestamp,
    }
  }

  return {
    ...state,
    tasks,
    messages,
    dispatches,
    lastEventAt: event.timestamp,
  }
}

function applyExternalTaskEvent(
  state: RuntimeProjectionState,
  event: RuntimeEvent,
): RuntimeProjectionState {
  const projections = readProjectionList(event.payload, 'externalTasks', isExternalTaskProjection)

  if (projections.length === 0) {
    return {
      ...state,
      lastEventAt: event.timestamp,
    }
  }

  return {
    ...state,
    externalTasks: projections,
    lastEventAt: event.timestamp,
  }
}

function applyReleaseEvent(
  state: RuntimeProjectionState,
  event: RuntimeEvent,
): RuntimeProjectionState {
  const projections = readProjectionList(event.payload, 'releases', isReleaseProjection)

  if (projections.length === 0) {
    return {
      ...state,
      lastEventAt: event.timestamp,
    }
  }

  return {
    ...state,
    releases: projections,
    lastEventAt: event.timestamp,
  }
}

function applyProviderEvent(
  state: RuntimeProjectionState,
  event: RuntimeEvent,
): RuntimeProjectionState {
  const projections = readProjectionList(event.payload, 'providers', isProviderProjection)

  if (projections.length === 0) {
    return {
      ...state,
      lastEventAt: event.timestamp,
    }
  }

  return {
    ...state,
    providers: projections,
    lastEventAt: event.timestamp,
  }
}

function applyComputerEvent(
  state: RuntimeProjectionState,
  event: RuntimeEvent,
): RuntimeProjectionState {
  const projections = readProjectionList(
    event.payload,
    'computerActions',
    isComputerActionProjection,
  )

  if (projections.length === 0) {
    return {
      ...state,
      lastEventAt: event.timestamp,
    }
  }

  return {
    ...state,
    computerActions: projections,
    lastEventAt: event.timestamp,
  }
}

function applyEmulatorEvent(
  state: RuntimeProjectionState,
  event: RuntimeEvent,
): RuntimeProjectionState {
  const devices = readProjectionList(event.payload, 'emulatorDevices', isEmulatorDeviceProjection)
  const sessions = readProjectionList(event.payload, 'emulatorSessions', isEmulatorSessionProjection)

  if (devices.length === 0 && sessions.length === 0) {
    return {
      ...state,
      lastEventAt: event.timestamp,
    }
  }

  return {
    ...state,
    emulatorDevices: devices,
    emulatorSessions: sessions,
    lastEventAt: event.timestamp,
  }
}

function applySettingsEvent(
  state: RuntimeProjectionState,
  event: RuntimeEvent,
): RuntimeProjectionState {
  const settings = readProjectionList(event.payload, 'settings', isSettingProjection)
  const keybindings = readProjectionList(event.payload, 'keybindings', isKeybindingProjection)

  if (settings.length === 0 && keybindings.length === 0) {
    return {
      ...state,
      lastEventAt: event.timestamp,
    }
  }

  return {
    ...state,
    settings,
    keybindings,
    lastEventAt: event.timestamp,
  }
}

function createTerminalProjectionFromEvent(
  sessionId: string,
  payload: Record<string, unknown>,
  timestamp: string,
): TerminalProjection {
  return {
    kind: 'terminal',
    sessionId,
    workspaceId: readString(payload.workspaceId) ?? 'unknown',
    title: readString(payload.title) ?? sessionId,
    cwd: readString(payload.cwd) ?? undefined,
    status: readTerminalStatus(payload.status) ?? 'running',
    isRemote: readBoolean(payload.isRemote) ?? false,
    inputEnabled: readBoolean(payload.inputEnabled) ?? true,
    output: [],
    updatedAt: timestamp,
  }
}

function upsertTerminalProjection(
  terminals: TerminalProjection[],
  nextTerminal: TerminalProjection,
): TerminalProjection[] {
  const existingIndex = terminals.findIndex(
    (terminal) => terminal.sessionId === nextTerminal.sessionId,
  )

  if (existingIndex === -1) {
    return [...terminals, nextTerminal]
  }

  return terminals.map((terminal, index) => (index === existingIndex ? nextTerminal : terminal))
}

function readProjectionList<TProjection>(
  payload: Record<string, unknown>,
  key: string,
  guard: (value: unknown) => value is TProjection,
): TProjection[] {
  const value = payload[key] ?? payload.projection

  if (Array.isArray(value)) {
    return value.filter(guard)
  }

  return guard(value) ? [value] : []
}

function isAgentProjection(value: unknown): value is AgentProjection {
  if (!isRecord(value)) {
    return false
  }

  return (
    value.kind === 'agent' &&
    typeof value.runId === 'string' &&
    typeof value.profileId === 'string' &&
    typeof value.workspaceId === 'string' &&
    typeof value.name === 'string' &&
    typeof value.agentKind === 'string' &&
    typeof value.updatedAt === 'string'
  )
}

function isSourceControlProjection(value: unknown): value is SourceControlProjection {
  if (!isRecord(value)) {
    return false
  }

  return (
    value.kind === 'source-control' &&
    typeof value.repositoryId === 'string' &&
    typeof value.workspaceId === 'string' &&
    typeof value.branch === 'string' &&
    typeof value.updatedAt === 'string' &&
    Array.isArray(value.changes)
  )
}

function isBrowserProjection(value: unknown): value is BrowserProjection {
  if (!isRecord(value)) {
    return false
  }

  return (
    value.kind === 'browser' &&
    typeof value.tabId === 'string' &&
    typeof value.workspaceId === 'string' &&
    typeof value.title === 'string' &&
    typeof value.url === 'string' &&
    typeof value.updatedAt === 'string'
  )
}

function isBrowserDownloadProjection(value: unknown): value is BrowserDownloadProjection {
  if (!isRecord(value)) {
    return false
  }

  return (
    value.kind === 'browser-download' &&
    typeof value.downloadId === 'string' &&
    typeof value.url === 'string' &&
    typeof value.status === 'string' &&
    typeof value.updatedAt === 'string'
  )
}

function isFileProjection(value: unknown): value is FileProjection {
  if (!isRecord(value)) {
    return false
  }

  return (
    value.kind === 'file' &&
    typeof value.projectId === 'string' &&
    typeof value.workspaceId === 'string' &&
    typeof value.path === 'string' &&
    typeof value.name === 'string' &&
    typeof value.entryKind === 'string' &&
    typeof value.isRemote === 'boolean' &&
    typeof value.updatedAt === 'string'
  )
}

function isAutomationProjection(value: unknown): value is AutomationProjection {
  if (!isRecord(value)) {
    return false
  }

  return (
    value.kind === 'automation' &&
    typeof value.automationId === 'string' &&
    typeof value.name === 'string' &&
    typeof value.enabled === 'boolean' &&
    typeof value.scheduleKind === 'string' &&
    typeof value.actionKind === 'string' &&
    typeof value.updatedAt === 'string'
  )
}

function isTaskProjection(value: unknown): value is TaskProjection {
  if (!isRecord(value)) {
    return false
  }

  return (
    value.kind === 'task' &&
    typeof value.taskId === 'string' &&
    typeof value.title === 'string' &&
    typeof value.status === 'string' &&
    typeof value.updatedAt === 'string'
  )
}

function isMessageProjection(value: unknown): value is MessageProjection {
  if (!isRecord(value)) {
    return false
  }

  return (
    value.kind === 'message' &&
    typeof value.messageId === 'string' &&
    typeof value.threadId === 'string' &&
    typeof value.from === 'string' &&
    typeof value.to === 'string' &&
    typeof value.subject === 'string' &&
    typeof value.type === 'string' &&
    typeof value.read === 'boolean' &&
    typeof value.createdAt === 'string'
  )
}

function isDispatchProjection(value: unknown): value is DispatchProjection {
  if (!isRecord(value)) {
    return false
  }

  return (
    value.kind === 'dispatch' &&
    typeof value.dispatchId === 'string' &&
    typeof value.taskId === 'string' &&
    typeof value.assignee === 'string' &&
    typeof value.status === 'string' &&
    typeof value.updatedAt === 'string'
  )
}

function isExternalTaskProjection(value: unknown): value is ExternalTaskProjection {
  if (!isRecord(value)) {
    return false
  }

  return (
    value.kind === 'external-task' &&
    typeof value.itemId === 'string' &&
    typeof value.provider === 'string' &&
    typeof value.itemKind === 'string' &&
    typeof value.externalId === 'string' &&
    typeof value.title === 'string' &&
    typeof value.status === 'string' &&
    typeof value.updatedAt === 'string'
  )
}

function isReleaseProjection(value: unknown): value is ReleaseProjection {
  if (!isRecord(value)) {
    return false
  }

  return (
    value.kind === 'release' &&
    typeof value.releaseId === 'string' &&
    typeof value.version === 'string' &&
    typeof value.channel === 'string' &&
    typeof value.status === 'string' &&
    typeof value.requiredCount === 'number' &&
    typeof value.artifactCount === 'number' &&
    typeof value.checkCount === 'number' &&
    typeof value.passedCheckCount === 'number' &&
    typeof value.failedCheckCount === 'number' &&
    typeof value.ready === 'boolean' &&
    typeof value.updatedAt === 'string'
  )
}

function isProviderProjection(value: unknown): value is ProviderProjection {
  if (!isRecord(value)) {
    return false
  }

  return (
    value.kind === 'provider' &&
    typeof value.providerId === 'string' &&
    typeof value.subsystem === 'string' &&
    typeof value.name === 'string' &&
    typeof value.status === 'string' &&
    Array.isArray(value.capabilities) &&
    typeof value.lastSeenAt === 'string'
  )
}

function isComputerActionProjection(value: unknown): value is ComputerActionProjection {
  if (!isRecord(value)) {
    return false
  }

  return (
    value.kind === 'computer-action' &&
    typeof value.actionId === 'string' &&
    typeof value.actionKind === 'string' &&
    typeof value.status === 'string' &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string'
  )
}

function isEmulatorDeviceProjection(value: unknown): value is EmulatorDeviceProjection {
  if (!isRecord(value)) {
    return false
  }

  return (
    value.kind === 'emulator-device' &&
    typeof value.deviceId === 'string' &&
    typeof value.name === 'string' &&
    typeof value.platform === 'string' &&
    typeof value.status === 'string' &&
    typeof value.updatedAt === 'string'
  )
}

function isEmulatorSessionProjection(value: unknown): value is EmulatorSessionProjection {
  if (!isRecord(value)) {
    return false
  }

  return (
    value.kind === 'emulator-session' &&
    typeof value.sessionId === 'string' &&
    typeof value.deviceId === 'string' &&
    typeof value.workspaceId === 'string' &&
    typeof value.active === 'boolean' &&
    typeof value.updatedAt === 'string'
  )
}

function isSettingProjection(value: unknown): value is SettingProjection {
  if (!isRecord(value)) {
    return false
  }

  return (
    value.kind === 'setting' &&
    typeof value.settingId === 'string' &&
    typeof value.scope === 'string' &&
    typeof value.key === 'string' &&
    typeof value.updatedAt === 'string'
  )
}

function isKeybindingProjection(value: unknown): value is KeybindingProjection {
  if (!isRecord(value)) {
    return false
  }

  return (
    value.kind === 'keybinding' &&
    typeof value.keybindingId === 'string' &&
    typeof value.command === 'string' &&
    typeof value.accelerator === 'string' &&
    typeof value.enabled === 'boolean' &&
    typeof value.updatedAt === 'string'
  )
}

function isRuntimeFileContent(value: unknown): value is RuntimeFileContent {
  if (!isRecord(value)) {
    return false
  }

  return (
    typeof value.projectId === 'string' &&
    typeof value.path === 'string' &&
    typeof value.encoding === 'string' &&
    typeof value.content === 'string' &&
    typeof value.size === 'number' &&
    typeof value.modifiedAt === 'string'
  )
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' ? value : null
}

function readTerminalStatus(value: unknown): TerminalProjection['status'] | null {
  if (value === 'idle' || value === 'running' || value === 'exited' || value === 'detached') {
    return value
  }

  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
