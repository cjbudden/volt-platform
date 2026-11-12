import { useCallback, useEffect, useState } from 'react'
import {
  api, type Watchfolder, type WatchfolderRule, type WatchfolderItem,
  type WatchfolderDryRun, type WatchfolderScan, type LadderGroup, type WatchfolderSiteOptions,
} from '../api'
import { pressable } from '../a11y'
import { useAccess } from '../access'
import { ConfirmDialog } from '../listActions'

/* ============================================================================
   WATCHFOLDERS — a drop folder, the rules that sort it, and what it refused.

   THE PAGE IS BUILT AROUND THE ORDER OF THE RULES, because that is the thing an
   operator gets wrong and cannot see. `*.png -> poster` above `slate_*.png ->
   slate` means every slate is filed as a poster, silently, and the rule set
   looks perfectly reasonable read as a list of independent statements. So the
   order is numbered, it is movable, and the rule that WOULD win is highlighted.

   THE DRY RUN IS THE ANSWER TO "WHICH ONE WINS". It is not a preview built from
   its own reading of the rules — it calls the same classify() the scanner runs,
   which is the only reason it is worth trusting. Type a filename, see the
   decision and the winning rule, before any file is dropped.

   THE REVIEW QUEUE IS NOT AN ERROR LOG. Every row is a file sitting in the
   review folder waiting for a person, and the two things that person can do are
   REPROCESS (I fixed the rule, look again) and REMOVE (this was junk). Remove
   closes the row and LEAVES THE FILE, which is stated on the button, because the
   whole point of quarantine is that nothing is destroyed on a guess.

   FAILED IS SHOWN BESIDE QUARANTINED, deliberately. They are different facts: a
   quarantined file matched nothing, a failed one matched and then the ingest
   broke, and an operator who cannot tell them apart will go looking for a rule
   that is not the problem.

   ON-PREM FOLDERS (build queue H2) are on a customer's storage and scanned by
   the agent of a Hybrid Site, with these same rules. Offered only to an
   account licensed for Hybrid Sites. The page says where the folder is and
   where its files are encoded; there is no Scan now (the agent scans every
   pass), and Reprocess asks the agent to move the file back.
   ========================================================================== */

/** Where an on-prem folder's work runs, in the console's words. */
const PLACEMENT: Record<string, { label: string; help: string }> = {
  upload_cloud: { label: 'Upload and encode in the cloud', help: 'The site agent uploads each accepted file, resumable: video and audio are encoded like any upload, images and captions are taken in as from a local folder. For sites without encoders.' },
  encode_site: { label: 'Encode at site', help: 'Video and audio are encoded by the site agent at the site and only the packaged output is uploaded; the original stays on your storage. Images, captions and loops are uploaded as usual.' },
}

/** Fallback times offered for an Encode at site folder (Hybrid Sites, H5). Null waits for the site. */
const FALLBACK_CHOICES: { minutes: number | null; label: string }[] = [
  { minutes: null, label: 'Wait for the site' },
  { minutes: 15, label: 'Encode in the cloud after 15 minutes' },
  { minutes: 30, label: 'Encode in the cloud after 30 minutes' },
  { minutes: 60, label: 'Encode in the cloud after 1 hour' },
  { minutes: 240, label: 'Encode in the cloud after 4 hours' },
  { minutes: 1440, label: 'Encode in the cloud after 1 day' },
]

const STATUS: Record<string, { label: string; tone: string; help: string }> = {
  seen:        { label: 'Waiting',     tone: 'var(--brand,#3f7bff)', help: 'Classified, waiting for the next ingest pass. A caption or metadata file waits up to 24 hours for its video.' },
  ingested:    { label: 'In library',  tone: 'var(--ok,#4ade80)',    help: 'A library record was created for this file: Image Library, Media Library (a video shows its encode there) or Loops & Fillers.' },
  quarantined: { label: 'Needs review',tone: 'var(--warn,#fbbf24)',  help: 'No rule matched, or a rule refused it. The file is in the review folder.' },
  failed:      { label: 'Failed',      tone: 'var(--danger,#f87171)',help: 'It matched a rule, but the ingest itself did not complete.' },
  reprocessed: { label: 'Sent back',   tone: 'var(--brand,#3f7bff)', help: 'Returned to the drop folder to be looked at again.' },
  off:         { label: 'Switched off',tone: 'var(--faint,#8b93a7)', help: 'Not scanned until switched on again.' },
  removed:     { label: 'Dismissed',   tone: 'var(--faint,#8b93a7)', help: 'Closed by an operator. The file itself was left where it was.' },
}

function fmtBytes(n: number | string | null | undefined): string {
  const b = Number(n ?? 0)
  if (!b) return '—'
  const u = ['B', 'kB', 'MB', 'GB', 'TB']
  let i = 0, v = b
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++ }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${u[i]}`
}

function ago(iso: string | null): string {
  if (!iso) return 'never'
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return `${Math.round(s)}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}

const box: React.CSSProperties = {
  background: 'var(--panel-2,#151922)', border: '1px solid var(--border,#242a36)',
  color: 'var(--text,#e7ebf3)', borderRadius: 8, padding: '7px 10px',
  fontFamily: 'inherit', fontSize: 'var(--fs-sm)', outline: 'none',
}

function Pill({ status }: { status: string }) {
  const s = STATUS[status] ?? { label: status, tone: 'var(--faint,#8b93a7)', help: '' }
  return (
    <span title={s.help} style={{
      display: 'inline-block', padding: '2px 9px', borderRadius: 999, fontSize: 'var(--fs-xs)',
      fontWeight: 600, color: s.tone, background: 'color-mix(in srgb, currentColor 12%, transparent)',
      border: '1px solid color-mix(in srgb, currentColor 35%, transparent)',
    }}>{s.label}</span>
  )
}

/** "On <site>": the folder is on a customer's storage, watched by that site's agent. */
function SiteTag({ name }: { name?: string | null }) {
  return (
    <span className="tag" title="An on-prem folder: on this site's storage, scanned by its agent">
      <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" style={{ verticalAlign: '-1px', marginRight: 4 }}>
        <path d="M3 21h18" /><path d="M5 21V8l7-5 7 5v13" /><path d="M9 21v-6h6v6" />
      </svg>
      On {name ?? 'a site'}
    </span>
  )
}

/* ---------------------------------------------------------------- rules ---- */

function Rules({ folder, rules, kinds, defaultsMissing, imageTypes, reload }: {
  folder: Watchfolder; rules: WatchfolderRule[]; kinds: TargetKind[]; defaultsMissing: string[]
  imageTypes: { key: string; label: string }[]; reload: () => void
}) {
  const { can } = useAccess()
  const canManage = can('media', 'manage')
  const canTry = can('media', 'operate')
  const [draft, setDraft] = useState({ name: '', pattern: '', targetKind: 'slate', workflow: 'register', imageType: '', imageTypeFromName: true })
  const typeLabel = (k?: string | null) => imageTypes.find(t => t.key === k)?.label ?? k ?? ''
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [deleting, setDeleting] = useState<WatchfolderRule | null>(null)
  const known = new Set(kinds.map(k => k.kind))

  // WHICH RULE WOULD WIN, asked of the server so the answer comes from the same
  // classifier the scanner uses. A preview that reimplemented the matching would
  // be confidently wrong exactly when it mattered.
  const [probe, setProbe] = useState('')
  const [dry, setDry] = useState<WatchfolderDryRun | null>(null)
  // SAID, NOT SWALLOWED: a role that cannot run the dry run used to type and
  // see nothing at all. The reason is shown where the answer would be.
  const [dryErr, setDryErr] = useState('')
  useEffect(() => {
    if (!probe.trim()) { setDry(null); setDryErr(''); return }
    const t = setTimeout(() => {
      api.watchfolderDryRun(folder.id, probe.trim())
        .then(d => { setDry(d); setDryErr('') })
        .catch((e: any) => {
          setDry(null)
          setDryErr(/403|not allow/i.test(String(e?.message ?? e))
            ? 'Your role cannot try file names here. It needs Files, uploads & storage: Operate.'
            : String(e?.message ?? e))
        })
    }, 250)
    return () => clearTimeout(t)
  }, [probe, folder.id, rules])

  const add = async () => {
    if (!draft.name.trim() || !draft.pattern.trim()) { setErr('A rule needs a name and a pattern.'); return }
    setBusy(true); setErr('')
    try {
      await api.addWatchfolderRule(folder.id, {
        name: draft.name.trim(), pattern: draft.pattern.trim(),
        targetKind: draft.targetKind.trim(), workflow: draft.workflow.trim() || null,
        ...(toImages ? { imageType: draft.imageType || null, imageTypeFromName: draft.imageTypeFromName } : {}),
      })
      setDraft({ ...draft, name: '', pattern: '', imageType: '', imageTypeFromName: true })
      reload()
    } catch (e: any) { setErr(String(e?.message ?? e)) } finally { setBusy(false) }
  }

  /** Swap two rules' ordinals. The order IS the rule set, so it has to be
   *  editable in one click rather than by typing numbers. */
  const move = async (i: number, dir: -1 | 1) => {
    const a = rules[i], b = rules[i + dir]
    if (!a || !b) return
    setBusy(true)
    try {
      // Through a spare ordinal, because (watchfolder_id, ordinal) is UNIQUE and
      // a direct swap collides on the first write.
      const spare = Math.max(...rules.map(r => r.ordinal)) + 1000
      await api.patchWatchfolderRule(folder.id, a.id, { ordinal: spare })
      await api.patchWatchfolderRule(folder.id, b.id, { ordinal: a.ordinal })
      await api.patchWatchfolderRule(folder.id, a.id, { ordinal: b.ordinal })
      reload()
    } catch (e: any) { setErr(String(e?.message ?? e)) } finally { setBusy(false) }
  }

  const winner = dry?.rules.find(r => r.winner)?.id ?? null

  // SWITCHED OFF, NOT DELETED: a default rule an operator does not want today
  // can come back with one click, and its place in the order is kept.
  const toggle = async (r: WatchfolderRule) => {
    setBusy(true); setErr('')
    try { await api.patchWatchfolderRule(folder.id, r.id, { enabled: !r.enabled }); reload() }
    catch (e: any) { setErr(String(e?.message ?? e)) } finally { setBusy(false) }
  }

  const addDefaults = async () => {
    setBusy(true); setErr('')
    try { await api.addWatchfolderDefaultRules(folder.id); reload() }
    catch (e: any) { setErr(String(e?.message ?? e)) } finally { setBusy(false) }
  }

  // The destinations a new rule may name, by what its pattern matches.
  const draftTypes = patternTypes(draft.pattern)
  const fits = (k: TargetKind) => !draftTypes || !k.accepts || draftTypes.every(t => k.accepts!.includes(t))
  const offered = kinds.filter(fits)
  // An image type is offered only for a rule that takes images into the
  // Image Library: nothing else becomes an asset's image.
  const toImages = kinds.find(k => k.kind === draft.targetKind)?.goesTo === 'images'
  useEffect(() => {
    if (offered.length && !offered.some(k => k.kind === draft.targetKind)) setDraft(d => ({ ...d, targetKind: offered[0].kind }))
  }, [draft.pattern]) // eslint-disable-line react-hooks/exhaustive-deps

  const removeRule = async (r: WatchfolderRule) => {
    setDeleting(null); setBusy(true); setErr('')
    try { await api.deleteWatchfolderRule(folder.id, r.id); reload() }
    catch (e: any) { setErr(String(e?.message ?? e)) } finally { setBusy(false) }
  }

  return (
    <div className="card" style={{ padding: 18, marginTop: 14 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 4 }}>
        <h3 style={{ margin: 0, fontSize: 'var(--fs-body)' }}>Rules</h3>
        <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--faint,#8b93a7)' }}>
          First match wins, top to bottom. A file matching nothing goes to review.
        </span>
        {canManage && defaultsMissing.length > 0 && (
          <button type="button" className="btn ghost" style={{ marginLeft: 'auto', padding: '4px 10px' }}
            onClick={addDefaults} disabled={busy}
            title="Adds the rules by file type this folder does not have, below its own rules. Nothing it does today changes.">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" style={{ verticalAlign: '-2px', marginRight: 5 }}>
              <path d="M12 5v14M5 12h14" />
            </svg>
            Add default rules
          </button>
        )}
      </div>

      {rules.length === 0 && (
        <p style={{ color: 'var(--faint,#8b93a7)', fontSize: 'var(--fs-sm)' }}>
          No rules yet, so every file will go to review. That is the safe default, not a fault.
        </p>
      )}

      <div style={{ display: 'grid', gap: 6, margin: '10px 0' }}>
        {rules.map((r, i) => (
          <div key={r.id} className="wf-rule" style={{
            display: 'grid', gridTemplateColumns: '28px 1fr 1fr 130px 120px auto',
            gap: 10, alignItems: 'center', padding: '8px 10px', borderRadius: 8,
            background: r.id === winner ? 'rgba(63,123,255,.12)' : 'var(--panel-2,#151922)',
            border: `1px solid ${r.id === winner ? 'rgba(63,123,255,.5)' : 'var(--border,#242a36)'}`,
            opacity: r.enabled ? 1 : 0.55,
          }}>
            <span style={{ color: 'var(--faint,#8b93a7)', fontVariantNumeric: 'tabular-nums' }}>{i + 1}</span>
            <span style={{ fontWeight: 600 }}>
              {r.name}
              {r.builtin && (
                <span className="tag" style={{ marginLeft: 8, color: 'var(--faint,#8b93a7)', background: 'var(--panel,#10131a)', border: '1px solid var(--border,#242a36)' }}
                  title="A default rule by file type. Edit it, switch it off or move it like any other rule.">
                  Default
                </span>
              )}
              {!r.enabled && <span style={{ marginLeft: 8, fontSize: 'var(--fs-xs)', color: 'var(--faint,#8b93a7)', fontWeight: 400 }}>off</span>}
            </span>
            <code style={{ fontSize: 'var(--fs-xs)' }}>{r.pattern}</code>
            <span style={{ fontSize: 'var(--fs-sm)' }}>
              {r.action === 'reject'
                ? <em style={{ color: 'var(--danger,#f87171)' }}>refuse</em>
                : <>→ {r.target_kind}</>}
              {r.action !== 'reject' && r.image_type && (
                <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--faint,#8b93a7)' }}
                  title={r.image_type_from_name === false ? 'Every image it takes is this type.' : 'Unless a type word at the end of the name says otherwise.'}>
                  as {typeLabel(r.image_type)}{r.image_type_from_name === false ? '' : ', or by name'}
                </div>
              )}
              {/* A rule saved before the kinds were checked can still name one
                  that nothing takes in. Said on the row, so it gets fixed. */}
              {r.action !== 'reject' && kinds.length > 0 && !known.has(String(r.target_kind).toLowerCase()) && (
                <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--warn,#fbbf24)' }}
                  title="Files this rule accepts wait for ever. Delete it and add it again with a kind from the list.">
                  ⚠ never taken in
                </div>
              )}
            </span>
            <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--faint,#8b93a7)' }}>{r.workflow ?? '—'}</span>
            <span style={{ display: 'flex', gap: 4 }}>
              {canManage && <>
              <button type="button" className="btn ghost" disabled={busy}
                onClick={() => toggle(r)} aria-pressed={r.enabled}
                aria-label={`${r.enabled ? 'Switch off' : 'Switch on'} ${r.name}`}
                title={r.enabled ? 'Switch this rule off. Files it catches go to the rules below it.' : 'Switch this rule back on'}
                style={{ padding: '3px 8px', minWidth: 44 }}>{r.enabled ? 'On' : 'Off'}</button>
              <button type="button" className="btn ghost" disabled={busy || i === 0}
                onClick={() => move(i, -1)} aria-label={`Move ${r.name} up`}
                style={{ padding: '3px 8px' }}>↑</button>
              <button type="button" className="btn ghost" disabled={busy || i === rules.length - 1}
                onClick={() => move(i, 1)} aria-label={`Move ${r.name} down`}
                style={{ padding: '3px 8px' }}>↓</button>
              <button type="button" className="btn ghost" disabled={busy}
                onClick={() => setDeleting(r)}
                aria-label={`Delete ${r.name}`} title="Delete this rule" style={{ padding: '3px 8px' }}>✕</button>
              </>}
            </span>
          </div>
        ))}
      </div>

      {deleting && (
        <ConfirmDialog danger title={`Delete the rule ${deleting.name}?`}
          body={<>Files matching <code>{deleting.pattern}</code> are then sorted by the rules below it, or go to review if none matches. Files already taken in are not affected.</>}
          confirmLabel="Delete rule" onCancel={() => setDeleting(null)} onConfirm={() => removeRule(deleting)} />
      )}

      {canManage && (
      <div className="wf-add" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 170px 120px auto', gap: 8, marginTop: 12 }}>
        <input style={box} placeholder="Rule name" value={draft.name}
          onChange={e => setDraft({ ...draft, name: e.target.value })} />
        <input style={box} placeholder="slate_*.png" value={draft.pattern}
          onChange={e => setDraft({ ...draft, pattern: e.target.value })} />
        {/* ONLY THE KINDS VOLT TAKES IN, from the server (GET /watchfolders/:id
            targetKinds). Free text accepted names like "document" that left
            every matching file waiting for ever. */}
        <select style={box} aria-label="Target kind" value={draft.targetKind}
          onChange={e => setDraft({ ...draft, targetKind: e.target.value })}>
          {(['images', 'media', 'loops', 'companions'] as const).filter(g => offered.some(k => k.goesTo === g)).map(g => (
            <optgroup key={g} label={GOES_TO[g]}>
              {offered.filter(k => k.goesTo === g).map(k => <option key={k.kind} value={k.kind}>{k.kind}</option>)}
            </optgroup>
          ))}
        </select>
        <input style={box} placeholder="workflow" value={draft.workflow}
          onChange={e => setDraft({ ...draft, workflow: e.target.value })} />
        <button type="button" className="btn primary" onClick={add} disabled={busy}>Add rule</button>
      </div>
      )}
      {canManage && toImages && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', marginTop: 8, fontSize: 'var(--fs-sm)' }}>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            Image type
            <select style={box} aria-label="Image type" value={draft.imageType}
              onChange={e => setDraft({ ...draft, imageType: e.target.value })}>
              <option value="">From the name only</option>
              {imageTypes.map(t => <option key={t.key} value={t.key}>{t.label}</option>)}
            </select>
          </label>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}
            title="A word at the end of the name, like _poster or -thumbnail, says the type. Off: every image this rule takes is the type above.">
            <input type="checkbox" checked={draft.imageTypeFromName}
              onChange={e => setDraft({ ...draft, imageTypeFromName: e.target.checked })} />
            A type word in the name wins
          </label>
          <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--faint,#8b93a7)' }}>
            An image with a type becomes that image of the video it is named after.
          </span>
        </div>
      )}
      {canManage && draftTypes && (
        <p style={{ fontSize: 'var(--fs-xs)', color: 'var(--faint,#8b93a7)', marginTop: 6 }}>
          {offered.length
            ? <>This pattern matches {TYPE_LABEL[draftTypes[0]]}, so only places that take {TYPE_LABEL[draftTypes[0]]} are offered.</>
            : <>Volt does not take {TYPE_LABEL[draftTypes[0]]} in through a rule yet. Without a rule they go to review.</>}
        </p>
      )}
      {err && <p style={{ color: 'var(--danger,#f87171)', fontSize: 'var(--fs-sm)' }}>{err}</p>}

      {/* ---- the dry run ---- */}
      <div style={{ marginTop: 18, paddingTop: 14, borderTop: '1px solid var(--border,#242a36)' }}>
        <label style={{ display: 'block', fontSize: 'var(--fs-sm)', fontWeight: 600, marginBottom: 6 }}>
          Try a filename
        </label>
        <input style={{ ...box, width: '100%', maxWidth: 420 }} placeholder="slate_open.png"
          value={probe} onChange={e => setProbe(e.target.value)} disabled={!canTry}
          title={canTry ? undefined : 'Needs Files, uploads & storage: Operate'} />
        {!canTry && (
          <p style={{ fontSize: 'var(--fs-xs)', color: 'var(--warn,#fbbf24)', marginTop: 6 }}>
            Your role cannot try file names here. It needs Files, uploads & storage: Operate.
          </p>
        )}
        {dryErr && canTry && <p style={{ fontSize: 'var(--fs-sm)', color: 'var(--danger,#f87171)', marginTop: 6 }}>{dryErr}</p>}
        <p style={{ fontSize: 'var(--fs-xs)', color: 'var(--faint,#8b93a7)', marginTop: 6 }}>
          Answered by the same classifier the scanner runs, so this is what would actually happen.
        </p>
        {dry && (
          <div style={{ marginTop: 8, fontSize: 'var(--fs-sm)' }}>
            {dry.decision.decision === 'accept' ? (
              <span style={{ color: 'var(--ok,#4ade80)' }}>
                Accepted as <strong>{dry.decision.targetKind}</strong>
                {dry.decision.workflow ? <> for <strong>{dry.decision.workflow}</strong></> : null}
                {winner ? <> by rule {rules.findIndex(r => r.id === winner) + 1}</> : null}
                {dry.imageType && <span style={{ color: 'var(--text)' }}>
                  {' '}· the <strong>{dry.imageType.label}</strong>{dry.imageType.from === 'name' ? <> (from “{dry.imageType.word}” in the name)</> : <> (from the rule)</>}
                </span>}
                {dry.asset && <span style={{ color: 'var(--text)' }}>
                  {' '}· of {dry.asset.waiting
                    ? <>the video <code>{dry.asset.objectKey}</code> once it is in (waits up to 24 hours)</>
                    : <><strong>{dry.asset.title ?? dry.asset.objectKey}</strong></>}
                </span>}
                {dry.imageType && !dry.asset && <span style={{ color: 'var(--faint,#8b93a7)' }}>
                  {' '}· no video in this folder is named like it yet, so it waits up to 24 hours, then stays in the Image Library
                </span>}
              </span>
            ) : (
              <span style={{ color: 'var(--warn,#fbbf24)' }}>
                Sent to <code>{dry.quarantinePath}</code> — {dry.decision.reason}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

/* ----------------------------------------------------------------- queue ---- */

function Queue({ folder, reload }: { folder: Watchfolder; reload: () => void }) {
  const canManage = useAccess().can('media', 'manage')
  const [items, setItems] = useState<WatchfolderItem[]>([])
  const [filter, setFilter] = useState<string>('open')
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState('')

  const load = useCallback(() => {
    // 'open' is not a status, it is the two statuses that need a person. Asking
    // for them separately keeps the server's filter honest about what it means.
    const wanted = filter === 'open' ? ['quarantined', 'failed'] : [filter]
    Promise.all(wanted.map(s => api.watchfolderItems(folder.id, s)))
      .then(rs => setItems(rs.flatMap(r => r.items)
        .sort((a, b) => +new Date(b.seen_at) - +new Date(a.seen_at))))
      .catch(e => setErr(String(e?.message ?? e)))
  }, [folder.id, filter])
  useEffect(load, [load])

  const resolve = async (it: WatchfolderItem, how: 'reprocess' | 'remove') => {
    setBusy(it.id); setErr('')
    try { await api.resolveWatchfolderItem(folder.id, it.id, how); load(); reload() }
    catch (e: any) { setErr(String(e?.message ?? e)) } finally { setBusy(null) }
  }

  return (
    <div className="card" style={{ padding: 18, marginTop: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <h3 style={{ margin: 0, fontSize: 'var(--fs-body)' }}>Queue</h3>
        <select className="inp sel-sm" style={{ width: 'auto' }} value={filter} onChange={e => setFilter(e.target.value)}>
          <option value="open">Needs a person</option>
          <option value="quarantined">Needs review</option>
          <option value="failed">Failed</option>
          <option value="seen">Waiting</option>
          <option value="ingested">In library</option>
          <option value="reprocessed">Sent back</option>
          <option value="removed">Dismissed</option>
        </select>
        <button type="button" className="btn ghost" onClick={load} style={{ marginLeft: 'auto' }}>Refresh</button>
      </div>

      {err && <p style={{ color: 'var(--danger,#f87171)', fontSize: 'var(--fs-sm)' }}>{err}</p>}
      {items.length === 0 && (
        <p style={{ color: 'var(--faint,#8b93a7)', fontSize: 'var(--fs-sm)' }}>Nothing here.</p>
      )}

      <div style={{ display: 'grid', gap: 6 }}>
        {items.map(it => (
          <div key={it.id} className="wf-item" style={{
            display: 'grid', gridTemplateColumns: '1fr 110px 90px 100px auto', gap: 10,
            alignItems: 'center', padding: '9px 10px', borderRadius: 8,
            background: 'var(--panel-2,#151922)', border: '1px solid var(--border,#242a36)',
          }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {it.object_key}
              </div>
              {/* The reason as it was RECORDED, not recomputed against today's
                  rules. That is what makes the queue a history rather than a
                  re-derivation that quietly changes when somebody edits a rule. */}
              {it.reason && (
                <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--faint,#8b93a7)' }}>{it.reason}</div>
              )}
              {it.quarantine_key && (
                <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--faint,#8b93a7)' }}>
                  now at <code>{it.quarantine_key}</code>{folder.kind === 'site' ? ` on ${folder.site_name ?? 'the site'}` : ''}
                </div>
              )}
              {it.site_action === 'return' && (
                <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--brand,#3f7bff)' }}>
                  Waiting for the site agent to move it back into the folder.
                </div>
              )}
              {it.site_action === 'review' && (
                <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--brand,#3f7bff)' }}>
                  Waiting for the site agent to move it into the review folder.
                </div>
              )}
            </div>
            <Pill status={it.status} />
            <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--faint,#8b93a7)' }}>{fmtBytes(it.size_bytes)}</span>
            <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--faint,#8b93a7)' }}>{ago(it.seen_at)}</span>
            <span style={{ display: 'flex', gap: 6 }}>
              {/* A REVIEW FILE IS REPROCESSED, A FAILED ONE RETRIED. They are
                  different moves on the server: a review file is moved back
                  into the drop folder, a failed one never left it and is only
                  taken in again. Both close with Dismiss, which deletes
                  nothing. */}
              {canManage && it.status === 'quarantined' && (
                <>
                  <button type="button" className="btn ghost" disabled={busy === it.id}
                    title={folder.kind === 'site'
                      ? 'The site agent puts the file back in the drop folder on its next pass and decides it again.'
                      : 'Put the file back in the drop folder and look at it again on the next scan.'}
                    onClick={() => resolve(it, 'reprocess')}>Reprocess</button>
                  <button type="button" className="btn ghost" disabled={busy === it.id}
                    title="Close this entry. The file itself stays in the review folder."
                    onClick={() => resolve(it, 'remove')}>Dismiss</button>
                </>
              )}
              {canManage && it.status === 'failed' && (
                <>
                  <button type="button" className="btn ghost" disabled={busy === it.id}
                    title="Take the file in again on the next pass, within a minute. Fix the cause in the reason first."
                    onClick={() => resolve(it, 'reprocess')}>Retry</button>
                  <button type="button" className="btn ghost" disabled={busy === it.id}
                    title="Close this entry. The file stays in the watchfolder and is not taken in."
                    onClick={() => resolve(it, 'remove')}>Dismiss</button>
                </>
              )}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

/* ---------------------------------------------------------------- detail ---- */

function Detail({ id, onBack }: { id: string; onBack: () => void }) {
  const canManage = useAccess().can('media', 'manage')
  const [folder, setFolder] = useState<(Watchfolder & { rules: WatchfolderRule[]; targetKinds?: TargetKind[]; defaultsMissing?: string[]; imageTypes?: { key: string; label: string }[] }) | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [scan, setScan] = useState<WatchfolderScan | null>(null)
  const [ladders, setLadders] = useState<LadderGroup[]>([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  useEffect(() => { api.ladderGroups().then(setLadders).catch(() => setLadders([])) }, [])

  const load = useCallback(() => {
    api.watchfolder(id).then(setFolder).catch(e => setErr(String(e?.message ?? e)))
  }, [id])
  useEffect(load, [load])

  const runScan = async () => {
    setBusy(true); setErr(''); setScan(null)
    try { setScan(await api.scanWatchfolder(id)); load() }
    catch (e: any) { setErr(String(e?.message ?? e)) } finally { setBusy(false) }
  }

  // RENAME, SWITCH OFF AND DELETE were API-only. All three go through the
  // folder's PATCH and DELETE, which version and audit like every record.
  const saveName = async () => {
    if (!folder || renaming == null) return
    const name = renaming.trim()
    if (!name) { setErr('A watchfolder needs a name.'); return }
    try { await api.patchWatchfolder(folder.id, { name, version: folder.version }); setRenaming(null); setErr(''); load() }
    catch (e: any) { setErr(String(e?.message ?? e)) }
  }
  const toggle = async () => {
    if (!folder) return
    try { await api.patchWatchfolder(folder.id, { enabled: !folder.enabled, version: folder.version }); setErr(''); load() }
    catch (e: any) { setErr(String(e?.message ?? e)) }
  }
  const remove = async () => {
    if (!folder) return
    setConfirmDelete(false)
    try { await api.deleteWatchfolder(folder.id); onBack() }
    catch (e: any) { setErr(String(e?.message ?? e)) }
  }

  if (!folder) return <p style={{ color: 'var(--faint,#8b93a7)' }}>{err || 'Loading…'}</p>

  return (
    <div>
      <button type="button" className="btn ghost" onClick={onBack} style={{ marginBottom: 12 }}>← Watchfolders</button>
      <div className="card" style={{ padding: 18 }}>
        <div className="wf-head" style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          {renaming == null ? (
            <h2 style={{ margin: 0 }}>{folder.name}</h2>
          ) : (
            <span style={{ display: 'flex', gap: 6 }}>
              <input style={box} aria-label="Watchfolder name" value={renaming} autoFocus
                onChange={e => setRenaming(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') saveName(); if (e.key === 'Escape') setRenaming(null) }} />
              <button type="button" className="btn primary" onClick={saveName}>Save</button>
              <button type="button" className="btn ghost" onClick={() => setRenaming(null)}>Cancel</button>
            </span>
          )}
          <code style={{ fontSize: 'var(--fs-xs)', color: 'var(--faint,#8b93a7)' }}>{folder.config?.path}</code>
          {folder.kind === 'site' && <SiteTag name={folder.site_name} />}
          {!folder.enabled && <Pill status="off" />}
          <span style={{ marginLeft: 'auto', display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {canManage && renaming == null && (
              <button type="button" className="btn ghost" onClick={() => setRenaming(folder.name)}>✎ Rename</button>
            )}
            {canManage && (
              <button type="button" className="btn ghost" onClick={toggle}
                title={folder.enabled ? 'Stop scanning this folder. Rules and the queue are kept.' : 'Start scanning this folder again.'}>
                {folder.enabled ? '⏸ Switch off' : '▶ Switch on'}
              </button>
            )}
            {canManage && (
              <button type="button" className="btn ghost" style={{ color: 'var(--danger,#f87171)' }}
                onClick={() => setConfirmDelete(true)}>✕ Delete</button>
            )}
            {canManage && folder.kind !== 'site' && (
              <button type="button" className="btn primary" onClick={runScan} disabled={busy || !folder.enabled}
                title={folder.enabled ? undefined : 'Switched off. Switch it on to scan.'}>{busy ? 'Scanning…' : 'Scan now'}</button>
            )}
          </span>
        </div>
        {confirmDelete && (
          <ConfirmDialog danger title={`Delete the watchfolder ${folder.name}?`}
            body={<>Volt stops watching the folder and its rules and queue are deleted. No file is deleted: everything in the folder and its review folder stays where it is, and what was taken in stays in the libraries.</>}
            confirmLabel="Delete watchfolder" typeToConfirm={folder.name}
            onCancel={() => setConfirmDelete(false)} onConfirm={remove} />
        )}
        {folder.kind === 'site' ? (
          <p style={{ fontSize: 'var(--fs-xs)', color: 'var(--faint,#8b93a7)', marginTop: 8 }}>
            {folder.enabled ? `On ${folder.site_name ?? 'a site'}: its agent scans this folder with these rules every pass.` : 'Switched off: the site agent does not scan it until it is switched on again.'} Refused
            files go to <code>{folder.quarantine_path}</code> inside this folder at the site and never leave it. Last pass {ago(folder.last_scan_at)}.
          </p>
        ) : (
          <p style={{ fontSize: 'var(--fs-xs)', color: 'var(--faint,#8b93a7)', marginTop: 8 }}>
            {folder.enabled ? 'Scanned automatically every minute.' : 'Switched off: not scanned until it is switched on again.'} Refused files go to <code>{folder.quarantine_path}</code> inside
            this folder. Last scan {ago(folder.last_scan_at)}.
          </p>
        )}
        {folder.kind === 'site' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
            <label style={{ fontSize: 'var(--fs-sm)', fontWeight: 600 }} htmlFor="wf-placement">Where it is encoded</label>
            <select id="wf-placement" className="inp sel-sm" style={{ width: 'auto', maxWidth: '100%' }}
              value={folder.placement ?? 'upload_cloud'} disabled={!canManage}
              onChange={async (e) => {
                try { await api.patchWatchfolder(folder.id, { placement: e.target.value }); setErr(''); load() }
                catch (er: any) { setErr(String(er?.message ?? er)) }
              }}>
              <option value="upload_cloud">{PLACEMENT.upload_cloud.label}</option>
              <option value="encode_site">{PLACEMENT.encode_site.label}</option>
            </select>
            <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--faint,#8b93a7)' }}>
              {PLACEMENT[folder.placement ?? 'upload_cloud']?.help}
            </span>
          </div>
        )}
        {/* CLOUD FALLBACK (Hybrid Sites, H5). Off unless a person picks a time:
            the original stays on the customer's storage unless they choose to
            let it go to the cloud when the site cannot encode it. */}
        {folder.kind === 'site' && folder.placement === 'encode_site' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
            <label style={{ fontSize: 'var(--fs-sm)', fontWeight: 600 }} htmlFor="wf-fallback">If the site does not encode it</label>
            <select id="wf-fallback" className="inp sel-sm" style={{ width: 'auto', maxWidth: '100%' }}
              value={String((folder as any).fallback_minutes ?? '')} disabled={!canManage}
              onChange={async (e) => {
                try { await api.patchWatchfolder(folder.id, { fallbackMinutes: e.target.value ? Number(e.target.value) : null }); setErr(''); load() }
                catch (er: any) { setErr(String(er?.message ?? er)) }
              }}>
              {FALLBACK_CHOICES.map((c) => (
                <option key={String(c.minutes)} value={c.minutes ?? ''}>{c.label}</option>
              ))}
              {(() => { const m = (folder as any).fallback_minutes; return m && !FALLBACK_CHOICES.some((c) => c.minutes === m) ? <option value={m}>Encode in the cloud after {m} minutes</option> : null })()}
            </select>
            <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--faint,#8b93a7)' }}>
              {(folder as any).fallback_minutes
                ? 'If no server of the site starts the encode in that time, the agent sends the original to Volt and it is encoded in the cloud. The item records why.'
                : 'The item waits until a server of the site encodes it. The original never leaves your storage.'}
            </span>
          </div>
        )}
        {/* THE LADDER. Video files this folder accepts are encoded to it; images
            and slates are unaffected, which is why it sits with the scan
            settings rather than with the rules. */}
        <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
          <label style={{ fontSize: 'var(--fs-sm)', fontWeight: 600 }}>Encode video to</label>
          <select
            style={{ maxWidth: '100%', background: 'var(--panel-2,#151922)', border: '1px solid var(--border,#242a36)',
                     color: 'var(--text,#e7ebf3)', borderRadius: 8, padding: '6px 9px',
                     fontFamily: 'inherit', fontSize: 'var(--fs-sm)' }}
            value={folder.ladder_group_id ?? ''} disabled={!canManage}
            onChange={async (e) => {
              try { await api.patchWatchfolder(folder.id, { ladderGroupId: e.target.value || null }); load() }
              catch (err: any) { setErr(String(err?.message ?? err)) }
            }}>
            <option value="">The account default ladder</option>
            {ladders.map(l => (
              <option key={l.id} value={l.id}>
                {l.name}{l.tracks_output_profile_id ? ' (tracks live)' : ''}
                {l.rungs.length ? ` — ${l.rungs.map(r => r.height + 'p').join('/')}` : ''}
              </option>
            ))}
          </select>
          <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--faint,#8b93a7)' }}>
            Applies to video files only. Images and slates go straight to the library.
          </span>
        </div>
        {folder.last_scan_error && (
          <p style={{ color: 'var(--danger,#f87171)', fontSize: 'var(--fs-sm)' }}>
            Last scan failed: {folder.last_scan_error}
          </p>
        )}
        {err && <p style={{ color: 'var(--danger,#f87171)', fontSize: 'var(--fs-sm)' }}>{err}</p>}
        {scan && (
          <p style={{ fontSize: 'var(--fs-sm)', marginTop: 10 }}>
            Looked at {scan.scanned}: {scan.accepted.length} accepted, {scan.quarantined.length} sent
            to review, {scan.skippedKnown} already known
            {scan.skippedTooNew.length ? `, ${scan.skippedTooNew.length} still arriving` : ''}.
            {scan.ingest && (
              <> Ingested {scan.ingest.ingested}
                {/* QUEUED IS COUNTED APART FROM INGESTED. An image is in the
                    library when the scan returns; a video has been accepted and
                    becomes playable when its encode finishes, minutes later. One
                    number for both would report work as done that has not
                    started. */}
                {scan.ingest.queued ? `, ${scan.ingest.queued} queued for encoding` : ''}
                {scan.ingest.loops ? `, ${scan.ingest.loops} added to Loops & Fillers` : ''}
                {scan.ingest.held ? `, ${scan.ingest.held} held by the ingest rules` : ''}
                {scan.ingest.failed ? `, ${scan.ingest.failed} failed` : ''}
                {scan.ingest.deferred ? `, ${scan.ingest.deferred} left for other workflows` : ''}.
              </>
            )}
          </p>
        )}
      </div>
      <Rules folder={folder} rules={folder.rules ?? []} kinds={folder.targetKinds ?? []} imageTypes={folder.imageTypes ?? []}
        defaultsMissing={folder.defaultsMissing ?? []} reload={load} />
      <Queue folder={folder} reload={load} />
    </div>
  )
}

/* ------------------------------------------------------------------ list ---- */

/** Where an accepted file of each target kind goes, in the console's words. */
const GOES_TO: Record<string, string> = { images: 'Image Library', media: 'Media Library', loops: 'Loops & Fillers', companions: 'Attach to its video' }

type TargetKind = { kind: string; goesTo: 'images' | 'media' | 'loops' | 'companions'; accepts?: string[] }

/** The file types a pattern can only match, the same reading as the server's
 *  (services/watchfolder/defaults.ts typesOfPattern), so the destination list
 *  offers only places that take that kind of file. The server checks it again. */
const TYPE_EXT: Record<string, string[]> = {
  image: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'tif', 'tiff'],
  video: ['mp4', 'mov', 'm4v', 'mxf', 'mkv', 'ts', 'webm'],
  audio: ['mp3', 'wav', 'm4a', 'aac', 'flac'],
  caption: ['srt', 'vtt', 'ttml', 'dfxp'],
  sidecar: ['json', 'xml', 'nfo', 'csv'],
}
function patternTypes(pattern: string): string[] | null {
  const m = /\.([a-z0-9]+)$/i.exec(pattern.trim())
  if (!m) return null
  const t = Object.keys(TYPE_EXT).find(k => TYPE_EXT[k].includes(m[1].toLowerCase()))
  return t ? [t] : null
}
const TYPE_LABEL: Record<string, string> = { image: 'images', video: 'video', audio: 'audio files', caption: 'caption files', sidecar: 'metadata files' }

export default function Watchfolders() {
  const [folders, setFolders] = useState<Watchfolder[]>([])
  const [open, setOpen] = useState<string | null>(null)
  const [err, setErr] = useState('')
  const [creating, setCreating] = useState(false)
  const [draft, setDraft] = useState({ name: '', path: '', where: 'local' as 'local' | 'site', siteId: '' })
  const [siteOpts, setSiteOpts] = useState<WatchfolderSiteOptions | null>(null)
  const canManage = useAccess().can('media', 'manage')

  const load = useCallback(() => {
    api.watchfolders().then(setFolders).catch(e => setErr(String(e?.message ?? e)))
  }, [])
  useEffect(load, [load])
  // ON-PREM IS OFFERED ONLY WITH THE LICENCE. Without Hybrid Sites the form is
  // exactly what it was: a name and a path on this server.
  useEffect(() => { api.watchfolderSiteOptions().then(setSiteOpts).catch(() => setSiteOpts(null)) }, [])
  const activeSites = (siteOpts?.sites ?? []).filter(x => x.status === 'active')

  const create = async () => {
    if (!draft.name.trim() || !draft.path.trim()) { setErr('A watchfolder needs a name and a path.'); return }
    if (draft.where === 'site' && !draft.siteId) { setErr('Choose the site whose agent watches this folder.'); return }
    try {
      const f = await api.createWatchfolder(draft.where === 'site'
        ? { name: draft.name.trim(), kind: 'site', siteId: draft.siteId, placement: 'upload_cloud',
            config: { path: draft.path.trim(), min_age_ms: 10000 } }
        : { name: draft.name.trim(), kind: 'local', config: { path: draft.path.trim(), min_age_ms: 5000 } })
      setCreating(false); setDraft({ name: '', path: '', where: 'local', siteId: '' }); setErr(''); load(); setOpen(f.id)
    } catch (e: any) { setErr(String(e?.message ?? e)) }
  }

  if (open) return <Detail id={open} onBack={() => { setOpen(null); load() }} />

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
        <h2 style={{ margin: 0 }}>Watchfolders</h2>
        {canManage && (
          <button type="button" className="btn primary" onClick={() => setCreating(v => !v)}
            style={{ marginLeft: 'auto' }}>New watchfolder</button>
        )}
      </div>
      <p style={{ color: 'var(--faint,#8b93a7)', fontSize: 'var(--fs-sm)', marginTop: -6 }}>
        A folder the system watches. Files are sorted by the folder's rules; anything that matches
        nothing is moved to a review folder and listed for a person, never deleted and never guessed at.
      </p>

      {creating && (
        <div className="card" style={{ padding: 16, marginBottom: 14, display: 'grid', gap: 10 }}>
          {siteOpts?.licensed && (
            <div role="radiogroup" aria-label="Where the folder is" style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 'var(--fs-sm)' }}>
              <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input type="radio" name="wf-where" checked={draft.where === 'local'} onChange={() => setDraft({ ...draft, where: 'local' })} />
                On this server
              </label>
              <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input type="radio" name="wf-where" checked={draft.where === 'site'}
                  onChange={() => setDraft({ ...draft, where: 'site', siteId: draft.siteId || activeSites[0]?.id || '' })} />
                On-prem, at a site
              </label>
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <input style={{ ...box, flex: '1 1 160px' }} placeholder="Name" aria-label="Name" value={draft.name}
              onChange={e => setDraft({ ...draft, name: e.target.value })} />
            {draft.where === 'site' && (
              <select className="inp" aria-label="Site" style={{ flex: '1 1 160px', width: 'auto', maxWidth: '100%' }} value={draft.siteId}
                onChange={e => setDraft({ ...draft, siteId: e.target.value })}>
                {activeSites.length === 0 && <option value="">No active site: add one in Admin, Sites</option>}
                {activeSites.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}
              </select>
            )}
            <input style={{ ...box, flex: '2 1 240px' }} aria-label={draft.where === 'site' ? 'Path on the site host' : 'Path'}
              placeholder={draft.where === 'site' ? '/mnt/nas/drop (on the site host)' : '/Volumes/Ingest/drop'} value={draft.path}
              onChange={e => setDraft({ ...draft, path: e.target.value })} />
            <button type="button" className="btn primary" onClick={create}>Create</button>
          </div>
          {draft.where === 'site' && (
            <p style={{ margin: 0, fontSize: 'var(--fs-xs)', color: 'var(--faint,#8b93a7)' }}>
              The site's agent scans this folder with the rules you set here. {PLACEMENT.upload_cloud.label}: {PLACEMENT.upload_cloud.help} Refused files
              go to the review folder at the site and never leave it.
            </p>
          )}
        </div>
      )}

      {err && <p style={{ color: 'var(--danger,#f87171)', fontSize: 'var(--fs-sm)' }}>{err}</p>}
      {folders.length === 0 && !creating && (
        <p style={{ color: 'var(--faint,#8b93a7)' }}>No watchfolders yet.</p>
      )}

      <div style={{ display: 'grid', gap: 10 }}>
        {folders.map(f => (
          <div key={f.id} className="card wf-card" {...pressable(() => setOpen(f.id))}
            style={{ padding: 16, display: 'grid', gridTemplateColumns: '1fr 120px 140px 120px', gap: 12, alignItems: 'center', cursor: 'pointer' }}>
            <div>
              <div style={{ fontWeight: 600 }}>{f.name}</div>
              <code style={{ fontSize: 'var(--fs-xs)', color: 'var(--faint,#8b93a7)' }}>{f.config?.path}</code>
              {f.kind === 'site' && <> <SiteTag name={f.site_name} /></>}
            </div>
            <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--faint,#8b93a7)' }}>
              {f.rule_count ?? 0} rule{(f.rule_count ?? 0) === 1 ? '' : 's'}
            </span>
            <span style={{ fontSize: 'var(--fs-sm)' }}>
              {(f.review_count ?? 0) > 0
                ? <strong style={{ color: 'var(--warn,#fbbf24)' }}>{f.review_count} to review</strong>
                : <span style={{ color: 'var(--faint,#8b93a7)' }}>nothing waiting</span>}
            </span>
            <span style={{ fontSize: 'var(--fs-xs)', color: f.last_scan_error && f.enabled ? 'var(--danger,#f87171)' : 'var(--faint,#8b93a7)' }}>
              {!f.enabled ? 'switched off' : f.last_scan_error ? 'scan failing' : `scanned ${ago(f.last_scan_at)}`}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
