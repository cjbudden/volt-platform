import { useEffect, useMemo, useState } from 'react'
import { api, type Group } from '../api'

const LANGS = [
  { code: 'en', label: 'English' }, { code: 'ms', label: 'Malay' },
  { code: 'zh', label: 'Chinese' }, { code: 'ta', label: 'Tamil' },
]

type Props = { createOpen: boolean; setCreateOpen: (v: boolean) => void; onOpen?: (id: string) => void }

export default function Channels({ createOpen, setCreateOpen, onOpen }: Props) {
  const [channels, setChannels] = useState<any[] | null>(null)
  const [groups, setGroups] = useState<Group[]>([])
  const [filter, setFilter] = useState<'all' | 'transcode' | 'package_only'>('all')

  async function load() {
    const [chs, gs] = await Promise.all([api.channels(), api.groups()])
    const gmap = new Map(gs.map(g => [g.id, g]))
    setChannels(chs.map(c => ({ ...c, _g: gmap.get(c.group_id) })))
    setGroups(gs)
  }
  useEffect(() => { load() }, [])

  const shown = useMemo(() => {
    if (!channels) return channels
    if (filter === 'all') return channels
    return channels.filter(c => c._g?.workflow_type === filter)
  }, [channels, filter])

  const counts = useMemo(() => {
    const c = channels || []
    return {
      all: c.length,
      transcode: c.filter(x => x._g?.workflow_type === 'transcode').length,
      package_only: c.filter(x => x._g?.workflow_type === 'package_only').length,
    }
  }, [channels])

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Channels</h1>
          <p>24×7 live channels. Transcode builds the rendition ladder for you; packaging takes a pre-encoded ladder.</p>
        </div>
        <div className="spacer" />
        <button className="btn primary" onClick={() => setCreateOpen(true)}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><path d="M12 5v14M5 12h14" /></svg>
          New channel
        </button>
      </div>

      {channels === null ? (
        <div className="loading">Loading channels…</div>
      ) : channels.length === 0 ? (
        <EmptyState onCreate={() => setCreateOpen(true)} />
      ) : (
        <>
          <div className="filters">
            <FChip label="All" n={counts.all} on={filter === 'all'} onClick={() => setFilter('all')} />
            <FChip label="Transcode" n={counts.transcode} on={filter === 'transcode'} onClick={() => setFilter('transcode')} />
            <FChip label="Packaging" n={counts.package_only} on={filter === 'package_only'} onClick={() => setFilter('package_only')} />
          </div>
          <ChannelTable channels={shown || []} onChanged={load} onOpen={onOpen} />
        </>
      )}

      {createOpen && (
        <CreateChannel groups={groups} onClose={() => setCreateOpen(false)} onCreated={() => { setCreateOpen(false); load() }} />
      )}
    </>
  )
}

function FChip({ label, n, on, onClick }: { label: string; n: number; on: boolean; onClick: () => void }) {
  return (
    <div className={`chip ${on ? 'active' : ''}`} onClick={onClick}>
      {label}<span className="ct">{n}</span>
    </div>
  )
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="empty">
      <div className="ic">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="7" width="20" height="13" rx="2" /><path d="m17 2-5 5-5-5" /></svg>
      </div>
      <h3>No channels yet</h3>
      <p>Create your first channel to start a live stream. You can make a transcode channel — we build the ABR ladder — or a packaging channel, where you send a pre-encoded ladder and we package it.</p>
      <button className="btn primary" onClick={onCreate} style={{ margin: '0 auto' }}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><path d="M12 5v14M5 12h14" /></svg>
        Create your first channel
      </button>
    </div>
  )
}

const THUMB_BG = ['linear-gradient(135deg,#7dd3fc,#3f7bff)', 'linear-gradient(135deg,#4ade80,#16a34a)', 'linear-gradient(135deg,#c4b5fd,#7c3aed)', 'linear-gradient(135deg,#fca5a5,#ef4444)', 'linear-gradient(135deg,#fdba74,#f97316)']
function initials(name: string) {
  return name.split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?'
}

function ChannelTable({ channels, onChanged, onOpen }: { channels: any[]; onChanged: () => void; onOpen?: (id: string) => void }) {
  const [busy, setBusy] = useState<string | null>(null)
  async function toggle(c: any) {
    setBusy(c.id)
    try { await api.startStop(c.id, c.status === 'live' ? 'stop' : 'start'); await onChanged() }
    finally { setBusy(null) }
  }
  return (
    <div className="card">
      <table>
        <thead>
          <tr>
            <th>Channel</th>
            <th>Type</th>
            <th>Renditions</th>
            <th>Status</th>
            <th>Retention</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {channels.map((c, i) => {
            const wt = c._g?.workflow_type
            const live = c.status === 'live'
            return (
              <tr key={c.id} onClick={() => onOpen?.(c.id)} style={onOpen ? { cursor: 'pointer' } : undefined}>
                <td>
                  <div className="cell-name">
                    <div className="thumb" style={{ background: THUMB_BG[i % THUMB_BG.length] }}>{initials(c.name)}</div>
                    <div>
                      <div className="nm">{c.name}</div>
                      <div className="id">{c._g?.name || '—'}</div>
                    </div>
                  </div>
                </td>
                <td>
                  <span className={`tag type ${wt === 'transcode' ? 'chan' : 'event'}`}>
                    {wt === 'transcode' ? 'Transcode' : wt === 'package_only' ? 'Packaging' : '—'}
                  </span>
                </td>
                <td style={{ color: 'var(--muted)' }}>
                  {wt === 'transcode'
                    ? (c._g?.rungs || []).map((r: any) => `${r.height}p`).join(' · ') || '—'
                    : 'source ladder'}
                </td>
                <td>
                  <span className={`tag ${live ? 'live' : 'idle'}`}>
                    <span className={`dot-s ${live ? 'live' : 'idle'}`} />
                    {live ? 'Live' : c.status === 'scheduled' ? 'Scheduled' : 'Idle'}
                  </span>
                </td>
                <td style={{ color: 'var(--muted)' }}>{c.recording_retention_days ? `${c.recording_retention_days}d` : '—'}</td>
                <td style={{ textAlign: 'right' }} onClick={e => e.stopPropagation()}>
                  <button className={`btn ${live ? 'ghost' : 'primary'}`} disabled={busy === c.id} onClick={() => toggle(c)}>
                    {busy === c.id ? '…' : live ? 'Stop' : 'Start'}
                  </button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function CreateChannel({ groups, onClose, onCreated }: { groups: Group[]; onClose: () => void; onCreated: () => void }) {
  const byType = useMemo(() => ({
    transcode: groups.find(g => g.workflow_type === 'transcode'),
    package_only: groups.find(g => g.workflow_type === 'package_only'),
  }), [groups])
  const [type, setType] = useState<'transcode' | 'package_only'>('transcode')
  const [name, setName] = useState('')
  const [purchasing, setPurchasing] = useState('reserved')
  const [retention, setRetention] = useState<string>('7')
  const [captions, setCaptions] = useState(false)
  const [langs, setLangs] = useState<string[]>(['en'])
  const [dvrMin, setDvrMin] = useState(60) // minutes; 24x7 sliding window
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const DVR_MAX_MIN = 240

  const group = byType[type]

  async function submit() {
    setErr('')
    if (!name.trim()) { setErr('Give the channel a name'); return }
    if (!group) { setErr(`No ${type === 'transcode' ? 'transcode' : 'packaging'} group set up yet`); return }
    setBusy(true)
    try {
      await api.createChannel({
        groupId: group.id, name: name.trim(), purchasingMode: purchasing,
        resilienceTier: 'standard', recordingRetentionDays: retention ? Number(retention) : null,
        dvrWindowSec: Math.max(30, dvrMin * 60), dvrMode: 'sliding',
      })
      onCreated()
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }

  return (
    <div className="drawer-scrim" onClick={onClose}>
      <div className="drawer" onClick={e => e.stopPropagation()}>
        <div className="drawer-h">
          <div className="t">New channel</div>
          <button className="xbtn" onClick={onClose}>✕</button>
        </div>
        <div className="drawer-b">
          <div className="field">
            <label>Channel name</label>
            <input className="inp" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. RTM News 24" />
          </div>

          <div className="field">
            <label>Type</label>
            <div className="presets">
              <Preset sel={type === 'transcode'} onClick={() => setType('transcode')}
                title="Transcode" desc="We build the ABR ladder with FFmpeg."
                meta={byType.transcode ? (byType.transcode.rungs || []).map(r => `${r.height}p`).join(' · ') : 'no group configured'} />
              <Preset sel={type === 'package_only'} onClick={() => setType('package_only')}
                title="Packaging" desc="You send a pre-encoded ladder; we package."
                meta={byType.package_only ? 'source ladder' : 'no group configured'} />
            </div>
          </div>

          <div className="field">
            <label>Purchasing mode</label>
            <select className="inp" value={purchasing} onChange={e => setPurchasing(e.target.value)}>
              <option value="reserved">Reserved</option>
              <option value="spot_fallback">Spot with on-demand fallback</option>
              <option value="on_demand">On demand</option>
            </select>
          </div>

          <div className="field">
            <label>Recording retention (days)</label>
            <input className="inp" value={retention} onChange={e => setRetention(e.target.value.replace(/[^0-9]/g, ''))} />
            <div className="hintxt">Recorded assets are kept this long before lifecycle cleanup.</div>
          </div>

          <div className="field">
            <label>DVR catch-up window — {dvrMin} min{dvrMin >= 60 ? ` (${(dvrMin / 60).toFixed(dvrMin % 60 ? 1 : 0)}h)` : ''}</label>
            <input type="range" min={1} max={DVR_MAX_MIN} step={1} value={dvrMin} onChange={e => setDvrMin(Number(e.target.value))} style={{ width: '100%', accentColor: 'var(--brand)' }} />
            <div className="hintxt">How far back viewers can scrub from the live edge. Max 4h for 24×7 channels; event streams scrub back to the event start.</div>
          </div>

          <div className="toggle-row">
            <div>
              <div className="tt">Live captions (Whisper)</div>
              <div className="td">Self-hosted transcription + translation. No per-minute fee.</div>
            </div>
            <div className={`sw ${captions ? '' : 'off'}`} onClick={() => setCaptions(!captions)}><i /></div>
          </div>

          {captions && (
            <div className="field">
              <label>Target languages</label>
              <div className="chipset">
                {LANGS.map(l => {
                  const on = langs.includes(l.code)
                  return (
                    <div key={l.code} className={`selchip ${on ? 'sel' : ''}`}
                      onClick={() => setLangs(on ? langs.filter(x => x !== l.code) : [...langs, l.code])}>
                      {l.label}
                    </div>
                  )
                })}
              </div>
              <div className="hintxt">Runs as a GPU add-on only while this channel is live. Validated end-to-end in the media tests.</div>
            </div>
          )}

          {err && <div className="err">{err}</div>}
        </div>
        <div className="drawer-f">
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy} onClick={submit}>{busy ? 'Creating…' : 'Create channel'}</button>
        </div>
      </div>
    </div>
  )
}

function Preset({ sel, onClick, title, desc, meta }: { sel: boolean; onClick: () => void; title: string; desc: string; meta: string }) {
  return (
    <div className={`preset ${sel ? 'sel' : ''}`} onClick={onClick}>
      <div className="pt">{title}</div>
      <div className="px">{desc}</div>
      <div className="px" style={{ fontFamily: 'ui-monospace,monospace', marginTop: 8, color: 'var(--faint)' }}>{meta}</div>
    </div>
  )
}
