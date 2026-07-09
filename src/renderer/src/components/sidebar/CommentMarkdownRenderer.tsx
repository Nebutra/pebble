import React from 'react'
import Markdown, { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import { cn } from '@/lib/utils'
import {
  compactCommentMarkdownComponents,
  createCompactCommentMarkdownComponents,
  createDocumentCommentMarkdownComponents,
  documentCommentMarkdownComponents,
  isTrustedCompactImageSrc
} from './comment-markdown-element-renderers'
import type { CommentMarkdownProps } from './comment-markdown-props'
import { remarkGitHubReferences } from './remark-github-references'

type MarkdownPlugins = NonNullable<React.ComponentProps<typeof Markdown>['rehypePlugins']>
type UrlTransform = NonNullable<React.ComponentProps<typeof Markdown>['urlTransform']>

const commentMarkdownUrlTransform: UrlTransform = (value, key, node) => {
  if (key === 'src' && node?.tagName === 'img' && isTrustedCompactImageSrc(value)) {
    return value
  }
  return defaultUrlTransform(value)
}

const commentMarkdownFileUriUrlTransform: UrlTransform = (value, key, node) => {
  if (key === 'href' && node?.tagName === 'a' && value.trim().toLowerCase().startsWith('file:')) {
    return value
  }
  return commentMarkdownUrlTransform(value, key, node)
}

// Why: standard CommonMark collapses single newlines into spaces. The old
// plain-text renderer used whitespace-pre-wrap which preserved them. Adding
// remark-breaks converts single newlines to <br>, keeping backward compat
// with existing plain-text comments that rely on newline formatting.
const remarkPlugins = [remarkGfm, remarkBreaks]

const commentMarkdownSanitizeSchema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), 'details', 'summary', 'sub', 'sup', 'ins', 'kbd'],
  attributes: {
    ...defaultSchema.attributes,
    a: [...(defaultSchema.attributes?.a ?? []), 'href', 'title'],
    details: [...(defaultSchema.attributes?.details ?? []), 'open'],
    img: [...(defaultSchema.attributes?.img ?? []), 'src', 'alt', 'title', 'width', 'height'],
    input: [...(defaultSchema.attributes?.input ?? []), 'type', 'checked', 'disabled'],
    td: [...(defaultSchema.attributes?.td ?? []), 'align'],
    th: [...(defaultSchema.attributes?.th ?? []), 'align']
  },
  protocols: {
    ...defaultSchema.protocols,
    // Why: native chat opts into file URI links after sanitize; the URL
    // transform below still strips them for all other markdown surfaces.
    href: [...(defaultSchema.protocols?.href ?? []), 'file'],
    src: [...(defaultSchema.protocols?.src ?? []), 'data', 'blob']
  }
}

// Why: GitHub comments often include safe raw HTML (`<sub>`, `<details>`,
// `<br />`). Parse it, then sanitize immediately before React renders it.
const rehypePlugins: MarkdownPlugins = [rehypeRaw, [rehypeSanitize, commentMarkdownSanitizeSchema]]

// Why forwardRef + rest props: Radix's HoverCardTrigger asChild merges a ref
// and event handlers (onPointerEnter, onPointerLeave, data-state, etc.) onto
// the child. Without forwarding both, the hover card cannot open or position.
const CommentMarkdownRenderer = React.memo(
  React.forwardRef<HTMLDivElement, CommentMarkdownProps>(function CommentMarkdownRenderer(
    {
      content,
      className,
      variant = 'compact',
      githubRepo,
      onLinkClick,
      allowFileUriLinks = false,
      ...rest
    },
    ref
  ) {
    const components = React.useMemo(() => {
      if (!onLinkClick) {
        return variant === 'document'
          ? documentCommentMarkdownComponents
          : compactCommentMarkdownComponents
      }
      return variant === 'document'
        ? createDocumentCommentMarkdownComponents(onLinkClick)
        : createCompactCommentMarkdownComponents(onLinkClick)
    }, [variant, onLinkClick])
    const activeRemarkPlugins = React.useMemo(
      () => (githubRepo ? [...remarkPlugins, remarkGitHubReferences(githubRepo)] : remarkPlugins),
      [githubRepo]
    )

    return (
      <div
        ref={ref}
        className={cn(
          // Reset inline-code pill styles when <code> is inside a <pre> block.
          // The descendant selector (pre code) has higher specificity than the
          // direct utility classes on <code>, so these overrides win reliably.
          '[&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:rounded-none',
          'min-w-0 max-w-full [overflow-wrap:anywhere]',
          className
        )}
        {...rest}
      >
        <Markdown
          remarkPlugins={activeRemarkPlugins}
          rehypePlugins={rehypePlugins}
          components={components}
          urlTransform={
            allowFileUriLinks ? commentMarkdownFileUriUrlTransform : commentMarkdownUrlTransform
          }
        >
          {content}
        </Markdown>
      </div>
    )
  })
)

export default CommentMarkdownRenderer
