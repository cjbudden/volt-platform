import { useEffect, useRef, useState } from 'react'
import { api, type EpgOwner, type PlaceResult, type RepeatPolicy, type RepeatRule, type RepeatWeekday } from '../api'
import { Segmented } from '../listFilters'
import { pressable } from '../a11y'
import { FormStatus } from '../notices'

/* ============================================================================
   COPY AND REPEAT: the pieces the guide page uses for both a whole day and a
   single programme. They share one vocabulary on purpose:

     - HOW OFTEN  (daily, weekdays, weekly on chosen days) and WHEN IT ENDS
       (after N weeks, on a date, or keeps going)
     - IF A DAY IS BUSY  (replace what's there, only fill empty time, keep both)
     - a PREVIEW of exactly what will happen before anything is written,
       and Undo afterwards.

   Copying to dates makes independent copies. Repeating makes linked
   occurrences that can later be changed one at a time, from a date on, or all
   together, and that keep themselves topped up when open-ended.
   ========================================================================== */

const p2 = (n: number) => String(n).padStart(2, '0')
export const toDateInput = (d: Date) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
export const browserTz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' } catch { return 'UTC' } }
const WD: RepeatWeekday[] = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']
const WD_SHORT: Record<RepeatWeekday, string> = { MO: 'Mon', TU: 'Tue', WE: 'Wed', TH: 'Thu', FR: 'Fri', SA: 'Sat', SU: 'Sun' }
export const weekdayOf = (d: Date): RepeatWeekday => WD[(d.getDay() + 6) % 7]
const addDays = (d: Date, n: number) => { const x = new Date(d); x.setDate(x.getDate() + n); return x }
const fmtDate = (ymd: string) => new Date(ymd + 'T00:00').toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })
const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

/* ------------------------------------------------------------ repeat value */
export interface RepeatValue {
  freq: 'none' | 'daily' | 'weekdays' | 'weekly'
  byDay: RepeatWeekday[]
  ends: 'weeks' | 'date' | 'never'
  weeks: number
  until: string
}
export function defaultRepeat(start: Date, freq: RepeatValue['freq'] = 'none'): RepeatValue {
  return { freq, byDay: [weekdayOf(start)], ends: 'weeks', weeks: 8, until: toDateInput(addDays(start, 56)) }
}
/** The rule and end date the API takes, or an error to show. */
export function toRule(v: RepeatValue, start: Date): { rule: RepeatRule; until: string | null } | { error: string } | null {
  if (v.freq === 'none') return null
  if (v.freq === 'weekly' && !v.byDay.length) return { error: 'Choose at least one day of the week' }
  const rule: RepeatRule = v.freq === 'weekly' ? { freq: 'weekly', byDay: v.byDay } : { freq: v.freq }
  if (v.ends === 'never') return { rule, until: null }
  if (v.ends === 'weeks') {
    if (!(v.weeks >= 1 && v.weeks <= 104)) return { error: 'Weeks must be 1 to 104' }
    return { rule, until: toDateInput(addDays(start, v.weeks * 7)) }
  }
  if (!v.until || v.until <= toDateInput(start)) return { error: 'The end date must be after the first day' }
  return { rule, until: v.until }
}

export function RepeatEditor({ value, onChange, allowNone }: { value: RepeatValue; onChange: (v: RepeatValue) => void; allowNone?: boolean }) {
  const set = (p: Partial<RepeatValue>) => onChange({ ...value, ...p })
  const freqs = [
    ...(allowNone ? [{ value: 'none' as const, label: 'Does not repeat' }] : []),
    { value: 'daily' as const, label: 'Daily' },
    { value: 'weekdays' as const, label: 'Weekdays' },
    { value: 'weekly' as const, label: 'Weekly' },
  ]
  return (
    <div className="rp-editor">
      <Segmented label="How often" value={value.freq} onChange={f => set({ freq: f })} options={freqs} />
      {value.freq === 'weekly' && (
        <div className="rp-days" role="group" aria-label="Days of the week">
          {WD.map(d => {
            const on = value.byDay.includes(d)
            return (
              <button key={d} type="button" className={`rp-day${on ? ' on' : ''}`} aria-pressed={on}
                onClick={() => set({ byDay: on ? value.byDay.filter(x => x !== d) : WD.filter(x => x === d || value.byDay.includes(x)) })}>
                {WD_SHORT[d]}
              </button>
            )
          })}
        </div>
      )}
      {value.freq !== 'none' && (
        <div className="rp-ends">
          <span className="rp-lbl">Ends</span>
          <label className="rp-opt"><input type="radio" checked={value.ends === 'weeks'} onChange={() => set({ ends: 'weeks' })} />
            after <input className="inp rp-num" type="number" min={1} max={104} value={value.weeks}
              onFocus={() => set({ ends: 'weeks' })} onChange={e => set({ weeks: Number(e.target.value), ends: 'weeks' })} /> weeks</label>
          <label className="rp-opt"><input type="radio" checked={value.ends === 'date'} onChange={() => set({ ends: 'date' })} />
            on <input className="inp rp-date" type="date" value={value.until} onFocus={() => set({ ends: 'date' })} onChange={e => set({ until: e.target.value, ends: 'date' })} /></label>
          <label className="rp-opt"><input type="radio" checked={value.ends === 'never'} onChange={() => set({ ends: 'never' })} /> keeps going</label>
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------ busy policy */
const POLICIES: { value: RepeatPolicy; label: string; hint: string }[] = [
  { value: 'replace', label: 'Replace what is there', hint: 'Programmes it overlaps are removed. Anything on air or aired, with a VOD made from it, or from an imported guide feed is never removed: that slot is skipped instead.' },
  { value: 'skip', label: 'Only fill empty time', hint: 'Anything that would overlap an existing programme is left out.' },
  { value: 'keep', label: 'Keep both', hint: 'Everything is added. Overlaps are highlighted in the guide for you to sort out.' },
]
export function PolicyPicker({ value, onChange, compact }: { value: RepeatPolicy; onChange: (p: RepeatPolicy) => void; compact?: boolean }) {
  if (compact) {
    return (
      <select className="inp" value={value} onChange={e => onChange(e.target.value as RepeatPolicy)} aria-label="If a slot is already taken">
        {POLICIES.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
      </select>
    )
  }
  return (
    <div className="rp-policies" role="radiogroup" aria-label="If a day already has programmes">
      {POLICIES.map(p => (
        <label key={p.value} className={`rp-policy${value === p.value ? ' on' : ''}`}>
          <input type="radio" checked={value === p.value} onChange={() => onChange(p.value)} />
          <span><b>{p.label}</b>{p.value === 'replace' && <em> recommended</em>}<span className="hintxt" style={{ display: 'block' }}>{p.hint}</span></span>
        </label>
      ))}
    </div>
  )
}

/* ------------------------------------------------------------ preview */
/** Debounced dry run: re-asks whenever `key` changes, ignores stale answers. */
export function usePreview(key: string, run: (() => Promise<PlaceResult>) | null) {
  const [state, setState] = useState<{ loading: boolean; result: PlaceResult | null; error: string }>({ loading: false, result: null, error: '' })
  const seq = useRef(0)
  useEffect(() => {
    if (!run) { setState({ loading: false, result: null, error: '' }); return }
    const n = ++seq.current
    setState(s => ({ ...s, loading: true, error: '' }))
    const t = setTimeout(() => {
      run().then(r => { if (n === seq.current) setState({ loading: false, result: r, error: '' }) })
        .catch(e => { if (n === seq.current) setState({ loading: false, result: null, error: e.message }) })
    }, 300)
    return () => clearTimeout(t)
    // eslint-disable-next-line
  }, [key])
  return state
}

export function PlacePreview({ loading, result, error, verb = 'Adds', compact }: { loading: boolean; result: PlaceResult | null; error: string; verb?: string; compact?: boolean }) {
  const [all, setAll] = useState(false)
  if (error) return <div className="rp-preview"><div className="err" style={{ marginTop: 0 }}>{error}</div></div>
  if (!result) return loading ? <div className="rp-preview hintxt">Working out what will change…</div> : null
  const s = result.summary
  const issues = new Map<string, typeof result.outcomes>()
  for (const o of result.outcomes) {
    const real = o.result === 'replace' && o.replaces!.some(r => !r.same)
    if (real || o.result === 'skip' || o.overlaps?.length) issues.set(o.date, [...(issues.get(o.date) ?? []), o])
  }
  const dates = [...issues.keys()].sort()
  const shown = all ? dates : dates.slice(0, compact ? 4 : 8)
  const span = s.firstDate && s.lastDate ? (s.firstDate === s.lastDate ? ` on ${fmtDate(s.firstDate)}` : ` from ${fmtDate(s.firstDate)} to ${fmtDate(s.lastDate)}`) : ''
  return (
    <div className={`rp-preview${loading ? ' stale' : ''}`} aria-live="polite">
      <div className="rp-sum">
        <b>{verb} {s.added} programme{s.added === 1 ? '' : 's'}</b>{s.dates > 1 ? ` over ${s.dates} days` : ''}{span}.
        {s.replaced > 0 && <span className="rp-n warn"> Replaces {s.replaced}.</span>}
        {s.skipped > 0 && <span className="rp-n warn"> Skips {s.skipped}.</span>}
        {s.overlapsKept > 0 && <span className="rp-n warn"> {s.overlapsKept} will overlap.</span>}
        {s.existing > 0 && <span className="rp-n"> {s.existing} already there.</span>}
        {(s.takenOver ?? 0) > 0 && <span className="rp-n"> {s.takenOver} identical programme{s.takenOver === 1 ? ' is' : 's are'} already there and become part of this repeat.</span>}
      </div>
      {result.openEnded && <div className="hintxt">Keeps going: the next 60 days are filled now and the guide is topped up automatically.</div>}
      {!dates.length
        ? <div className="rp-clear">Nothing already scheduled is affected.</div>
        : (
          <ul className="rp-issues">
            {shown.map(d => (
              <li key={d}>
                <span className="rp-d">{fmtDate(d)}</span>
                <span className="rp-lines">
                  {issues.get(d)!.map((o, i) => (
                    <span key={i} className={`rp-line ${o.result}`}>
                      {o.result === 'replace' && <>{o.title} replaces {o.replaces!.filter(r => !r.same).map(r => `${r.title} (${fmtTime(r.startsAt)}${r.fromRepeat ? ', a repeat' : ''})`).join(', ')}</>}
                      {o.result === 'skip' && <>{o.title} {fmtTime(o.startsAt)} skipped: {o.reason}</>}
                      {o.result === 'add' && o.overlaps?.length ? <>{o.title} {fmtTime(o.startsAt)} will overlap {o.overlaps.join(', ')}</> : null}
                    </span>
                  ))}
                </span>
              </li>
            ))}
            {dates.length > shown.length && (
              <li><button type="button" className="btn ghost sm" onClick={() => setAll(true)}>Show {dates.length - shown.length} more day{dates.length - shown.length === 1 ? '' : 's'} with changes</button></li>
            )}
          </ul>
        )}
    </div>
  )
}

/* ------------------------------------------------------------ the day modal */
type Target = 'tomorrow' | 'week' | 'dates' | 'repeat'

export function CopyDayModal({ owner, day, count, onClose, onDone }: {
  owner: EpgOwner; day: Date; count: number; onClose: () => void; onDone: (msg: string, batchId?: string | null) => void
}) {
  const tz = browserTz()
  const sourceDate = toDateInput(day)
  const [target, setTarget] = useState<Target>('tomorrow')
  const [dates, setDates] = useState<string[]>([toDateInput(addDays(day, 1))])
  const [repeat, setRepeat] = useState<RepeatValue>(() => defaultRepeat(day, 'weekly'))
  const [policy, setPolicy] = useState<RepeatPolicy>('replace')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const targetDates = target === 'tomorrow' ? [toDateInput(addDays(day, 1))]
    : target === 'week' ? [1, 2, 3, 4, 5, 6, 7].map(n => toDateInput(addDays(day, n)))
    : target === 'dates' ? [...new Set(dates.filter(d => d && d !== sourceDate))].sort() : []
  const rule = target === 'repeat' ? toRule(repeat, day) : null
  const ruleErr = rule && 'error' in rule ? rule.error : ''
  const body = target === 'repeat'
    ? (rule && !('error' in rule) ? { sourceDate, tz, repeat: rule, policy } : null)
    : (targetDates.length ? { sourceDate, tz, dates: targetDates, policy } : null)
  const pv = usePreview(JSON.stringify(body), body && count ? () => api.epgCopyDayV2(owner, { ...body, dryRun: true }) : null)

  async function run() {
    if (!body) { setErr(ruleErr || 'Choose where to copy this day'); return }
    setErr(''); setBusy(true)
    try {
      const r = await api.epgCopyDayV2(owner, body)
      const what = `${r.summary.added} programme${r.summary.added === 1 ? '' : 's'}`
      onDone(target === 'repeat'
        ? `Day repeat set (${r.describe ?? 'repeat'}): ${what} added${r.summary.replaced ? `, ${r.summary.replaced} replaced` : ''}${r.summary.skipped ? `, ${r.summary.skipped} skipped` : ''}`
        : `Copied ${what} onto ${r.summary.dates} day${r.summary.dates === 1 ? '' : 's'}${r.summary.replaced ? `, ${r.summary.replaced} replaced` : ''}${r.summary.skipped ? `, ${r.summary.skipped} skipped` : ''}`, r.batchId)
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }

  const n = pv.result?.summary.dates ?? (target === 'repeat' ? 0 : targetDates.length)
  const label = target === 'repeat' ? (n ? `Repeat on ${n} day${n === 1 ? '' : 's'}` : 'Repeat') : `Copy to ${targetDates.length} day${targetDates.length === 1 ? '' : 's'}`
  return (
    <div className="drawer-scrim" {...pressable((e: any) => { ((onClose) as any)(e) })} data-a11y-click="" style={{ alignItems: 'center', justifyContent: 'center' }}>
      <div className="card rp-modal" {...pressable((e: any) => { (((e: any) => e.stopPropagation()) as any)(e) })} data-a11y-click="" role="dialog" aria-label="Copy or repeat this day">
        <h3 style={{ margin: '0 0 4px' }}>Copy or repeat {day.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'short' })}</h3>
        <p className="hintxt" style={{ margin: '0 0 14px', fontSize: 'var(--fs-sm)' }}>
          {count} programme{count === 1 ? '' : 's'} start on this day. A programme that started the night before belongs to that day and is not included.
        </p>

        <div className="sec-label">Copy to</div>
        <Segmented label="Copy to" value={target} onChange={setTarget} options={[
          { value: 'tomorrow', label: 'Tomorrow' }, { value: 'week', label: 'Next 7 days' },
          { value: 'dates', label: 'Pick dates' }, { value: 'repeat', label: 'Repeat' },
        ]} />
        {target === 'dates' && (
          <div className="rp-dates">
            {dates.map((d, i) => (
              <div key={i} className="rp-date-row">
                <input className="inp" type="date" value={d} min={toDateInput(new Date())} onChange={e => setDates(ds => ds.map((x, j) => j === i ? e.target.value : x))} />
                <button type="button" className="xbtn" aria-label="Remove date" onClick={() => setDates(ds => ds.filter((_, j) => j !== i))}>✕</button>
              </div>
            ))}
            <button type="button" className="btn ghost sm" onClick={() => setDates(ds => [...ds, toDateInput(addDays(day, ds.length + 1))])}>+ Add date</button>
          </div>
        )}
        {target === 'repeat' && <RepeatEditor value={repeat} onChange={setRepeat} />}
        <div className="hintxt" style={{ marginTop: 8 }}>
          {target === 'repeat'
            ? 'Linked: the repeated days stay connected. Edit any programme later and choose this one, this and following, or all repeats.'
            : 'Independent copies: changing one later changes only that one.'}
        </div>

        <div className="sec-label">If a day already has programmes</div>
        <PolicyPicker value={policy} onChange={setPolicy} />

        <div className="sec-label">What will happen</div>
        {ruleErr ? <div className="err" style={{ marginTop: 0 }}>{ruleErr}</div>
          : <PlacePreview loading={pv.loading} result={pv.result} error={pv.error} />}

        <div className="modal-f">
          <FormStatus error={err} />
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy || count === 0 || !body || pv.loading || !!pv.error || (pv.result?.summary.added ?? 0) === 0} onClick={run}>
            {busy ? 'Working…' : label}
          </button>
        </div>
      </div>
    </div>
  )
}
