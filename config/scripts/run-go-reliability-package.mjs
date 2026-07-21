import { existsSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'

const repoRoot = resolve(import.meta.dirname, '../..')
const [packagePath, ...evidencePaths] = process.argv.slice(2)

if (!packagePath || evidencePaths.length === 0) {
  fail('usage: run-go-reliability-package.mjs <package-dir> <evidence-test.go> [...]')
}

const packageDir = resolveInsideRepo(packagePath, 'package directory')
const moduleRoot = findGoModule(packageDir)
const packageFromModule = relative(moduleRoot, packageDir).split(sep).join('/')

for (const evidencePath of evidencePaths) {
  const evidenceFile = resolveInsideRepo(evidencePath, 'evidence file')
  const fromPackage = relative(packageDir, evidenceFile)
  if (
    !evidenceFile.endsWith('_test.go') ||
    fromPackage === '' ||
    fromPackage.startsWith(`..${sep}`) ||
    isAbsolute(fromPackage) ||
    !existsSync(evidenceFile)
  ) {
    fail(`Go reliability evidence must be an existing _test.go file in ${packagePath}: ${evidencePath}`)
  }
}

const result = spawnSync('go', ['test', `./${packageFromModule}`], {
  cwd: moduleRoot,
  encoding: 'utf8',
  stdio: 'inherit'
})
if (result.error) {
  fail(`could not run Go reliability package: ${result.error.message}`)
}
process.exit(result.status ?? 1)

function resolveInsideRepo(path, label) {
  const absolute = resolve(repoRoot, path)
  const fromRoot = relative(repoRoot, absolute)
  if (fromRoot === '' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    fail(`${label} must stay inside the Pebble repository: ${path}`)
  }
  return absolute
}

function findGoModule(start) {
  let current = start
  while (true) {
    if (existsSync(resolve(current, 'go.mod'))) {
      return current
    }
    const parent = dirname(current)
    if (parent === current || relative(repoRoot, parent).startsWith(`..${sep}`)) {
      fail(`could not find go.mod above ${start}`)
    }
    current = parent
  }
}

function fail(message) {
  console.error(message)
  process.exit(1)
}
