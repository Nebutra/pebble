import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

const packageRoot = join(import.meta.dirname, '..')
const assetsDir = join(packageRoot, 'dist', 'assets')
const SETTINGS_CHUNK_LIMIT_BYTES = 160_000

const assetNames = await readdir(assetsDir)
const matchingJavaScript = (prefix) =>
  assetNames.filter((name) => name.startsWith(`${prefix}-`) && name.endsWith('.js'))

const settingsChunks = matchingJavaScript('Settings')
if (settingsChunks.length !== 1) {
  throw new Error(`Expected one Settings JavaScript chunk, found ${settingsChunks.length}.`)
}

const settingsChunk = settingsChunks[0]
const settingsBytes = (await stat(join(assetsDir, settingsChunk))).size
if (settingsBytes > SETTINGS_CHUNK_LIMIT_BYTES) {
  throw new Error(
    `Settings shell is ${settingsBytes} bytes; limit is ${SETTINGS_CHUNK_LIMIT_BYTES}. ` +
      'Keep pane implementations behind settings-pane-components dynamic imports.'
  )
}

for (const requiredChunk of ['TerminalPane', 'RepositoryPane']) {
  if (matchingJavaScript(requiredChunk).length === 0) {
    throw new Error(`${requiredChunk} must remain an independent Settings chunk.`)
  }
}

console.log(
  `Settings bundle boundary verified: ${settingsBytes}/${SETTINGS_CHUNK_LIMIT_BYTES} bytes.`
)
