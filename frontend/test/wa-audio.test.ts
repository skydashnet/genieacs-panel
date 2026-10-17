import { describe, expect, it } from 'vitest'
import { formatClock, isAudioType, pickRecordingFormat, recordingFileName } from '../src/lib/wa-audio'

describe('isAudioType', () => {
  it('reconhece áudio com ou sem parâmetros', () => {
    expect(isAudioType('audio/ogg; codecs=opus')).toBe(true)
    expect(isAudioType('AUDIO/MPEG')).toBe(true)
    expect(isAudioType('video/mp4')).toBe(false)
    expect(isAudioType(null)).toBe(false)
  })
})

describe('pickRecordingFormat', () => {
  it('prefere OGG/Opus, depois WebM, depois MP4', () => {
    expect(pickRecordingFormat(() => true)?.upload).toBe('audio/ogg')
    expect(pickRecordingFormat((m) => m.startsWith('audio/webm'))?.upload).toBe('audio/webm')
    expect(pickRecordingFormat((m) => m === 'audio/mp4')).toMatchObject({ upload: 'audio/mp4', extension: '.m4a' })
  })

  it('sem nenhum suportado (ou se a consulta lança), não grava', () => {
    expect(pickRecordingFormat(() => false)).toBeNull()
    expect(pickRecordingFormat(() => { throw new Error('x') })).toBeNull()
  })
})

describe('recordingFileName e formatClock', () => {
  it('nomeia pela hora local e conta minutos e segundos', () => {
    expect(recordingFileName(new Date(2026, 9, 3, 13, 7), '.webm')).toBe('audio-2026-10-03-1307.webm')
    expect(formatClock(7)).toBe('0:07')
    expect(formatClock(83.9)).toBe('1:23')
  })
})
