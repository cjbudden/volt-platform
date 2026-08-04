import { useEffect, useMemo, useState } from 'react'
import { api, type Channel, type Group } from '../api'

const LANGS = [
  { code: 'en', label: 'English' }, { code: 'ms', label: 'Malay' },
  { code: 'zh', label: 'Chinese' }, { code: 'ta', label: 'Tamil' },
]

export default function Channels() {
  const [channels, setChannels] = useState<Channel[] | null>(null)
  const [groups, setGroups] = useState<Group[]>([])
  const [open, setOpen] = useState(false)

  async function load() {
    const [chs, gs] = await Promise.all([api.channels(), api.groups()])
    // decorate channels with their group's workflow type
    const gmap = new Map(gs.map(g => [g.id, g]))
    setChannels(chs.map(c => ({ ...c, group_name: gmap.get(c.group_id)?.name, _g: gmap.get(c.group_id) } as any)))
    setGroups(gs)
  }
  useEffect(() => { load() }, [])

  return (
    <div className="max-w-5xl mx-auto">
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Channels</h1>
          <p className="text-[#98a0ad] text-sm mt-1">24×7 live channels. Transcode builds the rendition ladder for you; packaging takes a pre-encoded ladder.</p>
        </div>
        <button onClick={() => setOpen(true)} className="rounded-lg bg-blue-600 hover:bg-blue-500 px-4 py-2.5 text-sm font-semibold">+ New channel</button>
      </div>

      {channels === null ? (
        <div className="text-[#98a0ad] text-sm">Loading…</div>
      ) : channels.length === 0 ? (
        <EmptyState onCreate={() => setOpen(true)} />
      ) : (
        <ChannelTable channels={channels} onChanged={load} />
      )}

      {open && <CreateChannel groups={groups} onClose={() => setOpen(false)} onCreated={() => { setOpen(false); load() }} />}
    </div>
  )
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="rounded-2xl border border-dashed border-[#2b3346] bg-[#0f1219] p-12 text-center">
      <div className="mx-auto w-14 h-14 rounded-xl bg-blue-600/15 border border-blue-600/30 grid place-items-center text-2xl mb-4">▤</div>
      <div className="text-lg font-semibold">No channels yet</div>
      <p className="text-[#98a0ad] text-sm mt-1 mb-5">Create your first channel to start a live stream. You can make a transcode channel (we build the ladder) or a packaging channel (you send the ladder).</p>
      <button onClick={onCreate} className="rounded-lg bg-blue-600 hover:bg-blue-500 px-4 py-2.5 text-sm font-semibold">Create your first channel</button>
    </div>
  )
}

function TypeBadge({ g }: { g?: Group }) {
  const t = g?.workflow_type
  const label = t === 'transcode' ? 'Transcode' : t === 'package_only' ? 'Packaging' : '—'
  const cls = t === 'transcode' ? 'bg-indigo-500/15 text-indigo-300 border-indigo-500/30' : 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
  return <span className={`text-[11px] px-2 py-0.5 rounded-full border ${cls}`}>{label}</span>
}
function StatusBadge({ s }: { s: string }) {
  const map: Record<string, string> = { live: 'bg-red-500/15 text-red-300 border-red-500/30', scheduled: 'bg-white/5 text-[#9aa3b2] border-[#242833]', ended: 'bg-white/5 text-[#6b7280] border-[#242833]' }
  return <span className={`text-[11px] px-2 py-0.5 rounded-full border ${map[s] || map.scheduled}`}>{s}</span>
}

function ChannelTable({ channels, onChanged }: { channels: any[]; onChanged: () => void }) {
  async function toggle(c: any) {
    await api.startStop(c.id, c.status === 'live' ? 'stop' : 'start'); onChanged()
  }
  return (
    <div className="rounded-xl border border-[#242833] overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-[#0f1219] text-[#98a0ad] text-xs uppercase tracking-wide">
          <tr>
            <th className="text-left font-medium px-4 py-3">Name</th>
            <th className="text-left font-medium px-4 py-3">Type</th>
            <th className="text-left font-medium px-4 py-3">Renditions</th>
            <th className="text-left font-medium px-4 py-3">Status</th>
            <th className="text-left font-medium px-4 py-3">Retention</th>
            <th className="px-4 py-3"></th>
          </tr>
        </thead>
        <tbody>
          {channels.map(c => (
            <tr key={c.id} className="border-t border-[#242833] hover:bg-white/[0.02]">
              <td className="px-4 py-3 font-medium">{c.name}</td>
              <td className="px-4 py-3"><TypeBadge g={c._g} /></td>
              <td className="px-4 py-3 text-[#9aa3b2]">{c._g?.workflow_type === 'transcode' ? (c._g?.rungs || []).map((r: any) => `${r.height}p`).join(' · ') || '—' : 'source ladder'}</td>
              <td className="px-4 py-3"><StatusBadge s={c.status} /></td>
              <td className="px-4 py-3 text-[#9aa3b2]">{c.recording_retention_days ? `${c.recording_retention_days}d` : '—'}</td>
              <td className="px-4 py-3 text-right">
                <button onClick={() => toggle(c)} className="rounded-lg border border-[#242833] px-3 py-1.5 text-xs hover:bg-white/5">{c.status === 'live' ? 'Stop' : 'Start'}</button>
              </td>
            </tr>
          ))}
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
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

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
      })
      // captions (whisper) are applied at encode time on the profile — validated in the media tests
      onCreated()
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }

  return (
    <div className="fixed inset-0 z-20 flex justify-end bg-black/50" onClick={onClose}>
      <div className="w-[460px] h-full bg-[#14161d] border-l border-[#242833] overflow-auto" onClick={e => e.stopPropagation()}>
        <div className="px-6 py-4 border-b border-[#242833] flex items-center justify-between">
          <div className="font-semibold">New channel</div>
          <button onClick={onClose} className="text-[#98a0ad] hover:text-white">✕</button>
        </div>
        <div className="p-6 space-y-5">
          <Field label="Channel name">
            <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. RTM News 24" className="w-full rounded-lg bg-[#0e1017] border border-[#242833] px-3 py-2.5 outline-none focus:border-indigo-500" />
          </Field>

          <Field label="Type">
            <div className="grid grid-cols-2 gap-3">
              <TypeCard active={type === 'transcode'} onClick={() => setType('transcode')}
                title="Transcode" desc="We build the ABR ladder with FFmpeg." meta={byType.transcode ? (byType.transcode.rungs || []).map(r => `${r.height}p`).join(' · ') : 'no group'} />
              <TypeCard active={type === 'package_only'} onClick={() => setType('package_only')}
                title="Packaging" desc="You send a pre-encoded ladder; we package." meta={byType.package_only ? 'source ladder' : 'no group'} />
            </div>
          </Field>

          <Field label="Purchasing mode">
            <select value={purchasing} onChange={e => setPurchasing(e.target.value)} className="w-full rounded-lg bg-[#0e1017] border border-[#242833] px-3 py-2.5 outline-none focus:border-indigo-500">
              <option value="reserved">Reserved</option>
              <option value="spot_fallback">Spot with on-demand fallback</option>
              <option value="on_demand">On demand</option>
            </select>
          </Field>

          <Field label="Recording retention (days)">
            <input value={retention} onChange={e => setRetention(e.target.value.replace(/[^0-9]/g, ''))} className="w-full rounded-lg bg-[#0e1017] border border-[#242833] px-3 py-2.5 outline-none focus:border-indigo-500" />
          </Field>

          <div className="rounded-xl border border-[#242833] p-4">
            <label className="flex items-center justify-between cursor-pointer">
              <div>
                <div className="font-medium text-sm">Live captions (Whisper)</div>
                <div className="text-[#98a0ad] text-xs mt-0.5">Self-hosted transcription + translation. No per-minute fee.</div>
              </div>
              <input type="checkbox" checked={captions} onChange={e => setCaptions(e.target.checked)} className="w-5 h-5 accent-blue-600" />
            </label>
            {captions && (
              <div className="mt-4">
                <div className="text-[11px] uppercase tracking-wide text-[#98a0ad] mb-2">Target languages</div>
                <div className="flex flex-wrap gap-2">
                  {LANGS.map(l => {
                    const on = langs.includes(l.code)
                    return <button key={l.code} onClick={() => setLangs(on ? langs.filter(x => x !== l.code) : [...langs, l.code])}
                      className={`text-xs px-3 py-1.5 rounded-full border ${on ? 'bg-blue-600 border-blue-600 text-white' : 'bg-[#0e1017] border-[#242833] text-[#9aa3b2]'}`}>{l.label}</button>
                  })}
                </div>
                <div className="text-[11px] text-[#6b7280] mt-3">Runs as a GPU add-on only while this channel is live. Validated end-to-end in the media tests.</div>
              </div>
            )}
          </div>

          {err && <div className="text-red-400 text-sm">{err}</div>}
        </div>
        <div className="px-6 py-4 border-t border-[#242833] flex justify-end gap-2 sticky bottom-0 bg-[#14161d]">
          <button onClick={onClose} className="rounded-lg border border-[#242833] px-4 py-2 text-sm hover:bg-white/5">Cancel</button>
          <button disabled={busy} onClick={submit} className="rounded-lg bg-blue-600 hover:bg-blue-500 px-4 py-2 text-sm font-semibold disabled:opacity-50">{busy ? 'Creating…' : 'Create channel'}</button>
        </div>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><div className="text-[11px] uppercase tracking-wide text-[#98a0ad] mb-2">{label}</div>{children}</div>
}
function TypeCard({ active, onClick, title, desc, meta }: { active: boolean; onClick: () => void; title: string; desc: string; meta: string }) {
  return (
    <button onClick={onClick} className={`text-left rounded-xl border p-3 ${active ? 'border-blue-600 bg-blue-600/10' : 'border-[#242833] bg-[#0e1017] hover:border-[#33405e]'}`}>
      <div className="font-semibold text-sm">{title}</div>
      <div className="text-[#98a0ad] text-[11px] mt-1 leading-snug">{desc}</div>
      <div className="text-[10px] text-[#6b7280] mt-2 font-mono">{meta}</div>
    </button>
  )
}
