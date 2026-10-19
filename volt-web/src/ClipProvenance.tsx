import { useEffect, useState } from 'react'
import { api, type ClipProvenance, type ProvenanceBlock } from './api'
import { Notice } from './notices'

/* ============================================================================
   WHERE THIS CLIP CAME FROM.

   A clip's start and end times say what was ASKED for. This says what was
   actually used: which capture runs, which segment ranges, which broadcast days,
   and whether the media behind it still exists.

   The last part is the one that changes what an operator can do. A clip whose
   sources have been pruned still plays, but it can no longer be re-cut a few
   seconds wider, and finding that out from a job that fails an hour later is the
   wrong moment. So presence is shown per block, on the row it belongs to.

   The panel is DELIBERATELY plain. It is a record, read when something is in
   dispute — a rights query, a takedown, a re-cut, an audit — and a record earns
   trust by being legible and specific, not by being decorated.
   ========================================================================== */

const mono = { fontFamily: 'ui-monospace,monospace' } as const

function fmtDur(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
           : `${m}:${String(ss).padStart(2, '0')}`
}
/** In the broadcast day's own zone, so a block reads as the operator filed it. */
function inZone(ms: number, tz?: string) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour12: false, day: '2-digit', month: 'short',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).format(ms)
}

function Fact({ label, value, tone }: { label: string; value: string; tone?: 'warn' | 'ok' }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
      <span style={{ fontSize: 'var(--fs-micro)', color: 'var(--faint)', textTransform: 'uppercase', letterSpacing: 'var(--ls-label)' }}>
        {label}
      </span>
      <span style={{
        fontSize: 'var(--fs-sm)',
        color: tone === 'warn' ? 'var(--warn,#fbbf24)' : tone === 'ok' ? 'var(--ok,#4ade80)' : 'var(--text)',
      }}>{value}</span>
    </div>
  )
}

function BlockRow({ b }: { b: ProvenanceBlock }) {
  const tz = b.container?.tz
  return (
    <tr>
      <td style={{ ...mono, color: 'var(--faint)' }}>{b.ordinal + 1}</td>
      <td>
        <div style={{ ...mono, fontSize: 'var(--fs-sm)' }}>{b.runId}</div>
        <div style={{ fontSize: 'var(--fs-micro)', color: 'var(--faint)' }}>
          {b.rendition}
          {b.blockIndex > 0 && ` · block ${b.blockIndex + 1} of this run`}
        </div>
      </td>
      <td style={{ ...mono, fontSize: 'var(--fs-sm)', color: 'var(--muted)' }}>
        {b.segments.first}–{b.segments.last}
        <span style={{ color: 'var(--faint)' }}> ({b.segments.count})</span>
      </td>
      <td style={{ ...mono, fontSize: 'var(--fs-sm)', color: 'var(--muted)' }}>
        {inZone(b.source.fromMs, tz)}
        <div style={{ fontSize: 'var(--fs-micro)', color: 'var(--faint)' }}>
          {fmtDur(b.clip.durationMs)} at {fmtDur(b.clip.offsetMs)} in
        </div>
      </td>
      <td style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)' }}>
        {b.container ? b.container.day : <span style={{ color: 'var(--faint)' }}>—</span>}
      </td>
      <td style={{ fontSize: 'var(--fs-sm)' }}>
        {/* Both ends whole means the block was taken as-is, which is what makes a
            re-cut cheap and the claim checkable. */}
        {b.trimmed.head || b.trimmed.tail
          ? <span style={{ color: 'var(--muted)' }}>
              {b.trimmed.head && 'head'}{b.trimmed.head && b.trimmed.tail && ' + '}{b.trimmed.tail && 'tail'}
            </span>
          : <span style={{ color: 'var(--faint)' }}>whole</span>}
      </td>
      <td style={{ fontSize: 'var(--fs-sm)' }}>
        {b.sourceMediaPresent
          ? <span style={{ color: 'var(--ok,#4ade80)' }}>on disk</span>
          : <span style={{ color: 'var(--warn,#fbbf24)' }}>pruned</span>}
        {!b.recording && (
          <div style={{ fontSize: 'var(--fs-micro)', color: 'var(--faint)' }}>capture row gone</div>
        )}
      </td>
    </tr>
  )
}

export function ClipProvenancePanel({ assetId }: { assetId: string }) {
  const [p, setP] = useState<ClipProvenance | null>(null)
  const [err, setErr] = useState('')

  useEffect(() => {
    let dead = false
    api.clipProvenance(assetId)
      .then(v => { if (!dead) setP(v) })
      .catch(e => { if (!dead) setErr(e.message) })
    return () => { dead = true }
  }, [assetId])

  // Only when there is nothing to show. `err` is also written by the actions
  // on this page, so an unconditional guard let one rejected action replace
  // the working page — including the controls needed to retry — with a line
  // of red text and no way back except navigating away.
  if (err && !p) return <Notice kind="error" variant="compact" title="Couldn't load where this clip came from." message={err} />
  if (!p) return <div className="loading">Reading the chain…</div>

  if (!p.recorded) {
    return (
      <div style={{ padding: '10px 2px', color: 'var(--muted)', fontSize: 'var(--fs-sm)' }}>
        {p.note ?? 'No sources recorded for this asset.'}
      </div>
    )
  }

  const anyPruned = p.blocks.some(b => !b.sourceMediaPresent)
  // Source times are shown in the BROADCAST DAY's clock, because that is the
  // clock the material was filed under and the one a day label like 2026-08-20
  // only makes sense in. The rest of this page reads in the browser's zone, so
  // the column is labelled: the same instant printed in two clocks with nothing
  // saying which is which is how an hour goes missing in an argument.
  const zones = Array.from(new Set(p.blocks.map(b => b.container?.tz).filter(Boolean))) as string[]
  const zoneLabel = zones.length === 1 ? zones[0] : zones.length ? 'per day' : null

  return (
    <div style={{ padding: '4px 2px 10px' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 20, marginBottom: 12 }}>
        <Fact label="Blocks" value={String(p.counts.blocks)} />
        <Fact label="Runs" value={String(p.counts.runs)} />
        <Fact label="Broadcast days" value={String(p.counts.containers)}
          tone={p.spansBroadcastDays ? 'warn' : undefined} />
        <Fact label="Segments" value={String(p.counts.segments)} />
        <Fact label="Coverage" value={p.coveragePct != null ? `${p.coveragePct}%` : '—'}
          tone={p.coveragePct != null && p.coveragePct < 100 ? 'warn' : 'ok'} />
        <Fact label="Built" value={p.buildStrategy ?? '—'} />
        {p.builtAt && <Fact label="At" value={new Date(p.builtAt).toLocaleString()} />}
        <Fact label="Re-cuttable" value={anyPruned ? 'no, sources pruned' : 'yes'}
          tone={anyPruned ? 'warn' : 'ok'} />
      </div>

      {p.spansBroadcastDays && (
        <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)', marginBottom: 10 }}>
          This clip crosses a broadcast day boundary, which is normal for late-night
          programming. It is filed under {p.counts.containers} days.
        </div>
      )}
      {anyPruned && (
        <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--warn,#fbbf24)', marginBottom: 10 }}>
          Some source media has been pruned. The clip still plays, but it cannot be
          re-cut to a different length from the original recording.
        </div>
      )}

      <table>
        <thead>
          <tr>
            <th style={{ width: 34 }}>#</th>
            <th>Run</th>
            <th>Segments</th>
            <th>
              Source time
              {zoneLabel && (
                <span style={{ fontWeight: 400, textTransform: 'none', color: 'var(--faint)' }}> · {zoneLabel}</span>
              )}
            </th>
            <th>Day</th>
            <th>Trim</th>
            <th>Media</th>
          </tr>
        </thead>
        <tbody>
          {p.blocks.map(b => <BlockRow key={b.ordinal} b={b} />)}
        </tbody>
      </table>
    </div>
  )
}
