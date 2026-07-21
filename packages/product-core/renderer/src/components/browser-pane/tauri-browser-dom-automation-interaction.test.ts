// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { buildTauriBrowserDomAutomationScript } from './tauri-browser-dom-automation'

describe('buildTauriBrowserDomAutomationScript', () => {
  it('reads complete local and session storage snapshots when key is omitted', async () => {
    localStorage.clear()
    sessionStorage.clear()
    localStorage.setItem('theme', 'dark')
    localStorage.setItem('locale', 'zh-CN')
    sessionStorage.setItem('draft', 'ready')
    await expect(
      new Function(`return ${buildTauriBrowserDomAutomationScript('storageLocalGet', {})}`)()
    ).resolves.toEqual({ values: { theme: 'dark', locale: 'zh-CN' } })
    await expect(
      new Function(`return ${buildTauriBrowserDomAutomationScript('storageSessionGet', {})}`)()
    ).resolves.toEqual({ values: { draft: 'ready' } })
  })

  it('copies the current selection and pastes clipboard text into the focused editor', async () => {
    document.body.innerHTML = '<p id="source">Selected text</p><input id="target" value="before-">'
    const writes: string[] = []
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        readText: async () => 'pasted',
        writeText: async (text: string) => {
          writes.push(text)
        }
      }
    })
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: () => false
    })
    const selection = getSelection()!
    const range = document.createRange()
    range.selectNodeContents(document.querySelector('#source')!)
    selection.removeAllRanges()
    selection.addRange(range)
    await expect(
      new Function(`return ${buildTauriBrowserDomAutomationScript('clipboardCopy', {})}`)()
    ).resolves.toEqual({ copied: true, text: 'Selected text' })
    expect(writes).toEqual(['Selected text'])
    ;(document.querySelector('#target') as HTMLInputElement).focus()
    await expect(
      new Function(`return ${buildTauriBrowserDomAutomationScript('clipboardPaste', {})}`)()
    ).resolves.toEqual({ pasted: true, textLength: 6 })
    expect((document.querySelector('#target') as HTMLInputElement).value).toBe('before-pasted')
  })

  it('performs same-document SPA navigation with the History API fallback', async () => {
    history.replaceState({}, '', '/before')
    const result = await new Function(
      `return ${buildTauriBrowserDomAutomationScript('pushState', { url: '/after?ok=1' })}`
    )()
    expect(result).toEqual({ url: `${location.origin}/after?ok=1` })
    expect(location.pathname).toBe('/after')
  })

  it('reads native attributes and refuses to mutate multi-select options through DOM', async () => {
    document.body.innerHTML = `
      <button data-pebble-automation-ref="e1" aria-label="Run"></button>
      <select data-pebble-automation-ref="e2" multiple>
        <option value="alpha">Alpha</option>
        <option value="beta">Beta option</option>
        <option value="gamma">Gamma</option>
      </select>`
    await expect(
      new Function(
        `return ${buildTauriBrowserDomAutomationScript('get', {
          what: 'attr',
          attribute: 'aria-label',
          selector: '@e1'
        })}`
      )()
    ).resolves.toMatchObject({ name: 'aria-label', value: 'Run' })
    await expect(
      new Function(
        `return ${buildTauriBrowserDomAutomationScript('select', {
          element: '@e2',
          values: ['alpha', 'Beta option']
        })}`
      )()
    ).rejects.toThrow('requires native keyboard or mouse input')
    await expect(
      new Function(
        `return ${buildTauriBrowserDomAutomationScript('readSelectValues', { element: '@e2' })}`
      )()
    ).resolves.toEqual({ element: '@e2', multiple: true, values: [] })
    const selected = Array.from(document.querySelectorAll('option'))
      .filter((option) => option.selected)
      .map((option) => option.value)
    expect(selected).toEqual([])
  })

  it('finds first, last, and nth CSS matches with type and hover actions', async () => {
    document.body.innerHTML = `
      <input class="field"><input class="field"><input class="field">
      <button class="card">First</button><button class="card">Last</button>`
    let hovered = false
    document.querySelectorAll('.card')[1].addEventListener('mouseover', () => {
      hovered = true
    })
    await expect(
      new Function(
        `return ${buildTauriBrowserDomAutomationScript('find', {
          locator: 'css',
          position: 'nth',
          index: 2,
          value: '.field',
          action: 'type',
          text: 'third'
        })}`
      )()
    ).resolves.toEqual({ typed: "[data-agent-browser-located='true']" })
    expect((document.querySelectorAll('.field')[2] as HTMLInputElement).value).toBe('third')
    await expect(
      new Function(
        `return ${buildTauriBrowserDomAutomationScript('find', {
          locator: 'css',
          position: 'last',
          value: '.card',
          action: 'hover'
        })}`
      )()
    ).resolves.toEqual({ hovered: "[data-agent-browser-located='true']" })
    expect(hovered).toBe(true)
  })

  it('enables, lists, and disables request interception independently of capture', async () => {
    ;(
      globalThis as typeof globalThis & { __pebbleAutomationCapture?: unknown }
    ).__pebbleAutomationCapture = {
      active: false,
      console: [],
      network: [],
      interceptPatterns: [],
      interceptRoutes: [],
      intercepted: []
    }

    await expect(
      new Function(`return ${buildTauriBrowserDomAutomationScript('interceptEnable', {})}`)()
    ).resolves.toEqual({
      enabled: true,
      patterns: ['**/*'],
      routes: [{ pattern: '**/*', action: 'abort' }]
    })

    const capture = (
      globalThis as typeof globalThis & {
        __pebbleAutomationCapture: {
          active: boolean
          interceptPatterns: string[]
          interceptRoutes: { pattern: string; action: string }[]
          intercepted: unknown[]
        }
      }
    ).__pebbleAutomationCapture
    expect(capture.active).toBe(false)
    capture.intercepted.push({
      id: 'request-1',
      url: 'https://example.com/api'
    })

    await expect(
      new Function(`return ${buildTauriBrowserDomAutomationScript('interceptList', {})}`)()
    ).resolves.toEqual({
      requests: [{ id: 'request-1', url: 'https://example.com/api' }],
      patterns: ['**/*'],
      routes: [{ pattern: '**/*', action: 'abort' }]
    })
    await expect(
      new Function(`return ${buildTauriBrowserDomAutomationScript('interceptDisable', {})}`)()
    ).resolves.toEqual({ disabled: true })
    expect(capture.interceptPatterns).toEqual([])
    expect(capture.interceptRoutes).toEqual([])
  })

  it('bounds request interception patterns', () => {
    expect(() =>
      buildTauriBrowserDomAutomationScript('interceptEnable', {
        patterns: Array.from({ length: 33 }, (_, index) => `https://example.com/${index}`)
      })
    ).toThrow('Browser interception requires 1 to 32 URL patterns')
    expect(() =>
      buildTauriBrowserDomAutomationScript('interceptEnable', {
        patterns: ['x'.repeat(2049)]
      })
    ).toThrow('Invalid browser intercept pattern')
  })

  it('reads, writes, and clears page-scoped browser storage', async () => {
    localStorage.clear()
    sessionStorage.clear()
    await expect(
      new Function(
        `return ${buildTauriBrowserDomAutomationScript('storageLocalSet', {
          key: 'theme',
          value: 'dark'
        })}`
      )()
    ).resolves.toEqual({ key: 'theme', value: 'dark' })
    await expect(
      new Function(
        `return ${buildTauriBrowserDomAutomationScript('storageLocalGet', {
          key: 'theme'
        })}`
      )()
    ).resolves.toEqual({ key: 'theme', value: 'dark' })
    await new Function(
      `return ${buildTauriBrowserDomAutomationScript('storageSessionSet', {
        key: 'tab',
        value: 'one'
      })}`
    )()
    await expect(
      new Function(`return ${buildTauriBrowserDomAutomationScript('storageSessionClear', {})}`)()
    ).resolves.toEqual({ cleared: true })
    expect(sessionStorage.getItem('tab')).toBeNull()
  })

  it('applies document media emulation with reduced-motion styling', async () => {
    const originalMatchMedia = window.matchMedia
    window.matchMedia = ((query: string) => ({
      media: query,
      matches: false,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => true
    })) as typeof window.matchMedia

    await expect(
      new Function(
        `return ${buildTauriBrowserDomAutomationScript('setMedia', {
          colorScheme: 'dark',
          reducedMotion: 'reduce'
        })}`
      )()
    ).resolves.toEqual({
      colorScheme: 'dark',
      reducedMotion: 'reduce',
      scope: 'document'
    })
    expect(document.documentElement.style.colorScheme).toBe('dark')
    expect(window.matchMedia('(prefers-color-scheme: dark)').matches).toBe(true)
    expect(window.matchMedia('(prefers-reduced-motion: reduce)').matches).toBe(true)
    expect(document.querySelector('#pebble-reduced-motion-override')).not.toBeNull()

    await new Function(
      `return ${buildTauriBrowserDomAutomationScript('setMedia', {
        colorScheme: 'no-preference',
        reducedMotion: 'no-preference'
      })}`
    )()
    expect(document.documentElement.style.colorScheme).toBe('')
    expect(document.querySelector('#pebble-reduced-motion-override')).toBeNull()
    window.matchMedia = originalMatchMedia
  })

  it('rejects unsupported media emulation values', () => {
    expect(() =>
      buildTauriBrowserDomAutomationScript('setMedia', {
        colorScheme: 'sepia'
      })
    ).toThrow('Invalid browser color scheme')
    expect(() =>
      buildTauriBrowserDomAutomationScript('setMedia', {
        reducedMotion: 'sometimes'
      })
    ).toThrow('Invalid browser reduced motion')
  })

  it('dispatches coordinate mouse input to the element under the pointer', async () => {
    document.body.innerHTML = '<button>Target</button>'
    const button = document.querySelector('button')!
    const events: string[] = []
    for (const event of ['mousemove', 'mousedown', 'mouseup', 'click', 'wheel']) {
      button.addEventListener(event, () => events.push(event))
    }
    document.elementFromPoint = () => button
    await new Function(
      `return ${buildTauriBrowserDomAutomationScript('mouseMove', { x: 12, y: 18 })}`
    )()
    await new Function(
      `return ${buildTauriBrowserDomAutomationScript('mouseDown', { button: 'left' })}`
    )()
    await new Function(
      `return ${buildTauriBrowserDomAutomationScript('mouseUp', { button: 'left' })}`
    )()
    await new Function(
      `return ${buildTauriBrowserDomAutomationScript('mouseClick', { x: 12, y: 18 })}`
    )()
    await new Function(
      `return ${buildTauriBrowserDomAutomationScript('mouseWheel', { dx: 0, dy: 40 })}`
    )()
    expect(events).toEqual(['mousemove', 'mousedown', 'mouseup', 'click', 'wheel'])
  })

  it('highlights refs or bounded selectors and restores the previous outline', async () => {
    document.body.innerHTML = '<button id="target" style="outline: 1px solid blue">Target</button>'
    const button = document.querySelector('button')!
    await expect(
      new Function(
        `return ${buildTauriBrowserDomAutomationScript('highlight', { selector: '#target' })}`
      )()
    ).resolves.toEqual({ highlighted: '#target' })
    expect(button.style.outlineWidth).toBe('2px')
    expect(button.dataset.pebbleAutomationHighlight).toBeTruthy()
  })

  it('uses the guest page clipboard without reporting fake success', async () => {
    let clipboardText = 'from-page'
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        readText: async () => clipboardText,
        writeText: async (value: string) => {
          clipboardText = value
        }
      }
    })
    await expect(
      new Function(`return ${buildTauriBrowserDomAutomationScript('clipboardRead', {})}`)()
    ).resolves.toEqual({ text: 'from-page' })
    await expect(
      new Function(
        `return ${buildTauriBrowserDomAutomationScript('clipboardWrite', { text: 'pebble' })}`
      )()
    ).resolves.toEqual({ written: true })
    expect(clipboardText).toBe('pebble')
  })

  it('starts downloads through snapshot refs or bounded CSS selectors', async () => {
    document.body.innerHTML = '<a href="data:text/plain,pebble" download="note.txt">Download</a>'
    const link = document.querySelector('a')!
    link.getBoundingClientRect = () => ({
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
    link.addEventListener('click', (event) => {
      event.preventDefault()
      clicked = true
    })
    await new Function(`return ${buildTauriBrowserDomAutomationScript('snapshot', {})}`)()
    await expect(
      new Function(
        `return ${buildTauriBrowserDomAutomationScript('download', { selector: '@e1' })}`
      )()
    ).resolves.toEqual({ clicked: '@e1' })
    expect(clicked).toBe(true)
    clicked = false
    await expect(
      new Function(
        `return ${buildTauriBrowserDomAutomationScript('download', { selector: 'a[download]' })}`
      )()
    ).resolves.toEqual({ clicked: 'a[download]' })
    expect(clicked).toBe(true)
  })

  it('installs persistent geolocation overrides and notifies watchers', async () => {
    const first = await new Function(
      `return ${buildTauriBrowserDomAutomationScript('geolocation', {
        latitude: 31.2304,
        longitude: 121.4737,
        accuracy: 5
      })}`
    )()
    expect(first).toEqual({
      latitude: 31.2304,
      longitude: 121.4737,
      accuracy: 5
    })
    const positions: GeolocationPosition[] = []
    navigator.geolocation.watchPosition((position) => positions.push(position))
    await Promise.resolve()
    await new Function(
      `return ${buildTauriBrowserDomAutomationScript('geolocation', {
        latitude: 22.3193,
        longitude: 114.1694
      })}`
    )()
    await Promise.resolve()
    expect(positions.map((position) => position.coords.latitude)).toEqual([31.2304, 22.3193])
    expect(() =>
      buildTauriBrowserDomAutomationScript('geolocation', {
        latitude: 91,
        longitude: 0
      })
    ).toThrow('Invalid browser geolocation coordinates')
  })

  it('builds bounded file-input upload scripts from native file payloads', () => {
    const script = buildTauriBrowserDomAutomationScript('upload', {
      element: '@e3',
      files: [{ name: 'notes.txt', mimeType: 'text/plain', dataBase64: 'cGViYmxl' }]
    })
    expect(script).toContain("node.type!=='file'")
    expect(script).toContain('new DataTransfer()')
    expect(script).toContain('new File([bytes],file.name')
    expect(script).toContain('setter.call(node,transfer.files)')

    expect(() =>
      buildTauriBrowserDomAutomationScript('upload', {
        element: '@e3',
        files: []
      })
    ).toThrow('Browser upload requires 1 to 16 files')
    expect(() =>
      buildTauriBrowserDomAutomationScript('upload', {
        element: '@e3',
        files: [{ name: 'notes.txt', mimeType: 'text/plain', dataBase64: '' }]
      })
    ).toThrow('Invalid browser upload data')
  })

  it('matches agent-browser get result shapes for page and element properties', async () => {
    document.title = 'Pebble Contract'
    document.body.innerHTML = '<input aria-label="Name" value="Pebble"><button>Run task</button>'
    for (const node of document.querySelectorAll<HTMLElement>('input,button')) {
      node.getBoundingClientRect = () => ({
        x: 4,
        y: 8,
        top: 8,
        left: 4,
        right: 84,
        bottom: 32,
        width: 80,
        height: 24,
        toJSON: () => ({})
      })
    }
    await new Function(`return ${buildTauriBrowserDomAutomationScript('snapshot', {})}`)()

    await expect(
      new Function(`return ${buildTauriBrowserDomAutomationScript('get', { what: 'title' })}`)()
    ).resolves.toEqual({ title: 'Pebble Contract' })
    await expect(
      new Function(
        `return ${buildTauriBrowserDomAutomationScript('get', { what: 'value', selector: '@e1' })}`
      )()
    ).resolves.toMatchObject({ value: 'Pebble' })
    await expect(
      new Function(
        `return ${buildTauriBrowserDomAutomationScript('get', { what: 'text', selector: '@e2' })}`
      )()
    ).resolves.toMatchObject({ text: 'Run task' })
    await expect(
      new Function(
        `return ${buildTauriBrowserDomAutomationScript('get', { what: 'box', selector: '@e2' })}`
      )()
    ).resolves.toMatchObject({ box: { x: 4, y: 8, width: 80, height: 24 } })
  })

  it('matches agent-browser visible, enabled, and checked result shapes', async () => {
    document.body.innerHTML = [
      '<button aria-disabled="false">Enabled</button>',
      '<input type="checkbox" checked>',
      '<button disabled>Disabled</button>'
    ].join('')
    for (const node of document.querySelectorAll<HTMLElement>('button,input')) {
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
    await new Function(`return ${buildTauriBrowserDomAutomationScript('snapshot', {})}`)()

    await expect(
      new Function(
        `return ${buildTauriBrowserDomAutomationScript('is', { what: 'visible', selector: '@e1' })}`
      )()
    ).resolves.toMatchObject({ visible: true })
    await expect(
      new Function(
        `return ${buildTauriBrowserDomAutomationScript('is', { what: 'enabled', selector: '@e1' })}`
      )()
    ).resolves.toMatchObject({ enabled: true })
    await expect(
      new Function(
        `return ${buildTauriBrowserDomAutomationScript('is', { what: 'checked', selector: '@e2' })}`
      )()
    ).resolves.toMatchObject({ checked: true })
    await expect(
      new Function(
        `return ${buildTauriBrowserDomAutomationScript('is', { what: 'enabled', selector: '@e3' })}`
      )()
    ).resolves.toMatchObject({ enabled: false })

    expect(() =>
      buildTauriBrowserDomAutomationScript('is', {
        what: 'selected',
        selector: '@e1'
      })
    ).toThrow('Invalid browser state check')
  })

  it('finds semantic targets and returns agent-browser-compatible action fields', async () => {
    document.body.innerHTML = [
      '<button aria-label="Submit order">Submit</button>',
      '<input aria-label="Email">',
      '<input type="checkbox" data-testid="terms">'
    ].join('')
    let clicked = false
    document.querySelector('button')!.addEventListener('click', () => {
      clicked = true
    })

    await expect(
      new Function(
        `return ${buildTauriBrowserDomAutomationScript('find', {
          locator: 'role',
          value: 'button',
          action: 'click'
        })}`
      )()
    ).resolves.toEqual({ clicked: "[data-agent-browser-located='true']" })
    expect(clicked).toBe(true)
    expect(document.querySelector('[data-agent-browser-located]')).toBeNull()

    await expect(
      new Function(
        `return ${buildTauriBrowserDomAutomationScript('find', {
          locator: 'label',
          value: 'email',
          action: 'fill',
          text: 'test@example.com'
        })}`
      )()
    ).resolves.toEqual({ filled: "[data-agent-browser-located='true']" })
    expect((document.querySelector('[aria-label="Email"]') as HTMLInputElement).value).toBe(
      'test@example.com'
    )

    await expect(
      new Function(
        `return ${buildTauriBrowserDomAutomationScript('find', {
          locator: 'testid',
          value: 'terms',
          action: 'check'
        })}`
      )()
    ).resolves.toMatchObject({
      checked: "[data-agent-browser-located='true']",
      value: true
    })
  })

  it('inserts text into the focused control without keyboard events', async () => {
    document.body.innerHTML = '<input value="Pebble">'
    const input = document.querySelector('input')!
    input.focus()
    let keyEvents = 0
    input.addEventListener('keydown', () => keyEvents++)

    await expect(
      new Function(
        `return ${buildTauriBrowserDomAutomationScript('keyboardInsertText', { text: ' Tauri' })}`
      )()
    ).resolves.toEqual({ inserted: true })
    expect(input.value).toBe('Pebble Tauri')
    expect(keyEvents).toBe(0)
  })

  it('keeps key-down and key-up phases separate for held-key workflows', async () => {
    document.body.innerHTML = '<input>'
    const input = document.querySelector('input')!
    input.focus()
    const events: string[] = []
    input.addEventListener('keydown', (event) => events.push(`down:${event.key}`))
    input.addEventListener('keyup', (event) => events.push(`up:${event.key}`))

    await expect(
      new Function(`return ${buildTauriBrowserDomAutomationScript('keyDown', { key: 'Shift' })}`)()
    ).resolves.toEqual({ keyDown: 'Shift' })
    expect(events).toEqual(['down:Shift'])

    await expect(
      new Function(`return ${buildTauriBrowserDomAutomationScript('keyUp', { key: 'Shift' })}`)()
    ).resolves.toEqual({ keyUp: 'Shift' })
    expect(events).toEqual(['down:Shift', 'up:Shift'])
  })
})
