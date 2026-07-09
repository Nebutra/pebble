import React, { Suspense } from 'react'
import { cn } from '@/lib/utils'
import { lazyWithRetry as lazy } from '@/lib/lazy-with-retry'
import type { CommentMarkdownProps } from './comment-markdown-props'

export type { CommentMarkdownLinkClickHandler } from './comment-markdown-props'
export { remarkGitHubReferences } from './remark-github-references'

// Why lazy: the react-markdown + remark/rehype-raw pipeline (micromark, parse5,
// dompurify — ~600KB) only renders comment bodies, none of which are first-paint.
// Every entry-reachable call site imports this wrapper so the pipeline is
// code-split out of the desktop-tauri entry chunk at once. Tests and other
// synchronous consumers import ./CommentMarkdown directly instead.
const CommentMarkdown = lazy(() => import('./CommentMarkdown'), {
  reloadKey: 'comment-markdown'
})

// Plain-text fallback that preserves author newlines while the markdown chunk
// loads — matches the pre-markdown renderer's whitespace-pre-wrap behavior.
const CommentMarkdownLazy = React.memo(
  React.forwardRef<HTMLDivElement, CommentMarkdownProps>(function CommentMarkdownLazy(props, ref) {
    return (
      <Suspense
        fallback={
          <div
            className={cn(
              'min-w-0 max-w-full [overflow-wrap:anywhere] whitespace-pre-wrap',
              props.className
            )}
          >
            {props.content}
          </div>
        }
      >
        <CommentMarkdown ref={ref} {...props} />
      </Suspense>
    )
  })
)

export default CommentMarkdownLazy
