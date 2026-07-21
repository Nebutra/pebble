/// <reference lib="webworker" />

import { parseWarpThemeYaml } from '../../../packages/product-core/shared/warp-themes/parser'

type ParseRequest = Parameters<typeof parseWarpThemeYaml>

self.onmessage = (event: MessageEvent<ParseRequest>) => {
  self.postMessage(parseWarpThemeYaml(...event.data))
}

export {}
