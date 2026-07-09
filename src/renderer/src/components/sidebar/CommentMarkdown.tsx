import React, { Suspense } from 'react'
import { cn } from '@/lib/utils'
import { lazyWithRetry as lazy } from '@/lib/lazy-with-retry'
import type { CommentMarkdownProps } from './comment-markdown-props'

export type { CommentMarkdownLinkClickHandler } from './comment-markdown-props'
export { remarkGitHubReferences } from './remark-github-references'

// Why lazy: the react-markdown + remark/rehype-raw pipeline (micromark, parse5,
// dompurify — ~600KB) is only ever needed to render comment bodies, none of which
// are first-paint. Splitting it here keeps it out of the entry chunk for every
// call site at once, shrinking startup JS parse cost.
const CommentMarkdownRenderer = lazy(() => import('./CommentMarkdownRenderer'), {
  reloadKey: 'comment-markdown'
})

// Plain-text fallback that preserves author newlines while the markdown chunk
// loads — matches the pre-markdown renderer's whitespace-pre-wrap behavior.
const CommentMarkdown = React.memo(
  React.forwardRef<HTMLDivElement, CommentMarkdownProps>(function CommentMarkdown(props, ref) {
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
        <CommentMarkdownRenderer ref={ref} {...props} />
      </Suspense>
    )
  })
)

export default CommentMarkdown
