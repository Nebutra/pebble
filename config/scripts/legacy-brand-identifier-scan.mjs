import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

export function containsLegacyBrandIdentifier(value) {
  // Construct the retired name so this scanner does not need a source exemption.
  const oldName = `${'or'}${'ca'}`
  const token = new RegExp(`(^|[^A-Za-z0-9_])${oldName}($|[^A-Za-z0-9_]|[A-Z])`, 'i')
  const legacyPrefix = new RegExp(`(^|[^A-Za-z0-9_])${oldName}_`, 'i')
  const legacyDirectory = new RegExp(`\\.${oldName}(?:/|\\\\|$)`, 'i')
  return token.test(value) || legacyPrefix.test(value) || legacyDirectory.test(value)
}

// Why allowlisted: product still accepts pre-rename pairing deep-link schemes
// (`…://pair`) so remote QR / paste from older hosts works. Those surfaces must
// keep the retired token as runtime protocol text; rewrites to constructed
// strings are follow-up. Brand scan still guards the rest of the tree.
const PAIRING_COMPAT_ALLOWLIST = new Set([
  'apps/desktop/src-tauri/src/commands/runtime_environments.rs',
  'apps/desktop/src/tauri-deep-link-api.test.ts',
  'apps/desktop/src/tauri-deep-link-contract.ts',
  'apps/desktop/src/tauri-deep-link-pairing.ts',
  'apps/mobile/src/transport/pairing.test.ts',
  'apps/mobile/src/transport/pairing.ts',
  'packages/product-core/cli/runtime/client.ts',
  'packages/product-core/renderer/src/web/web-pairing.test.ts',
  'packages/product-core/renderer/src/web/web-pairing.ts',
  'packages/product-core/shared/pairing.test.ts',
  'packages/product-core/shared/pairing.ts',
  'packages/product-core/shared/runtime-environment-store.ts',
  'runtime/go/internal/runtimecore/ephemeral_vm_lifecycle.go',
  'runtime/go/internal/runtimecore/ephemeral_vm_lifecycle_test.go'
])

function shouldSkipLegacyBrandScan(file) {
  // Why: agent work logs / archive tasks intentionally record upstream issue
  // titles and paths with the retired product name. They are not product
  // runtime surfaces; scanning them blocks every PR while history is retained.
  if (file.startsWith('.trellis/') || file.startsWith('artifacts/')) {
    return true
  }
  // Why: the scanner itself and its tests must mention the retired token.
  if (file.includes('legacy-brand-identifier-scan')) {
    return true
  }
  // Why: retired-identity / product-origin specs document the rename.
  if (file.includes('retired-product-identity') || file.includes('product-origin')) {
    return true
  }
  if (PAIRING_COMPAT_ALLOWLIST.has(file)) {
    return true
  }
  return false
}

export async function scanLegacyBrandIdentifiers(repoRoot, trackedFiles) {
  const failures = []
  for (const file of trackedFiles) {
    if (shouldSkipLegacyBrandScan(file)) {
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
