import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const scannerFiles = new Set([
  'ROADMAP.md',
  'config/scripts/legacy-brand-identifier-scan.mjs',
  'config/scripts/legacy-brand-identifier-scan.test.mjs',
  'config/scripts/verify-tauri-mainline.mjs'
])

export function isHistoricalEvidencePath(file) {
  // Trellis task artifacts preserve migration rationale and are never shipped as product source.
  return file.startsWith('.trellis/tasks/')
}

export function containsLegacyBrandIdentifier(value) {
  const oldName = `${'or'}${'ca'}`
  const token = new RegExp(`(^|[^A-Za-z0-9_])${oldName}($|[^A-Za-z0-9_]|[A-Z])`, 'i')
  const legacyPrefix = new RegExp(`(^|[^A-Za-z0-9_])${oldName}_`, 'i')
  const legacyDirectory = new RegExp(`\\.${oldName}(?:/|\\\\|$)`, 'i')
  return token.test(value) || legacyPrefix.test(value) || legacyDirectory.test(value)
}

export async function scanLegacyBrandIdentifiers(repoRoot, trackedFiles) {
  const failures = []
  for (const file of trackedFiles) {
    if (scannerFiles.has(file) || isHistoricalEvidencePath(file)) {
      continue
    }
    if (containsLegacyBrandIdentifier(file)) {
      failures.push(`${file} (path)`)
      continue
    }
    const content = await readFile(resolve(repoRoot, file)).catch((error) => {
      if (error?.code === 'ENOENT') {
        return null
      }
      throw error
    })
    if (!content || content.includes(0)) {
      continue
    }
    if (containsLegacyBrandIdentifier(content.toString('utf8'))) {
      failures.push(file)
    }
  }
  return failures
}

async function runCli() {
  const repoRoot = resolve(import.meta.dirname, '../..')
  const sourceFiles = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { cwd: repoRoot, encoding: 'utf8' }
  )
    .split('\0')
    .filter(Boolean)
  const failures = await scanLegacyBrandIdentifiers(repoRoot, sourceFiles)
  if (failures.length > 0) {
    throw new Error(
      `Working source still contains legacy product identifiers: ${failures.join(', ')}`
    )
  }
  console.log(`Legacy brand identifier scan passed across ${sourceFiles.length} source files.`)
}

if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) {
  await runCli()
}
