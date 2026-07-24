import path from 'node:path'

const PEBBLE_GO_MODULE_PATH = 'module github.com/nebutra/pebble/runtime/go'

export function hasPebbleGoModulePath(source) {
  return (
    source.startsWith(`${PEBBLE_GO_MODULE_PATH}\n`) ||
    source.startsWith(`${PEBBLE_GO_MODULE_PATH}\r\n`)
  )
}

export function repositoryRelativePosixPath(repoRoot, filePath, pathImplementation = path) {
  return pathImplementation.relative(repoRoot, filePath).split(pathImplementation.sep).join('/')
}
