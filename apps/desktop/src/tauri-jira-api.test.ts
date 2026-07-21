import { invoke } from '@tauri-apps/api/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPebbleJiraApi } from './tauri-jira-api'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
const nativeInvoke = vi.mocked(invoke)
const site = {
  id: 'site-1',
  siteUrl: 'https://pebble.atlassian.net',
  email: 'dev@nebutra.com',
  displayName: 'Pebble Jira',
  accountId: 'viewer-1'
}

describe('createPebbleJiraApi', () => {
  beforeEach(() => nativeInvoke.mockReset())

  it('maps native multi-site search records into canonical issues', async () => {
    nativeInvoke
      .mockResolvedValueOnce({ connected: true, sites: [site], selectedSiteId: 'all' })
      .mockResolvedValueOnce({
        status: 200,
        body: {
          issues: [
            {
              id: '100',
              key: 'PEB-1',
              fields: {
                summary: 'Ship Pebble',
                project: { id: '1', key: 'PEB', name: 'Pebble' },
                issuetype: { id: '2', name: 'Task' },
                status: {
                  id: '3',
                  name: 'Doing',
                  statusCategory: { key: 'indeterminate', name: 'In Progress' }
                },
                labels: ['native'],
                created: '2026-01-01T00:00:00Z',
                updated: '2026-01-02T00:00:00Z'
              }
            }
          ]
        }
      })

    await expect(
      createPebbleJiraApi().searchIssues({ jql: 'project = PEB', siteId: 'all' })
    ).resolves.toMatchObject([
      { key: 'PEB-1', title: 'Ship Pebble', siteId: 'site-1', labels: ['native'] }
    ])
  })

  it('sends create fields and ADF through the native credential boundary', async () => {
    nativeInvoke
      .mockResolvedValueOnce({ connected: true, sites: [site], activeSiteId: site.id })
      .mockResolvedValueOnce({ status: 201, body: { id: '101', key: 'PEB-2' } })

    await expect(
      createPebbleJiraApi().createIssue({
        projectId: '1',
        issueTypeId: '2',
        title: ' Native task ',
        description: 'Details'
      })
    ).resolves.toEqual({
      ok: true,
      id: '101',
      key: 'PEB-2',
      url: 'https://pebble.atlassian.net/browse/PEB-2'
    })
    expect(nativeInvoke).toHaveBeenLastCalledWith(
      'jira_request',
      expect.objectContaining({
        input: expect.objectContaining({
          method: 'POST',
          path: '/rest/api/3/issue',
          body: expect.objectContaining({
            fields: expect.objectContaining({
              summary: 'Native task',
              description: expect.objectContaining({ type: 'doc' })
            })
          })
        })
      })
    )
  })
})
