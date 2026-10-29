// ============================================================================
//  A FAST CHANNEL'S LADDER, in the console (volt-app services/fast/ladder.ts).
//
//  The ladder is picked once, when the channel is made (the account default
//  unless someone picks another) and can be changed on the On air tab. Every
//  title on the channel is packaged to it behind the scenes; what is shown
//  here is only what an operator decides: which ladder, and what that means
//  for the titles the library offers (sources that fill its top rung).
// ============================================================================
import { useCallback, useEffect, useState } from 'react'
import { fastApi, type FastLadder, type FastRung, type ReadinessRow } from './fastApi'
import { useNotify } from '../notices'
import { api, type EncodeProfile, type LadderGroup } from '../api'
import { LadderEditor } from '../encode/LadderEditor'
import './fastLadder.css'

export const kbps = (k: number) => (k >= 1000 ? `${(k / 1000).toFixed(k % 1000 ? 1 : 0)} Mb/s` : `${Math.round(k)} kb/s`)
export const rungText = (r: FastRung) => `${r.height}p ${kbps(r.bitrate_kbps)}`
export const ladderText = (l: { rungs: FastRung[] }) => l.rungs.map(rungText).join(' · ')

/** The ladders a channel can use, loaded once. */
export function useFastLadders() {
  const [items, setItems] = useState<FastLadder[] | null>(null)
  useEffect(() => { fastApi.ladders().then(r => setItems(r.items)).catch(() => setItems([])) }, [])
  return items
}

/** The ladder picker for a new channel: '' is the account default. */
export function LadderField({ value, onChange, ladders }: { value: string; onChange: (id: string) => void; ladders: FastLadder[] | null }) {
  const def = ladders?.find(l => l.isDefault) ?? null
  const chosen = value ? ladders?.find(l => l.groupId === value) ?? null : def
  const top = chosen?.rungs[0]
  return (
    <div className="field"><label htmlFor="fl">Ladder</label>
      <select id="fl" className="inp" value={value} onChange={e => onChange(e.target.value)} disabled={!ladders}>
        <option value="">{def ? `Account default (${def.groupName})` : 'Account default'}</option>
        {(ladders ?? []).map(l => <option key={l.groupId} value={l.groupId}>{l.groupName} · {l.rungs[0] ? rungText(l.rungs[0]) : 'no rungs'}</option>)}
      </select>
      {chosen ? <div className="flad-sum">
        <div className="flad-rungs">{chosen.rungs.map(r => <span key={r.height} className="flad-rung"><b>{r.height}p</b>{kbps(r.bitrate_kbps)}</span>)}</div>
        <div className="hintxt">Every title on the channel is packaged to these renditions, in the background. The library offers sources of at least {top ? `${top.height}p and ${kbps(top.bitrate_kbps)}` : 'the top rung'}, so the top rung is never made from less.</div>
      </div>
        : ladders && !ladders.length
          ? <div className="hintxt">This account has no ladder yet. Make one in Encoding profiles (or mirror a live output profile) and the channel will use it.</div>
          : <div className="hintxt">Every title on the channel is packaged to one ladder, in the background.</div>}
    </div>
  )
}

/**
 * On air > Ladder: what the channel is packaged to, how far along that is, and
 * a way to change it.
 */
export function LadderCard({ channelId, ladder, ready, onChanged }: { channelId: string; ladder: FastLadder | null; ready: ReadinessRow[]; onChanged: () => void }) {
  const ladders = useFastLadders()
  const notify = useNotify()
  const [editing, setEditing] = useState(false)
  const [pick, setPick] = useState('')
  const [busy, setBusy] = useState(false)
  const done = ready.filter(r => r.state === 'ready').length
  const working = ready.filter(r => r.state === 'preparing').length
  const variants = ready.filter(r => r.packaging === 'variant').length
  const save = async () => {
    setBusy(true)
    try {
      const r = await fastApi.setLadder(channelId, pick || null)
      notify({ kind: 'ok', title: `The channel now uses ${r.ladder?.groupName ?? 'the account default'}.`,
        message: [r.prepared.queued.length ? `${r.prepared.queued.length} title(s) are being packaged to it.` : 'Everything is already packaged to it.',
          r.restartNeeded ? 'Restart the playout for viewers to get the new renditions.' : ''].filter(Boolean).join(' ') })
      setEditing(false); onChanged()
    } catch (e: any) { notify({ kind: 'error', title: "Couldn't change the ladder.", message: e.message }) } finally { setBusy(false) }
  }
  return (
    <div className="card">
      <div className="card-h"><h3>Ladder</h3><span className="sub">the renditions viewers get</span><span className="spacer" />
        {!editing && <button className="btn ghost sm" onClick={() => { setPick(ladder && !ladder.inherited ? ladder.groupId : ''); setEditing(true) }}>Change</button>}</div>
      <div className="card-b">
        {!ladder ? <div className="hintxt">No ladder: this account has no default ladder group, so each title plays its own encode. Choose one so every title shares the same renditions.</div> : <>
          <div className="kv"><span className="k">Ladder</span><span className="v">{ladder.groupName}{ladder.inherited ? ' (account default)' : ''}</span></div>
          <div className="flad-rungs" style={{ margin: '6px 0 8px' }}>{ladder.rungs.map(r => <span key={r.height} className="flad-rung"><b>{r.height}p</b>{kbps(r.bitrate_kbps)}</span>)}</div>
          <div className="kv"><span className="k">Packaged</span><span className="v">{done} of {ready.length}{working ? ` · ${working} in progress` : ''}{variants ? ` · ${variants} made for this ladder` : ''}</span></div>
        </>}
        {editing && <div style={{ marginTop: 10 }}>
          <LadderField value={pick} onChange={setPick} ladders={ladders} />
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button className="btn ghost" onClick={() => setEditing(false)} disabled={busy}>Cancel</button>
            <button className="btn primary" onClick={save} disabled={busy || !ladders}>{busy ? 'Saving…' : 'Use this ladder'}</button>
          </div>
        </div>}
      </div>
    </div>
  )
}

/** A readiness row's second line: role, why, progress and a note. */
export function readyMeta(r: ReadinessRow, role: string): string {
  return [role,
    r.state === 'preparing' && r.progress != null ? `${r.why ?? 'preparing'} · ${Math.round(r.progress)}%` : r.why,
    r.state === 'ready' && r.packaging === 'variant' ? 'packaged for this channel' : null,
    r.note].filter(Boolean).join(' · ')
}

/**
 * SETTINGS > LADDER: the channel's ladder (choose one, or make one, and set
 * its renditions, encode and packaging in the same editor Encoding profiles
 * uses). Saved as it changes. The slate and loops are under Build > Brand &
 * filler.
 */
export function FastPlayoutSettings({ channelId }: { channelId: string }) {
  return (
    <div style={{ marginTop: 16, minWidth: 0 }}><ChannelLadderCard channelId={channelId} /></div>
  )
}

function ChannelLadderCard({ channelId }: { channelId: string }) {
  const notify = useNotify()
  const [chosen, setChosen] = useState<string | null | undefined>(undefined)
  const [groups, setGroups] = useState<LadderGroup[] | null>(null)
  const [profiles, setProfiles] = useState<EncodeProfile[]>([])
  const [busy, setBusy] = useState(false)
  const [naming, setNaming] = useState<string | null>(null)
  const [err, setErr] = useState('')
  const load = useCallback(() => {
    Promise.all([fastApi.channel(channelId), api.ladderGroups(), api.encodeProfiles()])
      .then(([c, g, p]) => { setChosen(c.channel.ladderGroupId ?? null); setGroups(g); setProfiles(p); setErr('') })
      .catch(e => setErr(String(e?.message ?? e)))
  }, [channelId])
  useEffect(load, [load])
  if (err) return <div className="card"><div className="card-b"><div className="hintxt">Couldn't load the ladders: {err}</div></div></div>
  if (!groups || chosen === undefined) return <div className="card"><div className="card-b loading">Loading the ladder…</div></div>
  const def = groups.find(g => g.is_default) ?? null
  const g = chosen ? groups.find(x => x.id === chosen) ?? null : def
  const use = async (id: string | null, what?: string) => {
    setBusy(true)
    try {
      const r = await fastApi.setLadder(channelId, id)
      notify({ kind: 'ok', title: `The channel uses ${what ?? r.ladder?.groupName ?? 'the account default'}.`,
        message: [r.prepared.queued.length ? `${r.prepared.queued.length} title(s) are being packaged to it.` : '', r.restartNeeded ? 'Restart the playout (On air) for viewers to get the new renditions.' : ''].filter(Boolean).join(' ') || undefined })
      load()
    } catch (e: any) { notify({ kind: 'error', title: "Couldn't change the ladder.", message: e.message }) } finally { setBusy(false) }
  }
  const create = async () => {
    const name = (naming ?? '').trim(); if (!name) return
    setBusy(true)
    try {
      // a FAST ladder makes fixed sizes, with the current ladder's packaging as a start
      const n = await api.createLadderGroup({ name, frameMode: 'box', fps: Number(g?.effective_fps ?? 25), segmentDur: Number(g?.segment_seconds ?? 4), packaging: g?.packaging ?? 'both' })
      setNaming(null)
      await use(n.id, name)
    } catch (e: any) { notify({ kind: 'error', title: "Couldn't create the ladder.", message: e.message }) } finally { setBusy(false) }
  }
  const makeDefault = async () => {
    if (!g) return
    setBusy(true)
    try { await api.patchLadderGroup(g.id, { isDefault: true }); notify({ kind: 'ok', title: `${g.name} is the account default.`, message: 'Uploads are encoded to it from now on.' }); load() }
    catch (e: any) { notify({ kind: 'error', title: "Couldn't make it the default.", message: e.message }) } finally { setBusy(false) }
  }
  return (
    <div className="card">
      <div className="card-h"><h3>Ladder</h3><span className="sub">the renditions every title on the channel is packaged to</span></div>
      <div className="card-b">
        <div className="field"><label htmlFor="fsl">Ladder</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <select id="fsl" className="inp" value={chosen ?? ''} disabled={busy} onChange={e => use(e.target.value || null)} style={{ flex: 1 }}>
              <option value="">{def ? `Account default (${def.name})` : 'Account default (none set)'}</option>
              {groups.map(x => <option key={x.id} value={x.id}>{x.name}{x.rungs[0] ? ` · ${x.rungs[0].height}p ${kbps(x.rungs[0].bitrate_kbps)}` : ''}</option>)}
            </select>
            {naming == null && <button className="btn ghost" disabled={busy} onClick={() => setNaming(`${g?.name ? `${g.name} FAST` : 'FAST HD'}`)}>New ladder</button>}
          </div>
          {naming != null && <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <input className="inp" value={naming} onChange={e => setNaming(e.target.value)} placeholder="Name" aria-label="New ladder name" autoFocus style={{ flex: 1 }} />
            <button className="btn primary" disabled={busy || !naming.trim()} onClick={create}>Create and use</button>
            <button className="btn ghost" disabled={busy} onClick={() => setNaming(null)}>Cancel</button>
          </div>}
          <div className="hintxt">Saved as you change it. The library offers titles that fill the top rendition, and anything not already in these renditions is packaged in the background.</div>
        </div>
        {!g ? <div className="hintxt">No ladder yet. Create one, or set an account default in Encoding profiles.</div> : <>
          <LadderEditor g={g} profiles={profiles} onChanged={load} context="this channel" />
          {!g.is_default && <div className="flad-tip">
            <span>Make it the account default and uploads are encoded to it{g.frame_mode === 'box' ? ', so new titles arrive ready for this channel with nothing encoded twice' : ''}.</span>
            <button className="btn ghost sm" disabled={busy} onClick={makeDefault}>Make default</button>
          </div>}
          {g.is_default && g.frame_mode !== 'box' && <div className="flad-tip">
            <span>Uploads use this ladder but follow their source's shape, so the channel makes its own fixed-size copy of each title. Choose <b>Fixed sizes</b> above to ingest titles ready for air.</span>
          </div>}
        </>}
      </div>
    </div>
  )
}
