import { Loader2 } from 'lucide-react'
import { useState } from 'react'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { translate } from '@/i18n/i18n'

type RuntimeEnvironmentAddressFormProps = {
  environmentId: string
  currentEndpoint: string
  isSaving: boolean
  onCancel: () => void
  onSave: (endpoint: string) => void
}

/**
 * Inline editor for a saved server's address. Mirrors the Add Server form in
 * RuntimeEnvironmentsPane so the two read as one design.
 */
export function RuntimeEnvironmentAddressForm({
  environmentId,
  currentEndpoint,
  isSaving,
  onCancel,
  onSave
}: RuntimeEnvironmentAddressFormProps): React.JSX.Element {
  const [endpoint, setEndpoint] = useState(currentEndpoint)
  const inputId = `runtime-server-address-${environmentId}`
  const helpId = `${inputId}-help`
  const trimmedEndpoint = endpoint.trim()

  return (
    <form
      className="w-full space-y-2 rounded-lg border border-border/50 bg-muted/20 p-3"
      onSubmit={(event) => {
        event.preventDefault()
        onSave(trimmedEndpoint)
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !isSaving) {
          event.stopPropagation()
          onCancel()
        }
      }}
    >
      <div className="space-y-1">
        <Label htmlFor={inputId}>
          {translate(
            'auto.components.settings.RuntimeEnvironmentAddressForm.serverAddress',
            'Server address'
          )}
        </Label>
        <Input
          id={inputId}
          aria-describedby={helpId}
          value={endpoint}
          onChange={(event) => setEndpoint(event.target.value)}
          placeholder={translate(
            'auto.components.settings.RuntimeEnvironmentAddressForm.serverAddressPlaceholder',
            'ws://192.168.1.9:6768'
          )}
          className="h-8 min-w-0 font-mono text-xs"
          autoFocus
          spellCheck={false}
          autoComplete="off"
        />
        <p id={helpId} className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.RuntimeEnvironmentAddressForm.serverAddressHelp',
            'Use this when the server moved to a new address. Pebble keeps the existing pairing, so you do not need a new pairing code.'
          )}
        </p>
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onCancel} disabled={isSaving}>
          {translate('auto.components.settings.RuntimeEnvironmentAddressForm.cancel', 'Cancel')}
        </Button>
        <Button
          type="submit"
          size="sm"
          disabled={isSaving || !trimmedEndpoint || trimmedEndpoint === currentEndpoint}
        >
          {isSaving ? <Loader2 className="animate-spin" /> : null}
          {translate(
            'auto.components.settings.RuntimeEnvironmentAddressForm.saveAddress',
            'Save Address'
          )}
        </Button>
      </div>
    </form>
  )
}
