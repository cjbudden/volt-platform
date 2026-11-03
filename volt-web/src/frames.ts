// ============================================================================
//  EXACT FRAMES IN THE CONSOLE (build queue 3.2-3).
//
//  The player shows what the browser decoded, which is close to the frame an
//  editor asked for but not guaranteed to be it: a browser seeks to the nearest
//  decodable picture and the media element's clock is not frame-exact. The
//  server knows exactly (services/frames/, build queue 3.2): it reads only the
//  segment holding frame N and decodes forward to it. So when somebody steps
//  frame by frame while paused, the console shows the SERVER's still of that
//  frame over the player, and its frame number and timecode, and In and Out
//  are taken from that frame, not from the element's clock.
//
//  The timecode maths is a copy of volt-app/src/services/frames/frameIndex.ts
//  (the two must agree; the web app does not import from the API). Drop-frame
//  at 29.97 and 59.94, SMPTE 12M.
// ============================================================================
import { apiRequest } from './api'

export interface Rate { num: number; den: number; fps?: number; dropFrame?: boolean }

const fpsOf = (r: Rate) => r.num / r.den

/** Drop-frame applies to 29.97 and 59.94. */
export function isDropFrame(r: Rate): boolean {
  return r.den === 1001 && (r.num === 30000 || r.num === 60000)
}

/** Milliseconds from the start to the start of frame n. */
export function msOfFrame(r: Rate, n: number): number {
  return (n * r.den * 1000) / r.num
}

/** The frame on screen at `ms` from the start (the last one that began at or before it). */
export function frameAtMs(r: Rate, ms: number): number {
  return Math.max(0, Math.floor((ms * r.num) / (r.den * 1000) + 1e-6))
}

/** Length of one frame in ms. */
export function frameMs(r: Rate): number {
  return (r.den * 1000) / r.num
}

const pad = (n: number) => String(n).padStart(2, '0')

/** HH:MM:SS:FF for frame n (HH:MM:SS;FF in drop-frame). */
export function timecode(r: Rate, n: number): string {
  const nominal = Math.round(fpsOf(r))
  let f = Math.max(0, Math.floor(n))
  const drop = isDropFrame(r)
  if (drop) {
    const d = nominal === 60 ? 4 : 2
    const per10 = nominal * 600 - 9 * d
    const perMin = nominal * 60 - d
    const tens = Math.floor(f / per10), rem = f % per10
    f += 9 * d * tens + (rem > d ? d * Math.floor((rem - d) / perMin) : 0)
  }
  const ff = f % nominal
  const s = Math.floor(f / nominal)
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}${drop ? ';' : ':'}${pad(ff)}`
}

/** GET /api/vod/{id}/frame-index: ready, or queued while it is being made. */
export interface FrameIndexSummary {
  assetId: string
  state?: string
  rate?: Rate
  totalFrames?: number
  durationMs?: number
  firstTimecode?: string
  lastTimecode?: string
}

export interface ExactFrame {
  frame: number
  timecode: string
  ms: number
  /** Recordings only: the frame's start on the wall clock (epoch ms). */
  wallMs?: number
  rate: Rate
  image: { width: number; url: string }
}

export function getVodFrameIndex(assetId: string): Promise<FrameIndexSummary> {
  return apiRequest(`/vod/${encodeURIComponent(assetId)}/frame-index`)
}

export function getVodFrame(assetId: string, n: number, w = 960): Promise<ExactFrame> {
  return apiRequest(`/vod/${encodeURIComponent(assetId)}/frame?n=${Math.max(0, Math.round(n))}&w=${w}`)
}

/** A recording's frame at a wall-clock moment (epoch ms). */
export function getRecordingFrame(recordingId: string, atMs: number, w = 960): Promise<ExactFrame> {
  return apiRequest(`/recordings/${encodeURIComponent(recordingId)}/frame?at=${Math.round(atMs * 1000) / 1000}&w=${w}`)
}
