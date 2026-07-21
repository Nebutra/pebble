import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  normalizeRecordingRelativePath,
  selectVideoMimeType
} from './tauri-browser-video-recording'

describe('Tauri browser video recording', () => {
  beforeEach(() => {
    vi.stubGlobal('MediaRecorder', {
      isTypeSupported: vi.fn((type: string) => type === 'video/webm;codecs=vp8')
    })
  })

  it('selects a supported codec without changing the requested container', () => {
    expect(selectVideoMimeType('webm')).toBe('video/webm;codecs=vp8')
    expect(() => selectVideoMimeType('mp4')).toThrow('cannot encode')
  })

  it('keeps runtime output inside the selected worktree', () => {
    expect(normalizeRecordingRelativePath('./videos/demo.webm')).toBe('videos/demo.webm')
    expect(() => normalizeRecordingRelativePath('../demo.webm')).toThrow('remain inside')
    expect(() => normalizeRecordingRelativePath('/tmp/demo.webm')).toThrow('relative')
  })
})
