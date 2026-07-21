export type BrowserFindInPageOptions = {
  forward?: boolean
  findNext?: boolean
  matchCase?: boolean
  medialCapitalAsWordStart?: boolean
}

export type BrowserFoundInPageEvent = Event & {
  result: {
    requestId: number
    activeMatchOrdinal: number
    matches: number
    finalUpdate: boolean
  }
}

export type BrowserPageWebview = HTMLElement & {
  src: string
  canGoBack: () => boolean
  canGoForward: () => boolean
  findInPage: (text: string, options?: BrowserFindInPageOptions) => number
  getTitle: () => string
  getURL: () => string
  getWebContentsId: () => number
  getZoomLevel: () => number
  goBack: () => void
  goForward: () => void
  reload: () => void
  reloadIgnoringCache: () => void
  stop: () => void
  stopFindInPage: (action: 'clearSelection' | 'keepSelection' | 'activateSelection') => void
  setZoomLevel: (level: number) => void
  addEventListener<TEvent = Event>(
    type: string,
    listener: (event: TEvent) => void,
    options?: boolean | AddEventListenerOptions
  ): void
  removeEventListener<TEvent = Event>(
    type: string,
    listener: (event: TEvent) => void,
    options?: boolean | EventListenerOptions
  ): void
}
