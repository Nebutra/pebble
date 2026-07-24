import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  hasPebbleGoModulePath,
  repositoryRelativePosixPath
} from './repository-verifier-portability.mjs'

describe('repository verifier portability', () => {
  it('accepts the Pebble Go module path with LF or CRLF line endings', () => {
    expect(hasPebbleGoModulePath('module github.com/nebutra/pebble/runtime/go\n\ngo 1.25\n')).toBe(
      true
    )
    expect(
      hasPebbleGoModulePath('module github.com/nebutra/pebble/runtime/go\r\n\r\ngo 1.25\r\n')
    ).toBe(true)
    expect(hasPebbleGoModulePath('module example.com/other\r\n')).toBe(false)
    expect(hasPebbleGoModulePath('module github.com/nebutra/pebble/runtime/go')).toBe(false)
  })

  it('normalizes repository-relative paths on POSIX and Windows', () => {
    expect(
      repositoryRelativePosixPath(
        '/workspace/pebble',
        '/workspace/pebble/apps/desktop/src/main.tsx',
        path.posix
      )
    ).toBe('apps/desktop/src/main.tsx')
    expect(
      repositoryRelativePosixPath(
        'C:\\workspace\\pebble',
        'C:\\workspace\\pebble\\runtime\\go\\internal\\runtimehttp\\terminal.go',
        path.win32
      )
    ).toBe('runtime/go/internal/runtimehttp/terminal.go')
  })
})
