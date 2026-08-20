// ============================================================================
//  Shared page scaffold — the COMMON DESIGN LANGUAGE for list pages
//  (Channels, Events, Recordings, and future sections like Radio).
//
//  Every list page follows the same base structure so actions live in
//  predictable places:
//    1. .page-head     : title + one-line description LEFT, primary "New X"
//                        button RIGHT (always the same spot).
//    2. .filters row   : filter chips with counts LEFT, optional search RIGHT.
//    3. .card > table  : first column = entity identity (thumb + name + group
//                        subtitle), middle columns = contextual data, then a
//                        STATUS pill (tag + dot), and ONE primary action button
//                        right-aligned. Row click opens the entity (detail page
//                        or settings drawer). Destructive actions live INSIDE
//                        the drawer, never on the row.
// ============================================================================
import type { ReactNode } from 'react'

// ----------------------------------------------------------------------------
// FORM design language: channel and event create/settings drawers share one
// section order so the same action is always in the same place:
//   Name → Type → [Schedule: events only] → Source → [Ladder: transcode]
//   → Filler on loss → [Subtitles: channels] → Delivery → Recording
//   ([+ Automatic VOD: events] [+ DVR: channels])
// The shared building blocks below keep the two forms in lockstep.
// ----------------------------------------------------------------------------

/** Section header style used by every drawer form. */
export const SEC: React.CSSProperties = { fontSize: 11, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--faint)', margin: '20px 0 10px', fontWeight: 700 }

export type RetUnit = 'minutes' | 'hours' | 'days' | 'weeks' | 'months'
export const RET_UNIT_SEC: Record<RetUnit, number> = { minutes: 60, hours: 3600, days: 86400, weeks: 604800, months: 2592000 }
/** Seconds -> {number, unit} picking the largest whole unit (minutes and up). */
export function splitDuration(sec: number | null): { n: string; unit: RetUnit } {
  if (sec == null || sec <= 0) return { n: '', unit: 'days' }
  const order: RetUnit[] = ['months', 'weeks', 'days', 'hours', 'minutes']
  for (const u of order) { const s = RET_UNIT_SEC[u]; if (sec % s === 0 && sec >= s) return { n: String(sec / s), unit: u } }
  return { n: String(Math.max(1, Math.round(sec / 60))), unit: 'minutes' }
}

/** Type preset card (Transcode / Packaging) — same control in both forms. */
export function Preset({ sel, onClick, title, desc, meta }: { sel: boolean; onClick: () => void; title: string; desc: string; meta: string }) {
  return (
    <div className={`preset ${sel ? 'sel' : ''}`} onClick={onClick}>
      <div className="pt">{title}</div>
      <div className="px">{desc}</div>
      <div className="px" style={{ fontFamily: 'ui-monospace,monospace', marginTop: 8, color: 'var(--faint)' }}>{meta}</div>
    </div>
  )
}

/** The RECORDING section, identical in channel and event forms: the explicit
 *  switch, retention when on, and optional extras (auto-VOD for events, the
 *  DVR-floor warning for channels). One component so wording, order, and
 *  behaviour can never drift between the two. */
export function RecordingSection({ ctx, recOn, setRecOn, retNum, setRetNum, retUnit, setRetUnit, retWarn, autoVod, setAutoVod }: {
  ctx: 'channel' | 'event'
  recOn: boolean; setRecOn: (v: boolean | ((v: boolean) => boolean)) => void
  retNum: string; setRetNum: (v: string) => void
  retUnit: RetUnit; setRetUnit: (v: RetUnit) => void
  retWarn?: string | null
  autoVod?: boolean; setAutoVod?: (v: boolean | ((v: boolean) => boolean)) => void
}) {
  return (
    <>
      <div style={SEC}>Recording</div>
      <div className="toggle-row">
        <div>
          <div className="tt">Recording and clipping</div>
          <div className="td">{ctx === 'event'
            ? "Keep the event's output as one contained recording: review it, clip highlights, publish VOD. Off means nothing can be clipped later."
            : 'Keep the live output as a recording: review it, clip highlights, and publish VOD assets. Off means segments are cleared after the DVR window and nothing can be clipped later.'}</div>
        </div>
        <div className={`sw ${recOn ? '' : 'off'}`} onClick={() => setRecOn(v => !v)}><i /></div>
      </div>
      {recOn && (
        <>
          <div className="field"><label>Retention <span style={{ color: 'var(--faint)' }}>— blank number = keep forever</span></label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input className="inp" style={{ width: 110 }} inputMode="numeric" placeholder="keep forever"
                value={retNum} onChange={e => setRetNum(e.target.value.replace(/[^0-9]/g, ''))} />
              <select className="inp" value={retUnit} onChange={e => setRetUnit(e.target.value as RetUnit)}>
                <option value="minutes">minutes</option>
                <option value="hours">hours</option>
                <option value="days">days</option>
                <option value="weeks">weeks</option>
                <option value="months">months</option>
              </select>
            </div>
            {retWarn && <div className="hintxt" style={{ color: 'var(--warn)' }}>{retWarn}</div>}
          </div>
          {autoVod !== undefined && setAutoVod && (
            <div className="toggle-row">
              <div><div className="tt">Automatic VOD on end</div><div className="td">When the event's recording closes, publish it as a full-event VOD asset automatically (the event's metadata is carried over).</div></div>
              <div className={`sw ${autoVod ? '' : 'off'}`} onClick={() => setAutoVod(v => !v)}><i /></div>
            </div>
          )}
        </>
      )}
    </>
  )
}

export const THUMB_BG = [
  'linear-gradient(135deg,#7dd3fc,#3f7bff)', 'linear-gradient(135deg,#4ade80,#16a34a)',
  'linear-gradient(135deg,#c4b5fd,#7c3aed)', 'linear-gradient(135deg,#fca5a5,#ef4444)',
  'linear-gradient(135deg,#fdba74,#f97316)',
]

export function initials(name: string) {
  return name.split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?'
}

/** Filter chip with a count — the standard list filter control. */
export function FChip({ label, n, on, onClick }: { label: string; n: number; on: boolean; onClick: () => void }) {
  return (
    <div className={`chip ${on ? 'active' : ''}`} onClick={onClick}>
      {label}<span className="ct">{n}</span>
    </div>
  )
}

/** Standard page header: title + description left, primary action right. */
export function PageHead({ title, sub, action }: { title: string; sub: string; action?: ReactNode }) {
  return (
    <div className="page-head">
      <div><h1>{title}</h1><p>{sub}</p></div>
      <div className="spacer" />
      {action}
    </div>
  )
}

/** Standard "New X" primary button for the page head. */
export function NewButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button className="btn primary" onClick={onClick}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><path d="M12 5v14M5 12h14" /></svg>
      {label}
    </button>
  )
}

/** Entity identity cell: brand image or initials thumb + name + subtitle. */
export function EntityCell({ name, sub, index = 0, imgUrl }: { name: string; sub?: string; index?: number; imgUrl?: string | null }) {
  return (
    <div className="cell-name">
      {imgUrl
        ? <div className="thumb" style={{ background: '#0b0f16', overflow: 'hidden', padding: 0 }}><img src={imgUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'contain' }} /></div>
        : <div className="thumb" style={{ background: THUMB_BG[index % THUMB_BG.length] }}>{initials(name)}</div>}
      <div>
        <div className="nm">{name}</div>
        <div className="id">{sub || '—'}</div>
      </div>
    </div>
  )
}

/** Status pill (tag + dot) with an optional sub-line, e.g. a countdown. */
export function StatusTag({ label, cls, sub }: { label: string; cls: string; sub?: string }) {
  return (
    <div>
      <span className={`tag ${cls}`}><span className={`dot-s ${cls}`} />{label}</span>
      {sub && <div style={{ fontSize: 11, color: 'var(--faint)', marginTop: 3 }}>{sub}</div>}
    </div>
  )
}
