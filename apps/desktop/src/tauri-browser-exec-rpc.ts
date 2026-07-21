import { parseShellArguments } from '../../../packages/product-core/shared/shell-argument-parser'
import { executeTauriBrowserDiff, rememberTauriBrowserSnapshot } from './tauri-browser-diff'
import {
  buildReactInspectionExpression,
  TAURI_REACT_HOOK_SCRIPT
} from './tauri-browser-react-inspection'

type Dispatch = (method: string, params: Record<string, unknown>) => Promise<unknown>
const browserTracePaths = new Map<string, string>()

export async function executeTauriBrowserCommand(
  params: unknown,
  dispatch: Dispatch,
  depth = 0
): Promise<unknown> {
  if (depth > 8) {
    throw new Error('Browser batch nesting exceeds the safety limit.')
  }
  const input = readObject(params)
  const command = readRequired(input.command, 'browser exec command')
  const args = parseShellArguments(command)
  if (args[0] === 'agent-browser') {
    args.shift()
  }
  if (
    args.some(
      (arg) =>
        arg === '--session' ||
        arg === '--cdp' ||
        arg.startsWith('--session=') ||
        arg.startsWith('--cdp=')
    )
  ) {
    throw new Error('Browser exec cannot override the Pebble browser target.')
  }
  const target = {
    page: readRequired(input.page ?? input.browserPageId ?? input.tabId, 'browser page id'),
    ...(typeof input.worktree === 'string' ? { worktree: input.worktree } : {})
  }
  const [name, ...rest] = args
  const call = (method: string, payload: Record<string, unknown> = {}) =>
    dispatch(method, { ...target, ...payload })

  if (name === 'batch') {
    const bail = rest.includes('--bail')
    const commands = rest.filter((entry) => entry !== '--bail')
    const results: { command: string; result?: unknown; error?: string }[] = []
    for (const nestedCommand of commands) {
      try {
        results.push({
          command: nestedCommand,
          result: await executeTauriBrowserCommand(
            { command: nestedCommand, page: target.page, worktree: target.worktree },
            dispatch,
            depth + 1
          )
        })
      } catch (error) {
        results.push({
          command: nestedCommand,
          error: error instanceof Error ? error.message : String(error)
        })
        if (bail) {
          break
        }
      }
    }
    return results
  }

  if (name === 'snapshot') {
    const result = await call('browser.snapshot', parseSnapshotArguments(rest))
    rememberTauriBrowserSnapshot(target.page, result)
    return result
  }
  if (name === 'diff') {
    return executeTauriBrowserDiff(target.page, rest, call)
  }
  if (['back', 'forward', 'reload'].includes(name)) {
    return call(`browser.${name}`)
  }
  if (name === 'pdf') {
    return captureToOptionalPath('browser.pdf', rest[0], call)
  }
  if (name === 'open' && (rest.includes('--init-script') || rest.includes('--enable'))) {
    return openBrowserWithInitScripts(rest, call)
  }
  if (name === 'goto' || name === 'open' || name === 'navigate') {
    return call('browser.goto', { url: requiredAt(rest, 0, 'URL') })
  }
  if (name === 'screenshot') {
    return captureScreenshot(rest, call)
  }
  if (
    ['click', 'dblclick', 'focus', 'clear', 'hover', 'selectall', 'scrollintoview'].includes(name)
  ) {
    const method =
      name === 'selectall' ? 'selectAll' : name === 'scrollintoview' ? 'scrollIntoView' : name
    return call(`browser.${method}`, {
      element: requiredAt(rest, 0, 'element ref')
    })
  }
  if (name === 'fill') {
    return call('browser.fill', {
      element: requiredAt(rest, 0, 'element ref'),
      value: requiredAt(rest, 1, 'value', true)
    })
  }
  if (name === 'type') {
    return call('browser.type', {
      element: requiredAt(rest, 0, 'element ref'),
      input: requiredAt(rest, 1, 'text', true)
    })
  }
  if (name === 'keypress' || name === 'press' || name === 'key') {
    return call('browser.keypress', { key: requiredAt(rest, 0, 'key') })
  }
  if (name === 'keydown' || name === 'keyup') {
    return call(name === 'keydown' ? 'browser.keyDown' : 'browser.keyUp', {
      key: requiredAt(rest, 0, 'key')
    })
  }
  if (name === 'select') {
    return call('browser.select', {
      element: requiredAt(rest, 0, 'element ref'),
      values: [requiredAt(rest, 1, 'value', true), ...rest.slice(2)]
    })
  }
  if (name === 'check' || name === 'uncheck') {
    return call('browser.check', {
      element: requiredAt(rest, 0, 'element ref'),
      checked: name === 'check'
    })
  }
  if (name === 'drag') {
    return call('browser.drag', {
      from: requiredAt(rest, 0, 'source ref'),
      to: requiredAt(rest, 1, 'target ref')
    })
  }
  if (name === 'scroll') {
    return call('browser.scroll', {
      direction: requiredAt(rest, 0, 'direction'),
      amount: readNumber(rest[1], 500)
    })
  }
  if (name === 'scrollinto') {
    return call('browser.scrollIntoView', {
      element: requiredAt(rest, 0, 'element ref')
    })
  }
  if (name === 'highlight') {
    return call('browser.highlight', {
      selector: requiredAt(rest, 0, 'selector')
    })
  }
  if (name === 'get') {
    const what = requiredAt(rest, 0, 'property')
    return call('browser.get', {
      what,
      ...(what === 'attr'
        ? {
            selector: requiredAt(rest, 1, 'element selector'),
            attribute: requiredAt(rest, 2, 'attribute name')
          }
        : { selector: rest[1] })
    })
  }
  if (name === 'is') {
    return call('browser.is', {
      what: requiredAt(rest, 0, 'state'),
      selector: requiredAt(rest, 1, 'element ref')
    })
  }
  if (name === 'mouse') {
    return dispatchMouse(rest, call)
  }
  if (name === 'storage') {
    return dispatchStorage(rest, call)
  }
  if (name === 'clipboard') {
    return dispatchClipboard(rest, call)
  }
  if (name === 'cookies') {
    return dispatchCookies(rest, call)
  }
  if (name === 'dialog') {
    const action = requiredAt(rest, 0, 'dialog action')
    if (action === 'accept') {
      return call('browser.dialogAccept', rest[1] === undefined ? {} : { text: rest[1] })
    }
    if (action === 'dismiss') {
      return call('browser.dialogDismiss')
    }
    throw new Error(`Unsupported browser dialog action: ${action}`)
  }
  if (name === 'tab') {
    return dispatchTab(rest, call)
  }
  if (name === 'session') {
    return rest[0] === 'list'
      ? call('browser.tabList')
      : { session: target.worktree ?? 'pebble', page: target.page }
  }
  if (name === 'close') {
    return call('browser.tabClose')
  }
  if (name === 'inspect') {
    return call('browser.inspect')
  }
  if (name === 'pushstate') {
    return call('browser.pushState', { url: requiredAt(rest, 0, 'SPA URL') })
  }
  if (name === 'set' && ['geo', 'geolocation'].includes(rest[0])) {
    return call('browser.geolocation', {
      latitude: readNumber(requiredAt(rest, 1, 'latitude')),
      longitude: readNumber(requiredAt(rest, 2, 'longitude')),
      ...(rest[3] === undefined ? {} : { accuracy: readNumber(rest[3]) })
    })
  }
  if (name === 'keyboard') {
    if (rest[0] === 'type') {
      return call('browser.type', { input: requiredAt(rest, 1, 'text', true) })
    }
    if (rest[0] === 'inserttext') {
      return call('browser.keyboardInsertText', {
        text: requiredAt(rest, 1, 'text', true)
      })
    }
    throw new Error(`Unsupported browser keyboard action: ${rest[0] ?? '(empty)'}`)
  }
  if (name === 'eval') {
    return call('browser.eval', {
      expression: requiredAt(rest, 0, 'expression', true)
    })
  }
  if (name === 'vitals') {
    return collectBrowserVitals(rest, call)
  }
  if (name === 'react') {
    return runReactInspection(rest, call)
  }
  if (name === 'profiler' || name === 'trace') {
    return runBrowserProfiler(name, target.page, rest, call)
  }
  if (name === 'record') {
    return runBrowserVideoRecording(target.page, target.worktree, rest, call)
  }
  if (name === 'addinitscript') {
    return call('browser.initScriptAdd', {
      script: requiredAt(rest, 0, 'init script JavaScript', true)
    })
  }
  if (name === 'removeinitscript') {
    return call('browser.initScriptRemove', {
      identifier: requiredAt(rest, 0, 'init script identifier')
    })
  }
  if (name === 'upload') {
    return call('browser.upload', {
      element: requiredAt(rest, 0, 'element ref'),
      files: [requiredAt(rest, 1, 'upload file'), ...rest.slice(2)]
    })
  }
  if (name === 'download') {
    return call('browser.download', {
      selector: requiredAt(rest, 0, 'element ref'),
      path: requiredAt(rest, 1, 'download path')
    })
  }
  if (name === 'find') {
    return call('browser.find', parseFindArguments(rest))
  }
  if (name === 'wait') {
    return call('browser.wait', parseWaitArguments(rest))
  }
  if (name === 'viewport') {
    return call('browser.viewport', {
      width: readNumber(requiredAt(rest, 0, 'viewport width')),
      height: readNumber(requiredAt(rest, 1, 'viewport height'))
    })
  }
  if (name === 'console') {
    return call('browser.console', captureArguments(rest))
  }
  if (name === 'errors') {
    return call('browser.console', {
      ...captureArguments(rest),
      errorsOnly: true
    })
  }
  if (name === 'network') {
    return dispatchNetwork(rest, call)
  }
  if (name === 'set') {
    return dispatchSet(rest, call)
  }
  throw new Error(`Browser exec command is not migrated to Tauri: ${name ?? '(empty)'}`)
}

async function runBrowserVideoRecording(
  _page: string,
  worktree: string | undefined,
  args: string[],
  call: (method: string, payload?: Record<string, unknown>) => Promise<unknown>
): Promise<unknown> {
  const action = requiredAt(args, 0, 'record action')
  if (action === 'stop') {
    return call('browser.recordingStop')
  }
  if (action !== 'start' && action !== 'restart') {
    throw new Error(`Unsupported browser record action: ${action}`)
  }
  const path = requiredAt(args, 1, 'recording path')
  if (!/\.(webm|mp4)$/i.test(path)) {
    throw new Error('Browser recording path must use .webm or .mp4.')
  }
  if (action === 'restart') {
    await call('browser.recordingStop')
  }
  const url = args[2]
  if (url) {
    await call('browser.goto', {
      url: url.includes('://') ? url : `https://${url}`
    })
  }
  return call('browser.recordingStart', {
    path,
    ...(worktree ? { outputWorktree: worktree } : {})
  })
}

async function openBrowserWithInitScripts(
  args: string[],
  call: (method: string, payload?: Record<string, unknown>) => Promise<unknown>
): Promise<unknown> {
  const paths: string[] = []
  const features: string[] = []
  let url: string | undefined
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--init-script') {
      paths.push(requiredAt(args, ++index, 'init script path'))
    } else if (args[index] === '--enable') {
      features.push(...requiredAt(args, ++index, 'browser feature').split(','))
    } else if (!url) {
      url = args[index]
    }
  }
  for (const feature of features) {
    if (feature !== 'react-devtools') {
      throw new Error(`Unsupported browser feature: ${feature}`)
    }
    await call('browser.initScriptAdd', { script: TAURI_REACT_HOOK_SCRIPT })
  }
  for (const path of paths) {
    const file = readObject(await call('files.read', { relativePath: path }))
    const script = typeof file.content === 'string' ? file.content : ''
    if (!script) {
      throw new Error(`Browser init script is empty: ${path}`)
    }
    await call('browser.initScriptAdd', { script })
  }
  return url ? call('browser.goto', { url }) : { registered: paths.length }
}

async function runReactInspection(
  args: string[],
  call: (method: string, payload?: Record<string, unknown>) => Promise<unknown>
): Promise<unknown> {
  const action = requiredAt(args, 0, 'React action')
  const evaluated = readObject(
    await call('browser.eval', {
      expression: buildReactInspectionExpression(action, args.slice(1))
    })
  )
  const value = typeof evaluated.result === 'string' ? evaluated.result : ''
  return JSON.parse(value) as unknown
}

async function runBrowserProfiler(
  mode: 'profiler' | 'trace',
  pageId: string,
  rest: string[],
  call: (method: string, payload?: Record<string, unknown>) => Promise<unknown>
): Promise<unknown> {
  const operation = requiredAt(rest, 0, 'profiler operation')
  if (operation === 'start') {
    if (mode === 'trace' && rest[1]) {
      browserTracePaths.set(pageId, rest[1])
    }
    return call('browser.profilerStart')
  }
  if (operation !== 'stop') {
    throw new Error(`Unsupported browser profiler action: ${operation}`)
  }
  const result = readObject(await call('browser.profilerStop'))
  const path = rest[1] ?? (mode === 'trace' ? browserTracePaths.get(pageId) : undefined)
  if (mode === 'trace') {
    browserTracePaths.delete(pageId)
  }
  if (!path) {
    return result
  }
  const saved = await call('browser.harSave', {
    path,
    har: readObject(result.profile)
  })
  return { ...result, ...readObject(saved) }
}

const BROWSER_VITALS_EXPRESSION = String.raw`JSON.stringify((()=>{
  const entries=(type)=>{try{return performance.getEntriesByType(type)}catch{return []}};
  const navigation=entries('navigation')[0];
  const paints=entries('paint');
  const lcp=entries('largest-contentful-paint').at(-1);
  const shifts=entries('layout-shift').filter((entry)=>!entry.hadRecentInput);
  const events=entries('event');
  const fcp=paints.find((entry)=>entry.name==='first-contentful-paint');
  const cls=shifts.reduce((sum,entry)=>sum+(Number(entry.value)||0),0);
  const inp=events.reduce((maximum,entry)=>Math.max(maximum,Number(entry.duration)||0),0);
  const root=document.querySelector('#root,#__next,[data-reactroot]');
  return {url:location.href,lcp:lcp?Math.round(lcp.startTime):null,
    cls:Number(cls.toFixed(4)),ttfb:navigation?Math.round(navigation.responseStart):null,
    fcp:fcp?Math.round(fcp.startTime):null,inp:inp>0?Math.round(inp):null,
    hydration:{detected:Boolean(root),readyState:document.readyState}};
})())`

async function collectBrowserVitals(
  rest: string[],
  call: (method: string, payload?: Record<string, unknown>) => Promise<unknown>
): Promise<unknown> {
  const url = rest.find((value) => !value.startsWith('-'))
  if (url) {
    await call('browser.goto', { url })
    await call('browser.wait', { load: 'load', timeout: 30_000 })
  }
  const evaluated = readObject(
    await call('browser.eval', { expression: BROWSER_VITALS_EXPRESSION })
  )
  const raw = typeof evaluated.result === 'string' ? evaluated.result : null
  if (!raw) {
    throw new Error('Browser vitals evaluation returned no result.')
  }
  try {
    return JSON.parse(raw) as unknown
  } catch {
    throw new Error('Browser vitals evaluation returned invalid JSON.')
  }
}

function dispatchSet(
  rest: string[],
  call: (method: string, payload?: Record<string, unknown>) => Promise<unknown>
) {
  const setting = requiredAt(rest, 0, 'set target')
  if (setting === 'viewport') {
    return call('browser.viewport', {
      width: readNumber(requiredAt(rest, 1, 'viewport width')),
      height: readNumber(requiredAt(rest, 2, 'viewport height'))
    })
  }
  if (setting === 'device') {
    return call('browser.setDevice', { name: requiredAt(rest, 1, 'device') })
  }
  if (setting === 'offline') {
    return call('browser.setOffline', { state: rest[1] ?? 'on' })
  }
  if (setting === 'headers') {
    return call('browser.setHeaders', {
      headers: requiredAt(rest, 1, 'headers JSON', true)
    })
  }
  if (setting === 'credentials') {
    return call('browser.setCredentials', {
      user: requiredAt(rest, 1, 'credential user'),
      pass: requiredAt(rest, 2, 'credential password', true)
    })
  }
  if (setting === 'media') {
    const options = parseNamedArguments(rest.slice(1))
    const positional = rest
      .slice(1)
      .filter((value) => !value.startsWith('--') && !isNamedArgumentValue(rest.slice(1), value))
    return call('browser.setMedia', {
      ...((options['color-scheme'] ?? positional[0])
        ? { colorScheme: options['color-scheme'] ?? positional[0] }
        : {}),
      ...((options['reduced-motion'] ?? positional[1])
        ? {
            reducedMotion:
              (options['reduced-motion'] ?? positional[1]) === 'reduced-motion'
                ? 'reduce'
                : (options['reduced-motion'] ?? positional[1])
          }
        : {})
    })
  }
  throw new Error(`Unsupported browser set target: ${setting}`)
}

async function captureToOptionalPath(
  method: string,
  path: string | undefined,
  call: (method: string, payload?: Record<string, unknown>) => Promise<unknown>,
  payload: Record<string, unknown> = {}
): Promise<unknown> {
  const capture = await call(method, payload)
  return path === undefined ? capture : call('browser.captureSave', { path, capture })
}

function captureScreenshot(
  rest: string[],
  call: (method: string, payload?: Record<string, unknown>) => Promise<unknown>
): Promise<unknown> {
  const options = parseNamedArguments(rest)
  const path = rest.find((value) => !value.startsWith('-') && !isNamedArgumentValue(rest, value))
  const requestedFormat = options['screenshot-format'] ?? options.format
  const inferredFormat = path && /\.jpe?g$/i.test(path) ? 'jpeg' : undefined
  const format = requestedFormat ?? inferredFormat
  if (format !== undefined && !['png', 'jpeg', 'jpg'].includes(format.toLowerCase())) {
    throw new Error(`Unsupported browser screenshot format: ${format}`)
  }
  return captureToOptionalPath(
    rest.includes('--full') ? 'browser.fullScreenshot' : 'browser.screenshot',
    path,
    call,
    format === undefined
      ? {}
      : {
          format: format.toLowerCase() === 'jpg' ? 'jpeg' : format.toLowerCase()
        }
  )
}

async function dispatchTab(
  rest: string[],
  call: (method: string, payload?: Record<string, unknown>) => Promise<unknown>
): Promise<unknown> {
  const action = rest[0] ?? 'list'
  if (action === 'list') {
    return call('browser.tabList')
  }
  if (action === 'new') {
    return call('browser.tabCreate', rest[1] === undefined ? {} : { url: rest[1] })
  }
  if (action === 'close') {
    if (rest[1] === undefined) {
      return call('browser.tabClose')
    }
    const selected = readBrowserPageResult(
      await call('browser.tabSwitch', {
        index: readNonNegativeInteger(rest[1], 'tab index')
      })
    )
    return call('browser.tabClose', { page: selected })
  }
  return call('browser.tabSwitch', {
    index: readNonNegativeInteger(action, 'tab index'),
    focus: true
  })
}

function readBrowserPageResult(value: unknown): string {
  const result = readObject(value)
  return readRequired(result.browserPageId, 'browser page id')
}

function parseWaitArguments(rest: string[]): Record<string, unknown> {
  const options = parseNamedArguments(rest)
  const selector = rest.find(
    (value) => !value.startsWith('--') && !isNamedArgumentValue(rest, value)
  )
  const duration =
    selector !== undefined && /^\d+(?:\.\d+)?$/.test(selector) ? readNumber(selector) : undefined
  return {
    ...(selector && duration === undefined ? { selector } : {}),
    ...(duration === undefined ? {} : { duration }),
    ...copyNamed(options, ['text', 'url', 'load', 'fn', 'state']),
    ...(options.timeout === undefined ? {} : { timeout: readNumber(options.timeout) })
  }
}

function parseSnapshotArguments(rest: string[]): Record<string, unknown> {
  const options = parseNamedArguments(rest)
  const readShortValue = (flag: string): string | undefined => {
    const index = rest.indexOf(flag)
    return index < 0 ? undefined : rest[index + 1]
  }
  const depth = options.depth ?? readShortValue('-d')
  const selector = options.selector ?? readShortValue('-s')
  return {
    ...(rest.includes('-i') || rest.includes('--interactive') ? { interactive: true } : {}),
    ...(rest.includes('-c') || rest.includes('--compact') ? { compact: true } : {}),
    ...(rest.includes('-u') || rest.includes('--include-urls') ? { includeUrls: true } : {}),
    ...(depth === undefined ? {} : { depth: readNonNegativeInteger(depth, 'snapshot depth') }),
    ...(selector === undefined ? {} : { selector })
  }
}

function parseFindArguments(rest: string[]): Record<string, unknown> {
  const locator = requiredAt(rest, 0, 'locator')
  if (locator === 'first' || locator === 'last') {
    return {
      locator: 'css',
      position: locator,
      value: requiredAt(rest, 1, 'selector'),
      action: requiredAt(rest, 2, 'locator action'),
      ...(rest[3] === undefined ? {} : { text: rest[3] })
    }
  }
  if (locator === 'nth') {
    return {
      locator: 'css',
      position: 'nth',
      index: readNonNegativeInteger(requiredAt(rest, 1, 'find index'), 'find index'),
      value: requiredAt(rest, 2, 'selector'),
      action: requiredAt(rest, 3, 'locator action'),
      ...(rest[4] === undefined ? {} : { text: rest[4] })
    }
  }
  return {
    locator,
    value: requiredAt(rest, 1, 'locator value'),
    action: requiredAt(rest, 2, 'locator action'),
    ...(rest[3] === undefined ? {} : { text: rest[3] })
  }
}

function parseNamedArguments(values: string[]): Record<string, string> {
  const result: Record<string, string> = {}
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]
    if (!value?.startsWith('--')) {
      continue
    }
    const equals = value.indexOf('=')
    if (equals > 2) {
      result[value.slice(2, equals)] = value.slice(equals + 1)
      continue
    }
    const next = values[index + 1]
    result[value.slice(2)] = next && !next.startsWith('--') ? next : 'true'
    if (next && !next.startsWith('--')) {
      index += 1
    }
  }
  return result
}

function isNamedArgumentValue(values: string[], value: string): boolean {
  const index = values.indexOf(value)
  return index > 0 && values[index - 1]?.startsWith('--') === true
}

function copyNamed(values: Record<string, string>, keys: string[]): Record<string, string> {
  return Object.fromEntries(
    keys.flatMap((key) => (values[key] === undefined ? [] : [[key, values[key]]]))
  )
}

function captureArguments(rest: string[]): Record<string, unknown> {
  const options = parseNamedArguments(rest)
  return {
    ...(options.limit === undefined ? {} : { limit: readNumber(options.limit) }),
    ...(options.filter === undefined ? {} : { filter: options.filter }),
    ...(options.type === undefined ? {} : { types: options.type.split(',').filter(Boolean) }),
    ...(options.method === undefined ? {} : { method: options.method }),
    ...(options.status === undefined ? {} : { status: options.status }),
    ...(rest.includes('--clear') ? { clear: true } : {})
  }
}

async function dispatchNetwork(
  rest: string[],
  call: (method: string, payload?: Record<string, unknown>) => Promise<unknown>
): Promise<unknown> {
  const action = requiredAt(rest, 0, 'network action')
  if (action === 'requests') {
    return call('browser.network', captureArguments(rest.slice(1)))
  }
  if (action === 'request') {
    return call('browser.network', {
      requestId: requiredAt(rest, 1, 'network request id')
    })
  }
  if (action === 'har') {
    const operation = requiredAt(rest, 1, 'HAR operation')
    if (operation === 'start') {
      return call('browser.harStart')
    }
    if (operation === 'stop') {
      const result = await call('browser.harStop')
      return rest[2] === undefined
        ? result
        : call('browser.harSave', {
            path: rest[2],
            har: readObject(result).har
          })
    }
    throw new Error('Browser HAR operation must be start or stop.')
  }
  if (action === 'route') {
    const options = parseNamedArguments(rest.slice(2))
    const pattern = requiredAt(rest, 1, 'network route URL')
    const listed = readObject(await call('browser.intercept.list'))
    const existing = readInterceptRoutes(listed)
    const route = rest.includes('--abort')
      ? { pattern, action: 'abort' }
      : {
          pattern,
          action: 'fulfill',
          body: options.body ?? '',
          status: readHttpStatus(options.status),
          contentType: options['content-type'] ?? 'application/json'
        }
    return call('browser.intercept.enable', {
      routes: [...existing.filter((entry) => entry.pattern !== pattern), route]
    })
  }
  if (action === 'unroute') {
    const pattern = rest[1]
    if (pattern === undefined) {
      return call('browser.intercept.disable')
    }
    const existing = readInterceptRoutes(readObject(await call('browser.intercept.list')))
    const remaining = existing.filter((entry) => entry.pattern !== pattern)
    return remaining.length === 0
      ? call('browser.intercept.disable')
      : call('browser.intercept.enable', { routes: remaining })
  }
  throw new Error(`Unsupported browser network action: ${action}`)
}

type BrowserInterceptRoute = {
  pattern: string
  action: 'abort' | 'fulfill'
  body?: string
  status?: number
  contentType?: string
}

function readInterceptRoutes(value: Record<string, unknown>): BrowserInterceptRoute[] {
  if (Array.isArray(value.routes)) {
    return value.routes.flatMap((entry) => {
      const route = readObject(entry)
      return typeof route.pattern === 'string' &&
        (route.action === 'abort' || route.action === 'fulfill')
        ? [route as BrowserInterceptRoute]
        : []
    })
  }
  return readStringArray(value.patterns).map((pattern) => ({
    pattern,
    action: 'abort'
  }))
}

function readHttpStatus(value: string | undefined): number {
  if (value === undefined) {
    return 200
  }
  const status = readNumber(value)
  if (!Number.isInteger(status) || status < 100 || status > 599) {
    throw new Error('Browser route status must be an integer from 100 to 599.')
  }
  return status
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : []
}

function dispatchMouse(
  rest: string[],
  call: (method: string, payload?: Record<string, unknown>) => Promise<unknown>
) {
  const action = requiredAt(rest, 0, 'mouse action')
  if (action === 'move') {
    return call('browser.mouseMove', {
      x: readNumber(requiredAt(rest, 1, 'x')),
      y: readNumber(requiredAt(rest, 2, 'y'))
    })
  }
  if (action === 'down' || action === 'up') {
    return call(`browser.mouse${action === 'down' ? 'Down' : 'Up'}`, {
      button: rest[1] ?? 'left'
    })
  }
  if (action === 'wheel') {
    return call('browser.mouseWheel', {
      dy: readNumber(requiredAt(rest, 1, 'dy')),
      dx: readNumber(rest[2], 0)
    })
  }
  throw new Error(`Unsupported browser mouse action: ${action}`)
}

function dispatchStorage(
  rest: string[],
  call: (method: string, payload?: Record<string, unknown>) => Promise<unknown>
) {
  const scope = requiredAt(rest, 0, 'storage scope')
  if (!['local', 'session'].includes(scope)) {
    throw new Error('Browser storage scope must be local or session.')
  }
  const prefix = `browser.storage.${scope}`
  if (rest[1] === 'clear') {
    return call(`${prefix}.clear`)
  }
  if (rest[1] === 'set') {
    return call(`${prefix}.set`, {
      key: requiredAt(rest, 2, 'key'),
      value: requiredAt(rest, 3, 'value', true)
    })
  }
  return call(`${prefix}.get`, rest[1] === undefined ? {} : { key: rest[1] })
}

function dispatchClipboard(
  rest: string[],
  call: (method: string, payload?: Record<string, unknown>) => Promise<unknown>
) {
  if (rest[0] === 'read') {
    return call('browser.clipboardRead')
  }
  if (rest[0] === 'write') {
    return call('browser.clipboardWrite', {
      text: requiredAt(rest, 1, 'text')
    })
  }
  if (rest[0] === 'copy') {
    return call('browser.clipboardCopy')
  }
  if (rest[0] === 'paste') {
    return call('browser.clipboardPaste')
  }
  throw new Error('Browser clipboard action must be read, write, copy, or paste.')
}

function dispatchCookies(
  rest: string[],
  call: (method: string, payload?: Record<string, unknown>) => Promise<unknown>
) {
  if (rest.length === 0 || rest[0] === 'get') {
    return call('browser.cookie.get', cookieNamedArguments(rest.slice(1)))
  }
  if (rest[0] === 'clear') {
    return call('browser.cookie.clear')
  }
  if (rest[0] === 'set') {
    const options = cookieNamedArguments(rest.slice(3))
    return call('browser.cookie.set', {
      name: requiredAt(rest, 1, 'cookie name'),
      value: requiredAt(rest, 2, 'cookie value', true),
      ...options
    })
  }
  if (rest[0] === 'delete') {
    return call('browser.cookie.delete', {
      name: requiredAt(rest, 1, 'cookie name'),
      ...cookieNamedArguments(rest.slice(2))
    })
  }
  throw new Error(`Unsupported browser cookie action: ${rest[0]}`)
}

function cookieNamedArguments(values: string[]): Record<string, unknown> {
  const options = parseNamedArguments(values)
  return {
    ...copyNamed(options, ['url', 'domain', 'path', 'sameSite']),
    ...(options.expires === undefined ? {} : { expires: readNumber(options.expires) }),
    ...(values.includes('--httpOnly') ? { httpOnly: true } : {}),
    ...(values.includes('--secure') ? { secure: true } : {})
  }
}

function requiredAt(values: string[], index: number, label: string, allowEmpty = false): string {
  const value = values[index]
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    throw new Error(`Missing browser exec ${label}.`)
  }
  return value
}

function readNumber(value: string | undefined, fallback?: number): number {
  if (value === undefined && fallback !== undefined) {
    return fallback
  }
  const result = Number(value)
  if (!Number.isFinite(result)) {
    throw new Error('Browser exec expected a finite number.')
  }
  return result
}

function readNonNegativeInteger(value: string, label: string): number {
  const result = readNumber(value)
  if (!Number.isInteger(result) || result < 0) {
    throw new Error(`Browser exec expected ${label}.`)
  }
  return result
}

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function readRequired(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} is required`)
  }
  return value.trim()
}
