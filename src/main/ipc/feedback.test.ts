import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { fetchMock, handlers } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  handlers: new Map<string, (_event: unknown, args?: unknown) => unknown>()
}))

vi.mock('electron', () => ({
  app: { getVersion: () => '1.2.3-test' },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (_event: unknown, args?: unknown) => unknown) => {
      handlers.set(channel, handler)
    }),
    removeHandler: vi.fn((channel: string) => handlers.delete(channel))
  },
  net: { fetch: (...args: unknown[]) => fetchMock(...args) }
}))

import { registerFeedbackHandlers, submitFeedback } from './feedback'

function okResponse(): Response {
  return { ok: true, status: 200 } as unknown as Response
}

function postedBody(): Record<string, unknown> {
  const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined
  return JSON.parse(String(init?.body)) as Record<string, unknown>
}

describe('submitFeedback', () => {
  beforeEach(() => {
    vi.useRealTimers()
    handlers.clear()
    fetchMock.mockReset()
    fetchMock.mockResolvedValue(okResponse())
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('strips GitHub identity and anonymous contact fields when submitted anonymously', async () => {
    const anonymousArgs = {
      feedback: 'private bug report',
      submitAnonymously: true,
      githubLogin: 'trusted-user',
      githubEmail: 'trusted@example.com',
      anonymousGithubLogin: 'trusted-user',
      anonymousEmail: 'trusted@example.com',
      anonymousX: 'trusted'
    }
    await submitFeedback(anonymousArgs)

    const body = postedBody()
    expect(body).toMatchObject({
      feedback: 'private bug report',
      submissionType: 'feedback',
      githubLogin: null,
      githubEmail: null,
      appVersion: '1.2.3-test'
    })
    expect(body).not.toHaveProperty('anonymousGithubLogin')
    expect(body).not.toHaveProperty('anonymousEmail')
    expect(body).not.toHaveProperty('anonymousX')
  })

  it('preserves verified GitHub identity when not submitted anonymously', async () => {
    await submitFeedback({
      feedback: 'public bug report',
      submitAnonymously: false,
      githubLogin: 'trusted-user',
      githubEmail: 'trusted@example.com'
    })

    const body = postedBody()
    expect(body).toMatchObject({
      feedback: 'public bug report',
      submissionType: 'feedback',
      githubLogin: 'trusted-user',
      githubEmail: 'trusted@example.com',
      appVersion: '1.2.3-test'
    })
  })

  it('preserves crash submissions for the crash report lane', async () => {
    await submitFeedback({
      feedback: '[Crash Report]',
      submissionType: 'crash',
      submitAnonymously: false,
      githubLogin: 'trusted-user',
      githubEmail: null
    } as Parameters<typeof submitFeedback>[0])

    expect(postedBody()).toMatchObject({
      feedback: '[Crash Report]',
      submissionType: 'crash',
      githubLogin: 'trusted-user',
      githubEmail: null
    })
  })

  it('attaches diagnostic bundles only to crash submissions', async () => {
    const diagnosticBundle = {
      bundleSubmissionId: 'bundleabcdefghijklmnop',
      content: '{"type":"bundle-header"}\n',
      bytes: 25,
      spanCount: 1
    }
    await submitFeedback({
      feedback: '[Crash Report]',
      submissionType: 'crash',
      submitAnonymously: true,
      githubLogin: null,
      githubEmail: null,
      diagnosticBundle
    } as Parameters<typeof submitFeedback>[0])
    await submitFeedback({
      feedback: 'normal feedback',
      submitAnonymously: true,
      githubLogin: null,
      githubEmail: null,
      diagnosticBundle
    } as Parameters<typeof submitFeedback>[0])

    const crashInit = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined
    const feedbackInit = fetchMock.mock.calls[1]?.[1] as RequestInit | undefined
    const crashFormData = crashInit?.body as FormData
    expect(crashFormData).toBeInstanceOf(FormData)
    expect(crashInit?.headers).toBeUndefined()
    expect(crashFormData.get('submissionType')).toBe('crash')
    expect(crashFormData.get('diagnosticBundleSubmissionId')).toBe(
      diagnosticBundle.bundleSubmissionId
    )
    expect(crashFormData.get('diagnosticBundleBytes')).toBe(String(diagnosticBundle.bytes))
    expect(crashFormData.get('diagnosticBundleSpanCount')).toBe(String(diagnosticBundle.spanCount))
    const file = crashFormData.get('diagnosticBundleFile')
    expect(file).toBeInstanceOf(Blob)
    await expect((file as Blob).text()).resolves.toBe(diagnosticBundle.content)
    expect(JSON.parse(String(feedbackInit?.body))).not.toHaveProperty('diagnosticBundle')
  })

  it('returns an error when the Nebutra feedback request stalls', async () => {
    vi.useFakeTimers()
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('request aborted')))
      })
    })

    const result = submitFeedback({
      feedback: 'stalled primary',
      submitAnonymously: false,
      githubLogin: 'trusted-user',
      githubEmail: 'trusted@example.com'
    })
    await vi.advanceTimersByTimeAsync(10_000)

    await expect(Promise.race([result, Promise.resolve('pending')])).resolves.toEqual({
      ok: false,
      status: null,
      error: 'request aborted'
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('returns server errors from the Nebutra feedback route without legacy retry', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 } as Response)

    const result = submitFeedback({
      feedback: 'server error',
      submitAnonymously: false,
      githubLogin: 'trusted-user',
      githubEmail: 'trusted@example.com'
    })

    await expect(result).resolves.toEqual({
      ok: false,
      status: 500,
      error: 'status 500'
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('posts crash reports to the Nebutra feedback route', async () => {
    await submitFeedback({
      feedback: '[Crash Report]',
      submissionType: 'crash',
      submitAnonymously: true,
      githubLogin: null,
      githubEmail: null
    } as Parameters<typeof submitFeedback>[0])

    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://www.nebutra.com/pebble/v1/feedback')
  })

  it('forces renderer IPC submissions onto the feedback lane', async () => {
    registerFeedbackHandlers()
    await handlers.get('feedback:submit')?.(null, {
      feedback: 'not a crash report',
      submissionType: 'crash',
      submitAnonymously: false,
      githubLogin: 'trusted-user',
      githubEmail: null
    })

    expect(postedBody()).toMatchObject({
      feedback: 'not a crash report',
      submissionType: 'feedback',
      githubLogin: 'trusted-user',
      githubEmail: null
    })
  })
})
