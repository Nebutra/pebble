import { invoke } from '@tauri-apps/api/core'
import type { PreloadApi } from '../../../packages/product-core/shared/preload-api-types'
import { linearDocuments } from './tauri-linear-graphql-documents'
import {
  mapLinearCustomView,
  mapLinearIssue,
  mapLinearProject,
  mapLinearProjectDetail,
  record,
  records,
  text
} from './tauri-linear-record-mapping'
import {
  collect,
  issueFilter,
  limit,
  oneWorkspace,
  request,
  status
} from './tauri-linear-workspace-request'

export function createPebbleLinearApi(): PreloadApi['linear'] {
  return {
    connect: (args) => invoke('linear_connect', { input: { apiKey: args.apiKey.trim() } }),
    disconnect: (args) => invoke('linear_disconnect', { input: args }),
    selectWorkspace: (args) => invoke('linear_select_workspace', { input: args }),
    status,
    testConnection: (args) => invoke('linear_test_connection', { input: args }),
    searchIssues: async ({ query, limit: count, workspaceId }) => {
      const result = await collect(workspaceId, async (id) => {
        const data = await request(id, linearDocuments.searchIssues, {
          term: query,
          first: limit(count)
        })
        return records(data.searchIssues).map(mapLinearIssue)
      })
      if (result.errors?.length && result.items.length === 0) {
        throw new Error(result.errors.map((error) => error.message).join('; '))
      }
      return result.items.slice(0, limit(count))
    },
    listIssues: async (args) =>
      collect(args?.workspaceId, async (id) => {
        const first = limit(args?.limit, 30)
        const document =
          args?.filter === 'assigned'
            ? linearDocuments.viewerAssigned
            : args?.filter === 'created'
              ? linearDocuments.viewerCreated
              : linearDocuments.issues
        const data = await request(id, document, { first, filter: issueFilter(args?.filter) })
        const connection =
          args?.filter === 'assigned'
            ? record(data.viewer).assignedIssues
            : args?.filter === 'created'
              ? record(data.viewer).createdIssues
              : data.issues
        return records(connection).map(mapLinearIssue)
      }),
    createIssue: async (args) => {
      if (!args.teamId.trim()) {
        return { ok: false, error: 'Team ID is required' }
      }
      if (!args.title.trim()) {
        return { ok: false, error: 'Title is required' }
      }
      try {
        const workspaceId = await oneWorkspace(args.workspaceId)
        const input = {
          teamId: args.teamId.trim(),
          title: args.title.trim(),
          description: args.description?.trim() || undefined,
          parentId: args.parentIssueId?.trim() || undefined,
          projectId: args.projectId,
          stateId: args.stateId?.trim() || undefined,
          priority: args.priority,
          assigneeId: args.assigneeId,
          labelIds: args.labelIds
        }
        const data = await request(workspaceId, linearDocuments.issueCreate, { input })
        const payload = record(data.issueCreate)
        const issue = record(payload.issue)
        if (payload.success !== true || !text(issue.id)) {
          return { ok: false, error: 'Linear did not create the issue.' }
        }
        return {
          ok: true,
          id: text(issue.id),
          identifier: text(issue.identifier),
          title: text(issue.title),
          url: text(issue.url)
        }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
    getIssue: async ({ id, workspaceId }) => {
      if (!id.trim()) {
        return null
      }
      const data = await request(await oneWorkspace(workspaceId), linearDocuments.issue, {
        id: id.trim()
      })
      return data.issue ? mapLinearIssue(data.issue) : null
    },
    updateIssue: async ({ id, updates, workspaceId }) => {
      if (!id.trim()) {
        return { ok: false, error: 'Issue ID is required' }
      }
      try {
        const data = await request(await oneWorkspace(workspaceId), linearDocuments.issueUpdate, {
          id: id.trim(),
          input: updates
        })
        return record(data.issueUpdate).success === true
          ? { ok: true }
          : { ok: false, error: 'Linear did not update the issue.' }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
    addIssueComment: async ({ issueId, body, workspaceId }) => {
      if (!issueId.trim()) {
        return { ok: false, error: 'Issue ID is required' }
      }
      if (!body.trim()) {
        return { ok: false, error: 'Comment body is required' }
      }
      try {
        const data = await request(await oneWorkspace(workspaceId), linearDocuments.commentCreate, {
          input: { issueId: issueId.trim(), body: body.trim() }
        })
        const payload = record(data.commentCreate)
        return payload.success === true
          ? { ok: true, id: text(record(payload.comment).id) }
          : { ok: false, error: 'Linear did not add the comment.' }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
    issueComments: async ({ issueId, workspaceId }) => {
      if (!issueId.trim()) {
        return []
      }
      const data = await request(await oneWorkspace(workspaceId), linearDocuments.comments, {
        id: issueId.trim()
      })
      return records(record(data.issue).comments).map((comment) => ({
        id: text(comment.id),
        body: text(comment.body),
        createdAt: text(comment.createdAt),
        updatedAt: text(comment.updatedAt),
        user: {
          id: text(record(comment.user).id),
          displayName: text(record(comment.user).displayName),
          avatarUrl: text(record(comment.user).avatarUrl) || undefined
        }
      }))
    },
    listTeams: async (args) =>
      (
        await collect(args?.workspaceId, async (id) => {
          const data = await request(id, linearDocuments.teams)
          return records(data.teams).map((team) => ({
            id: text(team.id),
            name: text(team.name),
            key: text(team.key),
            description: text(team.description) || undefined,
            icon: text(team.icon) || undefined,
            color: text(team.color) || undefined
          }))
        })
      ).items,
    listProjects: async (args) =>
      collect(args?.workspaceId, async (id) => {
        const query = args?.query?.trim()
        const data = await request(
          id,
          query ? linearDocuments.searchProjects : linearDocuments.projects,
          { first: limit(args?.limit), ...(query ? { term: query } : {}) }
        )
        return records(query ? data.searchProjects : data.projects).map(mapLinearProject)
      }),
    createProject: async (args) => {
      if (!args.name.trim()) {
        return { ok: false, error: 'Project name is required' }
      }
      if (!args.teamIds.length) {
        return { ok: false, error: 'At least one team is required' }
      }
      try {
        const { workspaceId, ...input } = args
        const data = await request(await oneWorkspace(workspaceId), linearDocuments.projectCreate, {
          input: { ...input, name: input.name.trim() }
        })
        const payload = record(data.projectCreate)
        return payload.success === true
          ? { ok: true, project: mapLinearProjectDetail(payload.project) }
          : { ok: false, error: 'Linear did not create the project.' }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
    getProject: async ({ id, workspaceId }) => {
      const data = await request(workspaceId, linearDocuments.project, { id: id.trim() })
      return data.project ? mapLinearProjectDetail(data.project) : null
    },
    listProjectIssues: async ({ projectId, limit: count, workspaceId }) =>
      collect(workspaceId, async (id) => {
        const data = await request(id, linearDocuments.projectIssues, {
          id: projectId.trim(),
          first: limit(count, 30)
        })
        return records(record(data.project).issues).map(mapLinearIssue)
      }),
    listCustomViews: async ({ limit: count, workspaceId }) =>
      collect(workspaceId, async (id) => {
        const data = await request(id, linearDocuments.customViews, { first: limit(count) })
        return records(data.customViews).map(mapLinearCustomView)
      }),
    getCustomView: async ({ viewId, workspaceId }) => {
      const data = await request(workspaceId, linearDocuments.customView, { id: viewId.trim() })
      return data.customView ? mapLinearCustomView(data.customView) : null
    },
    listCustomViewIssues: async ({ viewId, limit: count, workspaceId }) =>
      collect(workspaceId, async (id) => {
        const data = await request(id, linearDocuments.customViewIssues, {
          id: viewId.trim(),
          first: limit(count, 30)
        })
        return records(record(data.customView).issues).map(mapLinearIssue)
      }),
    listCustomViewProjects: async ({ viewId, limit: count, workspaceId }) =>
      collect(workspaceId, async (id) => {
        const data = await request(id, linearDocuments.customViewProjects, {
          id: viewId.trim(),
          first: limit(count)
        })
        return records(record(data.customView).projects).map(mapLinearProject)
      }),
    teamStates: async ({ teamId, workspaceId }) => {
      if (!teamId.trim()) {
        return []
      }
      const data = await request(await oneWorkspace(workspaceId), linearDocuments.teamStates, {
        id: teamId.trim()
      })
      return records(record(data.team).states).map((state) => ({
        id: text(state.id),
        name: text(state.name),
        type: text(state.type),
        color: text(state.color),
        position: typeof state.position === 'number' ? state.position : 0
      }))
    },
    teamLabels: async ({ teamId, workspaceId }) => {
      if (!teamId.trim()) {
        return []
      }
      const data = await request(await oneWorkspace(workspaceId), linearDocuments.teamLabels, {
        id: teamId.trim()
      })
      return records(record(data.team).labels).map((label) => ({
        id: text(label.id),
        name: text(label.name),
        color: text(label.color)
      }))
    },
    teamMembers: async ({ teamId, workspaceId }) => {
      if (!teamId.trim()) {
        return []
      }
      const data = await request(await oneWorkspace(workspaceId), linearDocuments.teamMembers, {
        id: teamId.trim()
      })
      return records(record(data.team).members).map((member) => ({
        id: text(member.id),
        displayName: text(member.displayName),
        avatarUrl: text(member.avatarUrl) || undefined
      }))
    }
  }
}
