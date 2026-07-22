import { rmSync } from 'node:fs'
import { resolve } from 'node:path'

const generatedPaths = [
  'dist',
  'out',
  'test-results',
  'playwright-report',
  'artifacts/tauri-pixel-performance',
  'apps/desktop/dist',
  'apps/desktop/src-tauri/binaries',
  'apps/desktop/src-tauri/staged-macos-libraries',
  'apps/desktop/src-tauri/target/debug',
  'apps/desktop/src-tauri/target/x86_64-pc-windows-gnu',
  'apps/desktop/src-tauri/target/x86_64-pc-windows-msvc',
  'runtime/go/pebble-runtime',
  'native/rust-host/target',
  'native/computer-use-linux/__pycache__',
  'native/zig-system/.zig-cache',
  'native/zig-system/zig-out',
  'native/computer-use-linux/.build',
  'native/computer-use-macos/.build',
  'native/computer-use-windows/.build'
]

export function cleanPebbleGeneratedArtifacts(repoRoot, { includeRelease = false } = {}) {
  const paths = includeRelease
    ? [
        ...generatedPaths.filter((path) => !path.includes('src-tauri/target/')),
        'apps/desktop/src-tauri/target'
      ]
    : generatedPaths
  for (const path of paths) {
    rmSync(resolve(repoRoot, path), { force: true, recursive: true })
  }
  return paths
}

if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) {
  const repoRoot = resolve(import.meta.dirname, '../..')
  const includeRelease = process.argv.includes('--include-release')
  const removed = cleanPebbleGeneratedArtifacts(repoRoot, { includeRelease })
  console.log(
    `Removed ${removed.length} generated artifact locations${includeRelease ? ', including release bundles' : '; preserved release bundles'}.`
  )
}
