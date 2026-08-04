// Typed client for the Volt control-plane API (same-origin via the Vite proxy).
let token = ''
export function setToken(t: string) { token = t }
export function getToken() { return token }

async function req(path: string, opts: RequestInit = {}) {
  const r = await fetch('/api' + path, {
    ...opts,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(opts.headers || {}),
    },
  })
  if (!r.ok) {
    let msg = `${r.status}`
    try { msg = (await r.json()).error || msg } catch { try { msg = await r.text() } catch {} }
    throw new Error(msg)
  }
  if (r.status === 204) return null
  return r.json()
}

export interface Group {
  id: string; name: string; profile_name: string | null
  workflow_type: 'transcode' | 'package_only' | null
  packaging: string | null; rungs: { height: number; bitrate_kbps: number }[] | null
  codec_backend: string | null; captions_provider: 'none' | 'whisper' | 'gladia'
  max_channels: number; channel_count: number
}
export interface Channel {
  id: string; name: string; status: string; group_id: string
  enabled?: boolean; recording_retention_days: number | null
  created_at: string; version: number; group_name?: string
}

export const api = {
  login: (email: string, password: string) =>
    req('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  groups: (): Promise<Group[]> => req('/groups'),
  channels: (): Promise<Channel[]> => req('/channels'),
  createChannel: (b: {
    groupId: string; name: string; purchasingMode?: string
    resilienceTier?: string; recordingRetentionDays?: number | null
  }): Promise<Channel> => req('/channels', { method: 'POST', body: JSON.stringify(b) }),
  startStop: (id: string, action: 'start' | 'stop') =>
    req(`/channels/${id}/${action}`, { method: 'POST' }),
}
