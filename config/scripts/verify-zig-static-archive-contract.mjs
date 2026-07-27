import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export function verifyZigStaticArchiveContract(source) {
  if (
    !source.includes('target.result.os.tag == .linux') ||
    !source.includes('static_lib.bundle_compiler_rt = true')
  ) {
    throw new Error('Linux Zig static archives must bundle compiler-rt for the Cargo linker.')
  }
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  const repoRoot = resolve(import.meta.dirname, '../..')
  verifyZigStaticArchiveContract(
    readFileSync(resolve(repoRoot, 'native/zig-system/build.zig'), 'utf8')
  )
  console.log('Zig static archive contract verified.')
}
