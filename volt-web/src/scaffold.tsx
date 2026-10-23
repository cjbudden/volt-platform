import { recoveryView } from './recovery'
import type { FailureDiagnosis } from './api'
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
import { pressable } from './a11y'

// ----------------------------------------------------------------------------
// FORM design language: channel and event create/settings drawers share one
// section order so the same action is always in the same place:
//   Name → Type → [Schedule: events only] → Source → [Ladder: transcode]
//   → Filler on loss → [Subtitles: channels] → Delivery → Recording
//   ([+ Automatic VOD: events] [+ DVR: channels])
// The shared building blocks below keep the two forms in lockstep.
// ----------------------------------------------------------------------------

/** Section header style, kept for the rare place that must MERGE extra
 *  properties (`style={{ ...SEC, marginTop: 0 }}`).
 *
 *  Everywhere else use `className="sec-label"`. The class is identical but also
 *  carries `:first-child { margin-top: 0 }`, which an inline style cannot
 *  express — that is why cards whose first child was `style={SEC}` opened with
 *  20px of dead space above the label on top of the card's own padding. */
export const SEC: React.CSSProperties = {
  fontSize: 'var(--fs-label)', letterSpacing: 'var(--ls-label)', textTransform: 'uppercase',
  color: 'var(--faint)', margin: '20px 0 10px', fontWeight: 700,
}

// ============================================================================
//  STATUS + IDENTITY — one definition, used by every page.
//
//  The rule: a page NEVER decides what a status looks like. It passes the
//  pipeline state and gets the platform's pill. That is what keeps Channels,
//  Radio, Events and Recordings reading identically, and it means a new state
//  (or a colour change) is a one-line edit here rather than a hunt through
//  pages.
// ============================================================================

/** The pipeline roll-up states the backend produces (services/pipelineHealth). */
export type PipelineState = 'idle' | 'starting' | 'ready' | 'onair' | 'degraded' | 'error' | 'stopped'

/** state -> { label, tag class }. `cls` maps onto the .tag/.dot-s colour set. */
export const PIPELINE_STATE: Record<PipelineState, { label: string; cls: string }> = {
  onair: { label: 'On air', cls: 'live' },
  ready: { label: 'Ready · private', cls: 'sched' },
  starting: { label: 'Starting', cls: 'sched' },
  degraded: { label: 'Degraded', cls: 'warn' },
  error: { label: 'Error', cls: 'down' },
  stopped: { label: 'Stopped', cls: 'idle' },
  idle: { label: 'Idle', cls: 'idle' },
}

/** THE status pill. Shape, case and colour come from the state, not the page. */
export function StatusPill({ state, label, cls, sub, title }: {
  state?: PipelineState | string | null
  /** escape hatch for non-pipeline statuses (e.g. a recording's own status) */
  label?: string; cls?: string
  sub?: string; title?: string
}) {
  const m = (state && PIPELINE_STATE[state as PipelineState]) || null
  const text = label ?? m?.label ?? 'Idle'
  const klass = cls ?? m?.cls ?? 'idle'
  const pill = (
    <span className={`tag ${klass}`} title={title}>
      <span className={`dot-s ${klass}`} />{text}
    </span>
  )
  if (!sub) return pill
  return (
    <div>
      {pill}
      <div style={{ fontSize: 'var(--fs-label)', color: 'var(--faint)', marginTop: 3 }}>{sub}</div>
    </div>
  )
}

/** What a thing IS (workflow / kind). No dot: type is not a live state. */
export function TypeTag({ label, kind = 'chan' }: { label: string; kind?: 'chan' | 'event' | 'loop' }) {
  return <span className={`tag type ${kind}`}>{label}</span>
}

/** The identity row every DETAIL page starts with: breadcrumb, then
 *  thumb + title + tags, then the one-line summary. */
export function PageIdentity({ crumbLabel, onCrumb, name, imgUrl, tags, sub, gradient }: {
  crumbLabel: string
  onCrumb: () => void
  name: string
  imgUrl?: string | null
  tags?: ReactNode
  sub?: ReactNode
  gradient?: string
}) {
  return (
    <div>
      <div className="crumb" style={{ marginBottom: 6 }}>
        <span className="lnk" style={{ cursor: 'pointer', color: 'var(--brand)' }} {...pressable((e: any) => { ((onCrumb) as any)(e) })} data-a11y-click="">{crumbLabel}</span>
        &nbsp;/&nbsp; <b style={{ color: 'var(--text)' }}>{name}</b>
      </div>
      <h1 className="page-id">
        {imgUrl
          ? <span className="dthumb" style={{ background: '#0b0f16', overflow: 'hidden', padding: 0 }}>
              <img src={imgUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
            </span>
          : <span className="dthumb" style={{ background: gradient || 'linear-gradient(135deg,#1d4ed8,#3b82f6)' }}>{initials(name)}</span>}
        {name}
        {tags}
      </h1>
      {sub && <p>{sub}</p>}
    </div>
  )
}

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
    <div className={`preset ${sel ? 'sel' : ''}`} {...pressable((e: any) => { ((onClick) as any)(e) })} data-a11y-click="">
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
      <div className="sec-label">Recording</div>
      <div className="toggle-row">
        <div>
          <div className="tt">Recording and clipping</div>
          <div className="td">{ctx === 'event'
            ? "Keep the event's output as one contained recording: review it, clip highlights, publish VOD. Off means nothing can be clipped later."
            : 'Keep the live output as a recording: review it, clip highlights, and publish VOD assets. Off means segments are cleared after the DVR window and nothing can be clipped later.'}</div>
        </div>
        <div className={`sw ${recOn ? '' : 'off'}`} {...pressable((e: any) => { ((() => setRecOn(v => !v)) as any)(e) })} data-a11y-click=""><i /></div>
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
              <div className={`sw ${autoVod ? '' : 'off'}`} {...pressable((e: any) => { ((() => setAutoVod(v => !v)) as any)(e) })} data-a11y-click=""><i /></div>
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
    <div className={`chip ${on ? 'active' : ''}`} {...pressable((e: any) => { ((onClick) as any)(e) })} data-a11y-click="">
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
export function NewButton({ label, onClick, blockedReason }: { label: string; onClick: () => void; blockedReason?: string | null }) {
  // BLOCKED SAYS WHY. A full group (or no group) disables the button; the
  // reason is a warning in the page notice region (notices.tsx), the standard
  // place, raised by the page. The tooltip repeats it.
  return (
    <button className="btn primary" onClick={onClick} disabled={!!blockedReason} title={blockedReason || undefined}>
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

/** Status pill (tag + dot) with an optional sub-line, e.g. a countdown.
 *  Thin wrapper over StatusPill so existing list pages keep working while
 *  everything renders from the one definition. */
export function StatusTag({ label, cls, sub }: { label: string; cls: string; sub?: string }) {
  return <StatusPill label={label} cls={cls} sub={sub} />
}

// ============================================================================
//  THE FIVE-GATE STRIP — Server → Input → Encoder → Output → On air.
//
//  One definition, used by Channels and Radio. It was duplicated in both pages
//  and had drifted; worse, both copies wrapped. Each gate was `flex: 1 1 130px`,
//  so a gate with a long detail line (an Icecast station name, a source URL)
//  grew past its share and pushed "On air" onto a second row. The strip is a
//  PIPELINE: five steps in one line, or it stops reading as a pipeline.
//
//  Fix: `flex: 1 1 0` with `min-width: 0`. Every gate takes an equal share of
//  the row whatever it contains, and long detail ellipsises inside its own box
//  (the full text stays available on hover via `title`).
// ============================================================================
export const GATE_COLOR: Record<string, string> = {
  healthy: '#4ade80', degraded: '#fbbf24', failed: '#f87171',
  ready: '#38bdf8', starting: '#60a5fa', stopped: '#94a3b8', idle: '#64748b',
}

export interface StripGate {
  gate: string; label: string; status: string; detail?: string; billable?: boolean
  /** What the status means for this gate, e.g. UNASSIGNED, NOT CONNECTED, RECEIVING. */
  badge?: string
  /** A live reading in the box's lower right (CPU on Server, data received on Input). */
  meter?: { text: string; title?: string; warn?: boolean } | null
}

export function PipelineStrip({ gates }: { gates: StripGate[] }) {
  if (!gates.length) return null
  return (
    // pipe-strip / pipe-gate / pipe-arrow: on a phone the five gates wrap into
    // rows instead of squeezing into slivers (index.css, phone shell).
    <div className="pipe-strip" style={{ display: 'flex', alignItems: 'stretch', gap: 6, margin: '0 0 14px' }}>
      {gates.map((g, i) => {
        // A healthy PUBLIC gate is the one that means we are truly on air.
        // the gate's own word for its state (docs/STATUS_MAP.md), else the raw status
        const label = g.badge ?? ((g.gate === 'public' && g.status === 'healthy') ? 'ON AIR' : g.status)
        const color = GATE_COLOR[g.status] ?? '#64748b'
        return (
          <div key={g.gate} className="pipe-gate" style={{ display: 'flex', alignItems: 'stretch', gap: 6, flex: '1 1 0', minWidth: 0 }}>
            <div title={g.detail} style={{
              flex: 1, minWidth: 0, border: `1px solid ${color}55`, background: `${color}12`,
              borderRadius: 9, padding: '7px 10px',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 'var(--fs-label)', color: 'var(--muted)' }}>
                <span className="dot-s" style={{ background: color }} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{g.label}</span>
                {/* THE AMBER DOT: this gate is what is billed (server time). Named on
                    hover and to screen readers, and lit only while it is running. */}
                {g.billable && <span className="bill-dot" data-tip={g.status === 'healthy' || g.status === 'starting' || g.status === 'degraded' ? 'Billable: server time is charged while this runs' : 'Billable: server time is charged only while a stream runs (nothing now)'}
                  role="img" aria-label="Billable resource" tabIndex={0}
                  style={{ marginLeft: 'auto', color: g.status === 'healthy' || g.status === 'starting' || g.status === 'degraded' ? '#fbbf24' : 'rgba(251,191,36,.35)', fontSize: 9 }}>●</span>}
              </div>
              <div style={{ fontWeight: 700, fontSize: 'var(--fs-xs)', color, textTransform: 'uppercase' }}>{label}</div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <div style={{ flex: 1, minWidth: 0, fontSize: 'var(--fs-micro)', color: 'var(--faint)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{g.detail}</div>
                {g.meter && <span className="gate-meter" title={g.meter.title} style={g.meter.warn ? { color: 'var(--warn)' } : undefined}>{g.meter.text}</span>}
              </div>
            </div>
            {i < gates.length - 1 && (
              <div className="pipe-arrow" style={{ display: 'grid', placeItems: 'center', color: 'var(--faint)', fontSize: 'var(--fs-sm)', flex: 'none' }}>→</div>
            )}
          </div>
        )
      })}
    </div>
  )
}

/* ===========================================================================
 *  RECOVERY — what auto-connect is doing about a stream that stopped.
 *
 *  This existed only as a give-up notice, buried in the Settings drawer, and
 *  only once auto-connect had already stopped trying. So the whole middle of
 *  the story was invisible: a stream could be failing and being retried and the
 *  page said nothing at all, which reads exactly like a system that is not
 *  trying. "Resume is not working" was the reasonable conclusion, and it was
 *  not possible to tell from the console whether it was true.
 *
 *  Three states, and each of them is worth a sentence:
 *
 *    trying     attempts spent, not yet given up. The reason is the last error
 *               recorded, which is what an operator needs BEFORE the fifth
 *               attempt rather than after it.
 *    gave up    it has stopped. Says so, says why, and says that pressing Start
 *               clears it, because otherwise the only cure looks like a
 *               database edit.
 *    off        auto-connect is disabled on this stream, which is a legitimate
 *               choice and a surprising one when a stream stays down. Only
 *               mentioned when the stream is meant to be running.
 *
 *  Deliberately takes the raw row rather than a typed detail: the channel and
 *  radio payloads spell these fields differently (one maps to camelCase, one
 *  spreads the row) and a shared component that only works for one of them
 *  would be shared in name only.
 * ======================================================================== */
export function RecoveryNote({ row, state, onDismiss, dismissing, onAutoConnect, togglingAuto }: {
  row: any; state?: string | null
  /** Offered only where a caller can act on it. A give-up notice is the one
   *  kind an operator can put down without starting the stream: the others
   *  describe something still in progress and will clear themselves. */
  onDismiss?: () => void
  dismissing?: boolean
  /** Stop auto connect while it is retrying (leaves the evidence alone), or
   *  switch it back on when it is off. */
  onAutoConnect?: (enabled: boolean) => void
  togglingAuto?: boolean
}) {
  // The DECISION lives in recovery.ts, pure and pinned by
  // volt-app/test/recovery-note.check.ts. This component only paints it.
  const v = recoveryView(row, state)
  if (v.kind === 'none') return null

  const bad = v.kind === 'gave_up'

  // THE SAME BANNER AS EVERY OTHER FAILURE ON THESE PAGES: a tinted panel with
  // its own full border, not a card with a coloured spine. The offset left rule
  // read as an annotation hanging off the side of the page, which is the wrong
  // weight for the one notice that stays true until somebody acts on it, and it
  // did not match the primary-error banner sitting directly beneath it.
  const tint = bad
    ? { bg: 'rgba(248,113,113,.10)', line: 'rgba(248,113,113,.4)' }
    : { bg: 'rgba(251,191,36,.10)',  line: 'rgba(251,191,36,.4)' }

  return (
    <div style={{
      margin: '0 0 14px', padding: '12px 14px', borderRadius: 10,
      display: 'flex', alignItems: 'flex-start', gap: 10, minWidth: 0,
      background: tint.bg, border: `1px solid ${tint.line}`,
    }}>
      <span className={`dot-s ${bad ? 'down' : 'warn'}`} style={{ marginTop: 6, flex: 'none' }} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 'var(--fs-body)', color: 'var(--text)' }}>{v.text}</div>
        {v.lastError && (
          // THE REASON, VERBATIM. It is the encoder's own words, carried out of
          // a task whose disk is gone, and paraphrasing it here would throw away
          // the only specific thing anybody has to work with.
          <div style={{
            fontSize: 'var(--fs-sm)', color: 'var(--muted)', marginTop: 3,
            fontFamily: 'ui-monospace,monospace', wordBreak: 'break-word',
          }}>{v.lastError}</div>
        )}
      </div>
      {/* ONLY ON A GIVE-UP. "Retrying" and "auto reconnect is off" describe a
          live situation that will change on its own or that a setting controls;
          dismissing either would be hiding a true statement. A give-up is the
          one that stays true until a person acts, so it is the one worth being
          able to put down. The title says what dismissing actually DOES,
          because it is not only a visual change. */}
      {bad && onDismiss && (
        <button className="btn ghost" disabled={dismissing} onClick={onDismiss}
          title="Clears the notice and stands the stream down, so auto reconnect does not immediately start trying again. Press Start when the source is fixed."
          style={{ flex: 'none', alignSelf: 'center', color: '#fca5a5', borderColor: 'rgba(248,113,113,.5)' }}>
          {dismissing ? 'Dismissing…' : 'Dismiss'}
        </button>
      )}
      {/* STOP IT BY HAND. While auto reconnect is retrying, the one thing an
          operator may want is for it to stop so the failure can be read as it
          is. Off leaves every counter and log line untouched. */}
      {v.kind === 'retrying' && onAutoConnect && (
        <button className="btn ghost" disabled={togglingAuto} onClick={() => onAutoConnect(false)}
          title="Stops auto reconnect for this stream now. Nothing is cleared: the log and the last error stay as they are so you can read why it failed."
          style={{ flex: 'none', alignSelf: 'center' }}>
          {togglingAuto ? 'Stopping…' : 'Stop auto reconnect'}
        </button>
      )}
      {v.kind === 'auto_off' && onAutoConnect && (
        <button className="btn ghost" disabled={togglingAuto} onClick={() => onAutoConnect(true)}
          title="Switches auto reconnect back on. The stream still has to be seen healthy before it is put back automatically."
          style={{ flex: 'none', alignSelf: 'center' }}>
          {togglingAuto ? 'Switching on…' : 'Switch auto reconnect on'}
        </button>
      )}
    </div>
  )
}

/* ===========================================================================
   WHAT WENT WRONG. The QC panel's reading of a failure: a verdict in plain
   words, why, what to do first, the raw lines it was built from, and whether
   auto reconnect is going to do anything about it. Shared by the channel and
   radio panels so a failure reads the same on both. The evidence is shown
   because a verdict without its evidence is an opinion.
   ======================================================================== */
export function DiagnosisBlock({ diag }: { diag: FailureDiagnosis | null | undefined }) {
  if (!diag) return null
  const conf = { high: 'high confidence', medium: 'likely', low: 'best guess' }[diag.confidence]
  return (
    <div style={{ margin: '10px 0 16px', padding: '12px 14px', borderRadius: 10, background: 'rgba(248,113,113,.08)', border: '1px solid rgba(248,113,113,.35)' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <div style={{ fontWeight: 700, color: '#fca5a5' }}>What went wrong: {diag.verdict}</div>
        <span className="tag" style={{ fontSize: 'var(--fs-micro)' }}>{diag.gate}</span>
        <span style={{ fontSize: 'var(--fs-micro)', color: 'var(--faint)' }}>{conf}</span>
      </div>
      <div style={{ fontSize: 'var(--fs-body)', color: 'var(--muted)', marginTop: 4 }}>{diag.reason}</div>
      <div style={{ fontSize: 'var(--fs-body)', color: 'var(--text)', marginTop: 6 }}><b>Next:</b> {diag.nextStep}</div>
      {diag.retry.note && (
        <div style={{ fontSize: 'var(--fs-sm)', color: diag.retry.willRetry ? 'var(--warn,#fbbf24)' : 'var(--muted)', marginTop: 6 }}>
          {diag.retry.note}
        </div>
      )}
      {diag.evidence.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <div style={{ fontSize: 'var(--fs-micro)', color: 'var(--faint)', textTransform: 'uppercase', letterSpacing: '.04em' }}>Evidence</div>
          {diag.evidence.map((l, i) => (
            <div key={i} style={{ fontFamily: 'ui-monospace,monospace', fontSize: 'var(--fs-sm)', color: 'var(--muted)', wordBreak: 'break-word', marginTop: 2 }}>{l}</div>
          ))}
        </div>
      )}
    </div>
  )
}

/* ===========================================================================
   DRAWER TABS. The settings drawers for a channel, a station and an event
   carry three different jobs: how the stream runs (the primary tab), what it
   is (Metadata: its content type and fields) and who may reach what it
   produces (Access: the publishing and access rules). One long form buried
   the second and third under the first; tabs give each its own page while
   keeping every field mounted, so nothing typed is lost by switching.
   ======================================================================== */
export type DrawerTab = 'settings' | 'metadata' | 'access' | 'outputs'
export function DrawerTabs({ tab, setTab, labels, tabs = ['settings', 'metadata', 'access'] }: { tab: DrawerTab; setTab: (t: DrawerTab) => void; labels?: Partial<Record<DrawerTab, string>>; tabs?: DrawerTab[] }) {
  const L: Record<DrawerTab, string> = { settings: labels?.settings ?? 'Settings', metadata: labels?.metadata ?? 'Metadata', access: labels?.access ?? 'Access', outputs: labels?.outputs ?? 'Outputs' }
  return (
    <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--border)', margin: '-8px -20px 16px', padding: '0 20px' }}>
      {tabs.map(t => (
        <button key={t} type="button" onClick={() => setTab(t)}
          style={{ background: 'none', border: 'none', borderBottom: `2px solid ${tab === t ? 'var(--brand,#3f7bff)' : 'transparent'}`, color: tab === t ? 'var(--text)' : 'var(--muted)', padding: '8px 12px', fontWeight: 600, fontSize: 'var(--fs-sm)', cursor: 'pointer' }}>
          {L[t]}
        </button>
      ))}
    </div>
  )
}
export function TabPane({ active, children }: { active: boolean; children: ReactNode }) {
  return <div style={{ display: active ? 'block' : 'none' }}>{children}</div>
}
