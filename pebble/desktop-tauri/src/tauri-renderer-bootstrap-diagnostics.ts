type TauriRendererBootstrapFailure = {
  stage: string
  name: string
  message: string
  stack?: string
}

type TauriRendererBootstrapWindow = Window & {
  __pebbleTauriBootstrapFailure?: TauriRendererBootstrapFailure
}

let bootstrapDiagnosticsInstalled = false
let bootstrapComplete = false
let currentBootstrapStage = 'renderer-bootstrap'

export function installTauriRendererBootstrapDiagnostics(): void {
  if (bootstrapDiagnosticsInstalled || typeof window === 'undefined') {
    return
  }

  bootstrapDiagnosticsInstalled = true
  bootstrapComplete = false
  window.addEventListener('error', handleBootstrapError)
  window.addEventListener('unhandledrejection', handleBootstrapUnhandledRejection)
}

export function markTauriRendererBootstrapComplete(): void {
  bootstrapComplete = true
}

export function setTauriRendererBootstrapStage(stage: string): void {
  currentBootstrapStage = stage
}

export function runTauriRendererBootstrapStage(stage: string, action: () => void): boolean {
  setTauriRendererBootstrapStage(stage)
  try {
    action()
    return true
  } catch (error) {
    renderTauriRendererBootstrapFailure(stage, error)
    return false
  }
}

export function renderTauriRendererBootstrapFailure(stage: string, error: unknown): void {
  if (typeof document === 'undefined') {
    return
  }

  const failure = describeBootstrapFailure(stage, error)
  ;(window as TauriRendererBootstrapWindow).__pebbleTauriBootstrapFailure = failure
  console.error('[pebble:tauri-bootstrap]', failure)

  const rootElement = document.getElementById('root') ?? document.body
  rootElement.replaceChildren(createBootstrapFailureElement(failure))
}

export function _resetTauriRendererBootstrapDiagnosticsForTests(): void {
  if (typeof window !== 'undefined' && bootstrapDiagnosticsInstalled) {
    window.removeEventListener('error', handleBootstrapError)
    window.removeEventListener('unhandledrejection', handleBootstrapUnhandledRejection)
  }
  bootstrapDiagnosticsInstalled = false
  bootstrapComplete = false
  currentBootstrapStage = 'renderer-bootstrap'
}

function handleBootstrapError(event: ErrorEvent): void {
  if (bootstrapComplete) {
    return
  }
  renderTauriRendererBootstrapFailure(currentBootstrapStage, event.error ?? event.message)
}

function handleBootstrapUnhandledRejection(event: PromiseRejectionEvent): void {
  if (bootstrapComplete) {
    return
  }
  renderTauriRendererBootstrapFailure(currentBootstrapStage, event.reason)
}

function createBootstrapFailureElement(failure: TauriRendererBootstrapFailure): HTMLElement {
  const shell = document.createElement('section')
  shell.setAttribute('role', 'alert')
  shell.setAttribute('data-pebble-tauri-bootstrap-failure', failure.stage)
  shell.style.cssText = [
    'min-height:100vh',
    'box-sizing:border-box',
    'display:grid',
    'place-items:center',
    'padding:32px',
    'background:var(--background,#f8f7f4)',
    'color:var(--foreground,#1d1c19)',
    'font-family:var(--font-sans,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif)'
  ].join(';')

  const panel = document.createElement('div')
  panel.style.cssText = [
    'width:min(720px,100%)',
    'box-sizing:border-box',
    'border:1px solid var(--border,#dedbd2)',
    'border-radius:12px',
    'background:var(--card,#fff)',
    'padding:24px',
    'box-shadow:var(--shadow-lg,0 20px 60px rgba(0,0,0,.12))'
  ].join(';')

  const title = document.createElement('h1')
  title.textContent = 'Pebble could not finish starting.'
  title.style.cssText = 'margin:0 0 12px;font-size:20px;line-height:1.3;font-weight:650'

  const summary = document.createElement('p')
  summary.textContent = `${failure.stage}: ${failure.name}: ${failure.message}`
  summary.style.cssText = 'margin:0 0 16px;font-size:13px;line-height:1.6;color:var(--muted-foreground,#6f6a60)'

  const details = document.createElement('pre')
  details.textContent = failure.stack ?? failure.message
  details.style.cssText = [
    'margin:0',
    'max-height:360px',
    'overflow:auto',
    'white-space:pre-wrap',
    'word-break:break-word',
    'border-radius:8px',
    'background:var(--muted,#f0eee8)',
    'padding:14px',
    'font-size:12px',
    'line-height:1.5'
  ].join(';')

  panel.append(title, summary, details)
  shell.append(panel)
  return shell
}

function describeBootstrapFailure(stage: string, error: unknown): TauriRendererBootstrapFailure {
  if (error instanceof Error) {
    return {
      stage,
      name: error.name || 'Error',
      message: error.message || '[empty error message]',
      ...(typeof error.stack === 'string' ? { stack: error.stack } : {})
    }
  }

  return {
    stage,
    name: describeUnknownErrorName(error),
    message: stringifyUnknownError(error)
  }
}

function describeUnknownErrorName(error: unknown): string {
  if (error === null) {
    return 'null'
  }
  if (error === undefined) {
    return 'undefined'
  }
  if (typeof error === 'object' || typeof error === 'function') {
    return error.constructor?.name ?? typeof error
  }
  return typeof error
}

function stringifyUnknownError(error: unknown): string {
  try {
    return String(error)
  } catch {
    return '[unstringifiable]'
  }
}
