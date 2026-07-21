import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'

type ConfirmationDialogOptions = {
  title: string
  description?: string
  confirmLabel?: string
  cancelLabel?: string
  confirmVariant?: 'default' | 'destructive'
}

type ConfirmationDialogRequest = {
  id: number
  options: ConfirmationDialogOptions
  resolve: (confirmed: boolean) => void
}

type ConfirmationDialogContextValue = (options: ConfirmationDialogOptions) => Promise<boolean>

const ConfirmationDialogContext = createContext<ConfirmationDialogContextValue | null>(null)

type ConfirmationDialogGlobalBridge = {
  providers: ConfirmationDialogContextValue[]
}

const CONFIRMATION_DIALOG_GLOBAL_BRIDGE_KEY = Symbol.for('nebutra.pebble.confirmationDialog')

function getConfirmationDialogGlobalBridge(): ConfirmationDialogGlobalBridge {
  const globalScope = globalThis as typeof globalThis &
    Record<symbol, ConfirmationDialogGlobalBridge | undefined>
  const existingBridge = globalScope[CONFIRMATION_DIALOG_GLOBAL_BRIDGE_KEY]
  if (existingBridge) {
    return existingBridge
  }
  const bridge: ConfirmationDialogGlobalBridge = { providers: [] }
  globalScope[CONFIRMATION_DIALOG_GLOBAL_BRIDGE_KEY] = bridge
  return bridge
}

export function ConfirmationDialogProvider({
  children
}: {
  children: React.ReactNode
}): React.JSX.Element {
  const nextIdRef = useRef(0)
  const [queue, setQueue] = useState<ConfirmationDialogRequest[]>([])
  const activeRequest = queue[0] ?? null
  const activeRequestRef = useRef<ConfirmationDialogRequest | null>(activeRequest)
  const queueRef = useRef<ConfirmationDialogRequest[]>(queue)
  const setContextualToursBlockingSurfaceVisible = useAppStore(
    (s) => s.setContextualToursBlockingSurfaceVisible
  )
  const lastDisplayedRequestRef = useRef<ConfirmationDialogRequest | null>(activeRequest)
  activeRequestRef.current = activeRequest
  queueRef.current = queue
  if (activeRequest) {
    lastDisplayedRequestRef.current = activeRequest
  }
  // Why: Radix keeps dialog content mounted while closing; keep labels stable without a post-render Effect.
  const displayedRequest = activeRequest ?? lastDisplayedRequestRef.current

  useEffect(() => {
    // Why: this provider's dialog is not represented by activeModal. Block
    // contextual tours so they cannot appear behind confirmation prompts.
    setContextualToursBlockingSurfaceVisible(activeRequest !== null)
    return () => setContextualToursBlockingSurfaceVisible(false)
  }, [activeRequest, setContextualToursBlockingSurfaceVisible])

  useEffect(() => {
    return () => {
      // Why: right-sidebar/page providers can unmount while an async caller is
      // awaiting confirmation; resolve false so actions never hang indefinitely.
      for (const request of queueRef.current) {
        request.resolve(false)
      }
      queueRef.current = []
      activeRequestRef.current = null
    }
  }, [])

  const confirm = useCallback<ConfirmationDialogContextValue>((options) => {
    return new Promise((resolve) => {
      const request: ConfirmationDialogRequest = {
        id: nextIdRef.current,
        options,
        resolve
      }
      nextIdRef.current += 1
      setQueue((currentQueue) => [...currentQueue, request])
    })
  }, [])

  useEffect(() => {
    // Why: Vite dev HMR and symlinked worktrees can instantiate sidebar chunks
    // through a different module URL than App. Keep confirmation routing stable.
    const bridge = getConfirmationDialogGlobalBridge()
    bridge.providers = bridge.providers.filter((provider) => provider !== confirm)
    bridge.providers.push(confirm)
    return () => {
      bridge.providers = bridge.providers.filter((provider) => provider !== confirm)
    }
  }, [confirm])

  const settleActiveRequest = useCallback((confirmed: boolean) => {
    const request = activeRequestRef.current
    if (!request) {
      return
    }
    request.resolve(confirmed)
    setQueue((currentQueue) => {
      if (currentQueue[0]?.id === request.id) {
        return currentQueue.slice(1)
      }
      return currentQueue.filter((queuedRequest) => queuedRequest.id !== request.id)
    })
  }, [])

  return (
    <ConfirmationDialogContext.Provider value={confirm}>
      {children}
      <Dialog
        open={activeRequest !== null}
        onOpenChange={(open) => !open && settleActiveRequest(false)}
      >
        <DialogContent showCloseButton={false} className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{displayedRequest?.options.title}</DialogTitle>
            {displayedRequest?.options.description ? (
              <DialogDescription>{displayedRequest.options.description}</DialogDescription>
            ) : null}
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => settleActiveRequest(false)}>
              {displayedRequest?.options.cancelLabel ??
                translate('auto.components.confirmation.dialog.56f5c60e0c', 'Cancel')}
            </Button>
            <Button
              type="button"
              variant={displayedRequest?.options.confirmVariant ?? 'default'}
              onClick={() => settleActiveRequest(true)}
            >
              {displayedRequest?.options.confirmLabel ??
                translate('auto.components.confirmation.dialog.8490e5d36a', 'Confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ConfirmationDialogContext.Provider>
  )
}

export function useConfirmationDialog(): ConfirmationDialogContextValue {
  const confirm = useContext(ConfirmationDialogContext)
  if (confirm) {
    return confirm
  }
  const bridgedProviders = getConfirmationDialogGlobalBridge().providers
  const bridgedConfirm = bridgedProviders.at(-1)
  if (bridgedConfirm) {
    return bridgedConfirm
  }
  throw new Error('useConfirmationDialog must be used inside ConfirmationDialogProvider')
}
