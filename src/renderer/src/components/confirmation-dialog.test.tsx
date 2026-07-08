// @vitest-environment happy-dom

import { act, useEffect, type ComponentProps, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConfirmationDialogProvider, useConfirmationDialog } from './confirmation-dialog'

const mocks = vi.hoisted(() => ({
  setContextualToursBlockingSurfaceVisible: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      setContextualToursBlockingSurfaceVisible:
        mocks.setContextualToursBlockingSurfaceVisible
    })
}))

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>
}))

vi.mock('@/components/ui/button', () => ({
  Button: ({ children, ...props }: ComponentProps<'button'>) => (
    <button type="button" {...props}>
      {children}
    </button>
  )
}))

afterEach(() => {
  document.body.innerHTML = ''
  vi.clearAllMocks()
})

function AutoConfirmRequester({
  onResult
}: {
  onResult: (result: Promise<boolean>) => void
}): null {
  const confirm = useConfirmationDialog()
  useEffect(() => {
    onResult(confirm({ title: 'Delete comment?' }))
  }, [confirm, onResult])
  return null
}

describe('ConfirmationDialogProvider', () => {
  it('resolves pending confirmations as cancelled when the provider unmounts', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root: Root = createRoot(container)
    let result: Promise<boolean> | null = null

    await act(async () => {
      root.render(
        <ConfirmationDialogProvider>
          <AutoConfirmRequester
            onResult={(nextResult) => {
              result = nextResult
            }}
          />
        </ConfirmationDialogProvider>
      )
    })

    expect(result).not.toBeNull()

    await act(async () => {
      root.unmount()
    })

    await expect(result).resolves.toBe(false)
  })
})
