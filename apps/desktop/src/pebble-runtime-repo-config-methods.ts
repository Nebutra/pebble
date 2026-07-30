import { parsePebbleYaml } from '../../../packages/product-core/shared/pebble-yaml'
import type { SetupScriptImportCandidate } from '../../../packages/product-core/shared/setup-script-imports'
import { inspectSetupScriptImportCandidates } from '../../../packages/product-core/shared/setup-script-imports'
import type { PebbleHooks } from '../../../packages/product-core/shared/types'
import { requestRuntimeJson } from './pebble-tauri-runtime-transport'
import { readRepos } from './pebble-tauri-workspace-runtime-api'
import { requireRepoId } from './pebble-runtime-repo-method-args'
import { readRuntimeObject, readRuntimeRawString } from './pebble-runtime-param-coercion'

export async function readRuntimeRepoHooksCheck(params: unknown): Promise<{
  status: 'ok' | 'error'
  hasHooks: boolean
  hooks: PebbleHooks | null
  mayNeedUpdate: boolean
}> {
  const repoId = requireRepoId(params)
  const repo = (await readRepos()).find((entry) => entry.id === repoId)
  if (!repo || repo.kind === 'folder') {
    return { status: 'ok', hasHooks: false, hooks: null, mayNeedUpdate: false }
  }
  const content = await readRuntimeRepoTextFile(repoId, 'pebble.yaml')
  if (content === null) {
    return { status: 'ok', hasHooks: false, hooks: null, mayNeedUpdate: false }
  }
  const hooks = parsePebbleYaml(content)
  return {
    status: 'ok',
    hasHooks: true,
    hooks,
    mayNeedUpdate: hooks === null && hasUnrecognizedPebbleYamlKeys(content)
  }
}

export async function inspectRuntimeRepoSetupScriptImports(
  params: unknown
): Promise<SetupScriptImportCandidate[]> {
  const repoId = requireRepoId(params)
  const repo = (await readRepos()).find((entry) => entry.id === repoId)
  if (!repo || repo.kind === 'folder') {
    return []
  }
  return inspectSetupScriptImportCandidates((relativePath) =>
    readRuntimeRepoTextFile(repoId, relativePath)
  )
}

function hasUnrecognizedPebbleYamlKeys(content: string): boolean {
  const recognized = new Set(['scripts', 'issueCommand', 'defaultTabs', 'environmentRecipes'])
  for (const line of content.split('\n')) {
    const match = line.match(/^([A-Za-z][A-Za-z0-9_-]*):(\s|$)/)
    if (match && !recognized.has(match[1])) {
      return true
    }
  }
  return false
}

export async function readRuntimeRepoIssueCommand(params: unknown): Promise<{
  status: 'ok' | 'error'
  localContent: string | null
  sharedContent: string | null
  effectiveContent: string | null
  localFilePath: string
  source: 'local' | 'shared' | 'none'
}> {
  const repoId = requireRepoId(params)
  const repo = (await readRepos()).find((entry) => entry.id === repoId)
  if (!repo || repo.kind === 'folder') {
    return {
      status: 'ok',
      localContent: null,
      sharedContent: null,
      effectiveContent: null,
      localFilePath: '',
      source: 'none'
    }
  }
  const localFilePath = joinRuntimeControlPath(repo.path, '.pebble/issue-command')
  const localContent =
    (await readRuntimeRepoTextFile(repoId, '.pebble/issue-command'))?.trim() || null
  const sharedContent =
    parsePebbleYaml(
      (await readRuntimeRepoTextFile(repoId, 'pebble.yaml')) ?? ''
    )?.issueCommand?.trim() || null
  const effectiveContent = localContent ?? sharedContent
  return {
    status: 'ok',
    localContent,
    sharedContent,
    effectiveContent,
    localFilePath,
    source: localContent ? 'local' : sharedContent ? 'shared' : 'none'
  }
}

async function readRuntimeRepoTextFile(repoId: string, filePath: string): Promise<string | null> {
  return requestRuntimeJson<{ content: string }>(
    `/v1/files/read?${new URLSearchParams({ projectId: repoId, path: filePath }).toString()}`,
    { method: 'GET', timeoutMs: 3000 }
  )
    .then((result) => result.content)
    .catch(() => null)
}

export async function writeRuntimeRepoIssueCommand(params: unknown): Promise<{ ok: true }> {
  const input = readRuntimeObject(params)
  await requestRuntimeJson('/v1/files/write', {
    method: 'POST',
    timeoutMs: 5000,
    body: {
      projectId: requireRepoId(params),
      path: '.pebble/issue-command',
      content: readRuntimeRawString(input.content) ?? '',
      createDirs: true
    }
  })
  return { ok: true }
}

function joinRuntimeControlPath(base: string, child: string): string {
  if (!base) {
    return child
  }
  const separator = base.includes('\\') && !base.includes('/') ? '\\' : '/'
  return base.endsWith('/') || base.endsWith('\\')
    ? `${base}${child}`
    : `${base}${separator}${child}`
}
