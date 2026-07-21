import { queueTauriBrowserNavigation } from './tauri-browser-navigation-rpc'
import { queueTauriBrowserScreenshot } from './tauri-browser-screenshot-rpc'
import { queueTauriBrowserInteraction } from './tauri-browser-interaction-rpc'
import { executeTauriBrowserCommand } from './tauri-browser-exec-rpc'
import { callTauriFileRuntimeRpc } from './tauri-file-runtime-rpc'
import { readBrowserCapture, saveBrowserCapture, saveBrowserHar } from './tauri-browser-capture-rpc'
import {
  deleteBrowserCookie,
  disableBrowserInterception,
  enableBrowserInterception,
  evaluateBrowserExpression,
  getBrowserCookies,
  listBrowserInterceptions,
  resolveBrowserInterceptedRequest,
  setBrowserCookie,
  setBrowserCredentials,
  setBrowserDevice,
  setBrowserHeaders,
  setBrowserOffline
} from './tauri-browser-page-control-rpc'
import {
  cloneBrowserTabProfile,
  closeBrowserTab,
  createBrowserProfile,
  createBrowserTab,
  currentBrowserTab,
  deleteBrowserProfile,
  detectBrowserProfiles,
  listBrowserProfiles,
  listBrowserTabs,
  setBrowserTabProfile,
  showBrowserTab,
  showBrowserTabProfile,
  switchBrowserTab
} from './tauri-browser-profile-tab-rpc'
import { readBrowserPageId, readObject, readRequiredString } from './tauri-browser-rpc-values'
import { readTauriBrowserViewport } from './tauri-browser-viewport-state'
import {
  clearTauriBrowserDefaultCookies,
  clearTauriBrowserPageCookies,
  importTauriBrowserCookiesFromBrowser,
  openTauriBrowserPageDevTools,
  resolveTauriBrowserPageDialog
} from '@/components/browser-pane/tauri-browser-page-webview'

type RuntimeBrowserRpcResult = {
  handled: boolean
  result?: unknown
}

export async function callTauriBrowserRuntimeRpc(
  method: string,
  params: unknown
): Promise<RuntimeBrowserRpcResult> {
  switch (method) {
    case 'browser.profileList':
      return handled({ profiles: await listBrowserProfiles() })
    case 'browser.profileCreate':
      return handled({ profile: await createBrowserProfile(params) })
    case 'browser.profileDelete':
      return handled(await deleteBrowserProfile(params))
    case 'browser.profileDetectBrowsers':
      return handled({ browsers: await detectBrowserProfiles() })
    case 'browser.profileImportFromBrowser':
      return handled(await importBrowserProfileCookies(params))
    case 'browser.profileClearDefaultCookies':
      return handled({ cleared: await clearTauriBrowserDefaultCookies() })
    case 'browser.cookie.get':
      return handled(await getBrowserCookies(params))
    case 'browser.cookie.set':
      return handled(await setBrowserCookie(params))
    case 'browser.cookie.delete':
      return handled(await deleteBrowserCookie(params))
    case 'browser.cookie.clear':
      return handled(await clearTauriBrowserPageCookies(readBrowserPageId(params)))
    case 'browser.tabList':
      return handled({ tabs: await listBrowserTabs() })
    case 'browser.tabCurrent':
      return handled({ tab: await currentBrowserTab(params) })
    case 'browser.tabSwitch':
      return handled(await switchBrowserTab(params))
    case 'browser.tabCreate':
      return handled({ browserPageId: await createBrowserTab(params) })
    case 'browser.tabClose':
      return handled({ closed: await closeBrowserTab(params) })
    case 'browser.tabShow':
      return handled({ tab: await showBrowserTab(params) })
    case 'browser.tabSetProfile':
      return handled(await setBrowserTabProfile(params))
    case 'browser.tabProfileShow':
      return handled(await showBrowserTabProfile(params))
    case 'browser.tabProfileClone':
      return handled(await cloneBrowserTabProfile(params))
    case 'browser.goto':
      return handled(await queueTauriBrowserNavigation('goto', params))
    case 'browser.back':
      return handled(await queueTauriBrowserNavigation('goBack', params))
    case 'browser.forward':
      return handled(await queueTauriBrowserNavigation('goForward', params))
    case 'browser.reload':
      return handled(await queueTauriBrowserNavigation('reload', params))
    case 'browser.screenshot':
      return handled(await queueTauriBrowserScreenshot(params))
    case 'browser.fullScreenshot':
      return handled(await queueTauriBrowserInteraction('fullScreenshot', params))
    case 'browser.pdf':
      return handled(await queueTauriBrowserInteraction('pdf', params))
    case 'browser.captureSave':
      return handled(await saveBrowserCapture(params))
    case 'browser.captureRead':
      return handled(await readBrowserCapture(params))
    case 'browser.dialogAccept':
      return handled(await resolveBrowserDialog(params, true))
    case 'browser.dialogDismiss':
      return handled(await resolveBrowserDialog(params, false))
    case 'browser.inspect':
      return handled({ opened: await openTauriBrowserPageDevTools(readBrowserPageId(params)) })
    case 'browser.snapshot':
    case 'browser.click':
    case 'browser.dblclick':
    case 'browser.fill':
    case 'browser.type':
    case 'browser.focus':
    case 'browser.clear':
    case 'browser.keypress':
    case 'browser.keyDown':
    case 'browser.keyUp':
    case 'browser.scroll':
    case 'browser.scrollIntoView':
    case 'browser.select':
    case 'browser.check':
    case 'browser.hover':
    case 'browser.selectAll':
    case 'browser.drag':
    case 'browser.upload':
    case 'browser.get':
    case 'browser.is':
    case 'browser.find':
    case 'browser.wait':
    case 'browser.pushState':
      return handled(await queueTauriBrowserInteraction(method.slice('browser.'.length), params))
    case 'browser.keyboardInsertText':
      return handled(await queueTauriBrowserInteraction('keyboardInsertText', params))
    case 'browser.capture.start':
      return handled(await queueTauriBrowserInteraction('captureStart', params))
    case 'browser.capture.stop':
      return handled(await queueTauriBrowserInteraction('captureStop', params))
    case 'browser.recordingStart':
      return handled(await queueBrowserVideoRecording('recordingStart', params))
    case 'browser.recordingStop':
      return handled(await queueBrowserVideoRecording('recordingStop', params))
    case 'browser.console':
    case 'browser.network':
      return handled(await queueTauriBrowserInteraction(method.slice('browser.'.length), params))
    case 'browser.harStart':
      return handled(await queueTauriBrowserInteraction('harStart', params))
    case 'browser.harStop':
      return handled(await queueTauriBrowserInteraction('harStop', params))
    case 'browser.profilerStart':
      return handled(await queueTauriBrowserInteraction('profilerStart', params))
    case 'browser.profilerStop':
      return handled(await queueTauriBrowserInteraction('profilerStop', params))
    case 'browser.initScriptAdd':
      return handled(await queueTauriBrowserInteraction('initScriptAdd', params))
    case 'browser.initScriptRemove':
      return handled(await queueTauriBrowserInteraction('initScriptRemove', params))
    case 'browser.harSave':
      return handled(await saveBrowserHar(params))
    case 'browser.intercept.enable':
      return handled(await enableBrowserInterception(params))
    case 'browser.intercept.disable':
      return handled(await disableBrowserInterception(params))
    case 'browser.intercept.list':
      return handled(await listBrowserInterceptions(params))
    case 'browser.intercept.continue':
      return handled(
        await resolveBrowserInterceptedRequest({ ...readObject(params), action: 'continue' })
      )
    case 'browser.intercept.fulfill':
      return handled(
        await resolveBrowserInterceptedRequest({ ...readObject(params), action: 'fulfill' })
      )
    case 'browser.intercept.fail':
      return handled(
        await resolveBrowserInterceptedRequest({ ...readObject(params), action: 'fail' })
      )
    case 'browser.storage.local.get':
      return handled(await queueTauriBrowserInteraction('storageLocalGet', params))
    case 'browser.storage.local.set':
      return handled(await queueTauriBrowserInteraction('storageLocalSet', params))
    case 'browser.storage.local.clear':
      return handled(await queueTauriBrowserInteraction('storageLocalClear', params))
    case 'browser.storage.session.get':
      return handled(await queueTauriBrowserInteraction('storageSessionGet', params))
    case 'browser.storage.session.set':
      return handled(await queueTauriBrowserInteraction('storageSessionSet', params))
    case 'browser.storage.session.clear':
      return handled(await queueTauriBrowserInteraction('storageSessionClear', params))
    case 'browser.highlight':
    case 'browser.mouseMove':
    case 'browser.mouseDown':
    case 'browser.mouseUp':
    case 'browser.mouseClick':
    case 'browser.mouseWheel':
      return handled(await queueTauriBrowserInteraction(method.slice('browser.'.length), params))
    case 'browser.clipboardRead':
      return handled(await queueTauriBrowserInteraction('clipboardRead', params))
    case 'browser.clipboardWrite':
      return handled(await queueTauriBrowserInteraction('clipboardWrite', params))
    case 'browser.clipboardCopy':
      return handled(await queueTauriBrowserInteraction('clipboardCopy', params))
    case 'browser.clipboardPaste':
      return handled(await queueTauriBrowserInteraction('clipboardPaste', params))
    case 'browser.download':
      return handled(await queueTauriBrowserInteraction('download', params))
    case 'browser.geolocation':
      return handled(await queueTauriBrowserInteraction('geolocation', params))
    case 'browser.setMedia':
      return handled(await queueTauriBrowserInteraction('setMedia', params))
    case 'browser.setDevice':
      return handled(await setBrowserDevice(params))
    case 'browser.setHeaders':
      return handled(await setBrowserHeaders(params))
    case 'browser.setOffline':
      return handled(await setBrowserOffline(params))
    case 'browser.setCredentials':
      return handled(await setBrowserCredentials(params))
    case 'browser.eval':
      return handled(await evaluateBrowserExpression(params))
    case 'browser.exec':
      return handled(
        await executeTauriBrowserCommand(params, async (nestedMethod, nestedParams) => {
          if (nestedMethod === 'files.read') {
            const file = await callTauriFileRuntimeRpc(nestedMethod, nestedParams)
            if (!file.handled) {
              throw new Error('Browser init script file read is unavailable.')
            }
            return file.result
          }
          const nested = await callTauriBrowserRuntimeRpc(nestedMethod, nestedParams)
          if (!nested.handled) {
            throw new Error(`Browser exec target is not migrated: ${nestedMethod}`)
          }
          return nested.result
        })
      )
    case 'browser.viewport':
      return handled(readTauriBrowserViewport(params))
    default:
      return { handled: false }
  }
}

function queueBrowserVideoRecording(
  command: 'recordingStart' | 'recordingStop',
  params: unknown
): Promise<Record<string, unknown>> {
  const input = readObject(params)
  return queueTauriBrowserInteraction(command, {
    ...input,
    ...(typeof input.worktree === 'string' ? { outputWorktree: input.worktree } : {})
  })
}

function resolveBrowserDialog(params: unknown, accept: boolean) {
  const input = readObject(params)
  const text = typeof input.text === 'string' ? input.text : undefined
  return resolveTauriBrowserPageDialog(readBrowserPageId(input), accept, text)
}

function importBrowserProfileCookies(params: unknown) {
  const input = readObject(params)
  return importTauriBrowserCookiesFromBrowser({
    profileId: readRequiredString(input.profileId, 'browser profile id'),
    browserFamily: readRequiredString(input.browserFamily, 'browser family'),
    browserProfile:
      typeof input.browserProfile === 'string' && input.browserProfile.trim()
        ? input.browserProfile
        : undefined
  })
}

function handled(result: unknown): RuntimeBrowserRpcResult {
  return { handled: true, result }
}
