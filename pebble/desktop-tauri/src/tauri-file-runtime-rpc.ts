import { invoke } from '@tauri-apps/api/core'
import { homeDir } from '@tauri-apps/api/path'

import {
  relativePathInsideRoot,
  resolveRuntimePath
} from '../../../src/shared/cross-platform-path'
import type { RuntimeRpcResponse } from '../../../src/shared/runtime-rpc-envelope'
import type { RuntimeTerminalPathResolution } from '../../../src/shared/runtime-types'
import type { DirEntry, MarkdownDocument, SearchResult } from '../../../src/shared/types'
import { requestRuntimeJson } from './pebble-tauri-runtime-transport'

type SourceControlProjection = {
  repositoryId: string
  workspaceId: string
}

type RuntimeFileEntry = {
  name: string
  kind: 'file' | 'directory' | 'symlink'
}

type RuntimeFileContent = {
  content: string
  size?: number
}

type RuntimeFileStat = {
  size: number
  isDirectory: boolean
  mtime: number
}

type RuntimeWorktreeRecord = {
  id: string
  projectId: string
  path: string
  connectionId?: string
}

type RuntimeProjectRecord = {
  id: string
  locationKind: string
  hostId?: string
}

type RuntimeSession = {
  id: string
  worktreeId?: string
  cwd: string
}

type RuntimeOutputChunk = {
  content: string
}

type RuntimeFileReadResult = {
  worktree: string
  relativePath: string
  content: string
  truncated: boolean
  byteLength: number
}

type RuntimeFilePreviewResult = {
  content: string
  isBinary: boolean
  isImage?: boolean
  mimeType?: string
}

type RuntimeFileChunk = {
  contentBase64: string
  bytesRead: number
  eof: boolean
}

type RuntimeFileListResult = {
  files: { relativePath: string }[]
}

type RuntimeFileRpcResult = {
  handled: boolean
  result?: unknown
}

type RuntimeFileScope = {
  projectId: string
  worktreeId?: string
}

type TerminalArtifactGrantResult = {
  absolutePath: string
  isDirectory: boolean
  grantId?: string
}

type RemoteTerminalArtifactGrant = {
  connectionId: string
  worktreeId: string
  absolutePath: string
}

const runtimeFileReadMaxBytes = 512 * 1024
const runtimePreviewMaxBytes = 10 * 1024 * 1024
const remoteTerminalArtifactGrants = new Map<string, RemoteTerminalArtifactGrant>()
const remoteFileRuntimeMethods = new Set([
  'files.read',
  'files.readDir',
  'files.readPreview',
  'files.readChunk',
  'files.write',
  'files.writeBase64',
  'files.writeBase64Chunk',
  'files.createFile',
  'files.createDir',
  'files.createDirNoClobber',
  'files.commitUpload',
  'files.rename',
  'files.copy',
  'files.delete',
  'files.stat',
  'files.listAll',
  'files.search',
  'files.listMarkdownDocuments'
])

const mobileBinaryExtensions = new Set([
  '.avif',
  '.bmp',
  '.gif',
  '.heic',
  '.ico',
  '.jpeg',
  '.jpg',
  '.mov',
  '.mp3',
  '.mp4',
  '.pdf',
  '.png',
  '.webp',
  '.zip'
])

const previewMimeTypes = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.svg', 'image/svg+xml'],
  ['.webp', 'image/webp'],
  ['.bmp', 'image/bmp'],
  ['.ico', 'image/x-icon'],
  ['.pdf', 'application/pdf']
])

export async function callTauriFileRuntimeRpc(
  method: string,
  params: unknown
): Promise<RuntimeFileRpcResult> {
  const remoteResult = await callRemoteFileRuntimeRpc(method, params)
  if (remoteResult.handled) {
    return remoteResult
  }
  switch (method) {
    case 'files.read':
      return handled(await readFile(params))
    case 'files.resolveTerminalPath':
      return handled(await resolveTerminalPath(params))
    case 'files.readTerminalArtifact':
      return handled(await readTerminalArtifact(params))
    case 'files.readTerminalArtifactPreview':
      return handled(await readTerminalArtifactPreview(params))
    case 'files.writeTerminalArtifact':
      return handled(await writeTerminalArtifact(params))
    case 'files.readDir':
      return handled(await readDirectory(params))
    case 'files.readPreview':
      return handled(await readPreview(params))
    case 'files.readChunk':
      return handled(await readFileChunk(params))
    case 'files.browseServerDir':
      return handled(await browseServerDirectory(params))
    case 'files.write':
      return handled(await writeFile(params))
    case 'files.writeBase64':
      return handled(await writeBase64File(params, false))
    case 'files.writeBase64Chunk':
      return handled(await writeBase64File(params, true))
    case 'files.createFile':
      return handled(await createFile(params))
    case 'files.createDir':
      return handled(await createDirectory(params))
    case 'files.createDirNoClobber':
      return handled(await createDirectory(params))
    case 'files.commitUpload':
      return handled(await commitUpload(params))
    case 'files.rename':
      return handled(await renamePath(params))
    case 'files.copy':
      return handled(await copyPath(params))
    case 'files.delete':
      return handled(await deletePath(params))
    case 'files.stat':
      return handled(await statPath(params))
    case 'files.listAll':
      return handled(await listAllFiles(params))
    case 'files.search':
      return handled(await searchFiles(params))
    case 'files.listMarkdownDocuments':
      return handled(await listMarkdownDocuments(params))
    case 'files.unwatch':
      return handled({ ok: true })
    default:
      return { handled: false }
  }
}

async function readDirectory(params: unknown): Promise<DirEntry[]> {
  const input = readObject(params)
  const scope = await readRuntimeFileScope(input)
  const entries = await requestRuntimeJson<RuntimeFileEntry[]>(
    `/v1/files/tree?${fileQuery(scope, readString(input.relativePath) ?? '')}&maxDepth=1`,
    { method: 'GET', timeoutMs: 3000 }
  )
  return entries.map((entry) => ({
    name: entry.name,
    isDirectory: entry.kind === 'directory',
    isSymlink: entry.kind === 'symlink'
  }))
}

async function readFile(params: unknown): Promise<RuntimeFileReadResult> {
  const input = readObject(params)
  const relativePath = readRequiredString(input.relativePath, 'file path')
  if (isMobileBinaryPath(relativePath)) {
    throw new Error('binary_file')
  }
  const stat = await statPath(params)
  const truncated = stat.size > runtimeFileReadMaxBytes
  if (truncated) {
    const chunk = await readFileChunkWithLength(input, runtimeFileReadMaxBytes)
    const content = textFromBase64(chunk.contentBase64)
    if (content.includes('\u0000')) {
      throw new Error('binary_file')
    }
    return {
      worktree: normalizeRuntimeWorktreeId(readString(input.worktree)) ?? '',
      relativePath,
      content,
      truncated: true,
      byteLength: stat.size
    }
  }
  const scope = await readRuntimeFileScope(input)
  const file = await requestRuntimeJson<RuntimeFileContent>(
    `/v1/files/read?${fileQuery(scope, relativePath)}&maxBytes=${runtimeFileReadMaxBytes}`,
    { method: 'GET', timeoutMs: 3000 }
  )
  if (file.content.includes('\u0000')) {
    throw new Error('binary_file')
  }
  return {
    worktree: normalizeRuntimeWorktreeId(readString(input.worktree)) ?? '',
    relativePath,
    content: file.content,
    truncated: false,
    byteLength: file.size ?? stat.size
  }
}

async function readPreview(params: unknown): Promise<RuntimeFilePreviewResult> {
  const input = readObject(params)
  const scope = await readRuntimeFileScope(input)
  const relativePath = readRequiredString(input.relativePath, 'file path')
  const stat = await statPath(params)
  if (stat.size > runtimePreviewMaxBytes) {
    throw new Error('file_too_large')
  }
  const mimeType = previewMimeTypes.get(fileExtension(relativePath))
  if (mimeType) {
    const chunk =
      stat.size > 0 ? await readFileChunkWithLength(input, stat.size) : { contentBase64: '' }
    return {
      content: chunk.contentBase64,
      isBinary: true,
      isImage: true,
      mimeType
    }
  }
  if (isMobileBinaryPath(relativePath)) {
    return { content: '', isBinary: true }
  }
  const file = await requestRuntimeJson<RuntimeFileContent>(
    `/v1/files/read?${fileQuery(scope, relativePath)}&maxBytes=${runtimePreviewMaxBytes}`,
    { method: 'GET', timeoutMs: 3000 }
  )
  const isBinary = file.content.includes('\u0000')
  return {
    content: isBinary ? '' : file.content,
    isBinary
  }
}

async function readFileChunk(params: unknown): Promise<RuntimeFileChunk> {
  return readFileChunkWithLength(readObject(params), readNumber(readObject(params).length) ?? 0)
}

async function readFileChunkWithLength(
  input: Record<string, unknown>,
  length: number
): Promise<RuntimeFileChunk> {
  const scope = await readRuntimeFileScope(input)
  return requestRuntimeJson<RuntimeFileChunk>('/v1/files/read-chunk', {
    method: 'POST',
    timeoutMs: 30_000,
    body: {
      ...scope,
      path: readRequiredString(input.relativePath, 'file path'),
      offset: readNumber(input.offset) ?? 0,
      length
    }
  })
}

async function browseServerDirectory(params: unknown): Promise<{
  resolvedPath: string
  entries: DirEntry[]
}> {
  const input = readObject(params)
  return requestRuntimeJson<{ resolvedPath: string; entries: DirEntry[] }>(
    '/v1/files/browse-dir?' +
      new URLSearchParams({
        path: readString(input.path) ?? '~'
      }).toString(),
    { method: 'GET', timeoutMs: 5000 }
  )
}

async function writeFile(params: unknown): Promise<{ ok: true }> {
  const input = readObject(params)
  const scope = await readRuntimeFileScope(input)
  await requestRuntimeJson<RuntimeFileContent>('/v1/files/write', {
    method: 'POST',
    timeoutMs: 5000,
    body: {
      ...scope,
      path: readRequiredString(input.relativePath, 'file path'),
      content: readRawString(input.content) ?? '',
      createDirs: true
    }
  })
  return { ok: true }
}

async function writeBase64File(params: unknown, chunked: boolean): Promise<{ ok: true }> {
  const input = readObject(params)
  const scope = await readRuntimeFileScope(input)
  return requestRuntimeJson<{ ok: true }>('/v1/files/write-base64', {
    method: 'POST',
    timeoutMs: 30_000,
    body: {
      ...scope,
      path: readRequiredString(input.relativePath, 'file path'),
      contentBase64: readRawString(input.contentBase64) ?? '',
      append: chunked && input.append === true
    }
  })
}

async function createFile(params: unknown): Promise<{ ok: true }> {
  const input = readObject(params)
  const scope = await readRuntimeFileScope(input)
  return requestRuntimeJson<{ ok: true }>('/v1/files/create-file', {
    method: 'POST',
    body: { ...scope, path: readRequiredString(input.relativePath, 'file path') }
  })
}

async function createDirectory(params: unknown): Promise<{ ok: true }> {
  const input = readObject(params)
  const scope = await readRuntimeFileScope(input)
  return requestRuntimeJson<{ ok: true }>('/v1/files/create-dir', {
    method: 'POST',
    body: { ...scope, path: readRequiredString(input.relativePath, 'directory path') }
  })
}

async function commitUpload(params: unknown): Promise<{ ok: true }> {
  const input = readObject(params)
  const scope = await readRuntimeFileScope(input)
  await requestRuntimeJson<{ ok: true }>('/v1/files/copy', {
    method: 'POST',
    body: {
      ...scope,
      sourcePath: readRequiredString(input.tempRelativePath, 'temporary upload path'),
      destinationPath: readRequiredString(input.finalRelativePath, 'final upload path')
    }
  })
  await requestRuntimeJson<{ ok: true }>('/v1/files/delete', {
    method: 'POST',
    body: {
      ...scope,
      path: readRequiredString(input.tempRelativePath, 'temporary upload path'),
      recursive: false
    }
  }).catch(() => undefined)
  return { ok: true }
}

async function renamePath(params: unknown): Promise<{ ok: true }> {
  const input = readObject(params)
  const scope = await readRuntimeFileScope(input)
  return requestRuntimeJson<{ ok: true }>('/v1/files/rename', {
    method: 'POST',
    body: {
      ...scope,
      oldPath: readRequiredString(input.oldRelativePath, 'old path'),
      newPath: readRequiredString(input.newRelativePath, 'new path')
    }
  })
}

async function copyPath(params: unknown): Promise<{ ok: true }> {
  const input = readObject(params)
  const scope = await readRuntimeFileScope(input)
  return requestRuntimeJson<{ ok: true }>('/v1/files/copy', {
    method: 'POST',
    body: {
      ...scope,
      sourcePath: readRequiredString(input.sourceRelativePath, 'source path'),
      destinationPath: readRequiredString(input.destinationRelativePath, 'destination path')
    }
  })
}

async function deletePath(params: unknown): Promise<{ ok: true }> {
  const input = readObject(params)
  const scope = await readRuntimeFileScope(input)
  return requestRuntimeJson<{ ok: true }>('/v1/files/delete', {
    method: 'POST',
    body: {
      ...scope,
      path: readRequiredString(input.relativePath, 'file path'),
      recursive: input.recursive === true
    }
  })
}

async function statPath(params: unknown): Promise<RuntimeFileStat> {
  const input = readObject(params)
  const scope = await readRuntimeFileScope(input)
  return requestRuntimeJson<RuntimeFileStat>(
    `/v1/files/stat?${fileQuery(scope, readRequiredString(input.relativePath, 'file path'))}`,
    { method: 'GET', timeoutMs: 3000 }
  )
}

async function listAllFiles(params: unknown): Promise<RuntimeFileListResult> {
  const input = readObject(params)
  const scope = await readRuntimeFileScope(input)
  return requestRuntimeJson<RuntimeFileListResult>('/v1/files/list', {
    method: 'POST',
    timeoutMs: 5000,
    body: {
      ...scope,
      excludePaths: readStringList(input.excludePaths)
    }
  })
}

async function searchFiles(params: unknown): Promise<SearchResult> {
  const input = readObject(params)
  const scope = await readRuntimeFileScope(input)
  return requestRuntimeJson<SearchResult>('/v1/files/search', {
    method: 'POST',
    timeoutMs: 10_000,
    body: {
      ...scope,
      query: readString(input.query) ?? '',
      caseSensitive: input.caseSensitive === true,
      wholeWord: input.wholeWord === true,
      useRegex: input.useRegex === true,
      includePattern: readString(input.includePattern) ?? '',
      excludePattern: readString(input.excludePattern) ?? '',
      maxResults: readNumber(input.maxResults)
    }
  })
}

async function listMarkdownDocuments(params: unknown): Promise<MarkdownDocument[]> {
  const scope = await readRuntimeFileScope(readObject(params))
  return requestRuntimeJson<MarkdownDocument[]>(
    `/v1/files/markdown?${fileQuery(scope, '')}`,
    { method: 'GET', timeoutMs: 5000 }
  )
}

async function callRemoteFileRuntimeRpc(
  method: string,
  params: unknown
): Promise<RuntimeFileRpcResult> {
  if (!remoteFileRuntimeMethods.has(method)) {
    return { handled: false }
  }
  const input = readObject(params)
  const worktreeId = normalizeRuntimeWorktreeId(readString(input.worktree))
  if (!worktreeId) {
    return { handled: false }
  }
  const worktree = await readRuntimeWorktree(input)
  if (!worktree.connectionId) {
    return { handled: false }
  }
  // Why: SSH/remote worktrees cannot be read from the desktop host. Paired runtime
  // environments own the remote filesystem and return the same Electron RPC shapes.
  const result = await callRemoteRuntimeResult(
    worktree.connectionId,
    method,
    { ...input, worktree: toRuntimeWorktreeSelector(worktree.id) },
    remoteFileRuntimeTimeout(method)
  )
  return handled(result)
}

function remoteFileRuntimeTimeout(method: string): number {
  return method === 'files.search' || method === 'files.readChunk' ? 30_000 : 10_000
}

async function resolveTerminalPath(params: unknown): Promise<RuntimeTerminalPathResolution> {
  const input = readObject(params)
  const worktree = await readRuntimeWorktree(input)
  if (worktree.connectionId) {
    return resolveRemoteTerminalPath(input, worktree)
  }
  const pathText = readRequiredString(input.pathText, 'path text')
  const terminalHandle = readString(input.terminal)
  const session = terminalHandle ? await findRuntimeSession(terminalHandle) : null
  const expandedPath = await expandTerminalPathText(pathText)
  const base = session?.cwd || readString(input.cwd) || worktree.path
  const absolutePath = resolveRuntimePath(base, expandedPath)
  const relativePath = relativePathInsideRoot(worktree.path, absolutePath)
  const empty = emptyTerminalPathResolution(worktree.id, relativePath, absolutePath)

  if (relativePath !== null && relativePath !== '' && isSafeRuntimeRelativePath(relativePath)) {
    try {
      const stats = await statPath({
        ...input,
        worktree: worktree.id,
        relativePath
      })
      return {
        worktree: worktree.id,
        relativePath,
        absolutePath,
        exists: true,
        isDirectory: stats.isDirectory,
        openTarget: stats.isDirectory
          ? undefined
          : {
              kind: 'worktree-file',
              provider: 'local',
              relativePath,
              absolutePath
            }
      }
    } catch (error) {
      if (isRuntimeNotFoundError(error)) {
        return empty
      }
      throw error
    }
  }

  // Why: terminal taps can name agent-created temp files outside the worktree.
  // Only a live matching terminal with recent output for that exact path can mint a grant.
  if (!terminalHandle || !session || session.worktreeId !== worktree.id) {
    return empty
  }
  if (!(await hasRecentTerminalOutputPath(terminalHandle, pathText, absolutePath))) {
    return empty
  }

  let grant: TerminalArtifactGrantResult
  try {
    grant = await invoke<TerminalArtifactGrantResult>('terminal_artifact_grant', {
      input: {
        worktreeId: worktree.id,
        absolutePath,
        worktreePath: worktree.path
      }
    })
  } catch (error) {
    if (isTerminalArtifactResolutionMiss(error)) {
      return empty
    }
    throw error
  }

  return {
    worktree: worktree.id,
    relativePath: null,
    absolutePath: grant.absolutePath,
    exists: true,
    isDirectory: grant.isDirectory,
    openTarget:
      grant.grantId && !grant.isDirectory
        ? {
            kind: 'absolute-file',
            provider: 'local',
            absolutePath: grant.absolutePath,
            grantId: grant.grantId
          }
        : undefined
  }
}

async function readTerminalArtifact(params: unknown): Promise<RuntimeFileReadResult> {
  const input = readObject(params)
  const remoteGrant = readRemoteTerminalArtifactGrant(input)
  if (remoteGrant) {
    return callRemoteRuntimeResult<RuntimeFileReadResult>(
      remoteGrant.connectionId,
      'files.readTerminalArtifact',
      remoteTerminalArtifactParams(input, remoteGrant),
      30_000
    )
  }
  return invoke<RuntimeFileReadResult>('terminal_artifact_read', {
    input: readTerminalArtifactAccessInput(input)
  })
}

async function readTerminalArtifactPreview(params: unknown): Promise<RuntimeFilePreviewResult> {
  const input = readObject(params)
  const remoteGrant = readRemoteTerminalArtifactGrant(input)
  if (remoteGrant) {
    return callRemoteRuntimeResult<RuntimeFilePreviewResult>(
      remoteGrant.connectionId,
      'files.readTerminalArtifactPreview',
      remoteTerminalArtifactParams(input, remoteGrant),
      30_000
    )
  }
  return invoke<RuntimeFilePreviewResult>('terminal_artifact_preview', {
    input: readTerminalArtifactAccessInput(input)
  })
}

async function writeTerminalArtifact(params: unknown): Promise<{ ok: true }> {
  const input = readObject(params)
  const remoteGrant = readRemoteTerminalArtifactGrant(input)
  if (remoteGrant) {
    return callRemoteRuntimeResult<{ ok: true }>(
      remoteGrant.connectionId,
      'files.writeTerminalArtifact',
      {
        ...remoteTerminalArtifactParams(input, remoteGrant),
        content: readRequiredRawString(input.content, 'file content')
      },
      30_000
    )
  }
  return invoke<{ ok: true }>('terminal_artifact_write', {
    input: {
      ...readTerminalArtifactAccessInput(input),
      content: readRequiredRawString(input.content, 'file content')
    }
  })
}

async function readRuntimeWorktree(input: Record<string, unknown>): Promise<RuntimeWorktreeRecord> {
  const worktreeId = normalizeRuntimeWorktreeId(readString(input.worktree))
  if (!worktreeId) {
    throw new Error('files_runtime_requires_worktree')
  }
  const [worktrees, projects] = await Promise.all([
    requestRuntimeJson<RuntimeWorktreeRecord[]>('/v1/worktrees', {
      method: 'GET',
      timeoutMs: 3000
    }),
    requestRuntimeJson<RuntimeProjectRecord[]>('/v1/projects', {
      method: 'GET',
      timeoutMs: 3000
    })
  ])
  const worktree = worktrees.find((entry) => entry.id === worktreeId)
  if (!worktree) {
    throw new Error(`files_runtime_worktree_not_found:${worktreeId}`)
  }
  const project = projects.find((entry) => entry.id === worktree.projectId)
  return {
    ...worktree,
    connectionId: project?.locationKind === 'ssh' ? project.hostId : undefined
  }
}

async function resolveRemoteTerminalPath(
  input: Record<string, unknown>,
  worktree: RuntimeWorktreeRecord
): Promise<RuntimeTerminalPathResolution> {
  const connectionId = worktree.connectionId
  if (!connectionId) {
    throw new Error('remote_runtime_unavailable')
  }
  const result = await callRemoteRuntimeResult<RuntimeTerminalPathResolution>(
    connectionId,
    'files.resolveTerminalPath',
    {
      worktree: toRuntimeWorktreeSelector(worktree.id),
      pathText: readRequiredString(input.pathText, 'path text'),
      terminal: readString(input.terminal),
      cwd: readString(input.cwd)
    },
    30_000
  )
  rememberRemoteTerminalArtifactGrant(result, connectionId, worktree.id)
  return result
}

async function callRemoteRuntimeResult<T>(
  connectionId: string,
  method: string,
  params: unknown,
  timeoutMs: number
): Promise<T> {
  const response = (await window.api.runtimeEnvironments.call({
    selector: connectionId,
    method,
    params,
    timeoutMs
  })) as RuntimeRpcResponse<unknown>
  if (response.ok) {
    return response.result as T
  }
  throw new Error(response.error.message)
}

async function findRuntimeSession(id: string): Promise<RuntimeSession | null> {
  const sessions = await requestRuntimeJson<RuntimeSession[]>('/v1/sessions', {
    method: 'GET',
    timeoutMs: 3000
  })
  return sessions.find((session) => session.id === id) ?? null
}

async function hasRecentTerminalOutputPath(
  terminalHandle: string,
  pathText: string,
  absolutePath: string
): Promise<boolean> {
  const tail = await requestRuntimeJson<{ chunks: RuntimeOutputChunk[] }>(
    `/v1/sessions/${encodeURIComponent(terminalHandle)}/tail?limit=2000`,
    { method: 'GET', timeoutMs: 3000 }
  )
  const output = tail.chunks.map((chunk) => chunk.content).join('')
  const candidates = new Set([pathText, absolutePath])
  const uriPath = terminalFileUriPath(pathText)
  if (uriPath) {
    candidates.add(uriPath)
  }
  for (const candidate of candidates) {
    if (candidate && terminalOutputContainsPath(output, candidate)) {
      return true
    }
  }
  return false
}

async function expandTerminalPathText(pathText: string): Promise<string> {
  const uriPath = terminalFileUriPath(pathText)
  if (uriPath) {
    return uriPath
  }
  if (pathText.startsWith('~/') || pathText.startsWith('~\\')) {
    return resolveRuntimePath(await homeDir(), pathText.slice(2))
  }
  return pathText
}

function terminalFileUriPath(pathText: string): string | null {
  if (!pathText.startsWith('file://')) {
    return null
  }
  try {
    const url = new URL(pathText)
    const hostname = url.hostname.toLowerCase()
    if (hostname && hostname !== 'localhost' && hostname !== '127.0.0.1' && hostname !== '::1') {
      return null
    }
    const decoded = decodeURIComponent(url.pathname)
    return /^\/[A-Za-z]:[\\/]/.test(decoded) ? decoded.slice(1) : decoded
  } catch {
    return null
  }
}

function emptyTerminalPathResolution(
  worktreeId: string,
  relativePath: string | null,
  absolutePath: string
): RuntimeTerminalPathResolution {
  return {
    worktree: worktreeId,
    relativePath,
    absolutePath,
    exists: false,
    isDirectory: false
  }
}

function readTerminalArtifactAccessInput(input: Record<string, unknown>): {
  worktreeId: string
  grantId: string
  absolutePath: string
} {
  const worktreeId = normalizeRuntimeWorktreeId(readString(input.worktree))
  if (!worktreeId) {
    throw new Error('files_runtime_requires_worktree')
  }
  return {
    worktreeId,
    grantId: readRequiredString(input.grantId, 'terminal artifact grant'),
    absolutePath: readRequiredString(input.absolutePath, 'terminal artifact path')
  }
}

function rememberRemoteTerminalArtifactGrant(
  result: RuntimeTerminalPathResolution,
  connectionId: string,
  worktreeId: string
): void {
  if (result.openTarget?.kind !== 'absolute-file') {
    return
  }
  remoteTerminalArtifactGrants.set(result.openTarget.grantId, {
    connectionId,
    worktreeId,
    absolutePath: result.openTarget.absolutePath
  })
}

function readRemoteTerminalArtifactGrant(
  input: Record<string, unknown>
): RemoteTerminalArtifactGrant | null {
  const grantId = readString(input.grantId)
  if (!grantId) {
    return null
  }
  const grant = remoteTerminalArtifactGrants.get(grantId)
  if (!grant) {
    return null
  }
  const worktreeId = normalizeRuntimeWorktreeId(readString(input.worktree))
  const absolutePath = readString(input.absolutePath)
  if (grant.worktreeId !== worktreeId || grant.absolutePath !== absolutePath) {
    throw new Error('terminal_file_grant_mismatch')
  }
  return grant
}

function remoteTerminalArtifactParams(
  input: Record<string, unknown>,
  grant: RemoteTerminalArtifactGrant
): { worktree: string; grantId: string; absolutePath: string } {
  return {
    worktree: toRuntimeWorktreeSelector(grant.worktreeId),
    grantId: readRequiredString(input.grantId, 'terminal artifact grant'),
    absolutePath: grant.absolutePath
  }
}

async function readRuntimeFileScope(input: Record<string, unknown>): Promise<RuntimeFileScope> {
  const worktreeId = normalizeRuntimeWorktreeId(readString(input.worktree))
  if (!worktreeId) {
    throw new Error('files_runtime_requires_worktree')
  }
  const projections = await requestRuntimeJson<SourceControlProjection[]>(
    `/v1/source-control?workspaceId=${encodeURIComponent(worktreeId)}`,
    { method: 'GET', timeoutMs: 3000 }
  )
  const projection = projections.find((entry) => entry.workspaceId === worktreeId) ?? projections[0]
  if (!projection) {
    throw new Error(`files_runtime_scope_not_found:${worktreeId}`)
  }
  return {
    projectId: projection.repositoryId,
    ...(projection.workspaceId !== projection.repositoryId ? { worktreeId: projection.workspaceId } : {})
  }
}

function fileQuery(scope: RuntimeFileScope, path: string): string {
  const params = new URLSearchParams()
  params.set('projectId', scope.projectId)
  if (scope.worktreeId) {
    params.set('worktreeId', scope.worktreeId)
  }
  params.set('path', path)
  return params.toString()
}

function normalizeRuntimeWorktreeId(value: string | null): string | undefined {
  if (!value) {
    return undefined
  }
  return value.startsWith('id:') ? value.slice(3) : value
}

function toRuntimeWorktreeSelector(worktreeId: string): string {
  return `id:${worktreeId}`
}

function readObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function readRawString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function readRequiredString(value: unknown, label: string): string {
  const text = readString(value)
  if (!text) {
    throw new Error(`${label} is required`)
  }
  return text
}

function readRequiredRawString(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${label} is required`)
  }
  return value
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function readStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
}

function fileExtension(path: string): string {
  const leaf = path.replaceAll('\\', '/').split('/').pop() ?? ''
  const index = leaf.lastIndexOf('.')
  return index > 0 ? leaf.slice(index).toLowerCase() : ''
}

function isMobileBinaryPath(path: string): boolean {
  return mobileBinaryExtensions.has(fileExtension(path))
}

function isSafeRuntimeRelativePath(path: string): boolean {
  if (!path || path.includes('\0') || path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path)) {
    return false
  }
  return !path.split(/[\\/]+/).some((segment) => segment === '..')
}

function terminalOutputContainsPath(output: string, path: string): boolean {
  let index = output.indexOf(path)
  while (index !== -1) {
    const before = index > 0 ? output[index - 1] : ''
    const after = output[index + path.length] ?? ''
    if (isTerminalPathBoundary(before) && isTerminalPathBoundary(after)) {
      return true
    }
    index = output.indexOf(path, index + path.length)
  }
  return false
}

function isTerminalPathBoundary(char: string): boolean {
  return !char || !/[A-Za-z0-9_./\\:~-]/.test(char)
}

function isRuntimeNotFoundError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /not_found|not found|no such file|HTTP 404/i.test(message)
}

function isTerminalArtifactResolutionMiss(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /terminal_file_grant_unavailable|not_found|not_absolute/i.test(message)
}

function textFromBase64(contentBase64: string): string {
  const binary = atob(contentBase64)
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

function handled(result: unknown): RuntimeFileRpcResult {
  return { handled: true, result }
}
