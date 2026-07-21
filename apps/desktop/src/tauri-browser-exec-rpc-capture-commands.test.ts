import { describe, expect, it, vi } from 'vitest'
import { executeTauriBrowserCommand } from './tauri-browser-exec-rpc'

describe('executeTauriBrowserCommand capture, network, dialog, and tab routing', () => {
  it('starts, returns, and atomically saves HAR recordings through browser RPC', async () => {
    const har = { log: { version: '1.2', entries: [] } }
    const dispatch = vi.fn(async (method: string) =>
      method === 'browser.harStop' ? { har } : { path: '/tmp/session.har' }
    )
    await executeTauriBrowserCommand({ page: 'page-1', command: 'network har start' }, dispatch)
    await expect(
      executeTauriBrowserCommand(
        { page: 'page-1', command: 'network har stop session.har' },
        dispatch
      )
    ).resolves.toEqual({ path: '/tmp/session.har' })
    expect(dispatch.mock.calls).toEqual([
      ['browser.harStart', { page: 'page-1' }],
      ['browser.harStop', { page: 'page-1' }],
      ['browser.harSave', { page: 'page-1', path: 'session.har', har }]
    ])
  })

  it('adds and removes native abort routes without dropping unrelated patterns', async () => {
    const dispatch = vi.fn(async (method: string) =>
      method === 'browser.intercept.list'
        ? { patterns: ['https://example.com/keep'] }
        : { ok: true }
    )
    await executeTauriBrowserCommand(
      {
        page: 'page-1',
        command: 'network route "https://example.com/api/**" --abort'
      },
      dispatch
    )
    await executeTauriBrowserCommand(
      {
        page: 'page-1',
        command: 'network unroute "https://example.com/api/**"'
      },
      dispatch
    )
    await executeTauriBrowserCommand({ page: 'page-1', command: 'network unroute' }, dispatch)
    expect(dispatch).toHaveBeenNthCalledWith(2, 'browser.intercept.enable', {
      page: 'page-1',
      routes: [
        { pattern: 'https://example.com/keep', action: 'abort' },
        { pattern: 'https://example.com/api/**', action: 'abort' }
      ]
    })
    expect(dispatch).toHaveBeenNthCalledWith(4, 'browser.intercept.enable', {
      page: 'page-1',
      routes: [{ pattern: 'https://example.com/keep', action: 'abort' }]
    })
    expect(dispatch).toHaveBeenNthCalledWith(5, 'browser.intercept.disable', {
      page: 'page-1'
    })
    await executeTauriBrowserCommand(
      {
        page: 'page-1',
        command:
          'network route "**/api" --body "{\\"ok\\":true}" --status 201 --content-type application/json'
      },
      dispatch
    )
    expect(dispatch).toHaveBeenLastCalledWith('browser.intercept.enable', {
      page: 'page-1',
      routes: [
        { pattern: 'https://example.com/keep', action: 'abort' },
        {
          pattern: '**/api',
          action: 'fulfill',
          body: '{"ok":true}',
          status: 201,
          contentType: 'application/json'
        }
      ]
    })
  })

  it('preserves native cookie clear and metadata options', async () => {
    const dispatch = vi.fn().mockResolvedValue({ success: true })
    await executeTauriBrowserCommand(
      {
        page: 'page-1',
        command:
          'cookies set session token --url https://example.com/app --path / --httpOnly --secure --sameSite Lax --expires 42'
      },
      dispatch
    )
    await executeTauriBrowserCommand({ page: 'page-1', command: 'cookies clear' }, dispatch)
    expect(dispatch).toHaveBeenNthCalledWith(1, 'browser.cookie.set', {
      page: 'page-1',
      name: 'session',
      value: 'token',
      url: 'https://example.com/app',
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      expires: 42
    })
    expect(dispatch).toHaveBeenNthCalledWith(2, 'browser.cookie.clear', {
      page: 'page-1'
    })
  })

  it('routes dialog accept and dismiss through the native WebView bridge', async () => {
    const dispatch = vi.fn().mockResolvedValue({ ok: true })
    await executeTauriBrowserCommand(
      { page: 'page-1', command: 'agent-browser dialog accept "typed value"' },
      dispatch
    )
    await executeTauriBrowserCommand(
      { page: 'page-1', command: 'agent-browser dialog dismiss' },
      dispatch
    )

    expect(dispatch).toHaveBeenNthCalledWith(1, 'browser.dialogAccept', {
      page: 'page-1',
      text: 'typed value'
    })
    expect(dispatch).toHaveBeenNthCalledWith(2, 'browser.dialogDismiss', {
      page: 'page-1'
    })
    await expect(
      executeTauriBrowserCommand(
        { page: 'page-1', command: 'agent-browser dialog ignore' },
        dispatch
      )
    ).rejects.toThrow('Unsupported browser dialog action')
  })

  it('routes agent-browser tab lifecycle commands through native tab RPC', async () => {
    const dispatch = vi.fn(async (method: string) =>
      method === 'browser.tabSwitch' ? { browserPageId: 'page-2' } : { ok: true }
    )
    await executeTauriBrowserCommand({ page: 'page-1', command: 'tab list' }, dispatch)
    await executeTauriBrowserCommand(
      {
        page: 'page-1',
        worktree: 'id:wt-1',
        command: 'tab new https://example.com'
      },
      dispatch
    )
    await executeTauriBrowserCommand({ page: 'page-1', command: 'tab 2' }, dispatch)
    await executeTauriBrowserCommand({ page: 'page-1', command: 'tab close 2' }, dispatch)
    await executeTauriBrowserCommand({ page: 'page-1', command: 'close' }, dispatch)

    expect(dispatch).toHaveBeenNthCalledWith(1, 'browser.tabList', {
      page: 'page-1'
    })
    expect(dispatch).toHaveBeenNthCalledWith(2, 'browser.tabCreate', {
      page: 'page-1',
      worktree: 'id:wt-1',
      url: 'https://example.com'
    })
    expect(dispatch).toHaveBeenNthCalledWith(3, 'browser.tabSwitch', {
      page: 'page-1',
      index: 2,
      focus: true
    })
    expect(dispatch).toHaveBeenNthCalledWith(4, 'browser.tabSwitch', {
      page: 'page-1',
      index: 2
    })
    expect(dispatch).toHaveBeenNthCalledWith(5, 'browser.tabClose', {
      page: 'page-2'
    })
    expect(dispatch).toHaveBeenNthCalledWith(6, 'browser.tabClose', {
      page: 'page-1'
    })
  })

  it('routes inspect to the active native child WebView', async () => {
    const dispatch = vi.fn().mockResolvedValue({ opened: true })
    await expect(
      executeTauriBrowserCommand({ page: 'page-1', command: 'inspect' }, dispatch)
    ).resolves.toEqual({ opened: true })
    expect(dispatch).toHaveBeenCalledWith('browser.inspect', {
      page: 'page-1'
    })
  })

  it('routes pushstate as document-local SPA navigation', async () => {
    const dispatch = vi.fn().mockResolvedValue({ url: 'https://example.com/app' })
    await executeTauriBrowserCommand({ page: 'page-1', command: 'pushstate /app' }, dispatch)
    expect(dispatch).toHaveBeenCalledWith('browser.pushState', {
      page: 'page-1',
      url: '/app'
    })
  })

  it('collects framework-neutral web vitals from the existing child WebView', async () => {
    const dispatch = vi
      .fn()
      .mockResolvedValueOnce({ navigated: true })
      .mockResolvedValueOnce({ loaded: true })
      .mockResolvedValueOnce({
        result: JSON.stringify({
          url: 'https://example.com',
          lcp: 120,
          cls: 0.02,
          ttfb: 18,
          fcp: 42,
          inp: null,
          hydration: { detected: true, readyState: 'complete' }
        })
      })

    await expect(
      executeTauriBrowserCommand(
        { page: 'page-1', command: 'vitals https://example.com --json' },
        dispatch
      )
    ).resolves.toMatchObject({ lcp: 120, cls: 0.02, ttfb: 18, fcp: 42 })
    expect(dispatch.mock.calls.map(([method]) => method)).toEqual([
      'browser.goto',
      'browser.wait',
      'browser.eval'
    ])
  })

  it('records and saves a native Performance Timeline profile', async () => {
    const profile = { traceEvents: [{ name: 'paint', ph: 'X' }] }
    const dispatch = vi
      .fn()
      .mockResolvedValueOnce({ recording: true })
      .mockResolvedValueOnce({ profile })
      .mockResolvedValueOnce({ path: '/tmp/profile.json' })

    await expect(
      executeTauriBrowserCommand({ page: 'page-1', command: 'profiler start' }, dispatch)
    ).resolves.toEqual({ recording: true })
    await expect(
      executeTauriBrowserCommand(
        { page: 'page-1', command: 'profiler stop profile.json' },
        dispatch
      )
    ).resolves.toMatchObject({ profile, path: '/tmp/profile.json' })
    expect(dispatch).toHaveBeenNthCalledWith(1, 'browser.profilerStart', { page: 'page-1' })
    expect(dispatch).toHaveBeenNthCalledWith(2, 'browser.profilerStop', { page: 'page-1' })
    expect(dispatch).toHaveBeenNthCalledWith(3, 'browser.harSave', {
      page: 'page-1',
      path: 'profile.json',
      har: profile
    })
  })

  it('remembers the trace output path supplied at recording start', async () => {
    const profile = { traceEvents: [] }
    const dispatch = vi
      .fn()
      .mockResolvedValueOnce({ recording: true })
      .mockResolvedValueOnce({ profile })
      .mockResolvedValueOnce({ path: '/tmp/trace.json' })

    await executeTauriBrowserCommand(
      { page: 'page-trace', command: 'trace start trace.json' },
      dispatch
    )
    await executeTauriBrowserCommand({ page: 'page-trace', command: 'trace stop' }, dispatch)

    expect(dispatch).toHaveBeenNthCalledWith(3, 'browser.harSave', {
      page: 'page-trace',
      path: 'trace.json',
      har: profile
    })
  })

  it('adds and removes retained runtime init scripts', async () => {
    const dispatch = vi
      .fn()
      .mockResolvedValueOnce({ identifier: 'script-1' })
      .mockResolvedValueOnce({ identifier: 'script-1', removed: true })

    await executeTauriBrowserCommand(
      { page: 'page-1', command: 'addinitscript "globalThis.pebbleReady=true"' },
      dispatch
    )
    await executeTauriBrowserCommand(
      { page: 'page-1', command: 'removeinitscript script-1' },
      dispatch
    )

    expect(dispatch).toHaveBeenNthCalledWith(1, 'browser.initScriptAdd', {
      page: 'page-1',
      script: 'globalThis.pebbleReady=true'
    })
    expect(dispatch).toHaveBeenNthCalledWith(2, 'browser.initScriptRemove', {
      page: 'page-1',
      identifier: 'script-1'
    })
  })
})
