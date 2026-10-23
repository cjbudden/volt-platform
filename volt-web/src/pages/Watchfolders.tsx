import { useCallback, useEffect, useState } from 'react'
import {
  api, type Watchfolder, type WatchfolderRule, type WatchfolderItem,
  type WatchfolderDryRun, type WatchfolderScan, type LadderGroup,
} from '../api'
import { pressable } from '../a11y'

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
   ========================================================================== */

const STATUS: Record<string, { label: string; tone: string; help: string }> = {
  seen:        { label: 'Waiting',     tone: 'var(--brand,#3f7bff)', help: 'Classified, waiting for the next ingest pass.' },
  ingested:    { label: 'In library',  tone: 'var(--ok,#4ade80)',    help: 'A library record was created for this file: Image Library, Media Library (a video shows its encode there) or Loops & Fillers.' },
  quarantined: { label: 'Needs review',tone: 'var(--warn,#fbbf24)',  help: 'No rule matched, or a rule refused it. The file is in the review folder.' },
  failed:      { label: 'Failed',      tone: 'var(--danger,#f87171)',help: 'It matched a rule, but the ingest itself did not complete.' },
  reprocessed: { label: 'Sent back',   tone: 'var(--brand,#3f7bff)', help: 'Returned to the drop folder to be looked at again.' },
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

/* ---------------------------------------------------------------- rules ---- */

function Rules({ folder, rules, reload }: {
  folder: Watchfolder; rules: WatchfolderRule[]; reload: () => void
}) {
  const [draft, setDraft] = useState({ name: '', pattern: '', targetKind: 'slate', workflow: 'register' })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  // WHICH RULE WOULD WIN, asked of the server so the answer comes from the same
  // classifier the scanner uses. A preview that reimplemented the matching would
  // be confidently wrong exactly when it mattered.
  const [probe, setProbe] = useState('')
  const [dry, setDry] = useState<WatchfolderDryRun | null>(null)
  useEffect(() => {
    if (!probe.trim()) { setDry(null); return }
    const t = setTimeout(() => {
      api.watchfolderDryRun(folder.id, probe.trim()).then(setDry).catch(() => setDry(null))
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
      })
      setDraft({ ...draft, name: '', pattern: '' })
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

  return (
    <div className="card" style={{ padding: 18, marginTop: 14 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 4 }}>
        <h3 style={{ margin: 0, fontSize: 'var(--fs-body)' }}>Rules</h3>
        <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--faint,#8b93a7)' }}>
          First match wins, top to bottom. A file matching nothing goes to review.
        </span>
      </div>

      {rules.length === 0 && (
        <p style={{ color: 'var(--faint,#8b93a7)', fontSize: 'var(--fs-sm)' }}>
          No rules yet, so every file will go to review. That is the safe default, not a fault.
        </p>
      )}

      <div style={{ display: 'grid', gap: 6, margin: '10px 0' }}>
        {rules.map((r, i) => (
          <div key={r.id} style={{
            display: 'grid', gridTemplateColumns: '28px 1fr 1fr 130px 120px auto',
            gap: 10, alignItems: 'center', padding: '8px 10px', borderRadius: 8,
            background: r.id === winner ? 'rgba(63,123,255,.12)' : 'var(--panel-2,#151922)',
            border: `1px solid ${r.id === winner ? 'rgba(63,123,255,.5)' : 'var(--border,#242a36)'}`,
            opacity: r.enabled ? 1 : 0.55,
          }}>
            <span style={{ color: 'var(--faint,#8b93a7)', fontVariantNumeric: 'tabular-nums' }}>{i + 1}</span>
            <span style={{ fontWeight: 600 }}>{r.name}</span>
            <code style={{ fontSize: 'var(--fs-xs)' }}>{r.pattern}</code>
            <span style={{ fontSize: 'var(--fs-sm)' }}>
              {r.action === 'reject'
                ? <em style={{ color: 'var(--danger,#f87171)' }}>refuse</em>
                : <>→ {r.target_kind}</>}
            </span>
            <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--faint,#8b93a7)' }}>{r.workflow ?? '—'}</span>
            <span style={{ display: 'flex', gap: 4 }}>
              <button type="button" className="btn ghost" disabled={busy || i === 0}
                onClick={() => move(i, -1)} aria-label={`Move ${r.name} up`}
                style={{ padding: '3px 8px' }}>↑</button>
              <button type="button" className="btn ghost" disabled={busy || i === rules.length - 1}
                onClick={() => move(i, 1)} aria-label={`Move ${r.name} down`}
                style={{ padding: '3px 8px' }}>↓</button>
              <button type="button" className="btn ghost" disabled={busy}
                onClick={() => api.deleteWatchfolderRule(folder.id, r.id).then(reload)}
                aria-label={`Delete ${r.name}`} style={{ padding: '3px 8px' }}>✕</button>
            </span>
          </div>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 130px 120px auto', gap: 8, marginTop: 12 }}>
        <input style={box} placeholder="Rule name" value={draft.name}
          onChange={e => setDraft({ ...draft, name: e.target.value })} />
        <input style={box} placeholder="slate_*.png" value={draft.pattern}
          onChange={e => setDraft({ ...draft, pattern: e.target.value })} />
        <input style={box} placeholder="target kind" value={draft.targetKind}
          onChange={e => setDraft({ ...draft, targetKind: e.target.value })} />
        <input style={box} placeholder="workflow" value={draft.workflow}
          onChange={e => setDraft({ ...draft, workflow: e.target.value })} />
        <button type="button" className="btn primary" onClick={add} disabled={busy}>Add rule</button>
      </div>
      {err && <p style={{ color: 'var(--danger,#f87171)', fontSize: 'var(--fs-sm)' }}>{err}</p>}

      {/* ---- the dry run ---- */}
      <div style={{ marginTop: 18, paddingTop: 14, borderTop: '1px solid var(--border,#242a36)' }}>
        <label style={{ display: 'block', fontSize: 'var(--fs-sm)', fontWeight: 600, marginBottom: 6 }}>
          Try a filename
        </label>
        <input style={{ ...box, width: '100%', maxWidth: 420 }} placeholder="slate_open.png"
          value={probe} onChange={e => setProbe(e.target.value)} />
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

function Queue({ folder }: { folder: Watchfolder }) {
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
    try { await api.resolveWatchfolderItem(folder.id, it.id, how); load() }
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
          <div key={it.id} style={{
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
                  now at <code>{it.quarantine_key}</code>
                </div>
              )}
            </div>
            <Pill status={it.status} />
            <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--faint,#8b93a7)' }}>{fmtBytes(it.size_bytes)}</span>
            <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--faint,#8b93a7)' }}>{ago(it.seen_at)}</span>
            <span style={{ display: 'flex', gap: 6 }}>
              {(it.status === 'quarantined' || it.status === 'failed') && (
                <>
                  <button type="button" className="btn ghost" disabled={busy === it.id}
                    title="Put the file back in the drop folder and look at it again on the next scan."
                    onClick={() => resolve(it, 'reprocess')}>Reprocess</button>
                  {/* SAYS WHAT IT DOES. Nothing on this page deletes anything. */}
                  <button type="button" className="btn ghost" disabled={busy === it.id}
                    title="Close this entry. The file itself stays in the review folder."
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
  const [folder, setFolder] = useState<(Watchfolder & { rules: WatchfolderRule[] }) | null>(null)
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

  if (!folder) return <p style={{ color: 'var(--faint,#8b93a7)' }}>{err || 'Loading…'}</p>

  return (
    <div>
      <button type="button" className="btn ghost" onClick={onBack} style={{ marginBottom: 12 }}>← Watchfolders</button>
      <div className="card" style={{ padding: 18 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <h2 style={{ margin: 0 }}>{folder.name}</h2>
          <code style={{ fontSize: 'var(--fs-xs)', color: 'var(--faint,#8b93a7)' }}>{folder.config?.path}</code>
          <button type="button" className="btn primary" onClick={runScan} disabled={busy}
            style={{ marginLeft: 'auto' }}>{busy ? 'Scanning…' : 'Scan now'}</button>
        </div>
        <p style={{ fontSize: 'var(--fs-xs)', color: 'var(--faint,#8b93a7)', marginTop: 8 }}>
          Scanned automatically every minute. Refused files go to <code>{folder.quarantine_path}</code> inside
          this folder. Last scan {ago(folder.last_scan_at)}.
        </p>
        {/* THE LADDER. Video files this folder accepts are encoded to it; images
            and slates are unaffected, which is why it sits with the scan
            settings rather than with the rules. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10 }}>
          <label style={{ fontSize: 'var(--fs-sm)', fontWeight: 600 }}>Encode video to</label>
          <select
            style={{ background: 'var(--panel-2,#151922)', border: '1px solid var(--border,#242a36)',
                     color: 'var(--text,#e7ebf3)', borderRadius: 8, padding: '6px 9px',
                     fontFamily: 'inherit', fontSize: 'var(--fs-sm)' }}
            value={folder.ladder_group_id ?? ''}
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
      <Rules folder={folder} rules={folder.rules ?? []} reload={load} />
      <Queue folder={folder} />
    </div>
  )
}

/* ------------------------------------------------------------------ list ---- */

export default function Watchfolders() {
  const [folders, setFolders] = useState<Watchfolder[]>([])
  const [open, setOpen] = useState<string | null>(null)
  const [err, setErr] = useState('')
  const [creating, setCreating] = useState(false)
  const [draft, setDraft] = useState({ name: '', path: '' })

  const load = useCallback(() => {
    api.watchfolders().then(setFolders).catch(e => setErr(String(e?.message ?? e)))
  }, [])
  useEffect(load, [load])

  const create = async () => {
    if (!draft.name.trim() || !draft.path.trim()) { setErr('A watchfolder needs a name and a path.'); return }
    try {
      const f = await api.createWatchfolder({
        name: draft.name.trim(), kind: 'local', config: { path: draft.path.trim(), min_age_ms: 5000 },
      })
      setCreating(false); setDraft({ name: '', path: '' }); load(); setOpen(f.id)
    } catch (e: any) { setErr(String(e?.message ?? e)) }
  }

  if (open) return <Detail id={open} onBack={() => { setOpen(null); load() }} />

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
        <h2 style={{ margin: 0 }}>Watchfolders</h2>
        <button type="button" className="btn primary" onClick={() => setCreating(v => !v)}
          style={{ marginLeft: 'auto' }}>New watchfolder</button>
      </div>
      <p style={{ color: 'var(--faint,#8b93a7)', fontSize: 'var(--fs-sm)', marginTop: -6 }}>
        A folder the system watches. Files are sorted by the folder's rules; anything that matches
        nothing is moved to a review folder and listed for a person, never deleted and never guessed at.
      </p>

      {creating && (
        <div className="card" style={{ padding: 16, marginBottom: 14, display: 'grid', gap: 8, gridTemplateColumns: '1fr 2fr auto' }}>
          <input style={box} placeholder="Name" value={draft.name}
            onChange={e => setDraft({ ...draft, name: e.target.value })} />
          <input style={box} placeholder="/Volumes/Ingest/drop" value={draft.path}
            onChange={e => setDraft({ ...draft, path: e.target.value })} />
          <button type="button" className="btn primary" onClick={create}>Create</button>
        </div>
      )}

      {err && <p style={{ color: 'var(--danger,#f87171)', fontSize: 'var(--fs-sm)' }}>{err}</p>}
      {folders.length === 0 && !creating && (
        <p style={{ color: 'var(--faint,#8b93a7)' }}>No watchfolders yet.</p>
      )}

      <div style={{ display: 'grid', gap: 10 }}>
        {folders.map(f => (
          <div key={f.id} className="card" {...pressable(() => setOpen(f.id))}
            style={{ padding: 16, display: 'grid', gridTemplateColumns: '1fr 120px 140px 120px', gap: 12, alignItems: 'center', cursor: 'pointer' }}>
            <div>
              <div style={{ fontWeight: 600 }}>{f.name}</div>
              <code style={{ fontSize: 'var(--fs-xs)', color: 'var(--faint,#8b93a7)' }}>{f.config?.path}</code>
            </div>
            <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--faint,#8b93a7)' }}>
              {f.rule_count ?? 0} rule{(f.rule_count ?? 0) === 1 ? '' : 's'}
            </span>
            <span style={{ fontSize: 'var(--fs-sm)' }}>
              {(f.review_count ?? 0) > 0
                ? <strong style={{ color: 'var(--warn,#fbbf24)' }}>{f.review_count} to review</strong>
                : <span style={{ color: 'var(--faint,#8b93a7)' }}>nothing waiting</span>}
            </span>
            <span style={{ fontSize: 'var(--fs-xs)', color: f.last_scan_error ? 'var(--danger,#f87171)' : 'var(--faint,#8b93a7)' }}>
              {f.last_scan_error ? 'scan failing' : `scanned ${ago(f.last_scan_at)}`}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
