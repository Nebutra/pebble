// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { buildTauriBrowserDomAutomationScript } from './tauri-browser-dom-automation'

describe('Tauri browser selector routing', () => {
  it('snapshots and routes refs through open shadow roots', async () => {
    document.body.innerHTML = '<section id="shell"></section>'
    const shadow = document.querySelector('#shell')!.attachShadow({ mode: 'open' })
    shadow.innerHTML = '<button>Shadow action</button><input name="query">'
    const button = shadow.querySelector('button')!
    const input = shadow.querySelector('input')!
    for (const node of [button, input]) {
      node.getBoundingClientRect = () => ({ left: 10, top: 20, width: 80, height: 24 }) as DOMRect
    }
    let clicked = false
    button.addEventListener('click', () => {
      clicked = true
    })

    const snapshot = await run('snapshot', { interactive: true })
    expect(snapshot.refs).toEqual([
      { ref: '@e1', role: 'button', name: 'Shadow action' },
      { ref: '@e2', role: 'input', name: 'query' }
    ])
    expect(snapshot.routing).toEqual({ blockedFrames: 0 })

    await run('click', { element: '@e1' })
    await run('fill', {
      element: '#shell >>> input[name="query"]',
      value: 'routed'
    })
    expect(clicked).toBe(true)
    expect(input.value).toBe('routed')
  })

  it('routes through same-origin frames and translates points to the top viewport', async () => {
    document.body.innerHTML = '<iframe id="checkout"></iframe>'
    const frame = document.querySelector('iframe')!
    const frameDocument = frame.contentDocument!
    Object.defineProperty(frameDocument.defaultView, 'frameElement', {
      configurable: true,
      value: frame
    })
    frameDocument.body.innerHTML = '<payment-shell id="payment"></payment-shell>'
    const shadow = frameDocument.querySelector('#payment')!.attachShadow({ mode: 'open' })
    shadow.innerHTML = '<button id="pay">Pay</button>'
    const button = shadow.querySelector('button')!
    frame.getBoundingClientRect = () =>
      ({ left: 100, top: 200, width: 300, height: 180 }) as DOMRect
    button.getBoundingClientRect = () => ({ left: 20, top: 30, width: 80, height: 40 }) as DOMRect
    button.scrollIntoView = vi.fn()
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })

    const snapshot = await run('snapshot', { interactive: true })
    expect(snapshot.refs).toEqual([{ ref: '@e1', role: 'button', name: 'Pay' }])
    await expect(
      run('resolvePoint', {
        element: '#checkout >>> #payment >>> #pay',
        focus: true
      })
    ).resolves.toEqual({
      element: '#checkout >>> #payment >>> #pay',
      x: 160,
      y: 250
    })
  })

  it('rejects cross-origin frame routes without top-document fallback', async () => {
    document.body.innerHTML = '<iframe id="remote"></iframe><button id="submit">Top</button>'
    Object.defineProperty(document.querySelector('iframe')!, 'contentDocument', {
      configurable: true,
      value: null
    })

    await expect(run('click', { element: '#remote >>> #submit' })).rejects.toThrow(
      'cross-origin or unavailable frame'
    )
    await expect(run('get', { what: 'count', selector: '#submit' })).resolves.toMatchObject({
      count: 1,
      incomplete: true,
      blockedFrames: 1
    })
  })

  it('rejects ambiguous routes and closed shadow roots explicitly', async () => {
    document.body.innerHTML =
      '<div class="host"></div><div class="host"></div><div id="closed"></div>'
    for (const host of document.querySelectorAll('.host')) {
      host.attachShadow({ mode: 'open' })
    }
    document.querySelector('#closed')!.attachShadow({ mode: 'closed' })

    await expect(run('click', { element: '.host >>> button' })).rejects.toThrow(
      'route segment is ambiguous'
    )
    await expect(run('click', { element: '#closed >>> button' })).rejects.toThrow(
      'does not expose an open shadow root'
    )
  })

  it('rejects stale refs from routed roots', async () => {
    document.body.innerHTML = '<div id="host"></div>'
    const shadow = document.querySelector('#host')!.attachShadow({ mode: 'open' })
    shadow.innerHTML = '<button>Temporary</button>'
    shadow.querySelector('button')!.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 80, height: 24 }) as DOMRect
    await run('snapshot', { interactive: true })
    shadow.querySelector('button')!.remove()

    await expect(run('click', { element: '@e1' })).rejects.toThrow('Browser element ref is stale')
  })
})

function run(
  command: Parameters<typeof buildTauriBrowserDomAutomationScript>[0],
  payload: Record<string, unknown>
) {
  return new Function(`return ${buildTauriBrowserDomAutomationScript(command, payload)}`)()
}
