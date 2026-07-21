export function parseShellArguments(input: string): string[] {
  const args: string[] = []
  let current = ''
  let quote: 'single' | 'double' | null = null
  let escaped = false
  let tokenStarted = false

  for (const character of input) {
    if (escaped) {
      current += character
      tokenStarted = true
      escaped = false
      continue
    }
    if (character === '\\' && quote !== 'single') {
      escaped = true
      tokenStarted = true
      continue
    }
    if (character === '"' && quote !== 'single') {
      quote = quote === 'double' ? null : 'double'
      tokenStarted = true
      continue
    }
    if (character === "'" && quote !== 'double') {
      quote = quote === 'single' ? null : 'single'
      tokenStarted = true
      continue
    }
    if (/\s/.test(character) && quote === null) {
      if (tokenStarted) {
        args.push(current)
      }
      current = ''
      tokenStarted = false
      continue
    }
    current += character
    tokenStarted = true
  }
  if (escaped || quote !== null) {
    throw new Error('Browser exec command has an unterminated quote.')
  }
  if (tokenStarted) {
    args.push(current)
  }
  return args
}
