export const RUNTIME_API_VERSION = 'pebble.runtime.v1'
export const RUNTIME_EVENT_VERSION = 'pebble.events.v1'
export const MOBILE_RELAY_PROTOCOL_VERSION = 'pebble.mobile-relay.v1'
export const MOBILE_RELAY_PATH = '/v1/mobile-relay'

export type RuntimeApiVersion = typeof RUNTIME_API_VERSION
export type RuntimeEventVersion = typeof RUNTIME_EVENT_VERSION
export type MobileRelayProtocolVersion = typeof MOBILE_RELAY_PROTOCOL_VERSION

export type RuntimeMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'STREAM'

export type RuntimeResourceKey =
  | 'status'
  | 'events'
  | 'projects'
  | 'worktrees'
  | 'sessions'
  | 'agents'
  | 'orchestration'
  | 'automations'
  | 'externalTasks'
  | 'sourceControl'
  | 'files'
  | 'releases'
  | 'settings'
  | 'browser'
  | 'computer'
  | 'emulator'
  | 'providers'
  | 'mobileRelay'

export interface RuntimeResourceDescriptor {
  path: string
  methods: RuntimeMethod[]
  routes?: Record<string, RuntimeResourceDescriptor>
}

export interface RuntimeApiContract {
  version: RuntimeApiVersion
  resources: Record<RuntimeResourceKey, RuntimeResourceDescriptor>
}

export const runtimeApiV1: RuntimeApiContract = {
  version: RUNTIME_API_VERSION,
  resources: {
    status: {
      path: '/v1/status',
      methods: ['GET'],
    },
    events: {
      path: '/v1/events',
      methods: ['STREAM'],
    },
    projects: {
      path: '/v1/projects',
      methods: ['GET', 'POST', 'PATCH', 'DELETE'],
      routes: {
        projects: {
          path: '/v1/projects',
          methods: ['GET', 'POST'],
        },
        project: {
          path: '/v1/projects/{id}',
          methods: ['PATCH', 'DELETE'],
        },
      },
    },
    worktrees: {
      path: '/v1/worktrees',
      methods: ['GET', 'POST', 'DELETE'],
      routes: {
        worktrees: {
          path: '/v1/worktrees',
          methods: ['GET', 'POST'],
        },
        worktree: {
          path: '/v1/worktrees/{id}',
          methods: ['DELETE'],
        },
      },
    },
    sessions: {
      path: '/v1/sessions',
      methods: ['GET', 'POST', 'PATCH', 'DELETE', 'STREAM'],
    },
    agents: {
      path: '/v1/agents',
      methods: ['GET', 'POST', 'PATCH', 'DELETE', 'STREAM'],
      routes: {
        profiles: {
          path: '/v1/agents/profiles',
          methods: ['GET', 'POST'],
        },
        profile: {
          path: '/v1/agents/profiles/{id}',
          methods: ['PATCH', 'DELETE'],
        },
        runs: {
          path: '/v1/agents/runs',
          methods: ['GET', 'POST'],
        },
        run: {
          path: '/v1/agents/runs/{id}',
          methods: ['DELETE'],
        },
      },
    },
    orchestration: {
      path: '/v1/orchestration',
      methods: ['GET', 'POST', 'PATCH', 'DELETE', 'STREAM'],
      routes: {
        tasks: {
          path: '/v1/orchestration/tasks',
          methods: ['GET', 'POST'],
        },
        task: {
          path: '/v1/orchestration/tasks/{id}',
          methods: ['PATCH'],
        },
        messages: {
          path: '/v1/orchestration/messages',
          methods: ['GET', 'POST'],
        },
        messageReply: {
          path: '/v1/orchestration/messages/{id}/reply',
          methods: ['POST'],
        },
        dispatches: {
          path: '/v1/orchestration/dispatches',
          methods: ['GET', 'POST'],
        },
        dispatch: {
          path: '/v1/orchestration/dispatches/{id}',
          methods: ['PATCH'],
        },
      },
    },
    automations: {
      path: '/v1/automations',
      methods: ['GET', 'POST', 'PATCH', 'DELETE', 'STREAM'],
      routes: {
        automations: {
          path: '/v1/automations',
          methods: ['GET', 'POST'],
        },
        automation: {
          path: '/v1/automations/{id}',
          methods: ['PATCH', 'DELETE'],
        },
        runs: {
          path: '/v1/automations/runs',
          methods: ['GET'],
        },
        automationRuns: {
          path: '/v1/automations/{id}/runs',
          methods: ['GET', 'POST'],
        },
        evaluate: {
          path: '/v1/automations/evaluate',
          methods: ['POST'],
        },
      },
    },
    externalTasks: {
      path: '/v1/external-tasks',
      methods: ['GET', 'POST', 'PATCH', 'DELETE', 'STREAM'],
      routes: {
        items: {
          path: '/v1/external-tasks',
          methods: ['GET', 'POST'],
        },
        item: {
          path: '/v1/external-tasks/{id}',
          methods: ['PATCH', 'DELETE'],
        },
      },
    },
    sourceControl: {
      path: '/v1/source-control',
      methods: ['GET', 'POST', 'PATCH', 'STREAM'],
      routes: {
        projections: {
          path: '/v1/source-control',
          methods: ['GET'],
        },
        projectionUpdates: {
          path: '/v1/source-control/projections',
          methods: ['POST'],
        },
        status: {
          path: '/v1/source-control/status',
          methods: ['GET'],
        },
        diff: {
          path: '/v1/source-control/diff',
          methods: ['GET'],
        },
      },
    },
    files: {
      path: '/v1/files',
      methods: ['GET', 'POST', 'STREAM'],
      routes: {
        tree: {
          path: '/v1/files/tree',
          methods: ['GET'],
        },
        read: {
          path: '/v1/files/read',
          methods: ['GET'],
        },
        write: {
          path: '/v1/files/write',
          methods: ['POST'],
        },
        treeSnapshots: {
          path: '/v1/files/tree-snapshots',
          methods: ['POST'],
        },
        contentSnapshots: {
          path: '/v1/files/content-snapshots',
          methods: ['POST'],
        },
      },
    },
    releases: {
      path: '/v1/releases',
      methods: ['GET', 'POST', 'PATCH'],
      routes: {
        plans: {
          path: '/v1/releases',
          methods: ['GET', 'POST'],
        },
        plan: {
          path: '/v1/releases/{id}',
          methods: ['PATCH'],
        },
        artifacts: {
          path: '/v1/releases/{id}/artifacts',
          methods: ['POST'],
        },
        checks: {
          path: '/v1/releases/{id}/checks',
          methods: ['POST'],
        },
        manifest: {
          path: '/v1/releases/{id}/manifest',
          methods: ['GET'],
        },
        publish: {
          path: '/v1/releases/{id}/publish',
          methods: ['POST'],
        },
      },
    },
    settings: {
      path: '/v1/settings',
      methods: ['GET', 'POST'],
      routes: {
        settings: {
          path: '/v1/settings',
          methods: ['GET', 'POST'],
        },
        keybindings: {
          path: '/v1/settings/keybindings',
          methods: ['GET', 'POST'],
        },
      },
    },
    browser: {
      path: '/v1/browser',
      methods: ['GET', 'POST', 'PATCH', 'DELETE', 'STREAM'],
      routes: {
        tabs: {
          path: '/v1/browser/tabs',
          methods: ['GET', 'POST'],
        },
        tab: {
          path: '/v1/browser/tabs/{id}',
          methods: ['PATCH', 'DELETE'],
        },
        tabCommands: {
          path: '/v1/browser/tabs/{id}/commands',
          methods: ['POST'],
        },
        profiles: {
          path: '/v1/browser/profiles',
          methods: ['GET', 'POST'],
        },
        permissions: {
          path: '/v1/browser/permissions',
          methods: ['GET', 'POST'],
        },
        downloads: {
          path: '/v1/browser/downloads',
          methods: ['GET', 'POST'],
        },
        download: {
          path: '/v1/browser/downloads/{id}',
          methods: ['PATCH'],
        },
        downloadCommands: {
          path: '/v1/browser/downloads/{id}/commands/start',
          methods: ['POST'],
        },
      },
    },
    computer: {
      path: '/v1/computer',
      methods: ['GET', 'POST', 'PATCH', 'STREAM'],
      routes: {
        actions: {
          path: '/v1/computer/actions',
          methods: ['GET', 'POST'],
        },
        claimActions: {
          path: '/v1/computer/actions/claim',
          methods: ['POST'],
        },
        action: {
          path: '/v1/computer/actions/{id}',
          methods: ['PATCH'],
        },
      },
    },
    emulator: {
      path: '/v1/emulator',
      methods: ['GET', 'POST', 'PATCH', 'DELETE', 'STREAM'],
      routes: {
        devices: {
          path: '/v1/emulator/devices',
          methods: ['GET', 'POST'],
        },
        device: {
          path: '/v1/emulator/devices/{id}',
          methods: ['PATCH'],
        },
        sessions: {
          path: '/v1/emulator/sessions',
          methods: ['GET', 'POST'],
        },
        session: {
          path: '/v1/emulator/sessions/{id}',
          methods: ['DELETE'],
        },
        sessionCommands: {
          path: '/v1/emulator/sessions/{id}/commands',
          methods: ['POST'],
        },
      },
    },
    providers: {
      path: '/v1/providers',
      methods: ['GET', 'POST'],
    },
    mobileRelay: {
      path: MOBILE_RELAY_PATH,
      methods: ['GET', 'POST', 'DELETE', 'STREAM'],
      routes: {
        status: {
          path: `${MOBILE_RELAY_PATH}/status`,
          methods: ['GET'],
        },
        pairingCodes: {
          path: `${MOBILE_RELAY_PATH}/pairing-codes`,
          methods: ['POST'],
        },
        pairings: {
          path: `${MOBILE_RELAY_PATH}/pairings`,
          methods: ['GET'],
        },
        projection: {
          path: `${MOBILE_RELAY_PATH}/projection`,
          methods: ['GET'],
        },
        websocket: {
          path: MOBILE_RELAY_PATH,
          methods: ['STREAM'],
        },
      },
    },
  },
}

export type RuntimeEventTopic =
  | 'project.changed'
  | 'worktree.changed'
  | 'session.output'
  | 'session.status'
  | 'agent.changed'
  | 'orchestration.changed'
  | 'automation.changed'
  | 'external-task.changed'
  | 'source-control.changed'
  | 'file.changed'
  | 'release.changed'
  | 'settings.changed'
  | 'provider.changed'
  | 'browser.changed'
  | 'computer.changed'
  | 'emulator.changed'
  | 'mobile-relay.changed'

export interface RuntimeEvent<TPayload extends Record<string, unknown> = Record<string, unknown>> {
  version: RuntimeEventVersion
  id: string
  timestamp: string
  topic: RuntimeEventTopic
  payload: TPayload
}

export type ProjectionKind =
  | 'terminal'
  | 'source-control'
  | 'browser'
  | 'agents'
  | 'files'
  | 'orchestration'
  | 'automations'
  | 'external-tasks'
  | 'releases'
  | 'providers'
  | 'computer'
  | 'emulator'
  | 'settings'

export type DevicePlatform = 'ios' | 'android' | 'web' | 'unknown'

export interface DeviceIdentity {
  deviceId: string
  deviceName: string
  platform: DevicePlatform
}

export interface PairingRecord {
  deviceId: string
  deviceName: string
  endpoint: string
  relayId?: string
  workspaceName?: string
  pairingSecretRef?: string
  createdAt: string
  lastConnectedAt?: string
}

export interface PairingRequest {
  endpoint: string
  pairingCode: string
}

export interface RelayCryptoEnvelope {
  keyId: string
  nonce: string
  ciphertext: string
  associatedData?: string
}

export interface RelayCryptoHandshake {
  device: DeviceIdentity
  clientPublicKey: string
  pairingSecretRef: string
  subscriptions?: ProjectionKind[]
}

export interface RelayCryptoReady {
  algorithm: 'X25519-HKDF-SHA256-AES-256-GCM'
  keyId: string
  serverPublicKey: string
  associatedData: string
}

export type TerminalStatus = 'idle' | 'running' | 'exited' | 'detached'

export interface TerminalOutputLine {
  id: string
  stream: 'stdout' | 'stderr' | 'system'
  text: string
  timestamp: string
}

export interface TerminalProjection {
  kind: 'terminal'
  sessionId: string
  workspaceId: string
  title: string
  cwd?: string
  status: TerminalStatus
  isRemote: boolean
  inputEnabled: boolean
  output: TerminalOutputLine[]
  lastExitCode?: number
  updatedAt: string
}

export type AgentProjectionStatus = 'starting' | 'running' | 'exited' | 'failed' | 'stopped'

export interface AgentProjection {
  kind: 'agent'
  runId: string
  profileId: string
  sessionId?: string
  workspaceId: string
  name: string
  agentKind: string
  status: AgentProjectionStatus
  prompt?: string
  updatedAt: string
}

export type GitProviderKind =
  | 'git'
  | 'github'
  | 'gitlab'
  | 'bitbucket'
  | 'azure-devops'
  | 'unknown'

export type ReviewKind = 'none' | 'pull-request' | 'merge-request' | 'change-request'

export type SourceControlChangeStatus =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'untracked'
  | 'ignored'

export interface SourceControlChange {
  path: string
  status: SourceControlChangeStatus
  additions?: number
  deletions?: number
}

export interface SourceControlProjection {
  kind: 'source-control'
  repositoryId: string
  workspaceId: string
  provider: GitProviderKind
  reviewKind: ReviewKind
  branch: string
  baseBranch?: string
  ahead: number
  behind: number
  syncStatus: 'clean' | 'dirty' | 'syncing' | 'error' | 'unknown'
  changes: SourceControlChange[]
  updatedAt: string
}

export interface BrowserPermissionState {
  name: string
  state: 'prompt' | 'granted' | 'denied'
}

export interface BrowserScreenshotRef {
  uri: string
  capturedAt: string
}

export interface BrowserProjection {
  kind: 'browser'
  tabId: string
  workspaceId: string
  title: string
  url: string
  status: 'loading' | 'ready' | 'error'
  canGoBack: boolean
  canGoForward: boolean
  permissions: BrowserPermissionState[]
  screenshot?: BrowserScreenshotRef
  errorMessage?: string
  updatedAt: string
}

export interface BrowserDownloadProjection {
  kind: 'browser-download'
  downloadId: string
  tabId?: string
  url: string
  filename?: string
  path?: string
  status: string
  bytesReceived?: number
  totalBytes?: number
  error?: string
  updatedAt: string
}

export interface FileProjection {
  kind: 'file'
  projectId: string
  worktreeId?: string
  workspaceId: string
  path: string
  name: string
  entryKind: 'file' | 'directory' | 'symlink'
  size?: number
  isRemote: boolean
  updatedAt: string
}

export interface RuntimeFileContent {
  projectId: string
  worktreeId?: string
  path: string
  encoding: 'utf-8' | string
  content: string
  size: number
  modifiedAt: string
}

export interface AutomationProjection {
  kind: 'automation'
  automationId: string
  name: string
  description?: string
  enabled: boolean
  scheduleKind: string
  actionKind: string
  lastTriggeredAt?: string
  nextRunAt?: string
  updatedAt: string
}

export interface ExternalTaskProjection {
  kind: 'external-task'
  itemId: string
  provider: string
  itemKind: string
  externalId: string
  url?: string
  title: string
  status: string
  assignee?: string
  projectId?: string
  taskId?: string
  repositoryId?: string
  workspaceId?: string
  reviewKind?: string
  lastSyncedAt?: string
  updatedAt: string
}

export interface ReleaseProjection {
  kind: 'release'
  releaseId: string
  version: string
  channel: string
  status: string
  requiredCount: number
  artifactCount: number
  checkCount: number
  passedCheckCount: number
  failedCheckCount: number
  ready: boolean
  updateManifestUri?: string
  blockedReason?: string
  publishedAt?: string
  updatedAt: string
}

export interface TaskProjection {
  kind: 'task'
  taskId: string
  title: string
  status: string
  assignee?: string
  parentId?: string
  completedAt?: string
  updatedAt: string
}

export interface MessageProjection {
  kind: 'message'
  messageId: string
  threadId: string
  from: string
  to: string
  subject: string
  type: string
  priority?: string
  read: boolean
  createdAt: string
}

export interface DispatchProjection {
  kind: 'dispatch'
  dispatchId: string
  taskId: string
  assignee: string
  sessionId?: string
  status: string
  updatedAt: string
}

export interface EmulatorDeviceProjection {
  kind: 'emulator-device'
  deviceId: string
  name: string
  platform: string
  runtime?: string
  status: string
  error?: string
  updatedAt: string
}

export interface EmulatorSessionProjection {
  kind: 'emulator-session'
  sessionId: string
  deviceId: string
  workspaceId: string
  active: boolean
  updatedAt: string
}

export interface ProviderProjection {
  kind: 'provider'
  providerId: string
  subsystem: string
  name: string
  status: string
  capabilities: string[]
  message?: string
  lastSeenAt: string
}

export interface ComputerActionProjection {
  kind: 'computer-action'
  actionId: string
  actionKind: string
  target?: string
  status: string
  payload?: Record<string, unknown>
  result?: Record<string, unknown>
  error?: string
  createdAt: string
  updatedAt: string
}

export interface SettingProjection {
  kind: 'setting'
  settingId: string
  scope: string
  projectId?: string
  workspaceId?: string
  key: string
  updatedAt: string
}

export interface KeybindingProjection {
  kind: 'keybinding'
  keybindingId: string
  command: string
  accelerator: string
  platform?: string
  context?: string
  enabled: boolean
  updatedAt: string
}

export interface FileContentMessagePayload {
  requestId: string
  content: RuntimeFileContent
}

export interface RuntimeProjectionSnapshot {
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
  receivedAt: string
}

export type MobileRelayClientMessage =
  | {
      version: MobileRelayProtocolVersion
      id: string
      type: 'client.hello'
      payload: {
        device: DeviceIdentity
        runtimeApiVersion: RuntimeApiVersion
        runtimeEventVersion: RuntimeEventVersion
        subscriptions: ProjectionKind[]
        pairingSecretRef: string
      }
    }
  | {
      version: MobileRelayProtocolVersion
      id: string
      type: 'crypto.handshake'
      payload: RelayCryptoHandshake
    }
  | {
      version: MobileRelayProtocolVersion
      id: string
      type: 'encrypted'
      payload: RelayCryptoEnvelope
    }
  | {
      version: MobileRelayProtocolVersion
      id: string
      type: 'pair.start'
      payload: PairingRequest & {
        device: DeviceIdentity
      }
    }
  | {
      version: MobileRelayProtocolVersion
      id: string
      type: 'projection.subscribe'
      payload: {
        projections: ProjectionKind[]
      }
    }
  | {
      version: MobileRelayProtocolVersion
      id: string
      type: 'terminal.input'
      payload: {
        sessionId: string
        data: string
      }
    }
  | {
      version: MobileRelayProtocolVersion
      id: string
      type: 'browser.command'
      payload: {
        tabId: string
        command: 'reload' | 'goBack' | 'goForward' | 'stop' | 'screenshot'
      }
    }
  | {
      version: MobileRelayProtocolVersion
      id: string
      type: 'file.read'
      payload: {
        projectId: string
        worktreeId?: string
        path: string
        maxBytes?: number
      }
    }
  | {
      version: MobileRelayProtocolVersion
      id: string
      type: 'file.write'
      payload: {
        projectId: string
        worktreeId?: string
        path: string
        content: string
        createDirs?: boolean
      }
    }
  | {
      version: MobileRelayProtocolVersion
      id: string
      type: 'heartbeat'
      payload: {
        sentAt: string
      }
    }

export type MobileRelayServerMessage =
  | {
      version: MobileRelayProtocolVersion
      id: string
      type: 'server.hello'
      payload: {
        relayId: string
        workspaceName?: string
        acceptedSubscriptions: ProjectionKind[]
      }
    }
  | {
      version: MobileRelayProtocolVersion
      id: string
      type: 'crypto.ready'
      payload: RelayCryptoReady
    }
  | {
      version: MobileRelayProtocolVersion
      id: string
      type: 'pair.challenge'
      payload: {
        challengeId: string
        expiresAt: string
      }
    }
  | {
      version: MobileRelayProtocolVersion
      id: string
      type: 'pair.accepted'
      payload: {
        endpoint?: string
        relayId: string
        workspaceName?: string
        pairingSecretRef?: string
      }
    }
  | {
      version: MobileRelayProtocolVersion
      id: string
      type: 'pair.rejected'
      payload: {
        reason: string
      }
    }
  | {
      version: MobileRelayProtocolVersion
      id: string
      type: 'projection.snapshot'
      payload: RuntimeProjectionSnapshot
    }
  | {
      version: MobileRelayProtocolVersion
      id: string
      type: 'runtime.event'
      payload: RuntimeEvent
    }
  | {
      version: MobileRelayProtocolVersion
      id: string
      type: 'file.content'
      payload: FileContentMessagePayload
    }
  | {
      version: MobileRelayProtocolVersion
      id: string
      type: 'encrypted'
      payload: RelayCryptoEnvelope
    }
  | {
      version: MobileRelayProtocolVersion
      id: string
      type: 'error'
      payload: {
        code: string
        message: string
        requestId?: string
      }
    }
  | {
      version: MobileRelayProtocolVersion
      id: string
      type: 'heartbeat'
      payload: {
        sentAt: string
      }
    }
