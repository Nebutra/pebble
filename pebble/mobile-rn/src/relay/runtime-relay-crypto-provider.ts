import {
  canUseWebCryptoRelayCrypto,
  createWebCryptoRelayCryptoProvider,
  RelayCryptoProvider,
  RelayCryptoSelfTestResult,
  selfTestWebCryptoRelayCrypto,
} from './relay-crypto'
import { createNativeRelayCryptoProvider } from './relay-native-crypto'

export function createRuntimeRelayCryptoProvider(): RelayCryptoProvider | undefined {
  const providers = createRuntimeRelayCryptoProviders()

  if (providers.length === 0) {
    return undefined
  }
  if (providers.length === 1) {
    return providers[0]
  }

  return {
    async createHandshake(input) {
      let lastError: unknown

      for (const provider of providers) {
        try {
          return await provider.createHandshake(input)
        } catch (error) {
          lastError = error
        }
      }

      throw lastError
    },
    async selfTest() {
      return selfTestRuntimeRelayCrypto()
    },
  }
}

export async function selfTestRuntimeRelayCrypto(): Promise<RelayCryptoSelfTestResult> {
  let lastError: unknown

  for (const provider of createRuntimeRelayCryptoProviders()) {
    if (provider.selfTest === undefined) {
      continue
    }

    try {
      return await provider.selfTest()
    } catch (error) {
      lastError = error
    }
  }

  if (lastError !== undefined) {
    throw lastError
  }

  throw new Error('Relay crypto requires WebCrypto or a native crypto provider')
}

function createRuntimeRelayCryptoProviders(): RelayCryptoProvider[] {
  return [
    createNativeRelayCryptoProvider(),
    canUseWebCryptoRelayCrypto() ? createWebCryptoRelayCryptoProvider() : undefined,
  ].filter((provider): provider is RelayCryptoProvider => provider !== undefined)
}
