import type {
  LinearCustomViewSummary,
  LinearIssue,
  LinearProjectDetail,
  LinearProjectSummary
} from '../../../packages/product-core/shared/types'

export type LinearRecord = Record<string, unknown>

export function record(value: unknown): LinearRecord {
  return value && typeof value === 'object' ? (value as LinearRecord) : {}
}

export function records(value: unknown): LinearRecord[] {
  const node = record(value)
  return Array.isArray(node.nodes) ? node.nodes.map(record) : []
}

export function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function optionalText(value: unknown): string | undefined {
  const result = text(value)
  return result || undefined
}

function member(value: unknown) {
  const node = record(value)
  if (!text(node.id)) {
    return undefined
  }
  return {
    id: text(node.id),
    displayName: text(node.displayName),
    avatarUrl: optionalText(node.avatarUrl)
  }
}

export function mapLinearIssue(value: unknown): LinearIssue {
  const node = record(value)
  const state = record(node.state)
  const team = record(node.team)
  const project = record(node.project)
  return {
    id: text(node.id),
    identifier: text(node.identifier),
    title: text(node.title),
    description: optionalText(node.description),
    url: text(node.url),
    state: { name: text(state.name), type: text(state.type), color: text(state.color) },
    team: { id: text(team.id), name: text(team.name), key: text(team.key) },
    ...(text(project.id)
      ? {
          project: {
            id: text(project.id),
            name: text(project.name),
            url: optionalText(project.url),
            color: optionalText(project.color)
          }
        }
      : {}),
    labels: records(node.labels).map((label) => text(label.name)),
    labelIds: records(node.labels).map((label) => text(label.id)),
    assignee: member(node.assignee),
    estimate: typeof node.estimate === 'number' ? node.estimate : null,
    priority: typeof node.priority === 'number' ? node.priority : 0,
    dueDate: typeof node.dueDate === 'string' ? node.dueDate : null,
    updatedAt: text(node.updatedAt)
  }
}

export function mapLinearProject(value: unknown): LinearProjectSummary {
  const node = record(value)
  const status = record(node.status)
  return {
    id: text(node.id),
    name: text(node.name),
    description: optionalText(node.description),
    url: optionalText(node.url),
    color: optionalText(node.color),
    icon: optionalText(node.icon),
    health: optionalText(node.health),
    priority: typeof node.priority === 'number' ? node.priority : undefined,
    priorityLabel: optionalText(node.priorityLabel),
    progress: typeof node.progress === 'number' ? node.progress : undefined,
    scope: typeof node.scope === 'number' ? node.scope : undefined,
    startDate: optionalText(node.startDate),
    targetDate: optionalText(node.targetDate),
    createdAt: optionalText(node.createdAt),
    updatedAt: optionalText(node.updatedAt),
    completedAt: optionalText(node.completedAt),
    canceledAt: optionalText(node.canceledAt),
    startedAt: optionalText(node.startedAt),
    status: text(status.id)
      ? {
          id: text(status.id),
          name: text(status.name),
          type: text(status.type),
          color: text(status.color)
        }
      : undefined,
    lead: member(node.lead),
    members: records(node.members)
      .map(member)
      .filter((entry) => entry !== undefined),
    teams: records(node.teams).map((team) => ({
      id: text(team.id),
      name: text(team.name),
      key: text(team.key)
    })),
    labels: records(node.labels).map((label) => ({
      id: text(label.id),
      name: text(label.name),
      color: text(label.color)
    }))
  }
}

export function mapLinearProjectDetail(value: unknown): LinearProjectDetail {
  const node = record(value)
  return {
    ...mapLinearProject(node),
    content: optionalText(node.content),
    milestones: records(node.projectMilestones).map((item) => ({
      id: text(item.id),
      name: text(item.name),
      status: optionalText(item.status),
      targetDate: optionalText(item.targetDate),
      progress: typeof item.progress === 'number' ? item.progress : undefined
    })),
    resources: records(node.externalLinks).map((item) => ({
      id: text(item.id),
      title: text(item.label),
      url: text(item.url)
    }))
  }
}

export function mapLinearCustomView(value: unknown): LinearCustomViewSummary {
  const node = record(value)
  const team = record(node.team)
  return {
    id: text(node.id),
    name: text(node.name),
    description: optionalText(node.description),
    model: text(node.modelName) === 'Project' ? 'project' : 'issue',
    color: optionalText(node.color),
    icon: optionalText(node.icon),
    shared: node.shared === true,
    createdAt: optionalText(node.createdAt),
    updatedAt: optionalText(node.updatedAt),
    team: text(team.id)
      ? { id: text(team.id), name: text(team.name), key: text(team.key) }
      : undefined,
    owner: member(node.owner),
    creator: member(node.creator)
  }
}
