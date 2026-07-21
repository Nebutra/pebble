export const PEBBLE_AUTOMATIONS_CHANGED_EVENT = 'pebble:automations-changed'

export function dispatchAutomationsChangedEvent(): void {
  window.dispatchEvent(new Event(PEBBLE_AUTOMATIONS_CHANGED_EVENT))
}
