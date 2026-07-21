import fs from 'node:fs'
import ts from 'typescript'

const EXPECTED_FALLBACK_NAMESPACES = new Set([])

const apiTypePath = 'packages/product-core/shared/preload-api-types.ts'
const tauriSourcePath = 'apps/desktop/src'

const apiNamespaces = readTypeMembers(apiTypePath, 'PreloadApi')
const tauriNamespaces = new Set(
  [
    ...readTauriSource(tauriSourcePath).matchAll(/(?:window\.)?api\.([A-Za-z][A-Za-z0-9]*)\s*=/g)
  ].map((match) => match[1])
)
const fallback = apiNamespaces.filter((namespace) => !tauriNamespaces.has(namespace))
const unexpected = fallback.filter((namespace) => !EXPECTED_FALLBACK_NAMESPACES.has(namespace))
const migratedButAllowlisted = [...EXPECTED_FALLBACK_NAMESPACES].filter(
  (namespace) => !fallback.includes(namespace)
)

if (apiNamespaces.length === 0 || unexpected.length > 0 || migratedButAllowlisted.length > 0) {
  console.error('Tauri preload coverage verification failed.')
  if (apiNamespaces.length === 0) {
    console.error(`Preload API schema has no namespaces: ${apiTypePath}`)
  }
  if (unexpected.length > 0)
    console.error(`Unexpected fallback namespaces: ${unexpected.join(', ')}`)
  if (migratedButAllowlisted.length > 0) {
    console.error(
      `Remove migrated namespaces from the fallback allowlist: ${migratedButAllowlisted.join(', ')}`
    )
  }
  process.exit(1)
}

console.log(
  `Tauri preload coverage verified: ${tauriNamespaces.size}/${apiNamespaces.length} native namespaces; ${fallback.length} tracked migrations remain.`
)

function readTypeMembers(filePath, typeName) {
  const source = parseTypeScript(filePath)
  const members = []
  walk(source, (node) => {
    if (
      (ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) &&
      node.name.text === typeName
    ) {
      const declaration = ts.isTypeAliasDeclaration(node) ? node.type : node
      for (const member of declaration.members ?? []) {
        if (member.name) members.push(propertyName(member.name, source))
      }
    }
  })
  return members
}

function readTauriSource(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter(
      (entry) => entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')
    )
    .map((entry) => fs.readFileSync(`${dir}/${entry.name}`, 'utf8'))
    .join('\n')
}

function parseTypeScript(filePath) {
  return ts.createSourceFile(
    filePath,
    fs.readFileSync(filePath, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  )
}

function propertyName(node, source) {
  return node.getText(source).replace(/^['"]|['"]$/g, '')
}

function walk(node, visit) {
  visit(node)
  ts.forEachChild(node, (child) => walk(child, visit))
}
