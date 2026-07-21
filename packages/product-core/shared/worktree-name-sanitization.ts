/** Sanitize a parallel-universe name for Git refs and filesystem paths. */
export function sanitizeWorktreeName(input: string): string {
  // Why: Git and modern filesystems accept Unicode names; remove only unsafe
  // characters and ref-invalid dot sequences instead of forcing ASCII slugs.
  const sanitized = input
    .trim()
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/-+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[.-]+|[.-]+$/g, '')

  if (!sanitized || sanitized === '.' || sanitized === '..') {
    throw new Error('Invalid worktree name')
  }

  return sanitized
}
