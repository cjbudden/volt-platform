import { useCallback, useEffect, useState } from 'react'
import {
  api, type EncodeProfile, type LadderGroup, type LiveOutputProfile,
  type LadderPreview, type LadderRung,
} from '../api'

/* ============================================================================
   ENCODING PROFILES — renditions, and the ladders made of them.

   THE SCREEN IS BUILT AROUND ONE DISTINCTION, because it is the one that
   decides whether a file encode matches the live channel it is meant to match:

     A TRACKING ladder holds no renditions of its own. It points at a live
     output profile and reads that profile's rungs at encode time. Re-tune the
     live 720p rung and this ladder follows, with nothing written here.

     AN OWN ladder holds its own renditions and is independent of live. That is
     the right answer for an archive ladder or a social cut-down, and the wrong
     one for "the same as our channels", because a copy agrees on the day it is
     made and silently disagrees forever after.

   So a tracking ladder shows WHERE its numbers come from, shows the numbers it
   currently resolves to, and does not offer an editable rendition list — there
   is nothing here to edit, and a disabled list implying otherwise would be a
   lie about where the truth lives.

   THE PREVIEW IS THE PART OPERATORS WILL USE MOST. Type a source height, see
   exactly which rungs that file gets. It calls the server, which runs the SAME
   fitToSource() the encode runs, because a preview with its own copy of the
   rule would be confidently wrong precisely when it mattered.
   ========================================================================== */

const box: React.CSSProperties = {
  background: 'var(--panel-2,#151922)', border: '1px solid var(--border,#242a36)',
  color: 'var(--text,#e7ebf3)', borderRadius: 8, padding: '7px 10px',
  fontFamily: 'inherit', fontSize: 'var(--fs-sm)', outline: 'none',
}
const muted: React.CSSProperties = { fontSize: 'var(--fs-xs)', color: 'var(--faint,#8b93a7)' }

const rungLabel = (r: LadderRung) => `${r.height}p ${r.bitrate_kbps}k`

/* -------------------------------------------------------------- renditions */

function Renditions({ profiles, reload }: { profiles: EncodeProfile[]; reload: () => void }) {
  const [draft, setDraft] = useState({ name: '', height: '720', bitrateKbps: '3000' })
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const add = async () => {
    const height = Number(draft.height), bitrateKbps = Number(draft.bitrateKbps)
    if (!height || !bitrateKbps) { setErr('A rendition needs a height and a bitrate.'); return }
    setBusy(true); setErr('')
    try {
      await api.createEncodeProfile({
        name: draft.name.trim() || `${height}p ${bitrateKbps}k`, height, bitrateKbps,
      })
      setDraft({ name: '', height: '720', bitrateKbps: '3000' })
      reload()
    } catch (e: any) { setErr(String(e?.message ?? e)) } finally { setBusy(false) }
  }

  const remove = async (p: EncodeProfile) => {
    setErr('')
    try { await api.deleteEncodeProfile(p.id); reload() }
    catch (e: any) { setErr(String(e?.message ?? e)) }
  }

  return (
    <div className="card" style={{ padding: 18 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <h3 style={{ margin: 0, fontSize: 'var(--fs-body)' }}>Renditions</h3>
        <span style={muted}>
          One height and bitrate. Edit it once and every ladder containing it changes.
        </span>
      </div>

      <div style={{ display: 'grid', gap: 6, margin: '12px 0' }}>
        {profiles.map(p => (
          <div key={p.id} style={{
            display: 'grid', gridTemplateColumns: '1fr 90px 110px 130px auto', gap: 10,
            alignItems: 'center', padding: '8px 10px', borderRadius: 8,
            background: 'var(--panel-2,#151922)', border: '1px solid var(--border,#242a36)',
          }}>
            <span style={{ fontWeight: 600 }}>{p.name}</span>
            <span style={{ fontVariantNumeric: 'tabular-nums' }}>{p.height}p</span>
            <span style={{ fontVariantNumeric: 'tabular-nums' }}>{p.bitrate_kbps} kbps</span>
            <span style={muted}>
              {p.used_in ? `in ${p.used_in} ladder${p.used_in === 1 ? '' : 's'}` : 'not used'}
            </span>
            <button type="button" className="btn ghost" style={{ padding: '3px 9px' }}
              title={p.used_in
                ? 'Used by a ladder. Remove it there first — deleting it here would silently shrink that ladder.'
                : 'Delete this rendition'}
              onClick={() => remove(p)}>Delete</button>
          </div>
        ))}
        {!profiles.length && <p style={muted}>No renditions yet.</p>}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 100px 120px auto', gap: 8 }}>
        <input style={box} placeholder="Name (optional)" value={draft.name}
          onChange={e => setDraft({ ...draft, name: e.target.value })} />
        <input style={box} placeholder="720" inputMode="numeric" value={draft.height}
          onChange={e => setDraft({ ...draft, height: e.target.value })} />
        <input style={box} placeholder="3000" inputMode="numeric" value={draft.bitrateKbps}
          onChange={e => setDraft({ ...draft, bitrateKbps: e.target.value })} />
        <button type="button" className="btn primary" onClick={add} disabled={busy}>Add rendition</button>
      </div>
      <p style={{ ...muted, marginTop: 8 }}>
        Rate control (preset, maxrate, buffer, GOP) is not set here. It is the same for live and
        for file encodes and lives in the encoder, in one place, so the two cannot drift apart.
      </p>
      {err && <p style={{ color: 'var(--danger,#f87171)', fontSize: 'var(--fs-sm)' }}>{err}</p>}
    </div>
  )
}

/* ------------------------------------------------------------------ preview */

function Preview({ ladder }: { ladder: LadderGroup }) {
  const [height, setHeight] = useState('720')
  const [p, setP] = useState<LadderPreview | null>(null)
  const [err, setErr] = useState('')

  useEffect(() => {
    const h = height.trim() === '' ? null : Number(height)
    const t = setTimeout(() => {
      api.ladderPreview(ladder.id, Number.isFinite(h as number) ? h : null)
        .then(r => { setP(r); setErr('') })
        .catch(e => { setP(null); setErr(String(e?.message ?? e)) })
    }, 250)
    return () => clearTimeout(t)
  }, [height, ladder.id, ladder.version, ladder.rungs.length])

  return (
    <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--border,#242a36)' }}>
      <label style={{ display: 'block', fontSize: 'var(--fs-sm)', fontWeight: 600, marginBottom: 6 }}>
        What would a source of this height get?
      </label>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input style={{ ...box, width: 120 }} placeholder="720" inputMode="numeric"
          value={height} onChange={e => setHeight(e.target.value)} />
        <span style={muted}>pixels tall. Leave it empty for a source we could not measure.</span>
      </div>
      {err && <p style={{ color: 'var(--danger,#f87171)', fontSize: 'var(--fs-sm)' }}>{err}</p>}
      {p && (
        <div style={{ marginTop: 10, fontSize: 'var(--fs-sm)' }}>
          <div>
            <strong>{p.fit.kept.map(rungLabel).join('  ·  ') || 'nothing'}</strong>
          </div>
          {/* THE THREE CASES SAID APART, because they are three different facts
              and an operator reading one as another goes looking for a fault
              that is not there. */}
          {p.fit.sourceUnmeasured && (
            <div style={{ color: 'var(--warn,#fbbf24)', marginTop: 4 }}>
              The source height was not measured, so the full ladder is encoded. That is not the
              same as a source that fitted every rung.
            </div>
          )}
          {p.fit.adapted && (
            <div style={{ color: 'var(--warn,#fbbf24)', marginTop: 4 }}>
              Smaller than every rung. The lowest ({p.fit.adapted.from}p) is encoded at the
              source's own {p.fit.adapted.to}p rather than upscaled.
            </div>
          )}
          {!!p.fit.dropped.length && (
            <div style={{ ...muted, marginTop: 4 }}>
              Not encoded: {p.fit.dropped.map(rungLabel).join(', ')} — above the source, so they
              would cost a full rung to carry no extra detail.
            </div>
          )}
          {p.fit.fps !== p.ladder.fps && (
            <div style={{ ...muted, marginTop: 4 }}>Frame rate capped to {p.fit.fps}.</div>
          )}
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ ladders */

function Ladder({ g, profiles, reload }: {
  g: LadderGroup; profiles: EncodeProfile[]; reload: () => void
}) {
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const tracking = !!g.tracks_output_profile_id

  const patch = async (b: Record<string, any>) => {
    setBusy(true); setErr('')
    try { await api.patchLadderGroup(g.id, b); reload() }
    catch (e: any) { setErr(String(e?.message ?? e)) } finally { setBusy(false) }
  }

  const toggleMember = async (id: string) => {
    const cur = new Set(memberIds)
    cur.has(id) ? cur.delete(id) : cur.add(id)
    const ordered = profiles.filter(p => cur.has(p.id))
      .sort((a, b) => b.height - a.height).map(p => p.id)
    setBusy(true); setErr('')
    try { await api.setLadderMembers(g.id, ordered); reload() }
    catch (e: any) { setErr(String(e?.message ?? e)) } finally { setBusy(false) }
  }

  // Which renditions are in it. A tracking ladder has none by definition.
  const memberIds = tracking ? [] :
    profiles.filter(p => g.rungs.some(r => r.height === p.height && r.bitrate_kbps === p.bitrate_kbps))
      .map(p => p.id)

  return (
    <div className="card" style={{ padding: 18, marginTop: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0, fontSize: 'var(--fs-body)' }}>{g.name}</h3>
        {g.is_default && (
          <span style={{ ...muted, color: 'var(--ok,#4ade80)', fontWeight: 600 }}>account default</span>
        )}
        <button type="button" className="btn ghost" style={{ marginLeft: 'auto', padding: '3px 9px' }}
          disabled={busy || g.is_default} onClick={() => patch({ isDefault: true })}>
          {g.is_default ? 'Default' : 'Make default'}
        </button>
        <button type="button" className="btn ghost" style={{ padding: '3px 9px' }}
          disabled={busy} onClick={async () => {
            setErr('')
            try { await api.deleteLadderGroup(g.id); reload() }
            catch (e: any) { setErr(String(e?.message ?? e)) }
          }}>Delete</button>
      </div>

      {/* WHERE THE NUMBERS COME FROM. The single most important line here. */}
      <p style={{ ...muted, marginTop: 6 }}>
        {tracking ? (
          <>
            Tracks the live output profile <strong>{g.tracked_profile_name ?? 'unknown'}</strong>.
            These rungs are read from it at encode time, so a file encoded with this ladder matches
            the channels using that profile and cannot drift from them.
          </>
        ) : (
          <>Its own renditions. Independent of the live profiles, which is right for an archive or a
            cut-down ladder and wrong for "the same as our channels".</>
        )}
      </p>

      {g.problem ? (
        <p style={{ color: 'var(--danger,#f87171)', fontSize: 'var(--fs-sm)' }}>
          This ladder cannot be used: {g.problem}
        </p>
      ) : (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '10px 0' }}>
          {g.rungs.map((r, i) => (
            <span key={i} style={{
              padding: '4px 11px', borderRadius: 999, fontSize: 'var(--fs-sm)', fontWeight: 600,
              background: 'rgba(63,123,255,.12)', border: '1px solid rgba(63,123,255,.4)',
            }}>{rungLabel(r)}</span>
          ))}
          <span style={{ ...muted, alignSelf: 'center' }}>
            {g.segment_seconds}s segments · {g.effective_fps}fps · {g.packaging.toUpperCase()}
          </span>
        </div>
      )}

      {/* A tracking ladder gets NO rendition list, because there is nothing here
          to edit. A disabled one would imply the truth lives here. */}
      {!tracking && (
        <div style={{ marginTop: 8 }}>
          <div style={{ ...muted, marginBottom: 6 }}>Renditions in this ladder</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {profiles.map(p => {
              const on = memberIds.includes(p.id)
              return (
                <button key={p.id} type="button" disabled={busy}
                  onClick={() => toggleMember(p.id)}
                  style={{
                    padding: '4px 11px', borderRadius: 999, fontSize: 'var(--fs-sm)',
                    cursor: 'pointer', fontFamily: 'inherit',
                    background: on ? 'rgba(63,123,255,.16)' : 'var(--panel-2,#151922)',
                    border: `1px solid ${on ? 'rgba(63,123,255,.5)' : 'var(--border,#242a36)'}`,
                    color: on ? 'var(--text,#e7ebf3)' : 'var(--faint,#8b93a7)',
                  }}>{p.name}</button>
              )
            })}
            {!profiles.length && <span style={muted}>Add a rendition above first.</span>}
          </div>
        </div>
      )}

      <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, fontSize: 'var(--fs-sm)' }}>
        <input type="checkbox" checked={g.cap_to_source} disabled={busy}
          onChange={e => patch({ capToSource: e.target.checked })} />
        Never upscale — skip rungs above the source's own height
      </label>

      {err && <p style={{ color: 'var(--danger,#f87171)', fontSize: 'var(--fs-sm)' }}>{err}</p>}
      {!g.problem && <Preview ladder={g} />}
    </div>
  )
}

/* --------------------------------------------------------------------- page */

export default function EncodingProfiles() {
  const [profiles, setProfiles] = useState<EncodeProfile[]>([])
  const [ladders, setLadders] = useState<LadderGroup[]>([])
  const [live, setLive] = useState<LiveOutputProfile[]>([])
  const [err, setErr] = useState('')
  const [newName, setNewName] = useState('')
  const [mirrorId, setMirrorId] = useState('')

  const load = useCallback(() => {
    Promise.all([api.encodeProfiles(), api.ladderGroups(), api.liveOutputProfiles()])
      .then(([p, l, o]) => { setProfiles(p); setLadders(l); setLive(o) })
      .catch(e => setErr(String(e?.message ?? e)))
  }, [])
  useEffect(load, [load])

  const mirror = async () => {
    if (!mirrorId) return
    setErr('')
    try {
      await api.mirrorLiveProfile(mirrorId, undefined, !ladders.some(l => l.is_default))
      setMirrorId(''); load()
    } catch (e: any) { setErr(String(e?.message ?? e)) }
  }

  const createOwn = async () => {
    if (!newName.trim()) return
    setErr('')
    try { await api.createLadderGroup({ name: newName.trim() }); setNewName(''); load() }
    catch (e: any) { setErr(String(e?.message ?? e)) }
  }

  return (
    <div>
      <h2 style={{ margin: '0 0 4px' }}>Encoding profiles</h2>
      <p style={{ ...muted, fontSize: 'var(--fs-sm)', marginTop: 0 }}>
        The ladders uploaded and watched-folder video is encoded to. A ladder that tracks a live
        output profile reads its rungs at encode time, so file assets match the channels using that
        profile instead of drifting from them.
      </p>
      {err && <p style={{ color: 'var(--danger,#f87171)', fontSize: 'var(--fs-sm)' }}>{err}</p>}

      <Renditions profiles={profiles} reload={load} />

      <div className="card" style={{ padding: 18, marginTop: 14 }}>
        <h3 style={{ margin: '0 0 10px', fontSize: 'var(--fs-body)' }}>New ladder</h3>
        <div style={{ display: 'grid', gap: 10, gridTemplateColumns: '1fr auto', alignItems: 'center' }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <select style={box} value={mirrorId} onChange={e => setMirrorId(e.target.value)}>
              <option value="">Mirror a live output profile…</option>
              {live.map(o => (
                <option key={o.id} value={o.id}>
                  {o.name} ({(o.rungs ?? []).map(r => `${r.height}p`).join('/')})
                </option>
              ))}
            </select>
            <button type="button" className="btn primary" onClick={mirror} disabled={!mirrorId}>
              Mirror
            </button>
          </div>
          <span style={muted}>Recommended — it cannot drift from live</span>
        </div>
        <div style={{ display: 'grid', gap: 10, gridTemplateColumns: '1fr auto', alignItems: 'center', marginTop: 10 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input style={{ ...box, minWidth: 260 }} placeholder="Or a standalone ladder, by name"
              value={newName} onChange={e => setNewName(e.target.value)} />
            <button type="button" className="btn ghost" onClick={createOwn} disabled={!newName.trim()}>
              Create
            </button>
          </div>
          <span style={muted}>For an archive or cut-down ladder</span>
        </div>
      </div>

      {ladders.map(g => (
        <Ladder key={g.id} g={g} profiles={profiles} reload={load} />
      ))}
      {!ladders.length && (
        <p style={{ ...muted, marginTop: 14 }}>
          No ladders yet. Mirror one of your live output profiles to get started.
        </p>
      )}
    </div>
  )
}
