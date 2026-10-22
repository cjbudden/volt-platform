// ============================================================================
//  CAPTIONS (Admin > Captions, build queue 1.3).
//
//  Two levels, as the encoder reads them (volt-app jobConfig.ts):
//   - the ACCOUNT's engine: none (captions off everywhere), whisper
//     (self-hosted, no per-minute fee) or gladia (managed service). It is the
//     master switch and decides which engine every captioned stream uses.
//   - each OUTPUT PROFILE: captions on or off, the language spoken, the caption
//     languages published, how far captions are held back, the whisper model.
//     A profile is shared by every channel, station and event in the groups
//     that use it, so the card says who that is.
//  Both are read when a stream starts, so the server refuses a change while a
//  stream it would affect is running and the card says which stream.
//  Saves through /api/account-settings/captions (modules/captionsSettings.ts).
// ============================================================================
import { useEffect, useState } from 'react'
import { api, type CaptionsSettings, type CaptionsProfile, type CaptionsProvider } from '../api'
import { PageHead } from '../scaffold'
import { navigate } from '../router'
import { LangPicker } from '../LangPicker'
import { usePageNotice, useNotify, FormStatus, FieldError } from '../notices'

const CC = <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><rect x="2" y="5" width="20" height="14" rx="2" /><path d="M10 10.5a2 2 0 1 0 0 3M17 10.5a2 2 0 1 0 0 3" /></svg>
const LOCK = <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>

const PROVIDERS: { key: CaptionsProvider; label: string; about: string }[] = [
  { key: 'none', label: 'Off', about: 'No stream is captioned, whatever its profile says.' },
  { key: 'whisper', label: 'Whisper (self-hosted)', about: 'Runs on Volt servers, no per-minute fee. Transcribes about 100 languages; translation to other languages adds a translation model.' },
  { key: 'gladia', label: 'Gladia (managed service)', about: 'A cloud speech and translation service. No model or GPU on our side; charged per minute of audio.' },
]

function ProviderCard({ s, onSaved }: { s: CaptionsSettings; onSaved: (x: CaptionsSettings) => void }) {
  const [v, setV] = useState<CaptionsProvider>(s.provider)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const notify = useNotify()
  useEffect(() => { setV(s.provider) }, [s.provider])
  const dirty = v !== s.provider
  const ro = !s.canEditProvider
  async function save() {
    setBusy(true); setErr('')
    try {
      const out = await api.patchCaptionsProvider(v)
      onSaved(out)
      notify({ kind: 'ok', message: v === 'none' ? 'Saved. Captions are off for every stream.' : `Saved. Streams with captions on use ${PROVIDERS.find(p => p.key === v)!.label} from their next start.` })
    } catch (e: any) { setErr(e?.message || 'Could not save') } finally { setBusy(false) }
  }
  return (
    <div className="card" style={{ padding: 18 }}>
      <div className="sec-label" style={{ marginTop: 0, display: 'flex', alignItems: 'center', gap: 6 }}>{CC} Captions engine for the account</div>
      <div className="hintxt" style={{ marginTop: 0, marginBottom: 12 }}>The master switch. A profile below decides whether its streams are captioned and in which languages; this decides whether captions run at all, and with which engine.</div>
      <div role="radiogroup" aria-label="Captions engine" style={{ display: 'grid', gap: 8 }}>
        {PROVIDERS.map(p => (
          <label key={p.key} className="toggle-row" style={{ cursor: ro ? 'default' : 'pointer', marginBottom: 0, borderColor: v === p.key ? 'rgba(63,123,255,.45)' : undefined }}>
            <input type="radio" name="captions-provider" value={p.key} checked={v === p.key} disabled={ro} onChange={() => setV(p.key)} />
            <div><div className="tt">{p.label}{s.provider === p.key && <span className="tag type" style={{ marginLeft: 8 }}>current</span>}</div><div className="td">{p.about}</div></div>
          </label>
        ))}
      </div>
      {ro && <div className="hintxt" style={{ marginTop: 10 }}>{s.providerReason}</div>}
      {!ro && (
        <div className="acct-actions">
          <FormStatus error={err} />
          <button className="btn ghost" disabled={!dirty || busy} onClick={() => { setV(s.provider); setErr('') }}>Discard</button>
          <button className="btn primary" disabled={!dirty || busy} onClick={save}>{busy ? 'Saving…' : 'Save engine'}</button>
        </div>
      )}
    </div>
  )
}

function ProfileCard({ p, s, onSaved }: { p: CaptionsProfile; s: CaptionsSettings; onSaved: (x: CaptionsSettings) => void }) {
  const init = () => ({ enabled: p.enabled, sourceLang: p.sourceLang, targets: p.targets, offsetSec: String(p.offsetSec), modelSize: p.modelSize })
  const [f, setF] = useState(init)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const notify = useNotify()
  useEffect(() => { setF(init()) }, [JSON.stringify(p)])
  const offset = Number(f.offsetSec)
  const offsetBad = f.offsetSec.trim() === '' || !Number.isFinite(offset) || offset < 0 || offset > 60 || !Number.isInteger(offset)
  const locked = p.running.length > 0
  const ro = !s.canEditProfiles || locked
  const patch: Record<string, any> = {}
  if (f.enabled !== p.enabled) patch.enabled = f.enabled
  if (f.sourceLang !== p.sourceLang) patch.sourceLang = f.sourceLang
  if (JSON.stringify(f.targets) !== JSON.stringify(p.targets)) patch.targets = f.targets
  if (!offsetBad && offset !== p.offsetSec) patch.offsetSec = offset
  if (f.modelSize !== p.modelSize) patch.modelSize = f.modelSize
  const dirty = Object.keys(patch).length > 0 || (offsetBad && f.offsetSec !== String(p.offsetSec))
  const noTargets = f.enabled && f.targets.length === 0
  const used = [p.channelCount ? `${p.channelCount} channel${p.channelCount === 1 ? '' : 's'} or station${p.channelCount === 1 ? '' : 's'}` : '', p.eventCount ? `${p.eventCount} event${p.eventCount === 1 ? '' : 's'}` : ''].filter(Boolean).join(' and ')
  async function save() {
    setBusy(true); setErr('')
    try {
      const out = await api.patchCaptionsProfile(p.id, patch)
      onSaved(out)
      notify({ kind: 'ok', message: `Saved ${p.name}. Its streams use it from their next start.` })
    } catch (e: any) { setErr(e?.message || 'Could not save') } finally { setBusy(false) }
  }
  const whisper = s.provider === 'whisper'
  return (
    <div className="card" style={{ padding: 18, marginTop: 14 }} data-profile={p.id}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ fontWeight: 700 }}>{p.name}</div>
        <span className="tag type">{p.workflowType === 'transcode' ? 'Transcode' : 'Packaging'}</span>
        {p.enabled ? <span className="tag live">{CC} Captions on</span> : <span className="tag idle">Captions off</span>}
        {locked && <span className="tag warn">{LOCK} {p.running.length} running</span>}
      </div>
      <div className="hintxt" style={{ marginTop: 4, marginBottom: 12 }}>
        {p.groups.length ? <>Used by {p.groups.map(g => g.name).join(', ')}{used ? `: ${used}` : ''}. A change applies to all of them.</> : 'Not used by any channel group yet.'}
      </div>
      {locked && <div className="hintxt" style={{ color: 'var(--warn)', marginBottom: 10 }}>Running now: {p.running.map(r => r.name).join(', ')}. Captions are read when a stream starts, so stop {p.running.length === 1 ? 'it' : 'them'} to change this profile.</div>}
      <fieldset disabled={ro || busy} style={{ border: 0, padding: 0, margin: 0, opacity: ro ? 0.6 : 1 }}>
        <div className="toggle-row">
          <div><div className="tt">Caption this profile's streams</div><div className="td">{s.provider === 'none' ? 'Captions are off for the account: choose an engine above for this to take effect.' : 'Live subtitles as selectable tracks in the HLS and DASH outputs.'}</div></div>
          <button type="button" role="switch" aria-checked={f.enabled} aria-label={`Captions for ${p.name}`} className={`sw ${f.enabled ? '' : 'off'}`} style={{ border: 0 }}
            onClick={() => setF(x => ({ ...x, enabled: !x.enabled }))}><i /></button>
        </div>
        {f.enabled && (
          <>
            <div className="field"><label>Language spoken</label>
              <select className="inp" value={f.sourceLang} style={{ maxWidth: 320 }} onChange={e => setF(x => ({ ...x, sourceLang: e.target.value }))}>
                <option value="auto">Detect automatically</option>
                {s.languages.map(l => <option key={l.code} value={l.code}>{l.label}</option>)}
                {f.sourceLang !== 'auto' && !s.languages.some(l => l.code === f.sourceLang) && <option value={f.sourceLang}>{f.sourceLang}</option>}
              </select>
              <div className="hintxt">Naming it is faster and more accurate than detecting it.</div>
            </div>
            <div className="field"><label>Caption languages</label>
              <LangPicker value={f.targets} options={s.languages} onChange={t => setF(x => ({ ...x, targets: t }))} />
            </div>
            <div className="field"><label>Hold captions back by (seconds)</label>
              <input className="inp" type="number" min={0} max={60} step={1} style={{ maxWidth: 140 }} value={f.offsetSec}
                aria-label="Caption offset in seconds" onChange={e => setF(x => ({ ...x, offsetSec: e.target.value }))} />
              <FieldError>{offsetBad ? 'Whole seconds, from 0 to 60' : ''}</FieldError>
              <div className="hintxt">The playout delay that keeps words in step with the picture. 3 to 6 seconds suits most streams.</div>
            </div>
            <div className="field"><label>Whisper model</label>
              <select className="inp" value={f.modelSize} style={{ maxWidth: 320 }} onChange={e => setF(x => ({ ...x, modelSize: e.target.value }))}>
                {s.modelSizes.map(m => <option key={m} value={m}>{m}{s.cpuInEncoder && s.cpuSizes.includes(m) ? ' (runs in the encoder, no GPU)' : ' (GPU add-on)'}</option>)}
              </select>
              <div className="hintxt">{whisper ? 'Larger models are more accurate and need more of the server.' : 'Used only when the account engine is Whisper.'}</div>
            </div>
          </>
        )}
      </fieldset>
      {!s.canEditProfiles && <div className="hintxt">{s.profilesReason}</div>}
      {s.canEditProfiles && !locked && (
        <div className="acct-actions">
          <FormStatus error={err} blocked={noTargets ? 'Add at least one caption language, or turn captions off.' : offsetBad ? 'Set the offset in whole seconds, from 0 to 60.' : undefined} />
          <button className="btn ghost" disabled={!dirty || busy} onClick={() => { setF(init()); setErr('') }}>Discard</button>
          <button className="btn primary" disabled={!dirty || busy || noTargets || offsetBad} onClick={save}>{busy ? 'Saving…' : 'Save profile'}</button>
        </div>
      )}
    </div>
  )
}

export default function CaptionsPage() {
  const [s, setS] = useState<CaptionsSettings | null>(null)
  const [err, setErr] = useState('')
  const load = () => api.captionsSettings().then(x => { setS(x); setErr('') }).catch((e: any) => setErr(e?.message || 'Could not load the captions settings'))
  useEffect(() => { load() }, [])
  usePageNotice('load', err ? { kind: 'error', title: "Couldn't load the captions settings.", message: err, actions: [{ label: 'Retry', onClick: () => { load() } }] } : null)
  const sub = 'Live subtitles and translation: the engine for the account, and the languages each output profile publishes.'
  if (!s) return <><PageHead title="Captions" sub={sub} />{!err && <div className="loading">Loading…</div>}</>
  return (
    <>
      <PageHead title="Captions" sub={sub} action={<button className="btn ghost" onClick={() => navigate('/groups')}>Channel Groups</button>} />
      <ProviderCard s={s} onSaved={setS} />
      <div className="sec-label" style={{ marginTop: 24 }}>Output profiles</div>
      {s.profiles.length === 0
        ? <div className="hintxt">No output profiles yet. A profile is made with a channel group (Admin, Channel Groups).</div>
        : s.profiles.map(p => <ProfileCard key={p.id} p={p} s={s} onSaved={setS} />)}
    </>
  )
}
