// ============================================================================
//  REFRAME API CLIENT (volt-app modules/reframe.ts, volt/REFRAME.md): social
//  formats framed by following the picture. Kept beside the Media Library
//  rather than in api.ts, like libraryApi.ts.
// ============================================================================
import { apiRequest } from '../../api'

export type FormatKey = '9x16' | '1x1' | '4x5'
export type Ease = 'glide' | 'linear' | 'hold'
export type Mode = 'crop' | 'fill'

export interface Key { t: number; cx: number; cy: number; w: number; h: number; ease: Ease; mode: Mode; shot: number; cut?: boolean }
export interface ShotPlan {
  index: number; start: number; end: number; follow: string; followLabel: string; mode: Mode; fits: boolean
  confidence: number; reason: string; chosenBy: 'auto' | 'operator'
}
export interface FramingPath { version: 1; format: FormatKey; crop: { w: number; h: number }; keys: Key[]; shots: ShotPlan[]; confidence: number; needsReview: number[] }
export interface Subject { id: string; kind: 'face' | 'person'; label: string; onScreenSec: number; meanArea: number; shots: number[] }
export interface Shot { index: number; start: number; end: number }

export interface FormatView {
  format: FormatKey; label: string; ratio: string; width: number; height: number; for: string; enabled: boolean
  path: FramingPath | null; overrides: Record<string, { follow: string }>; edited: boolean
  review: 'pending' | 'approved'; approvedAt: string | null; approvedBy: string | null
  render: {
    state: 'none' | 'queued' | 'rendering' | 'ready' | 'failed' | 'stale'; key: string | null; width: number | null; height: number | null
    bytes: number | null; seconds: number | null; renderedAt: string | null; error: string | null
    progress: { state: string; pct: number; note: string | null } | null
  }
}

export interface ReframeView {
  assetId: string; title: string | null; durationMs: number
  media: { file: string | null; hls: string | null }
  audioOnly: boolean
  analysis: {
    state: 'none' | 'queued' | 'running' | 'ready' | 'failed'; error: string | null; analysedAt: string | null
    summary: null | {
      source: { width: number; height: number; fps: number; durationSec: number }
      analysis: { sampleFps: number; seconds: number; engine: Record<string, string> }
      shots: Shot[]; subjects: Subject[]; trackCount: number
    }
    progress: { state: string; pct: number; note: string | null } | null
  }
  settings: { movement: string; fallback: string; priority: string[]; requireApproval: boolean; safeArea: boolean; formats: Record<FormatKey, boolean> }
  formats: FormatView[]
}

export interface TrackStore {
  source: { width: number; height: number; fps: number; durationSec: number }
  analysis: { sampleFps: number }
  shots: Shot[]; subjects: Subject[]
  tracks: { id: string; subject: string; kind: 'face' | 'person'; shot: number; start: number; end: number; samples: [number, number, number, number, number, number][] }[]
}

export type TargetFormat = FormatKey | '16x9'
export interface ReframeSettings {
  formats: Record<FormatKey, boolean>
  priority: ('faces' | 'people' | 'centre')[]
  movement: 'steady' | 'responsive' | 'locked'
  fallback: 'fill' | 'follow'
  safeArea: boolean
  autoAnalyse: boolean
  renderOnPublish: boolean
  requireApproval: boolean
  autoApproveAbove: number | null
  targets: Record<string, TargetFormat>
}
export interface ReframeSettingsView {
  settings: ReframeSettings
  formats: { key: FormatKey; label: string; ratio: string; width: number; height: number; for: string }[]
  platforms: { key: string; label: string; accounts: { platform: string; name: string; external_account: string | null; enabled: boolean }[] }[]
  canEdit: boolean; updatedAt: string | null; updatedBy: string | null
  engine: Record<string, string>
}

const j = (body: unknown): RequestInit => ({ method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const post = (body?: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })

export const reframeApi = {
  view: (id: string): Promise<ReframeView> => apiRequest(`/vod/${id}/reframe`),
  tracks: (id: string): Promise<TrackStore> => apiRequest(`/vod/${id}/reframe/tracks`),
  analyse: (id: string): Promise<{ queued: boolean; jobId: string }> => apiRequest(`/vod/${id}/reframe/analyse`, post()),
  saveKeys: (id: string, f: FormatKey, keys: Key[]) => apiRequest(`/vod/${id}/reframe/formats/${f}`, j({ keys })),
  follow: (id: string, f: FormatKey, shot: number, follow: string | null) =>
    apiRequest(`/vod/${id}/reframe/formats/${f}`, j({ overrides: { [String(shot)]: follow ? { follow } : null } })),
  reset: (id: string, f: FormatKey) => apiRequest(`/vod/${id}/reframe/formats/${f}/reset`, post()),
  approve: (id: string, f: FormatKey) => apiRequest(`/vod/${id}/reframe/formats/${f}/approve`, post()),
  render: (id: string, formats?: FormatKey[]) => apiRequest(`/vod/${id}/reframe/render`, post(formats ? { formats } : {})),
  settings: (): Promise<ReframeSettingsView> => apiRequest('/account-settings/reframe'),
  saveSettings: (patch: Partial<ReframeSettings>): Promise<ReframeSettingsView> =>
    apiRequest('/account-settings/reframe', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) }),
}

/** Where the crop is at time t: the same easing the render uses (volt-app framing.ts sampleAt). */
export function sampleAt(keys: Key[], t: number): { cx: number; cy: number; w: number; h: number; mode: Mode } {
  if (!keys.length) return { cx: 0.5, cy: 0.5, w: 1, h: 1, mode: 'crop' }
  let i = 0
  while (i + 1 < keys.length && keys[i + 1].t <= t) i++
  const k0 = keys[i]
  if (t < k0.t || i + 1 >= keys.length || k0.ease === 'hold') return { cx: k0.cx, cy: k0.cy, w: k0.w, h: k0.h, mode: k0.mode }
  const k1 = keys[i + 1]
  let p = (t - k0.t) / ((k1.t - k0.t) || 1)
  if (k0.ease === 'glide') p = p * p * (3 - 2 * p)
  return { cx: k0.cx + (k1.cx - k0.cx) * p, cy: k0.cy + (k1.cy - k0.cy) * p, w: k0.w, h: k0.h, mode: k0.mode }
}

/** HH:MM:SS:FF */
export function timecode(t: number, fps = 25): string {
  const f = Math.max(0, t)
  const fr = Math.floor((f % 1) * fps)
  const s = Math.floor(f) % 60, m = Math.floor(f / 60) % 60, h = Math.floor(f / 3600)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(h)}:${p(m)}:${p(s)}:${p(fr)}`
}
