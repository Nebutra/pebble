import { i18n } from '@/i18n/i18n'
import { PRODUCT_NAME, PRODUCT_NAME_UPPER } from './product-brand'

const BRAND_PATTERN = /\bPEBBLE\b|\bPebble\b/g
const BRANDABLE_ATTRIBUTES = ['aria-label', 'title', 'placeholder'] as const
const SKIP_TEXT_TAGS = new Set(['CODE', 'KBD', 'PRE', 'SCRIPT', 'STYLE', 'TEXTAREA'])

let i18nBrandingInstalled = false

export function installPebbleI18nBranding(): void {
  if (i18nBrandingInstalled) {
    return
  }
  i18nBrandingInstalled = true

  const originalT = i18n.t.bind(i18n)
  i18n.t = ((...args: Parameters<typeof i18n.t>) =>
    applyPebbleBranding(originalT(...args))) as typeof i18n.t

  const originalGetFixedT = i18n.getFixedT.bind(i18n)
  i18n.getFixedT = ((...args: Parameters<typeof i18n.getFixedT>) => {
    const fixedT = originalGetFixedT(...args)
    return ((...fixedArgs: Parameters<typeof fixedT>) =>
      applyPebbleBranding(fixedT(...fixedArgs))) as typeof fixedT
  }) as typeof i18n.getFixedT
}

export function installPebbleDomBranding(root: HTMLElement): void {
  brandElementTree(root)
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      brandMutation(mutation)
    }
  })
  observer.observe(root, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: [...BRANDABLE_ATTRIBUTES]
  })
}

function brandMutation(mutation: MutationRecord): void {
  if (mutation.type === 'characterData') {
    brandTextNode(mutation.target)
    return
  }
  if (mutation.type === 'attributes' && mutation.target instanceof HTMLElement) {
    brandElementAttributes(mutation.target)
    return
  }
  for (const node of mutation.addedNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      brandTextNode(node)
    } else if (node instanceof HTMLElement) {
      brandElementTree(node)
    }
  }
}

function brandElementTree(root: HTMLElement): void {
  brandElementAttributes(root)
  for (const element of root.querySelectorAll<HTMLElement>('*')) {
    brandElementAttributes(element)
  }

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement
      if (!parent || SKIP_TEXT_TAGS.has(parent.tagName)) {
        return NodeFilter.FILTER_REJECT
      }
      return NodeFilter.FILTER_ACCEPT
    }
  })
  let current = walker.nextNode()
  while (current) {
    brandTextNode(current)
    current = walker.nextNode()
  }
}

function brandElementAttributes(element: HTMLElement): void {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    return
  }
  for (const attribute of BRANDABLE_ATTRIBUTES) {
    const value = element.getAttribute(attribute)
    if (!value) {
      continue
    }
    const branded = applyPebbleBrandingToString(value)
    if (branded !== value) {
      element.setAttribute(attribute, branded)
    }
  }
}

function brandTextNode(node: Node): void {
  const value = node.nodeValue
  if (!value || !BRAND_PATTERN.test(value)) {
    BRAND_PATTERN.lastIndex = 0
    return
  }
  BRAND_PATTERN.lastIndex = 0
  // Why: Pebble intentionally reuses Pebble's renderer for pixel parity; branding
  // is applied at the shell boundary until the fork owns its own copy deck.
  node.nodeValue = applyPebbleBrandingToString(value)
}

function applyPebbleBranding(value: unknown): unknown {
  if (typeof value === 'string') {
    return applyPebbleBrandingToString(value)
  }
  if (Array.isArray(value)) {
    return value.map(applyPebbleBranding)
  }
  return value
}

function applyPebbleBrandingToString(value: string): string {
  BRAND_PATTERN.lastIndex = 0
  return value.replace(BRAND_PATTERN, (match) =>
    match === 'PEBBLE' ? PRODUCT_NAME_UPPER : PRODUCT_NAME
  )
}
