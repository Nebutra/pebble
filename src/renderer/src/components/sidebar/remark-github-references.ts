import type { GitHubRepoReference } from './comment-markdown-props'

type MarkdownTextNode = {
  type: 'text'
  value: string
}

type MarkdownLinkNode = {
  type: 'link'
  url: string
  title: null
  children: MarkdownTextNode[]
}

type MarkdownNode = {
  type: string
  value?: string
  children?: MarkdownNode[]
}

const GITHUB_REFERENCE_PATTERN = /(?:\b([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+))?#([1-9][0-9]*)\b/g

function createGitHubIssueUrl(owner: string, repo: string, number: string): string {
  return `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}`
}

function isEmbeddedGitHubReference(value: string, index: number): boolean {
  if (index === 0) {
    return false
  }
  return /[A-Za-z0-9_./-]/.test(value[index - 1] ?? '')
}

function createGitHubReferenceLinkNode(
  label: string,
  owner: string,
  repo: string,
  number: string
): MarkdownLinkNode {
  return {
    type: 'link',
    url: createGitHubIssueUrl(owner, repo, number),
    title: null,
    children: [{ type: 'text', value: label }]
  }
}

function splitGitHubReferenceText(value: string, defaultRepo: GitHubRepoReference): MarkdownNode[] {
  const parts: MarkdownNode[] = []
  let cursor = 0

  for (const match of value.matchAll(GITHUB_REFERENCE_PATTERN)) {
    const label = match[0]
    const index = match.index ?? 0
    if (isEmbeddedGitHubReference(value, index)) {
      continue
    }

    const owner = match[1] ?? defaultRepo.owner
    const repo = match[2] ?? defaultRepo.repo
    const number = match[3]
    if (!number) {
      continue
    }

    if (index > cursor) {
      parts.push({ type: 'text', value: value.slice(cursor, index) })
    }
    parts.push(createGitHubReferenceLinkNode(label, owner, repo, number))
    cursor = index + label.length
  }

  if (cursor === 0) {
    return [{ type: 'text', value }]
  }
  if (cursor < value.length) {
    parts.push({ type: 'text', value: value.slice(cursor) })
  }
  return parts
}

function transformGitHubReferenceChildren(
  node: MarkdownNode,
  defaultRepo: GitHubRepoReference
): void {
  if (!node.children || node.type === 'link' || node.type === 'image') {
    return
  }

  const nextChildren: MarkdownNode[] = []
  for (const child of node.children) {
    if (child.type === 'text' && child.value !== undefined) {
      // Why: generated agent comments can contain thousands of issue refs;
      // appending iteratively avoids V8's argument-list limit.
      for (const part of splitGitHubReferenceText(child.value, defaultRepo)) {
        nextChildren.push(part)
      }
    } else {
      transformGitHubReferenceChildren(child, defaultRepo)
      nextChildren.push(child)
    }
  }

  node.children = nextChildren
}

export function remarkGitHubReferences(
  defaultRepo: GitHubRepoReference
): () => (tree: MarkdownNode) => void {
  return () => (tree) => transformGitHubReferenceChildren(tree, defaultRepo)
}
