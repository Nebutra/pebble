import { describe, expect, it, vi } from 'vitest'
import { executeTauriBrowserCommand } from './tauri-browser-exec-rpc'

describe('executeTauriBrowserCommand', () => {
  it('registers repeated file init scripts before the first navigation', async () => {
    const dispatch = vi.fn(async (method: string, params: Record<string, unknown>) =>
      method === 'files.read' ? { content: `script:${params.relativePath}` } : { ok: true }
    )
    await executeTauriBrowserCommand(
      {
        page: 'page-1',
        worktree: 'id:wt-ssh',
        command: 'open --init-script boot.js https://example.test --init-script auth.js'
      },
      dispatch
    )
    expect(dispatch.mock.calls).toEqual([
      ['files.read', { page: 'page-1', worktree: 'id:wt-ssh', relativePath: 'boot.js' }],
      [
        'browser.initScriptAdd',
        { page: 'page-1', worktree: 'id:wt-ssh', script: 'script:boot.js' }
      ],
      ['files.read', { page: 'page-1', worktree: 'id:wt-ssh', relativePath: 'auth.js' }],
      [
        'browser.initScriptAdd',
        { page: 'page-1', worktree: 'id:wt-ssh', script: 'script:auth.js' }
      ],
      ['browser.goto', { page: 'page-1', worktree: 'id:wt-ssh', url: 'https://example.test' }]
    ])
  })

  it('installs the React hook before navigation and reads the live Fiber tree', async () => {
    const dispatch = vi.fn(async (method: string) =>
      method === 'browser.eval' ? { result: '[{"id":1,"name":"App"}]' } : { ok: true }
    )
    await executeTauriBrowserCommand(
      { page: 'page-1', command: 'open --enable react-devtools https://example.test' },
      dispatch
    )
    expect(dispatch.mock.calls[0]?.[0]).toBe('browser.initScriptAdd')
    expect(dispatch.mock.calls[1]).toEqual([
      'browser.goto',
      { page: 'page-1', url: 'https://example.test' }
    ])
    await expect(
      executeTauriBrowserCommand({ page: 'page-1', command: 'react tree --json' }, dispatch)
    ).resolves.toEqual([{ id: 1, name: 'App' }])
    expect(dispatch.mock.calls[2]?.[0]).toBe('browser.eval')
  })

  it('routes React inspect, render recording, and Suspense reports to live Fiber evaluation', async () => {
    const dispatch = vi.fn().mockResolvedValue({ result: '{"ok":true}' })
    for (const command of [
      'react inspect 42 --json',
      'react renders start',
      'react renders stop --json',
      'react suspense --only-dynamic --json'
    ]) {
      await executeTauriBrowserCommand({ page: 'page-1', command }, dispatch)
    }
    const expressions = dispatch.mock.calls.map(([, value]) => String(value.expression))
    expect(expressions[0]).toContain('__pebbleFiberId===42')
    expect(expressions[1]).toContain('recording=true')
    expect(expressions[2]).toContain('components=[...p.state.renders.values()]')
    expect(expressions[3]).toContain('rows.filter(r=>r.dynamic)')
  })

  it('rejects invalid React fibers and commands before page evaluation', async () => {
    const dispatch = vi.fn()
    await expect(
      executeTauriBrowserCommand({ page: 'page-1', command: 'react inspect nope' }, dispatch)
    ).rejects.toThrow('fiber id must be positive')
    await expect(
      executeTauriBrowserCommand({ page: 'page-1', command: 'react unknown' }, dispatch)
    ).rejects.toThrow('not migrated')
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('routes quoted element commands to canonical browser RPC methods', async () => {
    const dispatch = vi.fn().mockResolvedValue({ filled: '@e2' })
    await expect(
      executeTauriBrowserCommand(
        {
          page: 'page-1',
          command: `agent-browser fill @e2 "hello world"`
        },
        dispatch
      )
    ).resolves.toEqual({ filled: '@e2' })
    expect(dispatch).toHaveBeenCalledWith('browser.fill', {
      page: 'page-1',
      element: '@e2',
      value: 'hello world'
    })
  })

  it('preserves snapshot scope, depth, compact, interactive, and URL options', async () => {
    const dispatch = vi.fn().mockResolvedValue({ snapshot: '' })
    await executeTauriBrowserCommand(
      { page: 'page-1', command: 'snapshot -i -c -u -d 3 -s "#main"' },
      dispatch
    )
    expect(dispatch).toHaveBeenCalledWith('browser.snapshot', {
      page: 'page-1',
      interactive: true,
      compact: true,
      includeUrls: true,
      depth: 3,
      selector: '#main'
    })
  })

  it('saves screenshot and PDF captures when the CLI supplies a path', async () => {
    const dispatch = vi.fn(async (method: string) => {
      if (method === 'browser.screenshot') {
        return { data: 'cG5n', format: 'png' }
      }
      if (method === 'browser.pdf') {
        return { data: 'cGRm' }
      }
      return { path: '/workspace/output' }
    })
    await executeTauriBrowserCommand(
      {
        page: 'page-1',
        worktree: 'id:wt-1',
        command: 'screenshot captures/page.png'
      },
      dispatch
    )
    await executeTauriBrowserCommand(
      { page: 'page-1', worktree: 'id:wt-1', command: 'pdf captures/page.pdf' },
      dispatch
    )
    expect(dispatch).toHaveBeenNthCalledWith(2, 'browser.captureSave', {
      page: 'page-1',
      worktree: 'id:wt-1',
      path: 'captures/page.png',
      capture: { data: 'cG5n', format: 'png' }
    })
    expect(dispatch).toHaveBeenNthCalledWith(4, 'browser.captureSave', {
      page: 'page-1',
      worktree: 'id:wt-1',
      path: 'captures/page.pdf',
      capture: { data: 'cGRm' }
    })
  })

  it('does not confuse screenshot format values with output paths', async () => {
    const dispatch = vi.fn(async (method: string) =>
      method === 'browser.screenshot'
        ? { data: 'anBlZw==', format: 'jpeg' }
        : { path: '/workspace/captures/page.jpg' }
    )
    await executeTauriBrowserCommand(
      {
        page: 'page-1',
        worktree: 'id:wt-1',
        command: 'screenshot --screenshot-format jpeg captures/page.jpg'
      },
      dispatch
    )
    expect(dispatch).toHaveBeenNthCalledWith(1, 'browser.screenshot', {
      page: 'page-1',
      worktree: 'id:wt-1',
      format: 'jpeg'
    })
    expect(dispatch).toHaveBeenNthCalledWith(2, 'browser.captureSave', {
      page: 'page-1',
      worktree: 'id:wt-1',
      path: 'captures/page.jpg',
      capture: { data: 'anBlZw==', format: 'jpeg' }
    })
  })

  it('preserves selector text typing and active-element keyboard typing semantics', async () => {
    const dispatch = vi.fn().mockResolvedValue({ typed: true })
    await executeTauriBrowserCommand(
      { page: 'page-1', command: `agent-browser type @e2 "hello world"` },
      dispatch
    )
    await executeTauriBrowserCommand(
      { page: 'page-1', command: `agent-browser keyboard type "more text"` },
      dispatch
    )
    expect(dispatch).toHaveBeenNthCalledWith(1, 'browser.type', {
      page: 'page-1',
      element: '@e2',
      input: 'hello world'
    })
    expect(dispatch).toHaveBeenNthCalledWith(2, 'browser.type', {
      page: 'page-1',
      input: 'more text'
    })
  })

  it('routes agent-browser navigation, key, and scroll aliases plus held keys', async () => {
    const dispatch = vi.fn().mockResolvedValue({ ok: true })
    await executeTauriBrowserCommand(
      { page: 'page-1', command: 'navigate https://example.test/path' },
      dispatch
    )
    await executeTauriBrowserCommand({ page: 'page-1', command: 'key Enter' }, dispatch)
    await executeTauriBrowserCommand({ page: 'page-1', command: 'keydown Shift' }, dispatch)
    await executeTauriBrowserCommand({ page: 'page-1', command: 'keyup Shift' }, dispatch)
    await executeTauriBrowserCommand({ page: 'page-1', command: 'scrollinto @e7' }, dispatch)

    expect(dispatch.mock.calls).toEqual([
      ['browser.goto', { page: 'page-1', url: 'https://example.test/path' }],
      ['browser.keypress', { page: 'page-1', key: 'Enter' }],
      ['browser.keyDown', { page: 'page-1', key: 'Shift' }],
      ['browser.keyUp', { page: 'page-1', key: 'Shift' }],
      ['browser.scrollIntoView', { page: 'page-1', element: '@e7' }]
    ])
  })

  it('preserves get-attribute and multi-value select arguments', async () => {
    const dispatch = vi.fn().mockResolvedValue({ ok: true })
    await executeTauriBrowserCommand(
      { page: 'page-1', command: 'get attr @e2 aria-label' },
      dispatch
    )
    await executeTauriBrowserCommand(
      { page: 'page-1', command: 'select @e3 alpha "Beta option"' },
      dispatch
    )
    expect(dispatch).toHaveBeenNthCalledWith(1, 'browser.get', {
      page: 'page-1',
      what: 'attr',
      attribute: 'aria-label',
      selector: '@e2'
    })
    expect(dispatch).toHaveBeenNthCalledWith(2, 'browser.select', {
      page: 'page-1',
      element: '@e3',
      values: ['alpha', 'Beta option']
    })
  })

  it('preserves first, last, and nth find locator semantics', async () => {
    const dispatch = vi.fn().mockResolvedValue({ ok: true })
    await executeTauriBrowserCommand(
      { page: 'page-1', command: 'find first .card click' },
      dispatch
    )
    await executeTauriBrowserCommand({ page: 'page-1', command: 'find last .card hover' }, dispatch)
    await executeTauriBrowserCommand(
      { page: 'page-1', command: 'find nth 2 input type hello' },
      dispatch
    )
    expect(dispatch).toHaveBeenNthCalledWith(1, 'browser.find', {
      page: 'page-1',
      locator: 'css',
      position: 'first',
      value: '.card',
      action: 'click'
    })
    expect(dispatch).toHaveBeenNthCalledWith(2, 'browser.find', {
      page: 'page-1',
      locator: 'css',
      position: 'last',
      value: '.card',
      action: 'hover'
    })
    expect(dispatch).toHaveBeenNthCalledWith(3, 'browser.find', {
      page: 'page-1',
      locator: 'css',
      position: 'nth',
      index: 2,
      value: 'input',
      action: 'type',
      text: 'hello'
    })
  })

  it('routes native environment, storage, mouse, and PDF commands', async () => {
    const dispatch = vi.fn().mockResolvedValue({ ok: true })
    await executeTauriBrowserCommand({ page: 'page-1', command: 'set geo 31.2 121.4 5' }, dispatch)
    await executeTauriBrowserCommand(
      { page: 'page-1', command: `storage local set theme "dark mode"` },
      dispatch
    )
    await executeTauriBrowserCommand({ page: 'page-1', command: 'mouse move 10 20' }, dispatch)
    await executeTauriBrowserCommand({ page: 'page-1', command: 'pdf' }, dispatch)
    expect(dispatch).toHaveBeenNthCalledWith(1, 'browser.geolocation', {
      page: 'page-1',
      latitude: 31.2,
      longitude: 121.4,
      accuracy: 5
    })
    expect(dispatch).toHaveBeenNthCalledWith(2, 'browser.storage.local.set', {
      page: 'page-1',
      key: 'theme',
      value: 'dark mode'
    })
    expect(dispatch).toHaveBeenNthCalledWith(3, 'browser.mouseMove', {
      page: 'page-1',
      x: 10,
      y: 20
    })
    expect(dispatch).toHaveBeenNthCalledWith(4, 'browser.pdf', {
      page: 'page-1'
    })
  })

  it('routes storage get-all without inventing a required key', async () => {
    const dispatch = vi.fn().mockResolvedValue({ values: {} })
    await executeTauriBrowserCommand({ page: 'page-1', command: 'storage local' }, dispatch)
    await executeTauriBrowserCommand({ page: 'page-1', command: 'storage session theme' }, dispatch)
    expect(dispatch).toHaveBeenNthCalledWith(1, 'browser.storage.local.get', {
      page: 'page-1'
    })
    expect(dispatch).toHaveBeenNthCalledWith(2, 'browser.storage.session.get', {
      page: 'page-1',
      key: 'theme'
    })
  })

  it('routes clipboard copy and paste through the native page executor', async () => {
    const dispatch = vi.fn().mockResolvedValue({ ok: true })
    await executeTauriBrowserCommand({ page: 'page-1', command: 'clipboard copy' }, dispatch)
    await executeTauriBrowserCommand({ page: 'page-1', command: 'clipboard paste' }, dispatch)
    expect(dispatch).toHaveBeenNthCalledWith(1, 'browser.clipboardCopy', {
      page: 'page-1'
    })
    expect(dispatch).toHaveBeenNthCalledWith(2, 'browser.clipboardPaste', {
      page: 'page-1'
    })
  })

  it('runs batch commands against the same native target and honors bail', async () => {
    const dispatch = vi.fn(async (method: string) => {
      if (method === 'browser.click') {
        throw new Error('click failed')
      }
      return { ok: true }
    })
    const result = await executeTauriBrowserCommand(
      {
        page: 'page-1',
        worktree: 'id:wt-1',
        command: `batch --bail "open https://example.test" "click @e1" "reload"`
      },
      dispatch
    )
    expect(result).toEqual([
      { command: 'open https://example.test', result: { ok: true } },
      { command: 'click @e1', error: 'click failed' }
    ])
    expect(dispatch).toHaveBeenNthCalledWith(1, 'browser.goto', {
      page: 'page-1',
      worktree: 'id:wt-1',
      url: 'https://example.test'
    })
  })

  it('reports the current native session and lists its tabs', async () => {
    const dispatch = vi.fn().mockResolvedValue([{ id: 'page-1' }])
    await expect(
      executeTauriBrowserCommand(
        { page: 'page-1', worktree: 'id:wt-1', command: 'session' },
        dispatch
      )
    ).resolves.toEqual({ session: 'id:wt-1', page: 'page-1' })
    await executeTauriBrowserCommand({ page: 'page-1', command: 'session list' }, dispatch)
    expect(dispatch).toHaveBeenCalledWith('browser.tabList', { page: 'page-1' })
  })

  it('rejects target overrides and commands without native migration', async () => {
    const dispatch = vi.fn()
    await expect(
      executeTauriBrowserCommand(
        {
          page: 'page-1',
          command: 'snapshot --session attacker'
        },
        dispatch
      )
    ).rejects.toThrow('cannot override')
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('routes video recording start, stop, restart, URL, and worktree output', async () => {
    const dispatch = vi.fn().mockResolvedValue({ started: true })
    await executeTauriBrowserCommand(
      { page: 'page-1', worktree: 'id:wt-1', command: 'record start videos/demo.webm example.com' },
      dispatch
    )
    expect(dispatch).toHaveBeenNthCalledWith(1, 'browser.goto', {
      page: 'page-1',
      worktree: 'id:wt-1',
      url: 'https://example.com'
    })
    expect(dispatch).toHaveBeenNthCalledWith(2, 'browser.recordingStart', {
      page: 'page-1',
      worktree: 'id:wt-1',
      path: 'videos/demo.webm',
      outputWorktree: 'id:wt-1'
    })

    dispatch.mockClear()
    await executeTauriBrowserCommand(
      { page: 'page-1', command: 'record restart /tmp/take.mp4' },
      dispatch
    )
    expect(dispatch).toHaveBeenNthCalledWith(1, 'browser.recordingStop', { page: 'page-1' })
    expect(dispatch).toHaveBeenNthCalledWith(2, 'browser.recordingStart', {
      page: 'page-1',
      path: '/tmp/take.mp4'
    })
    await expect(
      executeTauriBrowserCommand({ page: 'page-1', command: 'record start demo.mov' }, dispatch)
    ).rejects.toThrow('.webm or .mp4')
  })

  it('routes eval, upload, download, find, and wait commands', async () => {
    const dispatch = vi.fn().mockResolvedValue({ ok: true })
    await executeTauriBrowserCommand({ page: 'page-1', command: `eval "document.title"` }, dispatch)
    await executeTauriBrowserCommand(
      { page: 'page-1', command: `upload @e1 "/tmp/a file.txt" /tmp/b.txt` },
      dispatch
    )
    await executeTauriBrowserCommand(
      { page: 'page-1', command: `download @e2 "/tmp/report.pdf"` },
      dispatch
    )
    await executeTauriBrowserCommand(
      { page: 'page-1', command: `find role button click "Submit now"` },
      dispatch
    )
    await executeTauriBrowserCommand(
      { page: 'page-1', command: `wait "#ready" --text "Done" --timeout 2500` },
      dispatch
    )

    expect(dispatch).toHaveBeenNthCalledWith(1, 'browser.eval', {
      page: 'page-1',
      expression: 'document.title'
    })
    expect(dispatch).toHaveBeenNthCalledWith(2, 'browser.upload', {
      page: 'page-1',
      element: '@e1',
      files: ['/tmp/a file.txt', '/tmp/b.txt']
    })
    expect(dispatch).toHaveBeenNthCalledWith(3, 'browser.download', {
      page: 'page-1',
      selector: '@e2',
      path: '/tmp/report.pdf'
    })
    expect(dispatch).toHaveBeenNthCalledWith(4, 'browser.find', {
      page: 'page-1',
      locator: 'role',
      value: 'button',
      action: 'click',
      text: 'Submit now'
    })
    expect(dispatch).toHaveBeenNthCalledWith(5, 'browser.wait', {
      page: 'page-1',
      selector: '#ready',
      text: 'Done',
      timeout: 2500
    })
    await executeTauriBrowserCommand({ page: 'page-1', command: 'wait 250' }, dispatch)
    expect(dispatch).toHaveBeenNthCalledWith(6, 'browser.wait', {
      page: 'page-1',
      duration: 250
    })
  })

  it('routes viewport, logs, and native set commands', async () => {
    const dispatch = vi.fn().mockResolvedValue({ ok: true })
    await executeTauriBrowserCommand({ page: 'page-1', command: 'viewport 1440 900' }, dispatch)
    await executeTauriBrowserCommand({ page: 'page-1', command: 'console --limit 50' }, dispatch)
    await executeTauriBrowserCommand(
      { page: 'page-1', command: 'set device "iPhone 15"' },
      dispatch
    )
    await executeTauriBrowserCommand(
      {
        page: 'page-1',
        command: 'set media --color-scheme dark --reduced-motion reduce'
      },
      dispatch
    )
    await executeTauriBrowserCommand({ page: 'page-1', command: 'set viewport 1280 720' }, dispatch)
    await executeTauriBrowserCommand(
      { page: 'page-1', command: 'set media light reduced-motion' },
      dispatch
    )

    expect(dispatch).toHaveBeenNthCalledWith(1, 'browser.viewport', {
      page: 'page-1',
      width: 1440,
      height: 900
    })
    expect(dispatch).toHaveBeenNthCalledWith(2, 'browser.console', {
      page: 'page-1',
      limit: 50
    })
    expect(dispatch).toHaveBeenNthCalledWith(3, 'browser.setDevice', {
      page: 'page-1',
      name: 'iPhone 15'
    })
    expect(dispatch).toHaveBeenNthCalledWith(4, 'browser.setMedia', {
      page: 'page-1',
      colorScheme: 'dark',
      reducedMotion: 'reduce'
    })
    expect(dispatch).toHaveBeenNthCalledWith(5, 'browser.viewport', {
      page: 'page-1',
      width: 1280,
      height: 720
    })
    expect(dispatch).toHaveBeenNthCalledWith(6, 'browser.setMedia', {
      page: 'page-1',
      colorScheme: 'light',
      reducedMotion: 'reduce'
    })
  })

  it('preserves official console, errors, and network request options', async () => {
    const dispatch = vi.fn().mockResolvedValue({ entries: [] })
    await executeTauriBrowserCommand(
      { page: 'page-1', command: 'console --clear --limit 25' },
      dispatch
    )
    await executeTauriBrowserCommand({ page: 'page-1', command: 'errors --clear' }, dispatch)
    await executeTauriBrowserCommand(
      {
        page: 'page-1',
        command:
          'network requests --filter /api --type xhr,fetch --method POST --status 2xx --clear --limit 10'
      },
      dispatch
    )
    await executeTauriBrowserCommand(
      { page: 'page-1', command: 'network request request-42' },
      dispatch
    )
    expect(dispatch).toHaveBeenNthCalledWith(1, 'browser.console', {
      page: 'page-1',
      clear: true,
      limit: 25
    })
    expect(dispatch).toHaveBeenNthCalledWith(2, 'browser.console', {
      page: 'page-1',
      clear: true,
      errorsOnly: true
    })
    expect(dispatch).toHaveBeenNthCalledWith(3, 'browser.network', {
      page: 'page-1',
      clear: true,
      filter: '/api',
      limit: 10,
      types: ['xhr', 'fetch'],
      method: 'POST',
      status: '2xx'
    })
    expect(dispatch).toHaveBeenNthCalledWith(4, 'browser.network', {
      page: 'page-1',
      requestId: 'request-42'
    })
  })
})
