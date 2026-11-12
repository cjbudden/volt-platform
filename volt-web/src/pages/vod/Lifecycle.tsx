// ============================================================================
//  THE LIFECYCLE ON THE AVAILABILITY TAB (build queue P1-2,
//  PUBLISHING_POLICIES.md "Lifecycle model"; the API in modules/vod.ts).
//
//    [Available] Available until 12 Dec 18:00 UTC.        changes 12 Dec 18:00
//    (Draft) (Scheduled) (Available) (Expired) (Archived)
//    |==== Scheduled ====|====== Available ======|== Expired ==|
//                              ^ today
//    Available from / until / Listed from / Archived
//    Listing: [Listed from ....] [x] Unlisted  [Save]
//    Archive / Restore as draft / Restore and publish
//    Who can watch: [country] [viewer] [when] [Test]  -> the play gate's answer
//    Retention: when its policy deletes it, what keeps it, the legal hold, and
//    where an archived title's media is (build queue P5-3)
//
//  The status, reason and window come from GET /api/vod/:id, computed at the
//  moment of the request, so what is shown here is what a viewer gets now.
// ============================================================================
import { useState } from 'react'
import { apiRequest } from '../../api'
import { useAccess } from '../../access'
import { Notice, useNotify } from '../../notices'
import './lifecycle.css'
import { PUBLIC_STATUS_UI, PublicStatusTag } from './PublicStatus'
export { PUBLIC_STATUS_UI, PublicStatusTag }

const when = (s: string | null | undefined) => (s ? new Date(s).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : null)
const day = (t: number) => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
const ms = (s: string | null | undefined) => (s ? new Date(s).getTime() : null)
/** datetime-local wants local time without a zone. */
const toLocalInput = (s: string | null | undefined) => {
  if (!s) return ''
  const d = new Date(s); const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}
const J = (body: unknown) => ({ body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })

type Phase = 'draft' | 'scheduled' | 'available' | 'expired' | 'archived'
const PHASES: { key: Phase; label: string }[] = [
  { key: 'draft', label: 'Draft' }, { key: 'scheduled', label: 'Scheduled' }, { key: 'available', label: 'Available' },
  { key: 'expired', label: 'Expired' }, { key: 'archived', label: 'Archived' },
]

/** Where on the lifecycle it is now: what people set, and the window. */
function phaseOf(d: any, now: number): Phase {
  if (d.editorial_state === 'archived') return 'archived'
  if (d.editorial_state !== 'published') return 'draft'
  const from = ms(d.effective_from), until = ms(d.effective_until)
  if (d.public_status === 'expired' || (until != null && now >= until)) return 'expired'
  if (from != null && now < from) return 'scheduled'
  return 'available'
}

/** The bar: the stretches of the lifecycle in proportion, with today marked. */
function Timeline({ d, now }: { d: any; now: number }) {
  const phase = phaseOf(d, now)
  const from = ms(d.effective_from) ?? ms(d.created_at) ?? now
  const until = ms(d.effective_until)
  const start = Math.min(ms(d.created_at) ?? now, from, now)
  const pad = 7 * 86400_000
  const end = Math.max(now, until ?? from) + (until == null ? pad * 2 : pad)
  const x = (t: number) => `${(((t - start) / (end - start)) * 100).toFixed(2)}%`
  const w = (a: number, b: number) => `${(((b - a) / (end - start)) * 100).toFixed(2)}%`
  type Seg = { cls: Phase; a: number; b: number; label: string }
  const segs: Seg[] = []
  if (phase === 'archived') segs.push({ cls: 'archived', a: start, b: end, label: 'Archived' })
  else if (phase === 'draft') segs.push({ cls: 'draft', a: start, b: end, label: 'Draft: not published' })
  else {
    if (from > start) segs.push({ cls: 'scheduled', a: start, b: from, label: 'Scheduled' })
    segs.push({ cls: 'available', a: from, b: until ?? end, label: until ? 'Available' : 'Available, no end' })
    if (until != null) segs.push({ cls: 'expired', a: until, b: end, label: 'Expired' })
  }
  const marks: { t: number; cls: string }[] = [{ t: start, cls: 'lc-start' }]
  if (phase !== 'draft' && phase !== 'archived') {
    if (from > start + (end - start) * 0.08) marks.push({ t: from, cls: '' })
    if (until != null && until < end - (end - start) * 0.08) marks.push({ t: until, cls: '' })
  }
  marks.push({ t: end, cls: 'lc-end' })
  return (
    <div>
      <ol className="lc-steps" aria-label="Lifecycle">
        {PHASES.map((p) => (
          <li key={p.key} className={p.key === phase ? 'on' : ''} aria-current={p.key === phase ? 'step' : undefined}>
            <span className="lc-dot" aria-hidden="true" />{p.label}
          </li>
        ))}
      </ol>
      <div className="lc-bar" role="img" aria-label={`Timeline: ${segs.map((s) => `${s.label} ${day(s.a)} to ${day(s.b)}`).join(', ')}; today ${day(now)}`} style={{ marginTop: 10 }}>
        {segs.map((s, i) => <span key={i} className={`lc-seg ${s.cls}`} style={{ left: x(s.a), width: w(s.a, s.b) }} title={`${s.label}: ${day(s.a)} to ${day(s.b)}`}>{s.label}</span>)}
        <span className="lc-today" style={{ left: x(now) }} title={`Today, ${day(now)}`} />
      </div>
      <div className="lc-axis" aria-hidden="true">
        {marks.map((m, i) => <span key={i} className={m.cls} style={{ left: x(m.t) }}>{day(m.t)}</span>)}
      </div>
    </div>
  )
}

export function Lifecycle({ d, onChanged }: { d: any; onChanged: () => void }) {
  const { can } = useAccess()
  const notify = useNotify()
  const now = Date.now()
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState('')
  const [confirmArchive, setConfirmArchive] = useState(false)
  // Restoring from Archive storage takes hours: the wait is said and accepted first.
  const [confirmRestore, setConfirmRestore] = useState<'draft' | 'published' | null>(null)
  const [holdReason, setHoldReason] = useState<string | null>(null)
  const [listedFrom, setListedFrom] = useState(toLocalInput(d.listed_from))
  const [unlisted, setUnlisted] = useState(!!d.unlisted)
  const listingDirty = listedFrom !== toLocalInput(d.listed_from) || unlisted !== !!d.unlisted
  const archived = d.editorial_state === 'archived'

  async function act(key: string, fn: () => Promise<any>, ok: string) {
    setBusy(key); setErr('')
    try { await fn(); notify({ kind: 'ok', message: ok }); onChanged() } catch (e: any) { setErr(e.message); notify({ kind: 'error', message: e.message }) } finally { setBusy(''); setConfirmArchive(false); setConfirmRestore(null) }
  }
  const tier = d.archive_storage as null | { tier: 'infrequent' | 'glacier'; state: string; since: string | null; error: string | null; restoreWaitMs: number; restoreWait: string | null; restoreExpectedBy: string | null; restoreTo: string | null }
  const restoring = tier?.state === 'restoring'
  // From Archive storage a restore is asked for and waited on; otherwise it is at once.
  const restore = (to: 'draft' | 'published') => {
    if (tier && tier.restoreWaitMs > 0) { setConfirmRestore(to); return }
    act(to === 'draft' ? 'draft' : 'pub', () => apiRequest(`/vod/${d.id}/unarchive`, { method: 'POST', ...J({ to }) }), to === 'draft' ? 'Restored as a draft.' : 'Restored and published.')
  }
  const hold = (on: boolean) => act('hold', () => apiRequest(`/storage/vod/${d.id}/hold`, { method: 'POST', ...J(on ? { hold: true, reason: (holdReason ?? '').trim() } : { hold: false }) })
    .then(() => setHoldReason(null)), on ? 'Legal hold set.' : 'Legal hold released.')
  const saveListing = () => act('listing', () => apiRequest(`/vod/${d.id}/availability`, { method: 'PUT',
    ...J({ listedFrom: listedFrom ? new Date(listedFrom).toISOString() : null, unlisted }) }), 'Listing saved.')
  const until = d.status_until ? when(d.status_until) : null

  return (
    <section className="lc" aria-label="Public status">
      <div className="lc-status">
        <PublicStatusTag status={d.public_status} reason={d.status_reason} withdrawn={d.availability_state === 'withdrawn'} />
        <span className="lc-why">{d.status_reason}</span>
        {until && <span className="lc-next">Changes on its own {until}</span>}
      </div>
      <Timeline d={d} now={now} />
      <dl className="lc-dates">
        <div><dt>Available from</dt><dd>{when(d.effective_from) ?? (d.editorial_state === 'published' ? 'When published' : 'Not set')}</dd></div>
        <div><dt>Available until</dt><dd>{when(d.effective_until) ?? 'No end'}</dd></div>
        <div><dt>Listed from</dt><dd>{d.listed_from ? when(d.listed_from) : 'When it becomes available'}{d.unlisted ? ' (unlisted)' : ''}</dd></div>
        <div><dt>In browse and search</dt><dd>{d.publicly_listed ? 'Yes' : d.publicly_visible ? 'No, by link only' : 'No'}</dd></div>
        {archived && <div><dt>Archived</dt><dd>{when(d.archived_at)}{d.archived_by ? ` by ${d.archived_by}` : ''}</dd></div>}
      </dl>

      <Retention d={d} tier={tier} />
      {can('media', 'manage') && (
        <div className="lc-row" data-legal-hold-actions>
          {d.legal_hold_at
            ? <button type="button" className="btn ghost sm" disabled={!!busy} onClick={() => hold(false)}>{lockIcon}{busy === 'hold' ? 'Releasing…' : 'Release legal hold'}</button>
            : holdReason === null
              ? <button type="button" className="btn ghost sm" disabled={!!busy} onClick={() => setHoldReason('')}>{lockIcon}Legal hold…</button>
              : (<>
                <label>Reason for the legal hold
                  <input type="text" value={holdReason} maxLength={500} placeholder="Such as a case number" onChange={(e) => setHoldReason(e.target.value)} autoFocus />
                </label>
                <button type="button" className="btn primary sm" disabled={!!busy || !holdReason.trim()} onClick={() => hold(true)}>{busy === 'hold' ? 'Holding…' : 'Hold'}</button>
                <button type="button" className="btn ghost sm" disabled={!!busy} onClick={() => setHoldReason(null)}>Cancel</button>
              </>)}
        </div>
      )}

      {can('vod', 'manage') && !archived && (
        <div>
          <div className="sec-label">Listing</div>
          <div className="lc-row">
            <label>Listed from
              <input type="datetime-local" value={listedFrom} onChange={(e) => setListedFrom(e.target.value)} aria-describedby="lc-listed-hint" />
            </label>
            <label className="lc-check"><input type="checkbox" checked={unlisted} onChange={(e) => setUnlisted(e.target.checked)} />Unlisted</label>
            <button type="button" className="btn sm" disabled={!!busy || !listingDirty} onClick={saveListing}>{busy === 'listing' ? 'Saving…' : 'Save listing'}</button>
            {listedFrom && <button type="button" className="btn ghost sm" disabled={!!busy} onClick={() => setListedFrom('')}>Clear date</button>}
          </div>
          <div className="lc-hint" id="lc-listed-hint">A date before it becomes available shows it early as a teaser (title, artwork and when) with no way to play. Unlisted: playable by link only, never in browse or search.</div>
        </div>
      )}

      {can('vod', 'operate') && (
        <div className="lc-row">
          {!archived && !confirmArchive && (
            <button type="button" className="btn ghost sm" disabled={!!busy} onClick={() => setConfirmArchive(true)}>
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M3 4h18v4H3zM5 8v12h14V8M10 12h4" /></svg>Archive…
            </button>
          )}
          {!archived && confirmArchive && (<>
            <span style={{ fontSize: 'var(--fs-sm)' }}>Archive this title? It leaves the catalogue and stops playing now; the media is kept and you can restore it.</span>
            <button type="button" className="btn primary sm danger" disabled={!!busy} onClick={() => act('archive', () => apiRequest(`/vod/${d.id}/archive`, { method: 'POST', ...J({}) }), 'Archived.')}>
              {busy === 'archive' ? 'Archiving…' : 'Archive'}</button>
            <button type="button" className="btn ghost sm" disabled={!!busy} onClick={() => setConfirmArchive(false)}>Cancel</button>
          </>)}
          {archived && !restoring && !confirmRestore && (<>
            <button type="button" className="btn sm" disabled={!!busy} onClick={() => restore('draft')}>
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5" /></svg>{busy === 'draft' ? 'Restoring…' : tier?.restoreWaitMs ? 'Restore as draft…' : 'Restore as draft'}</button>
            <button type="button" className="btn primary sm" disabled={!!busy} onClick={() => restore('published')}>
              {busy === 'pub' ? 'Publishing…' : tier?.restoreWaitMs ? 'Restore and publish…' : 'Restore and publish'}</button>
          </>)}
          {archived && confirmRestore && tier && (<>
            <span style={{ fontSize: 'var(--fs-sm)', flex: '1 1 260px' }} data-restore-wait>
              Its media is in Archive storage. Bringing it back takes {tier.restoreWait}, expected by {when(new Date(Date.now() + tier.restoreWaitMs).toISOString())}.
              It stays archived until then and becomes {confirmRestore === 'published' ? 'published' : 'a draft'} when the media is back.
            </span>
            <button type="button" className="btn primary sm" disabled={!!busy} onClick={() => act('wait', () => apiRequest(`/vod/${d.id}/unarchive`, { method: 'POST', ...J({ to: confirmRestore, acceptWait: true }) }),
              `Restore started. It becomes ${confirmRestore === 'published' ? 'published' : 'a draft'} when the media is back.`)}>{busy === 'wait' ? 'Starting…' : 'Start restore'}</button>
            <button type="button" className="btn ghost sm" disabled={!!busy} onClick={() => setConfirmRestore(null)}>Cancel</button>
          </>)}
        </div>
      )}
      {err && <Notice kind="error" variant="compact" message={err} />}
      <WhoCanWatch id={d.id} />
    </section>
  )
}

const lockIcon = <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>
const TIER_LABEL: Record<string, string> = { infrequent: 'Infrequent access', glacier: 'Archive storage' }

/**
 * RETENTION ON THE DRAWER (build queue P5-3 (b)): when its publishing policy
 * deletes it (the date the hourly sweep last worked out), what keeps it when
 * it is due, its legal hold, and, once archived, which storage its media is in.
 * The full list is on the Storage page (Titles deleted by their publishing policy).
 */
function Retention({ d, tier }: { d: any; tier: any }) {
  const due = d.retention_due_at ? new Date(d.retention_due_at) : null
  const isDue = !!due && due.getTime() <= Date.now()
  return (
    <div data-retention>
      <div className="sec-label">Retention</div>
      <dl className="lc-dates">
        <div><dt>Deleted by its publishing policy</dt><dd data-retention-due>{due ? (isDue ? `Due since ${when(d.retention_due_at)}` : when(d.retention_due_at)) : 'Not set: its policy keeps it'}</dd></div>
        <div><dt>Legal hold</dt><dd data-legal-hold>{d.legal_hold_at
          ? <span style={{ color: 'var(--warn)' }}>{lockIcon} On hold since {when(d.legal_hold_at)}{d.legal_hold_reason ? `: ${d.legal_hold_reason}` : ''}</span>
          : 'None'}</dd></div>
        {tier && <div><dt>Media storage</dt><dd data-archive-storage>{TIER_LABEL[tier.tier] ?? tier.tier}{tier.since ? ` since ${when(tier.since)}` : ''}</dd></div>}
      </dl>
      {isDue && d.retention_wait && d.retention_wait_code !== 'legal_hold' && <div className="lc-hint" data-retention-wait>Due, but kept: {d.retention_wait}</div>}
      {tier && tier.state !== 'restoring' && tier.restoreWaitMs > 0 && <div className="lc-hint">A restore from Archive storage takes {tier.restoreWait}; the title stays archived until its media is back.</div>}
      {tier?.state === 'restoring' && <Notice kind="info" variant="compact" message={`Restoring from Archive storage, expected by ${when(tier.restoreExpectedBy)}. It becomes ${tier.restoreTo === 'published' ? 'published' : 'a draft'} when the media is back.`} />}
      {tier?.error && <div className="lc-hint" style={{ color: 'var(--warn)' }}>The last storage move did not finish and is tried again within the hour: {tier.error}</div>}
    </div>
  )
}

/** The tester: the play gate's own answer for one viewer (POST /api/vod/:id/evaluate). */
function WhoCanWatch({ id }: { id: string }) {
  const [country, setCountry] = useState('')
  const [viewer, setViewer] = useState<'anonymous' | 'signed_in' | 'entitled'>('anonymous')
  const [at, setAt] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [ans, setAns] = useState<any>(null)
  const test = async () => {
    setBusy(true); setErr('')
    try {
      setAns(await apiRequest(`/vod/${id}/evaluate`, { method: 'POST',
        ...J({ country: country.trim() ? country.trim().toUpperCase() : null, viewer, at: at ? new Date(at).toISOString() : null }) }))
    } catch (e: any) { setErr(e.message); setAns(null) } finally { setBusy(false) }
  }
  const OUT: Record<string, { label: string; cls: string }> = {
    play: { label: 'Plays', cls: 'live' }, teaser: { label: 'Teaser, no play', cls: 'sched' }, not_found: { label: 'Not found', cls: 'idle' },
    paywall: { label: 'Paywall', cls: 'warn' }, sign_in: { label: 'Sign in', cls: 'warn' }, blocked: { label: 'Blocked', cls: 'down' },
  }
  const STEP: Record<string, string> = { status: 'its public status', account: 'the account\'s regions', rights: 'its rights', on_demand: 'its publishing rules', rules: 'an access rule', none: 'nothing (open)', collection: 'a collection' }
  return (
    <div>
      <div className="sec-label">Who can watch</div>
      <div className="lc-row">
        <label>Country
          <input type="text" value={country} maxLength={2} placeholder="GB" style={{ width: 70, textTransform: 'uppercase' }} onChange={(e) => setCountry(e.target.value.replace(/[^a-z]/gi, ''))} />
        </label>
        <label>Viewer
          <select value={viewer} onChange={(e) => setViewer(e.target.value as any)}>
            <option value="anonymous">Not signed in</option>
            <option value="signed_in">Signed in</option>
            <option value="entitled">Signed in and has paid</option>
          </select>
        </label>
        <label>When
          <input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />
        </label>
        <button type="button" className="btn sm" disabled={busy || (country.length > 0 && country.length !== 2)} onClick={test}>
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M5 3l14 9-14 9V3z" /></svg>{busy ? 'Testing…' : 'Test'}</button>
      </div>
      <div className="lc-hint">The play gate's own decision for this viewer, now or at the date you pick. Leave the date empty for now.</div>
      {err && <Notice kind="error" variant="compact" message={err} />}
      {ans && (
        <div className="lc-answer" role="status" aria-live="polite" style={{ marginTop: 10 }}>
          <div className="lc-head">
            <span className={`tag ${OUT[ans.outcome]?.cls ?? 'idle'} lib-pill`}><span className="lib-dot" aria-hidden="true" />{OUT[ans.outcome]?.label ?? ans.outcome}</span>
            <span>{ans.message}</span>
            <span className="lc-code">HTTP {ans.http}</span>
          </div>
          <div>Decided by {STEP[ans.decidedBy] ?? ans.decidedBy}. At {when(ans.at)} the title is <b>{PUBLIC_STATUS_UI[ans.status.publicStatus]?.label ?? ans.status.publicStatus}</b>: {ans.status.reason}</div>
          {ans.notChecked?.length > 0 && <ul>{ans.notChecked.map((x: string) => <li key={x}>Not checked here: {x}</li>)}</ul>}
        </div>
      )}
    </div>
  )
}
