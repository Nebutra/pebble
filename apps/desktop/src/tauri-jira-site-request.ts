import { invoke } from '@tauri-apps/api/core'
import type {
  JiraConnectionStatus,
  JiraIssue,
  JiraSite,
  JiraSiteSelection
} from '../../../packages/product-core/shared/types'
import { mapJiraIssue, record, string, type JiraRecord } from './tauri-jira-record-mapping'

type NativeResponse = { status: number; body: unknown }

// Site resolution, REST request plumbing, pagination and search shared by every
// Jira API method; split out of tauri-jira-api.ts to keep that module focused on
// the preload surface.
export type Page = {
  values?: unknown[]
  issueTypes?: unknown[]
  comments?: unknown[]
  fields?: unknown[] | JiraRecord
  total?: number
  isLast?: boolean
  maxResults?: number
}

export const ISSUE_FIELDS =
  'summary,description,project,issuetype,status,assignee,reporter,priority,labels,created,updated'

export async function status(): Promise<JiraConnectionStatus> {
  return invoke('jira_status')
}

export async function request<T>(
  siteId: string,
  path: string,
  method = 'GET',
  body?: unknown
): Promise<T> {
  const response = await invoke<NativeResponse>('jira_request', {
    input: { siteId, path, method, body }
  })
  if (response.status < 200 || response.status >= 300) {
    const payload = record(response.body)
    const messages = Array.isArray(payload.errorMessages) ? payload.errorMessages : []
    throw new Error(`Error ${response.status}: ${string(messages[0], 'Jira request failed')}`)
  }
  return response.body as T
}

export async function sites(selection?: JiraSiteSelection): Promise<JiraSite[]> {
  const connection = await status()
  const selected = selection ?? connection.selectedSiteId ?? connection.activeSiteId
  if (selected === 'all') {
    return connection.sites ?? []
  }
  const site = (connection.sites ?? []).find((entry) => entry.id === selected)
  return site ? [site] : []
}

export async function oneSite(siteId?: string): Promise<JiraSite | undefined> {
  return (await sites(siteId))[0]
}

export function limit(value?: number): number {
  return Math.min(100, Math.max(1, Number.isFinite(value) ? Number(value) : 30))
}

export async function paged(
  siteId: string,
  path: (start: number) => string,
  key: 'values' | 'issueTypes' | 'comments'
): Promise<unknown[]> {
  const output: unknown[] = []
  for (let start = 0, guard = 0; guard < 100; guard += 1) {
    const page = await request<Page>(siteId, path(start))
    const values = Array.isArray(page[key]) ? page[key]! : (page.values ?? [])
    output.push(...values)
    if (
      page.isLast === true ||
      values.length === 0 ||
      (page.total !== undefined && output.length >= page.total)
    ) {
      break
    }
    start += page.maxResults ?? 100
  }
  return output
}

export async function search(
  jql: string,
  max: number,
  selection?: JiraSiteSelection
): Promise<JiraIssue[]> {
  const connected = await sites(selection)
  const results = await Promise.all(
    connected.map(async (site) => {
      try {
        const body = await request<{ issues?: unknown[] }>(
          site.id,
          '/rest/api/3/search/jql',
          'POST',
          {
            jql,
            maxResults: max,
            fields: ISSUE_FIELDS.split(',')
          }
        )
        return (body.issues ?? []).map((issue) => mapJiraIssue(site, issue))
      } catch (error) {
        if (connected.length === 1) {
          throw error
        }
        console.warn(`[jira] ${site.displayName} search failed`, error)
        return []
      }
    })
  )
  return results
    .flat()
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, max)
}

export function filterJql(filter = 'assigned'): string {
  if (filter === 'reported') {
    return 'reporter = currentUser() AND resolution = Unresolved ORDER BY updated DESC'
  }
  if (filter === 'done') {
    return 'assignee = currentUser() AND resolution IS NOT EMPTY ORDER BY updated DESC'
  }
  if (filter === 'all') {
    return 'resolution = Unresolved ORDER BY updated DESC'
  }
  return 'assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC'
}
