// ============================================================================
//  ONE LADDER, EDITED IN ONE WAY, WHEREVER IT IS USED.
//
//  A ladder (an encode ladder group, volt-app services/encode) is the shared
//  definition of what a title becomes: which renditions (height and bitrate,
//  from the account's rendition list), how they are encoded (frame rate,
//  encoder, fixed sizes or the source's shape) and how they are packaged
//  (HLS and/or DASH, segment length). Uploads use the account default, a
//  watch folder names one, and a FAST channel names one; all of them read
//  the same row, so this editor is the same on Encoding profiles and in a
//  FAST channel's Settings, and says what a change reaches before it is made.
//
//  Changes save as they are made. A FAST channel on the ladder re-packages
//  what it airs behind the scenes (services/fast/ladder.ts ladderChanged).
// ============================================================================
import { useState } from 'react'
import { api, type EncodeProfile, type LadderGroup } from '../api'
import { Notice } from '../notices'
import './ladderEditor.css'

const FPS = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60]
const SEGMENTS = [1, 2, 4, 6, 10]
const kbps = (k: number) => (k >= 1000 ? `${(k / 1000).toFixed(k % 1000 ? 1 : 0)} Mb/s` : `${Math.round(k)} kb/s`)
const boxW = (h: number) => { const w = Math.round((h * 16) / 9); return w % 2 ? w + 1 : w }

/** A standard set to start a ladder from: common 16:9 renditions and rates for H.264. */
export const STANDARD_SETS: { id: string; label: string; rungs: [number, number][] }[] = [
  { id: 'hd', label: 'HD: 1080p to 360p', rungs: [[1080, 6000], [720, 3000], [480, 1200], [360, 800]] },
  { id: 'hd-lite', label: 'HD lite: 720p to 360p', rungs: [[720, 2500], [480, 1200], [360, 700]] },
  { id: 'uhd', label: 'UHD: 2160p to 480p', rungs: [[2160, 16000], [1440, 9000], [1080, 6000], [720, 3000], [480, 1200]] },
]

/** The renditions in the account that a ladder's rungs are made of (by height and bitrate). */
function membersOf(g: LadderGroup, profiles: EncodeProfile[]): EncodeProfile[] {
  return profiles.filter(p => g.rungs.some(r => r.height === p.height && r.bitrate_kbps === p.bitrate_kbps))
}

/** Find the account rendition for a height and bitrate, or make it. */
async function renditionFor(height: number, bitrate: number, profiles: EncodeProfile[]): Promise<EncodeProfile> {
  const have = profiles.find(p => p.height === height && p.bitrate_kbps === bitrate)
  if (have) return have
  try { return await api.createEncodeProfile({ name: `${height}p ${bitrate}k`, height, bitrateKbps: bitrate }) }
  catch (e) {
    // a rendition by that name already exists with other numbers: name this one apart
    return api.createEncodeProfile({ name: `${height}p ${bitrate}k (${Date.now() % 10000})`, height, bitrateKbps: bitrate }).catch(() => { throw e })
  }
}

export function usageText(g: LadderGroup): string | null {
  const u = g.usage
  if (!u) return null
  const parts = [
    u.uploads ? 'uploads (account default)' : '',
    u.fastChannels.length ? `${u.fastChannels.length} FAST channel${u.fastChannels.length === 1 ? '' : 's'} (${u.fastChannels.slice(0, 3).map(c => c.name).join(', ')}${u.fastChannels.length > 3 ? '…' : ''})` : '',
    u.watchfolders ? `${u.watchfolders} watch folder${u.watchfolders === 1 ? '' : 's'}` : '',
  ].filter(Boolean)
  return parts.length ? parts.join(' · ') : null
}

export function LadderEditor({ g, profiles, onChanged, context, readOnly = false }: {
  g: LadderGroup; profiles: EncodeProfile[]; onChanged: () => void
  /** Who is editing (e.g. "this channel"), so the shared-use line can say "and N others". */
  context?: string
  /** Without Manage the ladder is shown, not offered for change (build queue 1.14-G3a-5). */
  readOnly?: boolean
}) {
  const [busyRaw, setBusy] = useState(false)
  // Read-only shows every control as it stands, disabled, rather than hiding
  // the settings: what a ladder encodes to is the point of the page.
  const busy = busyRaw || readOnly
  const [err, setErr] = useState('')
  const [h, setH] = useState('')
  const [k, setK] = useState('')
  const tracking = !!g.tracks_output_profile_id
  const members = membersOf(g, profiles)
  const run = async (f: () => Promise<unknown>) => {
    setBusy(true); setErr('')
    try { await f(); onChanged() } catch (e: any) { setErr(String(e?.message ?? e)) } finally { setBusy(false) }
  }
  const setMembers = (list: EncodeProfile[]) => api.setLadderMembers(g.id, [...new Map(list.map(p => [p.id, p])).values()].sort((a, b) => b.height - a.height || b.bitrate_kbps - a.bitrate_kbps).map(p => p.id))
  const add = () => run(async () => {
    const height = Number(h), bitrate = Number(k)
    if (!(height >= 90 && height <= 4320)) throw new Error('A height between 90 and 4320 lines.')
    if (!(bitrate >= 50 && bitrate <= 200000)) throw new Error('A bitrate between 50 and 200000 kb/s.')
    if (g.rungs.some(r => r.height === height)) throw new Error(`The ladder already has a ${height}p rendition. Remove it first to change its bitrate.`)
    const p = await renditionFor(height, bitrate, profiles)
    await setMembers([...members, p]); setH(''); setK('')
  })
  const remove = (p: EncodeProfile) => run(() => setMembers(members.filter(m => m.id !== p.id)))
  const standard = (id: string) => run(async () => {
    const set = STANDARD_SETS.find(x => x.id === id); if (!set) return
    const list: EncodeProfile[] = []
    let pool = profiles
    for (const [hh, kk] of set.rungs) { const p = await renditionFor(hh, kk, pool); list.push(p); pool = [...pool, p] }
    await setMembers(list)
  })
  const patch = (b: Record<string, unknown>) => run(() => api.patchLadderGroup(g.id, b))
  const frame = g.frame_mode === 'box' ? 'box' : g.cap_to_source ? 'fit' : 'all'
  const setFrame = (v: string) => patch(v === 'box' ? { frameMode: 'box' } : { frameMode: 'scale', capToSource: v === 'fit' })
  const shared = usageText(g)
  const others = (g.usage?.fastChannels.length ?? 0) + (g.usage?.watchfolders ?? 0) + (g.usage?.uploads ? 1 : 0)

  return (
    <div className="led">
      {shared && <div className="led-use">Used by {shared}.{others > 1 ? ` A change here applies to all of them${context ? `, not only ${context}` : ''}; FAST channels re-package what they air on their own.` : ''}</div>}
      {g.problem && <Notice kind="error" variant="compact" message={`This ladder cannot be used: ${g.problem}`} />}

      <div className="led-sec">
        <div className="led-h">Renditions</div>
        {tracking ? <div className="hintxt">From the live output profile <b>{g.tracked_profile_name ?? 'unknown'}</b>, read at encode time so files match the channels using it. Change them on that profile.</div> : null}
        <table className="led-rungs">
          <thead><tr><th>Height</th><th>Size{frame === 'box' ? '' : ' (16:9 source)'}</th><th>Bitrate</th><th aria-label="Actions" /></tr></thead>
          <tbody>
            {g.rungs.map(r => {
              const p = members.find(m => m.height === r.height && m.bitrate_kbps === r.bitrate_kbps)
              return (
                <tr key={`${r.height}-${r.bitrate_kbps}`}>
                  <td><b>{r.height}p</b></td><td>{boxW(r.height)}×{r.height}</td><td>{kbps(r.bitrate_kbps)}</td>
                  <td>{!tracking && p && !readOnly && <button className="btn ghost sm" disabled={busy} onClick={() => remove(p)} aria-label={`Remove ${r.height}p`}>Remove</button>}</td>
                </tr>
              )
            })}
            {!g.rungs.length && <tr><td colSpan={4} className="hintxt">No renditions yet. Add them below, or start from a standard set.</td></tr>}
          </tbody>
        </table>
        {!tracking && !readOnly && <div className="led-add">
          <input className="inp" inputMode="numeric" placeholder="Height, e.g. 1080" value={h} onChange={e => setH(e.target.value.replace(/\D/g, ''))} aria-label="Height in lines" />
          <input className="inp" inputMode="numeric" placeholder="Bitrate kb/s, e.g. 6000" value={k} onChange={e => setK(e.target.value.replace(/\D/g, ''))} aria-label="Bitrate in kb/s" />
          <button className="btn ghost" onClick={add} disabled={busy || !h || !k}>Add rendition</button>
          <select className="inp" value="" disabled={busy} onChange={e => e.target.value && standard(e.target.value)} aria-label="Start from a standard set">
            <option value="">{g.rungs.length ? 'Replace with a standard set…' : 'Start from a standard set…'}</option>
            {STANDARD_SETS.map(x => <option key={x.id} value={x.id}>{x.label} ({x.rungs.map(([hh, kk]) => `${hh}p ${kbps(kk)}`).join(', ')})</option>)}
          </select>
        </div>}
      </div>

      <div className="led-grid">
        <div className="led-sec">
          <div className="led-h">Encode</div>
          <div className="field"><label>Picture sizes</label>
            <select className="inp" value={frame} disabled={busy} onChange={e => setFrame(e.target.value)}>
              <option value="box">Fixed sizes: every rendition at its 16:9 size</option>
              <option value="fit">Follow the source: never upscale</option>
              <option value="all">Follow the source: every rendition</option>
            </select>
            <div className="hintxt">{frame === 'box'
              ? 'Every title comes out at exactly these sizes, letterboxed if its shape differs. Titles ingested this way go on a FAST channel with the same ladder as they are.'
              : frame === 'fit' ? 'Renditions above the source are skipped and the width follows its shape. A FAST channel makes its own copy of such titles at fixed sizes.'
              : 'Every rendition, the width following the source\'s shape (a smaller source is scaled up).'}</div></div>
          <div className="field"><label>Frame rate</label>
            <select className="inp" value={String(Number(g.effective_fps ?? g.fps))} disabled={busy || tracking} onChange={e => patch({ fps: Number(e.target.value) })}>
              {[...new Set([...FPS, Number(g.effective_fps ?? g.fps)])].sort((a, b) => a - b).map(f => <option key={f} value={String(f)}>{f} fps</option>)}
            </select></div>
          <div className="field"><label>Encoder</label>
            <select className="inp" value={g.codec_backend} disabled={busy} onChange={e => patch({ codecBackend: e.target.value })}>
              <option value="x264">H.264 on CPU (x264)</option>
              <option value="nvenc">H.264 on GPU (NVENC)</option>
            </select></div>
        </div>
        <div className="led-sec">
          <div className="led-h">Package</div>
          <div className="field"><label>Formats</label>
            <select className="inp" value={g.packaging} disabled={busy} onChange={e => patch({ packaging: e.target.value })}>
              <option value="both">HLS and DASH</option>
              <option value="hls">HLS only</option>
              <option value="dash">DASH only</option>
            </select></div>
          <div className="field"><label>Segment length</label>
            <select className="inp" value={String(Number(g.segment_seconds ?? g.segment_dur))} disabled={busy || tracking} onChange={e => patch({ segmentDur: Number(e.target.value) })}>
              {[...new Set([...SEGMENTS, Number(g.segment_seconds ?? g.segment_dur)])].sort((a, b) => a - b).map(sg => <option key={sg} value={String(sg)}>{sg} s</option>)}
            </select>
            <div className="hintxt">{tracking ? 'From the live profile, so file and live keyframes line up.' : 'Keyframes every segment. A FAST channel\'s slate is always cut in 1 s segments.'}</div></div>
        </div>
      </div>
      {err && <Notice kind="error" variant="compact" message={err} />}
    </div>
  )
}
