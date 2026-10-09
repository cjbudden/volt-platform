import { useEffect, useMemo, useState } from 'react'
import {
  api, type StorageCapabilities, type MediaObjectRow, type RetentionRuleRow,
  type RetentionStageInput, type SweepPreview, type AnalyticsRetention,
} from '../api'

/* ============================================================================
   STORAGE — what media exists, where it lives, and what will happen to it.

   The page is built around one distinction, because getting it wrong is what
   makes storage screens misleading:

     STATE  answers "can this be read right now, and if not, what is happening?"
     TIER   answers "where are the bytes, and what does reading them cost?"

   An object on Glacier Instant Retrieval is still available: it reads
   immediately, it is just cheaper to keep. An object on Deep Archive is not
   available at any price until a restore has been asked for and waited out. A
   screen that shows one number for both cannot tell an operator which of those
   they are looking at.

   The other thing this page has to do is be honest about what the DEPLOYMENT can
   do. On local disk there is one tier and no archive, so the ladder editor
   offers keep and delete and says plainly why the rest is missing, rather than
   offering an archive that would never happen.
   ========================================================================== */

const STATE_TONE: Record<string, string> = {
  available: 'var(--ok,#4ade80)',
  restored: 'var(--ok,#4ade80)',
  writing: 'var(--brand,#3f7bff)',
  archiving: 'var(--warn,#fbbf24)',
  archived: 'var(--warn,#fbbf24)',
  restoring: 'var(--warn,#fbbf24)',
  deleting: 'var(--danger,#f87171)',
  deleted: 'var(--faint)',
  pending: 'var(--faint)',
}

/** What each state means in one line, in the operator's terms, not the model's. */
const STATE_MEANING: Record<string, string> = {
  pending: 'declared, nothing written yet',
  writing: 'being recorded right now',
  available: 'readable immediately',
  archiving: 'moving to an archive tier',
  archived: 'needs a restore before it can be read',
  restoring: 'a restore is in progress',
  restored: 'temporarily readable; will lapse back',
  deleting: 'deletion in flight',
  deleted: 'the bytes are gone; this row is the record',
}

const TIER_LABEL: Record<string, string> = {
  local: 'Local disk',
  s3_standard: 'S3 Standard',
  s3_ia: 'S3 Infrequent Access',
  s3_glacier_ir: 'Glacier Instant Retrieval',
  s3_glacier_flexible: 'Glacier Flexible',
  s3_deep_archive: 'Deep Archive',
}

const ACTION_LABEL: Record<string, string> = {
  keep: 'Keep',
  to_cold: 'Move to cheaper storage',
  to_archive: 'Archive',
  delete: 'Delete',
}

function fmtBytes(n: number | string | null | undefined): string {
  const b = Number(n ?? 0)
  if (!b) return '—'
  const u = ['B', 'kB', 'MB', 'GB', 'TB']
  let i = 0, v = b
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++ }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${u[i]}`
}
function fmtDur(ms: number | string | null | undefined): string {
  const s = Math.round(Number(ms ?? 0) / 1000)
  if (!s) return '—'
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60)
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`
}

function StateChip({ state }: { state: string }) {
  return (
    <span title={STATE_MEANING[state] ?? state} style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      fontSize: 'var(--fs-sm)', color: STATE_TONE[state] ?? 'var(--muted)',
    }}>
      <span style={{
        width: 7, height: 7, borderRadius: 4,
        background: STATE_TONE[state] ?? 'var(--muted)', flex: 'none',
      }} />
      {state}
    </span>
  )
}

// ---------------------------------------------------------------------------
//  The ladder editor
// ---------------------------------------------------------------------------
function LadderEditor({ caps, rule, onSaved }: {
  caps: StorageCapabilities
  rule: RetentionRuleRow | null
  onSaved: () => void
}) {
  const [name, setName] = useState(rule?.name ?? 'Default retention')
  const [stages, setStages] = useState<RetentionStageInput[]>(
    rule?.stages?.map(s => ({ afterDays: s.afterDays, action: s.action, targetTier: s.targetTier ?? undefined }))
    ?? caps.defaultLadder.map(s => ({ afterDays: s.afterDays, action: s.action, targetTier: s.targetTier ?? undefined }))
  )
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState('')

  const set = (i: number, patch: Partial<RetentionStageInput>) =>
    setStages(s => s.map((x, k) => k === i ? { ...x, ...patch } : x))

  async function save() {
    setBusy(true); setErr(''); setSaved('')
    try {
      await api.saveRetentionRule({
        ruleId: rule?.id, name,
        accountScope: !rule?.channel_id && !rule?.event_id,
        channelId: rule?.channel_id ?? undefined,
        stages: stages.map(s => ({
          afterDays: Number(s.afterDays), action: s.action,
          targetTier: s.targetTier || undefined,
        })),
      })
      setSaved('Saved.')
      onSaved()
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }

  return (
    <div className="card p-4">
      <div className="sec-label">Retention ladder</div>
      <p style={{ color: 'var(--muted)', fontSize: 'var(--fs-sm)', marginTop: 0 }}>
        Each rung fires once, at the age you set, measured from when the recording
        closed. Media that is already older than a rung skips straight to the last
        one that applies.
      </p>

      {!caps.archiveEnabled && (
        <div style={{
          fontSize: 'var(--fs-sm)', color: 'var(--warn,#fbbf24)',
          border: '1px solid rgba(251,191,36,.3)', borderRadius: 6,
          padding: '8px 10px', marginBottom: 12,
        }}>
          {caps.archiveUnavailableReason}
        </div>
      )}

      <div className="flex items-center gap-2" style={{ marginBottom: 12 }}>
        <input value={name} onChange={e => setName(e.target.value)} style={{ width: 260 }} placeholder="Rule name" />
      </div>

      <table>
        <thead><tr><th style={{ width: 130 }}>After</th><th>Action</th><th>Tier</th><th style={{ width: 40 }} /></tr></thead>
        <tbody>
          {stages.map((s, i) => (
            <tr key={i}>
              <td>
                <div className="flex items-center gap-2">
                  <input type="number" min={0} value={s.afterDays}
                    onChange={e => set(i, { afterDays: Number(e.target.value) })}
                    style={{ width: 80 }} />
                  <span style={{ color: 'var(--faint)', fontSize: 'var(--fs-sm)' }}>days</span>
                </div>
              </td>
              <td>
                <select value={s.action} onChange={e => set(i, { action: e.target.value as any, targetTier: undefined })}
                  style={{ width: 230 }}>
                  {caps.actions.map(a => <option key={a} value={a}>{ACTION_LABEL[a] ?? a}</option>)}
                </select>
              </td>
              <td>
                {s.action === 'to_cold' || s.action === 'to_archive' ? (
                  <select value={s.targetTier ?? ''} onChange={e => set(i, { targetTier: e.target.value || undefined })}
                    style={{ width: 220 }}>
                    <option value="">deployment default</option>
                    {caps.tiers
                      .filter(t => s.action === 'to_cold'
                        ? ['s3_ia', 's3_glacier_ir'].includes(t)
                        : ['s3_glacier_flexible', 's3_deep_archive'].includes(t))
                      .map(t => <option key={t} value={t}>{TIER_LABEL[t] ?? t}</option>)}
                  </select>
                ) : <span style={{ color: 'var(--faint)', fontSize: 'var(--fs-sm)' }}>—</span>}
              </td>
              <td style={{ textAlign: 'right' }}>
                <button className="btn ghost" onClick={() => setStages(x => x.filter((_, k) => k !== i))}
                  disabled={stages.length <= 1} title="Remove this rung">×</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="flex items-center gap-2" style={{ marginTop: 12 }}>
        <button className="btn ghost" onClick={() => setStages(s => [
          ...s, { afterDays: (Math.max(0, ...s.map(x => Number(x.afterDays))) || 0) + 30, action: 'delete' },
        ])}>Add a rung</button>
        <div className="flex-1" />
        {saved && <span style={{ color: 'var(--ok,#4ade80)', fontSize: 'var(--fs-sm)' }}>{saved}</span>}
        <button className="btn primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save ladder'}</button>
      </div>
      {err && <div className="err" style={{ marginTop: 8 }}>{err}</div>}
    </div>
  )
}

// ---------------------------------------------------------------------------
//  One object, expanded
// ---------------------------------------------------------------------------
function ObjectDetail({ id, caps, onChanged }: { id: string; caps: StorageCapabilities; onChanged: () => void }) {
  const [d, setD] = useState<any>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState('')

  async function load() {
    try { setD(await api.mediaObject(id)) } catch (e: any) { setErr(e.message) }
  }
  useEffect(() => { load() /* eslint-disable-next-line */ }, [id])

  // Only when there is nothing to show. `err` is also written by the actions
  // on this page, so an unconditional guard let one rejected action replace
  // the working page — including the controls needed to retry — with a line
  // of red text and no way back except navigating away.
  if (err && !d) return <div className="err">{err}</div>
  if (!d) return <div className="loading">Loading…</div>

  const r = d.readability

  async function act(fn: () => Promise<any>, label: string) {
    setBusy(label); setErr('')
    try { await fn(); await load(); onChanged() } catch (e: any) { setErr(e.message) } finally { setBusy('') }
  }

  return (
    <div style={{ padding: '6px 2px 12px' }}>
      <div className="flex flex-wrap items-center gap-3" style={{ marginBottom: 10 }}>
        <span style={{
          fontSize: 'var(--fs-sm)',
          color: r.readable ? 'var(--ok,#4ade80)' : 'var(--warn,#fbbf24)',
        }}>{r.message}</span>
        {r.expectedBy && (
          <span style={{ color: 'var(--faint)', fontSize: 'var(--fs-sm)' }}>
            expected by {new Date(r.expectedBy).toLocaleString()}
          </span>
        )}
        <div className="flex-1" />
        {d.state === 'archived' && caps.archiveEnabled && (
          <button className="btn primary" disabled={!!busy}
            onClick={() => act(() => api.restoreMedia(d.id), 'restore')}>
            {busy === 'restore' ? 'Requesting…' : 'Request restore'}
          </button>
        )}
        <button className="btn ghost" disabled={!!busy}
          onClick={() => act(() => api.holdMedia(d.id, !d.hold, d.hold ? undefined : 'held from the storage page'), 'hold')}>
          {d.hold ? 'Release hold' : 'Hold'}
        </button>
      </div>

      {d.hold && (
        <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--warn,#fbbf24)', marginBottom: 10 }}>
          On hold: {d.hold_reason || 'no reason given'}. Retention rules will not touch this.
        </div>
      )}

      <div className="sec-label">Where the bytes are</div>
      <table style={{ marginBottom: 12 }}>
        <thead><tr><th>Tier</th><th>Location</th><th>Size</th><th>Last confirmed</th></tr></thead>
        <tbody>
          {d.locations.length === 0 ? (
            <tr><td colSpan={4} style={{ color: 'var(--faint)' }}>No copy on any tier.</td></tr>
          ) : d.locations.map((l: any) => (
            <tr key={l.id}>
              <td>{TIER_LABEL[l.tier] ?? l.tier}</td>
              <td style={{ fontFamily: 'ui-monospace,monospace', fontSize: 'var(--fs-sm)', color: 'var(--muted)', wordBreak: 'break-all' }}>{l.uri}</td>
              <td style={{ color: 'var(--muted)' }}>{fmtBytes(l.bytes)}</td>
              <td style={{ color: 'var(--muted)' }}>{l.verified_at ? new Date(l.verified_at).toLocaleString() : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="sec-label">What has happened to it</div>
      <table>
        <thead><tr><th style={{ width: 190 }}>When</th><th>Action</th><th>State</th><th>By</th><th>Detail</th></tr></thead>
        <tbody>
          {d.history.map((h: any, i: number) => (
            <tr key={i}>
              <td style={{ color: 'var(--muted)', whiteSpace: 'nowrap' }}>{new Date(h.at).toLocaleString()}</td>
              <td>{h.action}</td>
              <td style={{ color: 'var(--muted)' }}>
                {h.from_state && h.from_state !== h.to_state ? `${h.from_state} → ${h.to_state}` : h.to_state ?? '—'}
              </td>
              <td style={{ color: 'var(--muted)' }}>{h.actor}</td>
              <td style={{ color: 'var(--faint)', fontSize: 'var(--fs-sm)' }}>{h.detail ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}


// ---------------------------------------------------------------------------
//  Event data, which is a different lifetime from media
// ---------------------------------------------------------------------------
function EventRetention() {
  const [r, setR] = useState<AnalyticsRetention | null>(null)
  const [days, setDays] = useState('')
  const [forever, setForever] = useState(false)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState('')
  const [swept, setSwept] = useState<string>('')

  async function load() {
    try {
      const v = await api.analyticsRetention()
      setR(v); setForever(v.rawRetentionDays == null)
      setDays(String(v.rawRetentionDays ?? 90)); setErr('')
    } catch (e: any) { setErr(e.message) }
  }
  useEffect(() => { load() }, [])

  if (err && !r) return <div className="card p-4"><div className="err">{err}</div></div>
  if (!r) return <div className="card p-4"><div className="loading">Loading…</div></div>

  return (
    <div className="card p-4" style={{ marginBottom: 16 }}>
      <div className="sec-label">Event data</div>
      {/* The distinction this panel exists to make: reports and the events they
          were computed from do not have the same lifetime, and only one of them
          ages out. */}
      <p style={{ color: 'var(--muted)', fontSize: 'var(--fs-sm)', marginTop: 0 }}>
        {r.note}
      </p>

      <div className="flex flex-wrap items-center gap-4" style={{ fontSize: 'var(--fs-sm)', marginBottom: 12 }}>
        <span>
          <span style={{ color: 'var(--faint)' }}>Raw sessions </span>
          {r.raw.sessions.toLocaleString()}
          {r.raw.oldest && <span style={{ color: 'var(--faint)' }}> from {r.raw.oldest}</span>}
        </span>
        <span>
          <span style={{ color: 'var(--faint)' }}>Report days </span>
          {r.reports.days}
          <span style={{ color: 'var(--faint)' }}> ({r.reports.sealed} sealed)</span>
        </span>
        {r.reports.oldest && (
          <span><span style={{ color: 'var(--faint)' }}>Reports from </span>{r.reports.oldest}</span>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2" style={{ fontSize: 'var(--fs-sm)' }}>
          <input type="checkbox" checked={forever} onChange={e => setForever(e.target.checked)} />
          Keep raw events forever
        </label>
        {!forever && (
          <>
            <input type="number" min={1} value={days} onChange={e => setDays(e.target.value)}
              style={{ width: 90 }} />
            <span style={{ color: 'var(--faint)', fontSize: 'var(--fs-sm)' }}>days</span>
          </>
        )}
        <button className="btn primary" disabled={!!busy} onClick={async () => {
          setBusy('save'); setErr('')
          try { setR(await api.setAnalyticsRetention(forever ? null : Number(days))) }
          catch (e: any) { setErr(e.message) } finally { setBusy('') }
        }}>{busy === 'save' ? 'Saving…' : 'Save'}</button>
        <div className="flex-1" />
        <button className="btn ghost" disabled={!!busy} onClick={async () => {
          setBusy('sweep'); setErr('')
          try {
            const s = await api.sweepAnalyticsRetention()
            setSwept(`Sealed ${s.seal.sealed} day(s), pruned ${s.prune.sessionsDeleted} session(s)` +
              (s.prune.heldForUnsealed ? `, held ${s.prune.heldForUnsealed} unsealed` : '') + '.')
            await load()
          } catch (e: any) { setErr(e.message) } finally { setBusy('') }
        }}>Seal and prune now</button>
      </div>
      {swept && <div style={{ color: 'var(--ok,#4ade80)', fontSize: 'var(--fs-sm)', marginTop: 8 }}>{swept}</div>}
      {err && <div className="err" style={{ marginTop: 8 }}>{err}</div>}
    </div>
  )
}

// ---------------------------------------------------------------------------
export default function StoragePage() {
  const [caps, setCaps] = useState<StorageCapabilities | null>(null)
  const [rules, setRules] = useState<RetentionRuleRow[]>([])
  const [objects, setObjects] = useState<MediaObjectRow[]>([])
  const [preview, setPreview] = useState<SweepPreview | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [err, setErr] = useState('')

  async function load() {
    try {
      const [c, r, o] = await Promise.all([
        api.storageCapabilities(), api.retentionRules(), api.mediaObjects({ limit: 200 }),
      ])
      setCaps(c); setRules(r.rules); setObjects(o.objects); setErr('')
    } catch (e: any) { setErr(e.message) }
  }
  useEffect(() => { load() }, [])

  const totals = useMemo(() => {
    const t = { bytes: 0, byState: {} as Record<string, number>, held: 0 };
    for (const o of objects) {
      t.bytes += Number(o.bytes ?? 0)
      t.byState[o.state] = (t.byState[o.state] ?? 0) + 1
      if (o.hold) t.held++
    }
    return t
  }, [objects])

  const shown = objects.filter(o =>
    !filter || o.logical_key.toLowerCase().includes(filter.toLowerCase())
    || (o.source_name ?? '').toLowerCase().includes(filter.toLowerCase()))

  if (err && !caps) return <div className="err">{err}</div>
  if (!caps) return <div className="loading">Loading storage…</div>

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Storage</h1>
          <p>What media exists, where it lives, and what retention will do to it next.</p>
        </div>
        <div className="spacer" />
        <button className="btn ghost" onClick={load}>Refresh</button>
      </div>
      {err && <div className="err">{err}</div>}

      {/* WHAT THIS DEPLOYMENT CAN DO. Stated first, because everything below is
          shaped by it and an operator looking for an archive that is not there
          should find out here rather than from a rule that silently never fires. */}
      <div className="card p-4" style={{ marginBottom: 16 }}>
        <div className="sec-label">This deployment</div>
        <div className="flex flex-wrap items-center gap-4" style={{ fontSize: 'var(--fs-sm)' }}>
          <span><span style={{ color: 'var(--faint)' }}>Driver </span>{caps.driver === 's3' ? 'S3 or compatible' : 'Local disk'}</span>
          <span><span style={{ color: 'var(--faint)' }}>Tiers </span>{caps.tiers.map(t => TIER_LABEL[t] ?? t).join(', ')}</span>
          <span>
            <span style={{ color: 'var(--faint)' }}>Archiving </span>
            <span style={{ color: caps.archiveEnabled ? 'var(--ok,#4ade80)' : 'var(--muted)' }}>
              {caps.archiveEnabled ? 'available' : 'not available'}
            </span>
          </span>
          <span><span style={{ color: 'var(--faint)' }}>Tracked </span>{fmtBytes(totals.bytes)} across {objects.length} object{objects.length === 1 ? '' : 's'}</span>
          {totals.held > 0 && <span style={{ color: 'var(--warn,#fbbf24)' }}>{totals.held} on hold</span>}
        </div>
        {caps.archiveUnavailableReason && (
          <div style={{ color: 'var(--muted)', fontSize: 'var(--fs-sm)', marginTop: 8 }}>
            {caps.archiveUnavailableReason}
          </div>
        )}
      </div>

      <div style={{ marginBottom: 16 }}>
        <LadderEditor caps={caps} rule={rules[0] ?? null} onSaved={load} />
      </div>

      <EventRetention />

      {/* SEE IT BEFORE IT HAPPENS. A ladder deletes things; being able to look
          first is the difference between a policy someone switches on and one
          that sits disabled forever. */}
      <div className="card p-4" style={{ marginBottom: 16 }}>
        <div className="sec-label">What the next sweep would do</div>
        <div className="flex flex-wrap items-center gap-4">
          <button className="btn ghost" onClick={async () => {
            try { setPreview(await api.previewSweep()) } catch (e: any) { setErr(e.message) }
          }}>Run a dry run</button>
          {preview && (
            <>
              <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)' }}>
                {preview.considered} considered
              </span>
              <span style={{ fontSize: 'var(--fs-sm)' }}>{preview.cooled} to cheaper storage</span>
              <span style={{ fontSize: 'var(--fs-sm)' }}>{preview.archived} archived</span>
              <span style={{ fontSize: 'var(--fs-sm)', color: preview.deleted ? 'var(--danger,#f87171)' : undefined }}>
                {preview.deleted} deleted
              </span>
              {preview.skippedOnHold > 0 && (
                <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--warn,#fbbf24)' }}>
                  {preview.skippedOnHold} skipped on hold
                </span>
              )}
              {preview.unavailable > 0 && (
                <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--warn,#fbbf24)' }}>
                  {preview.unavailable} this deployment cannot do
                </span>
              )}
            </>
          )}
        </div>
      </div>

      <div className="card">
        <div className="flex items-center gap-2" style={{ padding: '12px 14px 0' }}>
          <input value={filter} onChange={e => setFilter(e.target.value)}
            placeholder="Filter by run or source…" style={{ width: 280 }} />
          <div className="flex-1" />
          <span style={{ color: 'var(--faint)', fontSize: 'var(--fs-sm)' }}>
            {Object.entries(totals.byState).map(([s, n]) => `${n} ${s}`).join(' · ')}
          </span>
        </div>
        <table>
          <thead><tr><th>Media</th><th>Source</th><th>State</th><th>Tier</th><th>Size</th><th>Length</th><th /></tr></thead>
          <tbody>
            {shown.map(o => (
              <FragmentRow key={o.id} o={o} open={open === o.id}
                onToggle={() => setOpen(open === o.id ? null : o.id)}
                caps={caps} onChanged={load} />
            ))}
            {shown.length === 0 && (
              <tr><td colSpan={7} style={{ color: 'var(--faint)' }}>
                No media is tracked yet. It is registered as recordings are written.
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  )
}

function FragmentRow({ o, open, onToggle, caps, onChanged }: {
  o: MediaObjectRow; open: boolean; onToggle: () => void
  caps: StorageCapabilities; onChanged: () => void
}) {
  const tiers = (o.locations ?? []).map(l => TIER_LABEL[l.tier] ?? l.tier)
  return (
    <>
      <tr onClick={onToggle} style={{ cursor: 'pointer' }}>
        <td style={{ fontFamily: 'ui-monospace,monospace', fontSize: 'var(--fs-sm)' }}>{o.logical_key}</td>
        <td style={{ color: 'var(--muted)' }}>{o.source_name ?? '—'}</td>
        <td><StateChip state={o.state} />{o.hold && <span style={{ color: 'var(--warn,#fbbf24)', fontSize: 'var(--fs-micro)', marginLeft: 6 }}>held</span>}</td>
        <td style={{ color: 'var(--muted)' }}>{tiers.length ? tiers.join(', ') : <span style={{ color: 'var(--faint)' }}>none</span>}</td>
        <td style={{ color: 'var(--muted)' }}>{fmtBytes(o.bytes)}</td>
        <td style={{ color: 'var(--muted)' }}>{fmtDur(o.duration_ms)}</td>
        <td style={{ textAlign: 'right' }}>
          <button className="btn ghost" onClick={e => { e.stopPropagation(); onToggle() }}>
            {open ? 'Hide' : 'Details'}
          </button>
        </td>
      </tr>
      {open && (
        <tr><td colSpan={7} style={{ background: 'var(--panel-2)' }}>
          <ObjectDetail id={o.id} caps={caps} onChanged={onChanged} />
        </td></tr>
      )}
    </>
  )
}
