import type { PreloadApi } from '../../../packages/product-core/shared/preload-api-types'
import type {
  ProjectHostSetupCreateArgs,
  ProjectHostSetupDeleteArgs,
  ProjectHostSetupExistingFolderArgs,
  ProjectHostSetupUpdateArgs,
  ProjectUpdateArgs
} from '../../../packages/product-core/shared/types'

type RuntimeRpcResult = { handled: boolean; result?: unknown }
type ProjectsApi = Pick<
  PreloadApi['projects'],
  | 'list'
  | 'update'
  | 'listHostSetups'
  | 'createHostSetup'
  | 'setupExistingFolder'
  | 'updateHostSetup'
  | 'deleteHostSetup'
>

export async function callTauriProjectHostSetupRuntimeRpc(
  method: string,
  params: unknown,
  projectsApi?: ProjectsApi
): Promise<RuntimeRpcResult> {
  switch (method) {
    case 'project.list':
      return {
        handled: true,
        result: { projects: await requireProjectsApi(projectsApi).list() }
      }
    case 'project.update': {
      const args = readProjectUpdateArgs(params)
      return {
        handled: true,
        result: { project: await requireProjectsApi(projectsApi).update(args) }
      }
    }
    case 'projectHostSetup.list':
      return {
        handled: true,
        result: { setups: await requireProjectsApi(projectsApi).listHostSetups() }
      }
    case 'projectHostSetup.create':
      return {
        handled: true,
        result: {
          result: await requireProjectsApi(projectsApi).createHostSetup(readCreateArgs(params))
        }
      }
    case 'projectHostSetup.setupExistingFolder':
      return {
        handled: true,
        result: {
          result: await requireProjectsApi(projectsApi).setupExistingFolder(
            readExistingFolderArgs(params)
          )
        }
      }
    case 'projectHostSetup.update':
      return {
        handled: true,
        result: {
          result: await requireProjectsApi(projectsApi).updateHostSetup(readUpdateArgs(params))
        }
      }
    case 'projectHostSetup.delete':
      return {
        handled: true,
        result: {
          result: await requireProjectsApi(projectsApi).deleteHostSetup(readDeleteArgs(params))
        }
      }
    default:
      return { handled: false }
  }
}

function readProjectUpdateArgs(params: unknown): ProjectUpdateArgs {
  const input = requireRecord(params)
  const updates = requireRecord(input.updates)
  const rawPreference = updates.localWindowsRuntimePreference
  if (rawPreference === undefined) {
    return { projectId: requireString(input.projectId, 'projectId'), updates: {} }
  }
  const preference = requireRecord(rawPreference)
  const kind = requireString(preference.kind, 'localWindowsRuntimePreference.kind')
  if (kind === 'inherit-global' || kind === 'windows-host') {
    return {
      projectId: requireString(input.projectId, 'projectId'),
      updates: { localWindowsRuntimePreference: { kind } }
    }
  }
  if (kind === 'wsl') {
    return {
      projectId: requireString(input.projectId, 'projectId'),
      updates: {
        localWindowsRuntimePreference: {
          kind,
          distro: requireString(preference.distro, 'localWindowsRuntimePreference.distro')
        }
      }
    }
  }
  throw new Error('Project host setup localWindowsRuntimePreference.kind is invalid.')
}

function requireProjectsApi(projectsApi?: ProjectsApi): ProjectsApi {
  // Why: unrelated runtime calls can arrive before the preload surface is fully assembled.
  return projectsApi ?? window.api.projects
}

function readCreateArgs(params: unknown): ProjectHostSetupCreateArgs {
  const input = requireRecord(params)
  return {
    ...input,
    projectId: requireString(input.projectId, 'projectId'),
    hostId: requireString(input.hostId, 'hostId') as ProjectHostSetupCreateArgs['hostId']
  } as ProjectHostSetupCreateArgs
}

function readExistingFolderArgs(params: unknown): ProjectHostSetupExistingFolderArgs {
  const input = requireRecord(params)
  return {
    ...input,
    projectId: requireString(input.projectId, 'projectId'),
    hostId: requireString(input.hostId, 'hostId') as ProjectHostSetupExistingFolderArgs['hostId'],
    path: requireString(input.path, 'path')
  } as ProjectHostSetupExistingFolderArgs
}

function readUpdateArgs(params: unknown): ProjectHostSetupUpdateArgs {
  const input = requireRecord(params)
  return {
    setupId: requireString(input.setupId, 'setupId'),
    updates: requireRecord(input.updates) as ProjectHostSetupUpdateArgs['updates']
  }
}

function readDeleteArgs(params: unknown): ProjectHostSetupDeleteArgs {
  const input = requireRecord(params)
  return { setupId: requireString(input.setupId, 'setupId') }
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Project host setup parameters must be an object.')
  }
  return value as Record<string, unknown>
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Project host setup ${field} must be a non-empty string.`)
  }
  return value.trim()
}
