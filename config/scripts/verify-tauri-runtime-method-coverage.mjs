import { readdirSync, readFileSync, statSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { join, relative, resolve } from 'node:path'

import ts from 'typescript'

const scriptDir = import.meta.dirname
const repoRoot = resolve(scriptDir, '../..')
const rendererRoot = join(repoRoot, 'packages/product-core/renderer/src')
const tauriRendererRoot = join(repoRoot, 'apps/desktop/src')

function productionTypeScriptFiles(root) {
  const files = []
  for (const entry of readdirSync(root)) {
    const path = join(root, entry)
    const stats = statSync(path)
    if (stats.isDirectory()) {
      files.push(...productionTypeScriptFiles(path))
      continue
    }
    if (!/\.(?:ts|tsx)$/.test(entry) || /\.(?:test|spec)\.(?:ts|tsx)$/.test(entry)) {
      continue
    }
    files.push(path)
  }
  return files
}

function literalText(node) {
  return ts.isStringLiteralLike(node) ? node.text : null
}

function isCallRuntimeRpc(node) {
  return ts.isIdentifier(node.expression) && node.expression.text === 'callRuntimeRpc'
}

function isWindowRuntimeCall(node) {
  if (!ts.isPropertyAccessExpression(node.expression) || node.expression.name.text !== 'call') {
    return false
  }
  const runtime = node.expression.expression
  if (!ts.isPropertyAccessExpression(runtime) || runtime.name.text !== 'runtime') {
    return false
  }
  const api = runtime.expression
  return (
    ts.isPropertyAccessExpression(api) &&
    api.name.text === 'api' &&
    ts.isIdentifier(api.expression) &&
    api.expression.text === 'window'
  )
}

function objectMethodLiteral(node) {
  if (!node || !ts.isObjectLiteralExpression(node)) {
    return null
  }
  for (const property of node.properties) {
    if (
      ts.isPropertyAssignment(property) &&
      ((ts.isIdentifier(property.name) && property.name.text === 'method') ||
        (ts.isStringLiteralLike(property.name) && property.name.text === 'method'))
    ) {
      return literalText(property.initializer)
    }
  }
  return null
}

function comparedMethodLiteral(node) {
  if (!ts.isBinaryExpression(node)) {
    return null
  }
  if (
    node.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken &&
    node.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsToken &&
    node.operatorToken.kind !== ts.SyntaxKind.ExclamationEqualsEqualsToken &&
    node.operatorToken.kind !== ts.SyntaxKind.ExclamationEqualsToken
  ) {
    return null
  }
  if (ts.isIdentifier(node.left) && node.left.text === 'method') {
    return literalText(node.right)
  }
  if (ts.isIdentifier(node.right) && node.right.text === 'method') {
    return literalText(node.left)
  }
  return null
}

export function collectRendererRuntimeMethods(files) {
  const methods = new Map()
  for (const file of files) {
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    )
    const visit = (node) => {
      if (ts.isCallExpression(node)) {
        const method = isCallRuntimeRpc(node)
          ? literalText(node.arguments[1])
          : isWindowRuntimeCall(node)
            ? objectMethodLiteral(node.arguments[0])
            : null
        if (method) {
          const locations = methods.get(method) ?? []
          const { line } = source.getLineAndCharacterOfPosition(node.getStart(source))
          locations.push(`${relative(repoRoot, file)}:${line + 1}`)
          methods.set(method, locations)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return methods
}

export function collectDispatcherMethods(file) {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  )
  const methods = new Set()
  const visit = (node) => {
    if (ts.isCaseClause(node)) {
      const method = literalText(node.expression)
      if (method) {
        methods.add(method)
      }
    }
    const comparedMethod = comparedMethodLiteral(node)
    if (comparedMethod) {
      methods.add(comparedMethod)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return methods
}

export function findMissingRuntimeMethods(rendererMethods, dispatcherMethods) {
  return [...rendererMethods.keys()]
    .filter((method) => !isRemoteOnlyRendererMethod(method))
    .filter((method) => !dispatcherMethods.has(method))
    .sort()
}

function isRemoteOnlyRendererMethod(method) {
  // Jira/Linear adapters call their dedicated preload API locally and use
  // runtime RPC only when the selected owner is a paired environment.
  if (method.startsWith('jira.') || method.startsWith('linear.')) {
    return true
  }
  return new Set([
    'nativeChat.readSession',
    'terminal.restoreFit',
    'workspacePorts.kill',
    'workspacePorts.scan'
  ]).has(method)
}

export function verifyRuntimeMethodCoverage({ rendererFiles, dispatcherFiles }) {
  const rendererMethods = collectRendererRuntimeMethods(rendererFiles)
  const dispatcherMethods = new Set(
    dispatcherFiles.flatMap((file) => [...collectDispatcherMethods(file)])
  )
  const missing = findMissingRuntimeMethods(rendererMethods, dispatcherMethods)
  return { dispatcherMethods, missing, rendererMethods }
}

function run() {
  const result = verifyRuntimeMethodCoverage({
    // Domain dispatchers intentionally live beside their bridge implementations.
    // Scanning production Tauri sources keeps that decomposition visible to the gate.
    dispatcherFiles: productionTypeScriptFiles(tauriRendererRoot),
    rendererFiles: productionTypeScriptFiles(rendererRoot)
  })
  if (result.missing.length > 0) {
    const details = result.missing.flatMap((method) => [
      `- ${method}`,
      ...(result.rendererMethods.get(method) ?? []).map((location) => `    ${location}`)
    ])
    throw new Error(`Tauri runtime dispatcher is missing renderer methods:\n${details.join('\n')}`)
  }
  console.log(
    `Tauri runtime method coverage verified: ${result.rendererMethods.size} renderer methods mapped.`
  )
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  run()
}
