type DiffOperation = { kind: 'same' | 'add' | 'remove'; line: string }

const MAX_SNAPSHOT_CHARS = 2 * 1024 * 1024
const MAX_DIFF_LINES = 5000

// Myers line diff split out of tauri-browser-diff.ts so the RPC orchestration
// and the diff algorithm stay in separate focused modules.
export function buildTextDiff(before: string, after: string): Record<string, unknown> {
  const operations = diffLines(before, after)
  const additions = operations.filter((entry) => entry.kind === 'add').length
  const removals = operations.filter((entry) => entry.kind === 'remove').length
  const unchanged = operations.filter((entry) => entry.kind === 'same').length
  const body = operations
    .map(
      (entry) => `${entry.kind === 'add' ? '+' : entry.kind === 'remove' ? '-' : ' '}${entry.line}`
    )
    .join('\n')
  return {
    additions,
    removals,
    unchanged,
    changed: additions > 0 || removals > 0,
    diff: `--- before\n+++ after\n@@ -1 +1 @@\n${body}${body ? '\n' : ''}`
  }
}

export function diffLines(before: string, after: string): DiffOperation[] {
  const left = boundedLines(before)
  const right = boundedLines(after)
  if (left.length + right.length > MAX_DIFF_LINES) {
    return [
      ...left.map((line) => ({ kind: 'remove' as const, line })),
      ...right.map((line) => ({ kind: 'add' as const, line }))
    ]
  }
  return myersDiff(left, right)
}

function myersDiff(left: string[], right: string[]): DiffOperation[] {
  const trace: Map<number, number>[] = []
  let frontier = new Map<number, number>([[1, 0]])
  for (let depth = 0; depth <= left.length + right.length; depth += 1) {
    trace.push(new Map(frontier))
    for (let diagonal = -depth; diagonal <= depth; diagonal += 2) {
      let x =
        diagonal === -depth ||
        (diagonal !== depth &&
          (frontier.get(diagonal - 1) ?? -1) < (frontier.get(diagonal + 1) ?? -1))
          ? (frontier.get(diagonal + 1) ?? 0)
          : (frontier.get(diagonal - 1) ?? 0) + 1
      let y = x - diagonal
      while (x < left.length && y < right.length && left[x] === right[y]) {
        x += 1
        y += 1
      }
      frontier.set(diagonal, x)
      if (x >= left.length && y >= right.length) {
        return backtrackDiff(trace, left, right)
      }
    }
  }
  return []
}

function backtrackDiff(
  trace: Map<number, number>[],
  left: string[],
  right: string[]
): DiffOperation[] {
  let x = left.length
  let y = right.length
  const result: DiffOperation[] = []
  for (let depth = trace.length - 1; depth >= 0; depth -= 1) {
    const frontier = trace[depth] ?? new Map<number, number>()
    const diagonal = x - y
    const previousDiagonal =
      diagonal === -depth ||
      (diagonal !== depth &&
        (frontier.get(diagonal - 1) ?? -1) < (frontier.get(diagonal + 1) ?? -1))
        ? diagonal + 1
        : diagonal - 1
    const previousX = frontier.get(previousDiagonal) ?? 0
    const previousY = previousX - previousDiagonal
    while (x > previousX && y > previousY) {
      result.push({ kind: 'same', line: left[x - 1] ?? '' })
      x -= 1
      y -= 1
    }
    if (depth === 0) {
      break
    }
    if (x === previousX) {
      result.push({ kind: 'add', line: right[y - 1] ?? '' })
      y -= 1
    } else {
      result.push({ kind: 'remove', line: left[x - 1] ?? '' })
      x -= 1
    }
  }
  return result.toReversed()
}

function boundedLines(value: string): string[] {
  if (value.length > MAX_SNAPSHOT_CHARS) {
    throw new Error('Browser snapshot exceeds the diff limit.')
  }
  return value ? value.replace(/\r\n/g, '\n').split('\n') : []
}
