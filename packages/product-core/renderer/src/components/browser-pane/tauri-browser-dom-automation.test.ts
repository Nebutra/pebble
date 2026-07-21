// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { buildTauriBrowserDomAutomationScript } from './tauri-browser-dom-automation'

describe('buildTauriBrowserDomAutomationScript', () => {
  it('evaluates bounded expressions for remote shared-control parity', async () => {
    const result = await new Function(
      `return ${buildTauriBrowserDomAutomationScript('eval', {
        expression: 'Promise.resolve({ product: "Pebble" })'
      })}`
    )()
    expect(result).toEqual({
      result: '{"product":"Pebble"}',
      origin: location.origin
    })
    expect(() =>
      buildTauriBrowserDomAutomationScript('eval', {
        expression: 'x'.repeat(512 * 1024 + 1)
      })
    ).toThrow('browser expression')
  })

  it('records a bounded Performance Timeline profile as Chrome trace events', async () => {
    const originalObserver = globalThis.PerformanceObserver
    class TestPerformanceObserver {
      static supportedEntryTypes = ['mark']
      observe = vi.fn()
      disconnect = vi.fn()
      constructor(_callback: PerformanceObserverCallback) {}
    }
    vi.stubGlobal('PerformanceObserver', TestPerformanceObserver)
    const getEntries = vi.spyOn(performance, 'getEntries').mockReturnValue([
      {
        name: 'profile-start',
        entryType: 'mark',
        startTime: 2,
        duration: 0,
        toJSON: () => ({ name: 'profile-start' })
      } as PerformanceEntry
    ])

    await new Function(`return ${buildTauriBrowserDomAutomationScript('profilerStart', {})}`)()
    const result = await new Function(
      `return ${buildTauriBrowserDomAutomationScript('profilerStop', {})}`
    )()

    expect(result.profile.traceEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'process_name', ph: 'M' }),
        expect.objectContaining({
          name: 'profile-start',
          ph: 'X',
          cat: 'devtools.timeline'
        })
      ])
    )
    expect(result.profile.metadata.source).toBe('Performance Timeline')
    getEntries.mockRestore()
    vi.stubGlobal('PerformanceObserver', originalObserver)
  })
  it('builds snapshots with canonical refs and no arbitrary renderer script input', () => {
    const script = buildTauriBrowserDomAutomationScript('snapshot', {})
    expect(script).toContain("const ref=interactive?'@e'+index++:null")
    expect(script).toContain('data-pebble-automation-ref')
    expect(script).toContain('return {snapshot:lines.join')
  })

  it('scopes interactive snapshots and includes URLs with bounded depth', async () => {
    document.body.innerHTML = `
      <main id="main"><section><a href="/inside">Inside</a></section></main>
      <a href="/outside">Outside</a>`
    const link = document.querySelector('#main a') as HTMLAnchorElement
    link.getBoundingClientRect = () => ({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 20,
      bottom: 20,
      width: 20,
      height: 20,
      toJSON: () => ({})
    })
    const result = await new Function(
      `return ${buildTauriBrowserDomAutomationScript('snapshot', {
        interactive: true,
        compact: true,
        includeUrls: true,
        depth: 1,
        selector: '#main'
      })}`
    )()
    expect(result.snapshot).toContain('[@e1] a "Inside"')
    expect(result.snapshot).toContain(`url="${location.origin}/inside"`)
    expect(result.snapshot).not.toContain('Outside')
    expect(result.refs).toEqual([{ ref: '@e1', role: 'a', name: 'Inside' }])
  })

  it('accepts bounded CSS selectors and snapshot refs', () => {
    expect(() => buildTauriBrowserDomAutomationScript('click', { element: '@e12' })).not.toThrow()
    expect(() =>
      buildTauriBrowserDomAutomationScript('click', { element: '#submit' })
    ).not.toThrow()
    expect(() =>
      buildTauriBrowserDomAutomationScript('click', {
        element: 'x'.repeat(4097)
      })
    ).toThrow('Invalid browser element selector or @eN ref')
  })

  it('resolves a visible element center without clicking it', async () => {
    document.body.innerHTML = '<button id="native-target">Run</button>'
    const button = document.querySelector('button')!
    button.getBoundingClientRect = () => ({
      x: 10,
      y: 20,
      top: 20,
      left: 10,
      right: 90,
      bottom: 60,
      width: 80,
      height: 40,
      toJSON: () => ({})
    })
    button.scrollIntoView = vi.fn()
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
    let clicked = false
    button.addEventListener('click', () => {
      clicked = true
    })

    const result = await new Function(
      `return ${buildTauriBrowserDomAutomationScript('resolvePoint', {
        element: '#native-target',
        focus: true
      })}`
    )()

    expect(result).toEqual({ element: '#native-target', x: 50, y: 40 })
    expect(document.activeElement).toBe(button)
    expect(clicked).toBe(false)
  })

  it('bounds scroll amounts and text payloads', () => {
    expect(
      buildTauriBrowserDomAutomationScript('scroll', {
        direction: 'down',
        amount: 99_999
      })
    ).toContain('"amount":10000')
    expect(() =>
      buildTauriBrowserDomAutomationScript('type', {
        input: 'x'.repeat(1024 * 1024 + 1)
      })
    ).toThrow('Invalid browser type input')
  })

  it('resolves and focuses native select option indexes without changing the value', async () => {
    document.body.innerHTML = `
      <select id="native-select">
        <option value="one">One</option>
        <option value="two">Two</option>
      </select>
    `
    const select = document.querySelector<HTMLSelectElement>('#native-select')!
    const result = await new Function(
      `return ${buildTauriBrowserDomAutomationScript('resolveSelectOption', {
        element: '#native-select',
        value: 'two'
      })}`
    )()

    expect(result).toEqual({
      element: '#native-select',
      index: 1,
      multiple: false,
      text: 'Two',
      value: 'two'
    })
    expect(document.activeElement).toBe(select)
    expect(select.value).toBe('one')
  })

  it('resolves multi-select option geometry and only reads native selection state', async () => {
    document.body.innerHTML = `
      <select id="native-multi" multiple size="3">
        <option value="alpha">Alpha</option>
        <option value="beta" selected>Beta</option>
        <option value="gamma">Gamma option</option>
      </select>
    `
    const select = document.querySelector<HTMLSelectElement>('#native-multi')!
    const option = select.options[2]!
    select.getBoundingClientRect = () => ({ left: 20, top: 40, width: 180, height: 90 }) as DOMRect
    option.getBoundingClientRect = () => ({ left: 20, top: 100, width: 180, height: 30 }) as DOMRect
    option.scrollIntoView = vi.fn()

    const resolved = await new Function(
      `return ${buildTauriBrowserDomAutomationScript('resolveSelectOption', {
        element: '#native-multi',
        value: 'Gamma option'
      })}`
    )()
    expect(resolved).toEqual({
      element: '#native-multi',
      index: 2,
      multiple: true,
      value: 'gamma',
      x: 110,
      y: 115
    })
    expect(option.scrollIntoView).toHaveBeenCalled()
    expect(Array.from(select.selectedOptions, (entry) => entry.value)).toEqual(['beta'])

    await expect(
      new Function(
        `return ${buildTauriBrowserDomAutomationScript('readSelectValues', {
          element: '#native-multi'
        })}`
      )()
    ).resolves.toEqual({
      element: '#native-multi',
      multiple: true,
      values: ['beta']
    })
    await expect(
      new Function(
        `return ${buildTauriBrowserDomAutomationScript('select', {
          element: '#native-multi',
          values: ['alpha', 'gamma']
        })}`
      )()
    ).rejects.toThrow('requires native keyboard or mouse input')
    expect(Array.from(select.selectedOptions, (entry) => entry.value)).toEqual(['beta'])
  })

  it('preserves horizontal scroll directions', () => {
    expect(
      buildTauriBrowserDomAutomationScript('scroll', {
        direction: 'left',
        amount: 400
      })
    ).toContain('"direction":"left"')
    expect(
      buildTauriBrowserDomAutomationScript('scroll', {
        direction: 'right',
        amount: 400
      })
    ).toContain('"direction":"right"')
  })

  it('snapshots and clicks a live guest DOM through the same ref', async () => {
    document.body.innerHTML = '<button aria-label="Run task">Run</button>'
    const button = document.querySelector('button')!
    button.getBoundingClientRect = () => ({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 80,
      bottom: 24,
      width: 80,
      height: 24,
      toJSON: () => ({})
    })
    let clicked = false
    button.addEventListener('click', () => {
      clicked = true
    })

    const snapshot = (await new Function(
      `return ${buildTauriBrowserDomAutomationScript('snapshot', {})}`
    )()) as { refs: { ref: string }[] }
    expect(snapshot.refs[0]?.ref).toBe('@e1')

    const result = (await new Function(
      `return ${buildTauriBrowserDomAutomationScript('click', { element: '@e1' })}`
    )()) as { clicked: string }
    expect(result).toEqual({ clicked: '@e1' })
    expect(clicked).toBe(true)
  })

  it('clicks and fills live guest elements through CSS selectors', async () => {
    document.body.innerHTML = '<input name="email"><button id="submit">Submit</button>'
    let clicked = false
    document.querySelector('button')!.addEventListener('click', () => {
      clicked = true
    })
    await new Function(
      `return ${buildTauriBrowserDomAutomationScript('fill', {
        element: 'input[name="email"]',
        value: 'hello@example.com'
      })}`
    )()
    await new Function(
      `return ${buildTauriBrowserDomAutomationScript('click', { element: '#submit' })}`
    )()
    expect((document.querySelector('input') as HTMLInputElement).value).toBe('hello@example.com')
    expect(clicked).toBe(true)
  })

  it('counts all CSS selector matches without requiring one element to exist', async () => {
    document.body.innerHTML = '<div class="row"></div><div class="row"></div>'
    await expect(
      new Function(
        `return ${buildTauriBrowserDomAutomationScript('get', {
          what: 'count',
          selector: '.row'
        })}`
      )()
    ).resolves.toMatchObject({ count: 2 })
    await expect(
      new Function(
        `return ${buildTauriBrowserDomAutomationScript('get', {
          what: 'count',
          selector: '.missing'
        })}`
      )()
    ).resolves.toMatchObject({ count: 0 })
  })

  it('resolves select options without mutating them and toggles checkboxes through snapshot refs', async () => {
    document.body.innerHTML = [
      '<select aria-label="Theme"><option value="light">Light</option><option value="dark">Dark</option></select>',
      '<input type="checkbox" aria-label="Enabled">'
    ].join('')
    for (const node of document.querySelectorAll<HTMLElement>('select,input')) {
      node.getBoundingClientRect = () => ({
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 80,
        bottom: 24,
        width: 80,
        height: 24,
        toJSON: () => ({})
      })
    }
    const snapshot = (await new Function(
      `return ${buildTauriBrowserDomAutomationScript('snapshot', {})}`
    )()) as { refs: { ref: string }[] }
    expect(snapshot.refs.map((entry) => entry.ref)).toEqual(['@e1', '@e2'])

    await expect(
      new Function(
        `return ${buildTauriBrowserDomAutomationScript('resolveSelectOption', { element: '@e1', value: 'dark' })}`
      )()
    ).resolves.toMatchObject({
      element: '@e1',
      index: 1,
      multiple: false,
      value: 'dark'
    })
    await new Function(
      `return ${buildTauriBrowserDomAutomationScript('check', { element: '@e2', checked: true })}`
    )()

    expect((document.querySelector('select') as HTMLSelectElement).value).toBe('light')
    expect((document.querySelector('input') as HTMLInputElement).checked).toBe(true)
  })

  it('dispatches hover and selects all text on ref targets', async () => {
    document.body.innerHTML = '<input aria-label="Query" value="pebble">'
    const input = document.querySelector('input')!
    input.getBoundingClientRect = () => ({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 80,
      bottom: 24,
      width: 80,
      height: 24,
      toJSON: () => ({})
    })
    let hovered = false
    input.addEventListener('mouseover', () => {
      hovered = true
    })
    await new Function(`return ${buildTauriBrowserDomAutomationScript('snapshot', {})}`)()
    await new Function(
      `return ${buildTauriBrowserDomAutomationScript('hover', { element: '@e1' })}`
    )()
    await new Function(
      `return ${buildTauriBrowserDomAutomationScript('selectAll', { element: '@e1' })}`
    )()
    expect(hovered).toBe(true)
    expect(input.selectionStart).toBe(0)
    expect(input.selectionEnd).toBe(input.value.length)
  })

  it('dispatches a complete drag sequence between snapshot refs', async () => {
    document.body.innerHTML = '<button>Source</button><button>Target</button>'
    const events: string[] = []
    for (const node of document.querySelectorAll<HTMLElement>('button')) {
      node.getBoundingClientRect = () => ({
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 80,
        bottom: 24,
        width: 80,
        height: 24,
        toJSON: () => ({})
      })
      for (const name of ['dragstart', 'dragenter', 'dragover', 'drop', 'dragend']) {
        node.addEventListener(name, () => events.push(name))
      }
    }
    await new Function(`return ${buildTauriBrowserDomAutomationScript('snapshot', {})}`)()
    const result = (await new Function(
      `return ${buildTauriBrowserDomAutomationScript('drag', { from: '@e1', to: '@e2' })}`
    )()) as { dragged: string; to: string }
    expect(result).toEqual({ dragged: '@e1', to: '@e2' })
    expect(events).toEqual(['dragstart', 'dragenter', 'dragover', 'drop', 'dragend'])
  })

  it('waits for a guest condition and bounds the deadline', async () => {
    document.body.innerHTML = '<main>Loading</main>'
    window.setTimeout(() => {
      document.querySelector('main')!.textContent = 'Ready'
    }, 5)
    const result = await new Function(
      `return ${buildTauriBrowserDomAutomationScript('wait', { text: 'Ready', timeout: 99_999_999 })}`
    )()
    expect(result).toEqual({ waited: true })
    expect(
      buildTauriBrowserDomAutomationScript('wait', {
        selector: '#ready',
        timeout: 99_999_999
      })
    ).toContain('"timeout":120000')
  })

  it('supports bounded fixed-duration waits without treating milliseconds as selectors', async () => {
    vi.useFakeTimers()
    const pending = new Function(
      `return ${buildTauriBrowserDomAutomationScript('wait', { duration: 250 })}`
    )()
    await vi.advanceTimersByTimeAsync(250)
    await expect(pending).resolves.toEqual({ waited: true, duration: 250 })
    vi.useRealTimers()
  })

  it('controls and reads bounded console and network capture state', async () => {
    ;(
      globalThis as typeof globalThis & { __pebbleAutomationCapture?: unknown }
    ).__pebbleAutomationCapture = {
      active: false,
      console: [{ level: 'log', text: 'stale' }],
      network: [{ url: 'https://stale.example' }]
    }
    await new Function(`return ${buildTauriBrowserDomAutomationScript('captureStart', {})}`)()
    const capture = (
      globalThis as typeof globalThis & {
        __pebbleAutomationCapture: {
          active: boolean
          console: unknown[]
          network: unknown[]
        }
      }
    ).__pebbleAutomationCapture
    expect(capture).toEqual({ active: true, console: [], network: [] })
    capture.console.push({ level: 'warn', text: 'one' }, { level: 'error', text: 'two' })
    const result = await new Function(
      `return ${buildTauriBrowserDomAutomationScript('console', { limit: 1 })}`
    )()
    expect(result).toEqual({
      entries: [{ level: 'error', text: 'two' }],
      truncated: true
    })
    await expect(
      new Function(
        `return ${buildTauriBrowserDomAutomationScript('console', { errorsOnly: true, limit: 10 })}`
      )()
    ).resolves.toEqual({
      entries: [{ level: 'error', text: 'two' }],
      truncated: false
    })
    await expect(
      new Function(
        `return ${buildTauriBrowserDomAutomationScript('console', { clear: true, limit: 10 })}`
      )()
    ).resolves.toEqual({ entries: [], cleared: true, truncated: false })
    expect(capture.console).toEqual([])
    capture.network.push(
      {
        id: 'one',
        url: 'https://example.com/api',
        resourceType: 'fetch',
        method: 'POST',
        status: 201
      },
      {
        id: 'two',
        url: 'https://example.com/image',
        resourceType: 'image',
        method: 'GET',
        status: 404
      }
    )
    await expect(
      new Function(
        `return ${buildTauriBrowserDomAutomationScript('network', {
          limit: 10,
          filter: '/api',
          types: ['fetch'],
          method: 'post',
          status: '2xx'
        })}`
      )()
    ).resolves.toEqual({ entries: [capture.network[0]], truncated: false })
    await expect(
      new Function(
        `return ${buildTauriBrowserDomAutomationScript('network', { requestId: 'two' })}`
      )()
    ).resolves.toEqual({ request: capture.network[1] })
    await new Function(`return ${buildTauriBrowserDomAutomationScript('captureStop', {})}`)()
    expect(capture.active).toBe(false)
  })

  it('projects captured requests into a HAR 1.2 recording', async () => {
    ;(
      globalThis as typeof globalThis & { __pebbleAutomationCapture?: unknown }
    ).__pebbleAutomationCapture = { network: [], harStartedAt: null }
    await new Function(`return ${buildTauriBrowserDomAutomationScript('harStart', {})}`)()
    const capture = (
      globalThis as typeof globalThis & {
        __pebbleAutomationCapture: {
          network: Record<string, unknown>[]
          harStartedAt: number | null
        }
      }
    ).__pebbleAutomationCapture
    capture.network.push({
      id: 'request-1',
      url: 'https://example.com/api',
      method: 'POST',
      status: 201,
      resourceType: 'fetch',
      requestHeaders: { accept: 'application/json' },
      responseHeaders: { 'content-type': 'application/json' },
      responseBody: '{"ok":true}',
      timestamp: Date.now()
    })
    const result = await new Function(
      `return ${buildTauriBrowserDomAutomationScript('harStop', {})}`
    )()
    expect(result.har.log).toMatchObject({
      version: '1.2',
      creator: { name: 'Pebble', version: '1' }
    })
    expect(result.har.log.entries[0]).toMatchObject({
      request: { method: 'POST', url: 'https://example.com/api' },
      response: { status: 201, content: { text: '{"ok":true}' } }
    })
    expect(capture.harStartedAt).toBeNull()
  })

})
