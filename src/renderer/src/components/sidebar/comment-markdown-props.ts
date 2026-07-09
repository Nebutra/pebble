import type React from 'react'
import type { CommentMarkdownLinkClickHandler } from './comment-markdown-element-renderers'

export type { CommentMarkdownLinkClickHandler }

export type GitHubRepoReference = {
  owner: string
  repo: string
}

export type CommentMarkdownProps = React.ComponentPropsWithoutRef<'div'> & {
  content: string
  variant?: 'compact' | 'document'
  githubRepo?: GitHubRepoReference | null
  onLinkClick?: CommentMarkdownLinkClickHandler
  allowFileUriLinks?: boolean
}
