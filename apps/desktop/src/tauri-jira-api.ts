import { invoke } from '@tauri-apps/api/core'
import type { PreloadApi } from '../../../packages/product-core/shared/preload-api-types'
import { textToAdf } from '../../../packages/product-core/shared/jira-adf-markdown'
import {
  mapJiraComment,
  mapJiraCreateField,
  mapJiraIssue,
  mapJiraIssueType,
  mapJiraPriority,
  mapJiraProject,
  mapJiraTransition,
  mapJiraUser,
  record,
  type JiraRecord
} from './tauri-jira-record-mapping'
import {
  filterJql,
  ISSUE_FIELDS,
  limit,
  oneSite,
  type Page,
  paged,
  request,
  search,
  sites,
  status
} from './tauri-jira-site-request'

export function createPebbleJiraApi(): PreloadApi['jira'] {
  return {
    connect: (args) => invoke('jira_connect', { input: args }),
    disconnect: (args) => invoke('jira_disconnect', { input: args }),
    selectSite: (args) => invoke('jira_select_site', { input: args }),
    status,
    testConnection: (args) => invoke('jira_test_connection', { input: args }),
    searchIssues: ({ jql, limit: max, siteId }) => search(jql.trim(), limit(max), siteId),
    listIssues: (args) => search(filterJql(args?.filter), limit(args?.limit), args?.siteId),
    getIssue: async ({ key, siteId }) => {
      const site = await oneSite(siteId)
      if (!site) {
        return null
      }
      try {
        const issue = await request(
          site.id,
          `/rest/api/3/issue/${encodeURIComponent(key)}?fields=${encodeURIComponent(ISSUE_FIELDS)}`
        )
        return mapJiraIssue(site, issue)
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('Error 404:')) {
          return null
        }
        throw error
      }
    },
    createIssue: async (args) => {
      const site = await oneSite(args.siteId)
      if (!site) {
        return { ok: false, error: 'Not connected to Jira.' }
      }
      const title = args.title.trim()
      if (!title) {
        return { ok: false, error: 'Title is required.' }
      }
      const fields: JiraRecord = {
        project: { id: args.projectId },
        issuetype: { id: args.issueTypeId },
        summary: title
      }
      if (args.description?.trim()) {
        fields.description = textToAdf(args.description.trim())
      }
      for (const [key, value] of Object.entries(args.customFields ?? {})) {
        if (key && value !== '' && value != null) {
          fields[key] = value
        }
      }
      try {
        const created = await request<{ id: string; key: string }>(
          site.id,
          '/rest/api/3/issue',
          'POST',
          { fields }
        )
        return {
          ok: true,
          id: created.id,
          key: created.key,
          url: `${site.siteUrl}/browse/${encodeURIComponent(created.key)}`
        }
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : 'Failed to create issue.'
        }
      }
    },
    updateIssue: async ({ key, updates, siteId }) => {
      const site = await oneSite(siteId)
      if (!site) {
        return { ok: false, error: 'Not connected to Jira.' }
      }
      try {
        const fields: JiraRecord = {}
        if (updates.title !== undefined) {
          fields.summary = updates.title
        }
        if (updates.labels !== undefined) {
          fields.labels = updates.labels
        }
        if (updates.priorityId !== undefined) {
          fields.priority = updates.priorityId ? { id: updates.priorityId } : null
        }
        if (Object.keys(fields).length) {
          await request(site.id, `/rest/api/3/issue/${encodeURIComponent(key)}`, 'PUT', { fields })
        }
        if (updates.assigneeAccountId !== undefined) {
          await request(site.id, `/rest/api/3/issue/${encodeURIComponent(key)}/assignee`, 'PUT', {
            accountId: updates.assigneeAccountId
          })
        }
        if (updates.transitionId) {
          await request(
            site.id,
            `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`,
            'POST',
            { transition: { id: updates.transitionId } }
          )
        }
        return { ok: true }
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : 'Failed to update issue.'
        }
      }
    },
    addIssueComment: async ({ key, body, siteId }) => {
      const site = await oneSite(siteId)
      if (!site) {
        return { ok: false, error: 'Not connected to Jira.' }
      }
      try {
        const comment = await request<{ id: string }>(
          site.id,
          `/rest/api/3/issue/${encodeURIComponent(key)}/comment`,
          'POST',
          { body: textToAdf(body) }
        )
        return { ok: true, id: comment.id }
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : 'Failed to add comment.'
        }
      }
    },
    issueComments: async ({ key, siteId }) => {
      const site = await oneSite(siteId)
      if (!site) {
        return []
      }
      const values = await paged(
        site.id,
        (start) =>
          `/rest/api/3/issue/${encodeURIComponent(key)}/comment?maxResults=100&orderBy=created&startAt=${start}`,
        'comments'
      )
      return values.map(mapJiraComment)
    },
    listProjects: async (args) => {
      const connected = await sites(args?.siteId)
      const groups = await Promise.all(
        connected.map(async (site) => {
          const values = await paged(
            site.id,
            (start) => `/rest/api/3/project/search?maxResults=100&startAt=${start}`,
            'values'
          )
          return values.map((value) => mapJiraProject(value, site))
        })
      )
      return groups.flat().sort((a, b) => a.name.localeCompare(b.name))
    },
    listIssueTypes: async ({ projectIdOrKey, siteId }) => {
      const site = await oneSite(siteId)
      if (!site) {
        return []
      }
      const values = await paged(
        site.id,
        (start) =>
          `/rest/api/3/issue/createmeta/${encodeURIComponent(projectIdOrKey)}/issuetypes?maxResults=100&startAt=${start}`,
        'issueTypes'
      )
      return values.map(mapJiraIssueType)
    },
    listCreateFields: async ({ projectIdOrKey, issueTypeId, siteId }) => {
      const site = await oneSite(siteId)
      if (!site) {
        return []
      }
      const response = await request<Page>(
        site.id,
        `/rest/api/3/issue/createmeta/${encodeURIComponent(projectIdOrKey)}/issuetypes/${encodeURIComponent(issueTypeId)}?maxResults=100`
      )
      const values = Array.isArray(response.fields)
        ? response.fields
        : Object.entries(response.fields ?? {}).map(([key, value]) => ({ key, ...record(value) }))
      return values
        .map((value) => mapJiraCreateField(value))
        .filter((value): value is NonNullable<typeof value> => value !== null)
    },
    listPriorities: async ({ siteId } = {}) => {
      const site = await oneSite(siteId)
      if (!site) {
        return []
      }
      return (await request<unknown[]>(site.id, '/rest/api/3/priority'))
        .map(mapJiraPriority)
        .filter((value): value is NonNullable<typeof value> => !!value)
    },
    listAssignableUsers: async ({ key, query, siteId }) => {
      const site = await oneSite(siteId)
      if (!site) {
        return []
      }
      const params = new URLSearchParams({ issueKey: key, maxResults: '50' })
      if (query?.trim()) {
        params.set('query', query.trim())
      }
      return (await request<unknown[]>(site.id, `/rest/api/3/user/assignable/search?${params}`))
        .map(mapJiraUser)
        .filter((value): value is NonNullable<typeof value> => !!value)
    },
    listTransitions: async ({ key, siteId }) => {
      const site = await oneSite(siteId)
      if (!site) {
        return []
      }
      const response = await request<{ transitions?: unknown[] }>(
        site.id,
        `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`
      )
      return (response.transitions ?? []).map(mapJiraTransition)
    }
  }
}
