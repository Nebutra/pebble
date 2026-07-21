// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import {
  buildReactInspectionExpression,
  TAURI_REACT_HOOK_SCRIPT
} from './tauri-browser-react-inspection'

type Fiber = Record<string, unknown> & { child?: Fiber | null; sibling?: Fiber | null }

describe('Tauri React inspection scripts', () => {
  it('reads, inspects, records, and classifies live Fiber roots', async () => {
    new Function(TAURI_REACT_HOOK_SCRIPT)()
    const hook = (globalThis as Record<string, unknown>).__REACT_DEVTOOLS_GLOBAL_HOOK__ as {
      inject: (renderer: object) => number
      onCommitFiberRoot: (id: number, root: object) => void
    }
    const suspense: Fiber = { tag: 13, type: { name: 'Suspense' }, memoizedState: {} }
    const app: Fiber = {
      tag: 0,
      type: { name: 'App' },
      memoizedProps: { title: 'Pebble' },
      memoizedState: { memoizedState: 1, next: null },
      _debugHookTypes: ['useState'],
      _debugSource: { fileName: 'App.tsx', lineNumber: 7, columnNumber: 3 },
      child: suspense
    }
    suspense.return = app
    const root = { current: app }
    const renderer = hook.inject({ version: '19' })
    hook.onCommitFiberRoot(renderer, root)

    const run = async (action: string, args: string[] = []) =>
      JSON.parse(await new Function(`return ${buildReactInspectionExpression(action, args)}`)())
    const tree = await run('tree')
    expect(tree.map((node: { name: string }) => node.name)).toEqual(['App', 'Suspense'])
    expect(await run('inspect', [String(tree[0].id)])).toMatchObject({
      name: 'App',
      props: { title: 'Pebble' },
      hooks: [{ id: 0, name: 'useState', value: 1, debugInfoAvailable: true }],
      source: ['App.tsx', 7, 3]
    })
    expect(await run('renders', ['start'])).toMatchObject({ recording: true })
    app.alternate = { memoizedProps: { title: 'Old' } }
    hook.onCommitFiberRoot(renderer, root)
    expect((await run('renders', ['stop'])).components[0]).toMatchObject({
      name: 'App',
      reRenders: 1,
      changes: expect.arrayContaining([
        { type: 'props', name: 'title', prev: 'Old', next: 'Pebble' }
      ])
    })
    expect((await run('suspense', ['--only-dynamic'])).boundaries).toMatchObject([
      {
        name: 'Suspense',
        isSuspended: true,
        dynamic: true,
        classification: 'unknown-suspender',
        recommendation: expect.stringContaining('React development build')
      }
    ])
  })

  it('keeps tree and inspect in the official DevTools element ID space', async () => {
    const hook = (globalThis as Record<string, unknown>).__REACT_DEVTOOLS_GLOBAL_HOOK__ as {
      emit: (event: string, payload: unknown) => void
      rendererInterfaces: Map<number, unknown>
    }
    hook.rendererInterfaces.set(99, {
      flushInitialOperations: () =>
        hook.emit('operations', [99, 1, 4, 3, 65, 112, 112, 1, 42, 5, 0, 0, 1, 0, 0]),
      hasElementWithId: (id: number) => id === 42,
      getDisplayNameForElementID: () => 'App',
      inspectElement: () => ({
        type: 'full-data',
        value: {
          props: { data: { title: 'Pebble' } },
          hooks: { data: [{ id: 0, name: 'State', value: 1 }] },
          state: null,
          owners: [],
          source: [null, 'App.tsx', 7, 3]
        }
      })
    })
    const tree = JSON.parse(
      await new Function(`return ${buildReactInspectionExpression('tree', [])}`)()
    )
    expect(tree).toMatchObject([{ id: 42, name: 'App', parent: 0 }])
    const inspected = JSON.parse(
      new Function(`return ${buildReactInspectionExpression('inspect', ['42'])}`)()
    )
    expect(inspected).toMatchObject({
      devtoolsElementId: 42,
      idSpace: 'react-devtools',
      hooks: [{ id: 0, name: 'State', value: 1 }]
    })
  })
})
