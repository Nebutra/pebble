import type {
  JiraComment,
  JiraCreateField,
  JiraIssue,
  JiraIssueType,
  JiraPriority,
  JiraProject,
  JiraSite,
  JiraStatus,
  JiraTransition,
  JiraUser
} from '../../../packages/product-core/shared/types'
import { adfToMarkdownText } from '../../../packages/product-core/shared/jira-adf-markdown'

export type JiraRecord = Record<string, unknown>

export function record(value: unknown): JiraRecord {
  return value && typeof value === 'object' ? (value as JiraRecord) : {}
}

export function string(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function avatar(value: unknown): string | undefined {
  const urls = record(value)
  return string(urls['48x48']) || string(urls['32x32']) || string(urls['24x24']) || undefined
}

export function mapJiraUser(value: unknown): JiraUser | undefined {
  const user = record(value)
  const accountId = string(user.accountId)
  if (!accountId) {
    return undefined
  }
  return {
    accountId,
    displayName: string(user.displayName, 'Unknown'),
    email: typeof user.emailAddress === 'string' ? user.emailAddress : undefined,
    avatarUrl: avatar(user.avatarUrls)
  }
}

export function mapJiraProject(value: unknown, site?: JiraSite): JiraProject {
  const project = record(value)
  return {
    id: string(project.id),
    key: string(project.key),
    name: string(project.name, string(project.key)),
    siteId: site?.id,
    siteName: site?.displayName
  }
}

export function mapJiraIssueType(value: unknown): JiraIssueType {
  const issueType = record(value)
  return {
    id: string(issueType.id),
    name: string(issueType.name, 'Issue'),
    description: string(issueType.description) || undefined,
    iconUrl: string(issueType.iconUrl) || undefined,
    subtask: typeof issueType.subtask === 'boolean' ? issueType.subtask : undefined
  }
}

export function mapJiraStatus(value: unknown): JiraStatus {
  const status = record(value)
  const category = record(status.statusCategory)
  return {
    id: string(status.id),
    name: string(status.name, 'Unknown'),
    categoryKey: string(category.key, 'undefined'),
    categoryName: string(category.name, 'No Category'),
    colorName: string(category.colorName) || undefined
  }
}

export function mapJiraPriority(value: unknown): JiraPriority | undefined {
  const priority = record(value)
  const id = string(priority.id)
  return id
    ? {
        id,
        name: string(priority.name, 'Priority'),
        iconUrl: string(priority.iconUrl) || undefined
      }
    : undefined
}

export function mapJiraIssue(site: JiraSite, value: unknown): JiraIssue {
  const issue = record(value)
  const fields = record(issue.fields)
  const key = string(issue.key)
  return {
    id: string(issue.id, key),
    key,
    siteId: site.id,
    siteName: site.displayName,
    title: string(fields.summary, key || 'Untitled issue'),
    description: adfToMarkdownText(fields.description),
    url: `${site.siteUrl}/browse/${encodeURIComponent(key)}`,
    project: mapJiraProject(fields.project, site),
    issueType: mapJiraIssueType(fields.issuetype),
    status: mapJiraStatus(fields.status),
    labels: Array.isArray(fields.labels)
      ? fields.labels.filter((item): item is string => typeof item === 'string')
      : [],
    assignee: mapJiraUser(fields.assignee),
    reporter: mapJiraUser(fields.reporter),
    priority: mapJiraPriority(fields.priority),
    createdAt: string(fields.created, new Date().toISOString()),
    updatedAt: string(fields.updated, new Date().toISOString())
  }
}

export function mapJiraComment(value: unknown): JiraComment {
  const comment = record(value)
  return {
    id: string(comment.id),
    body: adfToMarkdownText(comment.body),
    createdAt: string(comment.created),
    updatedAt: string(comment.updated) || undefined,
    user: mapJiraUser(comment.author)
  }
}

export function mapJiraTransition(value: unknown): JiraTransition {
  const transition = record(value)
  return {
    id: string(transition.id),
    name: string(transition.name),
    to: mapJiraStatus(transition.to)
  }
}

export function mapJiraCreateField(value: unknown, fallbackKey = ''): JiraCreateField | null {
  const field = record(value)
  const schema = record(field.schema)
  const key =
    string(field.key) ||
    string(field.fieldId) ||
    string(field.id) ||
    string(field.fieldKey) ||
    fallbackKey
  if (!key) {
    return null
  }
  return {
    key,
    name: string(field.name, key),
    required: field.required === true,
    schema: {
      type: string(schema.type) || undefined,
      items: string(schema.items) || undefined,
      custom: string(schema.custom) || undefined
    },
    allowedValues: Array.isArray(field.allowedValues)
      ? field.allowedValues.map((item) => {
          const option = record(item)
          return {
            id: string(option.id) || undefined,
            value: string(option.value) || undefined,
            name: string(option.name) || undefined
          }
        })
      : undefined
  }
}
