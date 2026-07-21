type TieredPrice = { threshold: number; price: number }
type ModelPricing = {
  input: number
  cachedInput: number
  output: number
  inputTiers?: TieredPrice[]
  cachedInputTiers?: TieredPrice[]
  outputTiers?: TieredPrice[]
}

const LONG_CONTEXT_THRESHOLD_TOKENS = 272_000
const MODEL_PRICING: Record<string, ModelPricing> = {
  'gpt-5': { input: 1.25, cachedInput: 0.125, output: 10 },
  'gpt-5.1': { input: 1.25, cachedInput: 0.125, output: 10 },
  'gpt-5.1-codex': { input: 1.25, cachedInput: 0.125, output: 10 },
  'gpt-5.1-codex-max': { input: 1.25, cachedInput: 0.125, output: 10 },
  'gpt-5.2': { input: 1.75, cachedInput: 0.175, output: 14 },
  'gpt-5.2-codex': { input: 1.75, cachedInput: 0.175, output: 14 },
  'gpt-5.3': { input: 1.75, cachedInput: 0.175, output: 14 },
  'gpt-5.3-codex': { input: 1.75, cachedInput: 0.175, output: 14 },
  'gpt-5.3-codex-spark': { input: 1.75, cachedInput: 0.175, output: 14 },
  'gpt-5.4-mini': { input: 0.75, cachedInput: 0.075, output: 4.5 },
  'gpt-5.4-nano': { input: 0.2, cachedInput: 0.02, output: 1.25 },
  'gpt-5.4-pro': {
    input: 30,
    cachedInput: 30,
    output: 180,
    inputTiers: [{ threshold: LONG_CONTEXT_THRESHOLD_TOKENS, price: 60 }],
    cachedInputTiers: [{ threshold: LONG_CONTEXT_THRESHOLD_TOKENS, price: 60 }],
    outputTiers: [{ threshold: LONG_CONTEXT_THRESHOLD_TOKENS, price: 270 }]
  },
  'gpt-5.4': {
    input: 2.5,
    cachedInput: 0.25,
    output: 15,
    inputTiers: [{ threshold: LONG_CONTEXT_THRESHOLD_TOKENS, price: 5 }],
    cachedInputTiers: [{ threshold: LONG_CONTEXT_THRESHOLD_TOKENS, price: 0.5 }],
    outputTiers: [{ threshold: LONG_CONTEXT_THRESHOLD_TOKENS, price: 22.5 }]
  },
  'gpt-5.5-pro': {
    input: 30,
    cachedInput: 30,
    output: 180,
    inputTiers: [{ threshold: LONG_CONTEXT_THRESHOLD_TOKENS, price: 60 }],
    cachedInputTiers: [{ threshold: LONG_CONTEXT_THRESHOLD_TOKENS, price: 60 }],
    outputTiers: [{ threshold: LONG_CONTEXT_THRESHOLD_TOKENS, price: 270 }]
  },
  'gpt-5.5': {
    input: 5,
    cachedInput: 0.5,
    output: 30,
    inputTiers: [{ threshold: LONG_CONTEXT_THRESHOLD_TOKENS, price: 10 }],
    cachedInputTiers: [{ threshold: LONG_CONTEXT_THRESHOLD_TOKENS, price: 1 }],
    outputTiers: [{ threshold: LONG_CONTEXT_THRESHOLD_TOKENS, price: 45 }]
  }
}

const REASONING_TIERS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'auto', 'none']

function normalizeModel(model: string | null): string | null {
  if (!model) {
    return null
  }
  let normalized = model.toLowerCase().trim()
  const parenthesized = normalized.match(/^(.*)\(([^()]*)\)$/)
  if (parenthesized) {
    if (!REASONING_TIERS.includes(parenthesized[2].trim())) {
      return null
    }
    normalized = parenthesized[1]
  }
  for (let index = 0; index < 4; index++) {
    const suffix = REASONING_TIERS.find((tier) => normalized.endsWith(`-${tier}`))
    if (!suffix) {
      break
    }
    normalized = normalized.slice(0, -suffix.length - 1)
  }
  if (normalized === 'gpt-5' || normalized === 'gpt-5-codex') {
    return 'gpt-5'
  }
  const ordered = [
    'gpt-5.1-codex-max',
    'gpt-5.1-codex',
    'gpt-5.1',
    'gpt-5.2-codex',
    'gpt-5.2',
    'gpt-5.3-codex-spark',
    'gpt-5.3-codex',
    'gpt-5.3',
    'gpt-5.4-mini',
    'gpt-5.4-nano',
    'gpt-5.4-pro',
    'gpt-5.4',
    'gpt-5.5-pro',
    'gpt-5.5'
  ]
  return ordered.find((key) => normalized === key || normalized.startsWith(`${key}-`)) ?? null
}

function tieredCost(tokens: number, base: number, tiers: TieredPrice[] = []): number {
  let cost = 0
  let lower = 0
  let price = base
  for (const tier of tiers) {
    if (tokens <= tier.threshold) {
      return cost + Math.max(tokens - lower, 0) * price
    }
    cost += (tier.threshold - lower) * price
    lower = tier.threshold
    price = tier.price
  }
  return cost + Math.max(tokens - lower, 0) * price
}

export function estimateCodexCostUsd(
  model: string | null,
  inputTokens: number,
  cachedInputTokens: number,
  outputTokens: number
): number | null {
  const normalized = normalizeModel(model)
  if (!normalized) {
    return null
  }
  const pricing = MODEL_PRICING[normalized]
  const cached = Math.min(cachedInputTokens, inputTokens)
  const uncached = Math.max(inputTokens - cached, 0)
  return (
    (tieredCost(uncached, pricing.input, pricing.inputTiers) +
      tieredCost(cached, pricing.cachedInput, pricing.cachedInputTiers) +
      tieredCost(outputTokens, pricing.output, pricing.outputTiers)) /
    1_000_000
  )
}
