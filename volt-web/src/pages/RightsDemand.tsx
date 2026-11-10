import { useEffect, useMemo, useState } from 'react'
import { apiRequest, getToken, ApiError } from '../api'
import { countryName } from '../lib/countries'
import { navigate, useRoute } from '../router'
import { PageError } from '../notices'
import { AnalyticsViewSwitch } from './OperatingReports'
import { LineChart } from './Analytics'

/* ============================================================================
   RIGHTS DEMAND  (build queue P2-4, PUBLISHING_POLICIES.md "Rights demand")

   Who wanted a title and could not have it: viewers the play gate refused for
   a region or the rights, and token requests the CDN refused from another
   country, by country and by title, beside the plays where the title is
   licensed. It is the page a rights team opens before a negotiation, so every
   figure on it is also in the CSV, and the API (GET /api/analytics/rights-demand)
   is the same numbers.

   Read from the daily rollups only (services/availabilityDemand.ts), so the
   page never touches request logs and is at most a minute behind.

   THE MAP is a choropleth of one measure, in one hue from dim to bright: on
   this dark surface brighter means more, so the countries that matter are the
   ones that stand out. Bins are quantiles of the countries that have any
   demand, because demand is long-tailed and equal-width bins would paint
   everything but the top country the same dim blue. The map is a picture of
   the ranked table beside it, never the only place a number is: countries too
   small to draw at this scale (Singapore, Hong Kong, Malta) are in the table.

   THE TREND puts blocked viewers and plays on one axis because they are the
   same kind of number (people and plays per day) and the comparison between
   them is the point. Today is not over, so it is drawn dashed. With one title
   chosen, the dates its window opens and closes are marked on the trend, so
   demand after a licence ends is visible where it happens.
   ========================================================================== */

// ---- the report, as GET /api/analytics/rights-demand answers it ------------------
interface DemandRow { blockedViewers: number; blockedRequests: number; plays: number; afterWindowRequests: number }
interface DemandCountry extends DemandRow { country: string | null; licensed?: boolean | null }
interface DemandWindow {
  state: 'upcoming' | 'open' | 'expired' | null; status: string
  from: string | null; until: string | null; rightsFrom: string | null; rightsUntil: string | null
  territoryMode: string; territories: string[]; blockTerritories: string[]
}
interface DemandTitle extends DemandRow { assetId: string; title: string | null; kind: string | null; window: DemandWindow | null }
interface DemandReport {
  from: string; to: string
  filters: { assetId: string | null; country: string | null; kind: string | null }
  totals: DemandRow
  byCountry: DemandCountry[]
  byTitle: DemandTitle[]
  trend: (DemandRow & { day: string })[]
  otherRefusals: { reason: string; requests: number }[]
}

const DAY = 86_400_000
const fmtInt = (n: number | null | undefined) => (n == null ? '–' : n.toLocaleString())
const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10)
function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '–'
  return new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })
}
/** Numbers right-aligned in even-width digits, so a column reads down by size. */
const NUM = { textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' } as const
const nameOf = (code: string | null) => (code ? countryName(code) : 'Unknown country')

// The play gate's other answers, in the words the Playback report uses.
const OTHER_REASON: Record<string, string> = {
  availability: 'Not available yet', payment: 'Needs payment', sign_in: 'Needs sign in', group: "The app's restrictions",
  rules: 'Access rules', expired: 'Window ended', restricted: 'Withdrawn',
}
const KIND_LABEL: Record<string, string> = { vod: 'On demand', channel: 'Channel', event: 'Event' }

// ---- the period and filters live in the URL, so a view can be shared --------------
type Preset = '7d' | '30d' | '90d' | '365d' | 'custom'
const PRESETS: { key: Exclude<Preset, 'custom'>; label: string; days: number }[] = [
  { key: '7d', label: '7 days', days: 7 }, { key: '30d', label: '30 days', days: 30 },
  { key: '90d', label: '90 days', days: 90 }, { key: '365d', label: '12 months', days: 365 },
]
function useDemandParams() {
  const route = useRoute()
  void route // re-read the URL on every navigation
  const sp = new URLSearchParams(window.location.search)
  const preset = (sp.get('period') as Preset) || '30d'
  const today = utcDay(Date.now())
  let from: string, to: string
  if (preset === 'custom' && /^\d{4}-\d{2}-\d{2}$/.test(sp.get('from') ?? '') && /^\d{4}-\d{2}-\d{2}$/.test(sp.get('to') ?? '')) {
    from = sp.get('from')!; to = sp.get('to')!
  } else {
    const n = PRESETS.find((p) => p.key === preset)?.days ?? 30
    to = today; from = utcDay(Date.parse(today) - (n - 1) * DAY)
  }
  const kind = sp.get('kind') ?? ''
  const country = (sp.get('country') ?? '').toUpperCase()
  const asset = sp.get('asset') ?? ''
  const show: 'blocked' | 'plays' = sp.get('show') === 'plays' ? 'plays' : 'blocked'
  const set = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(window.location.search)
    for (const [k, v] of Object.entries(patch)) { if (v == null || v === '') next.delete(k); else next.set(k, v) }
    const qs = next.toString()
    navigate(`${window.location.pathname}${qs ? '?' + qs : ''}`, { replace: true })
  }
  const qs = new URLSearchParams({ from, to })
  if (kind) qs.set('kind', kind)
  if (country) qs.set('country', country)
  if (asset) qs.set('assetId', asset)
  return { preset, from, to, kind, country, asset, show, set, qs: qs.toString(), today }
}
type Params = ReturnType<typeof useDemandParams>

async function downloadCsv(qs: string): Promise<void> {
  const r = await fetch(`/api/analytics/rights-demand?${qs}&format=csv`, { headers: { authorization: `Bearer ${getToken()}` } })
  if (!r.ok) {
    let msg = `${r.status}`
    try { const b = await r.json(); msg = b.error || msg } catch { /* not json */ }
    throw new ApiError(r.status, msg, null)
  }
  const blob = await r.blob()
  const name = /filename="([^"]+)"/.exec(r.headers.get('content-disposition') || '')?.[1] || 'rights-demand.csv'
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a'); a.href = url; a.download = name
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

function PeriodBar({ p }: { p: Params }) {
  const [f, setF] = useState(p.from)
  const [t, setT] = useState(p.to)
  useEffect(() => { setF(p.from); setT(p.to) }, [p.from, p.to])
  return (
    <div className="flex flex-wrap items-center gap-2" style={{ minWidth: 0 }}>
      {PRESETS.map((x) => (
        <button key={x.key} className={`chip${p.preset === x.key ? ' active' : ''}`} style={{ padding: '5px 11px' }}
          onClick={() => p.set({ period: x.key, from: null, to: null })}>{x.label}</button>
      ))}
      <span className="flex flex-wrap items-center gap-2" style={{ marginLeft: 4 }}>
        <input className="inp" type="date" value={f} max={t} aria-label="From" style={{ width: 150 }}
          onChange={(e) => { setF(e.target.value); if (e.target.value) p.set({ period: 'custom', from: e.target.value, to: t }) }} />
        <span style={{ color: 'var(--faint)' }}>to</span>
        <input className="inp" type="date" value={t} min={f} max={p.today} aria-label="To" style={{ width: 150 }}
          onChange={(e) => { setT(e.target.value); if (e.target.value) p.set({ period: 'custom', from: f, to: e.target.value }) }} />
      </span>
    </div>
  )
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div style={{ minWidth: 128 }}>
      <div style={{ fontSize: 'var(--fs-micro)', color: 'var(--faint)', textTransform: 'uppercase', letterSpacing: 'var(--ls-label)', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 'var(--fs-h1)', lineHeight: 1.1, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
      {sub && <div style={{ fontSize: 'var(--fs-micro)', color: 'var(--faint)', marginTop: 2 }}>{sub}</div>}
    </div>
  )
}

// ---- the map ------------------------------------------------------------------
// Five steps of one hue between a step above the panel and a light blue, mixed in
// OKLab so each step is an even move in lightness. No-data countries stay the
// panel's own colour with an outline, so "none" never reads as "a little".
const STEPS = [16, 34, 54, 76, 100].map((p) => `color-mix(in oklab, #8fbdf7 ${p}%, #252c3d)`)
const NO_DATA = 'var(--panel-2)'

/** Upper bounds of five quantile bins over the non-zero values (fewer when there are few distinct values). */
export function quantileBreaks(values: number[]): number[] {
  const v = [...new Set(values.filter((x) => x > 0))].sort((a, b) => a - b)
  if (!v.length) return []
  if (v.length <= 5) return v
  const out: number[] = []
  for (let i = 1; i <= 5; i++) out.push(v[Math.min(v.length - 1, Math.ceil((i / 5) * v.length) - 1)])
  return [...new Set(out)]
}
function binOf(x: number, breaks: number[]): number {
  if (x <= 0 || !breaks.length) return -1
  const i = breaks.findIndex((b) => x <= b)
  return i < 0 ? breaks.length - 1 : i
}
/** The step a bin is drawn in: spread over all five when there are fewer bins, so the top is always the brightest. */
const stepOf = (bin: number, bins: number) => STEPS[bins <= 1 ? STEPS.length - 1 : Math.round((bin / (bins - 1)) * (STEPS.length - 1))]

type WorldMap = typeof import('../lib/worldMap.data')

function DemandMap({ rows, measure, selected, onPick }: {
  rows: DemandCountry[]; measure: 'blocked' | 'plays'; selected: string; onPick: (code: string) => void
}) {
  // The outlines are ~100 KB, loaded only when this report opens.
  const [world, setWorld] = useState<WorldMap | null>(null)
  const [hover, setHover] = useState<{ code: string; x: number; y: number } | null>(null)
  useEffect(() => { let live = true; import('../lib/worldMap.data').then((m) => { if (live) setWorld(m) }); return () => { live = false } }, [])

  const val = (r: DemandCountry) => (measure === 'plays' ? r.plays : r.blockedViewers)
  const byCode = useMemo(() => new Map(rows.filter((r) => r.country).map((r) => [r.country!, r])), [rows])
  const breaks = useMemo(() => quantileBreaks(rows.map(val)), [rows, measure])
  const missing = useMemo(() => (world ? rows.filter((r) => r.country && val(r) > 0 && !world.WORLD_SHAPES[r.country]).length : 0), [rows, world, measure])
  const label = measure === 'plays' ? 'Plays' : 'Blocked viewers'

  if (!world) return <div className="loading" style={{ height: 240 }}>Loading the map…</div>
  const hr = hover ? byCode.get(hover.code) : null
  return (
    <div style={{ position: 'relative' }} onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${world.WORLD_W} ${world.WORLD_H}`} width="100%" role="img" style={{ display: 'block' }}
        aria-label={`${label} by country on a world map. The table below has every country.`}>
        {Object.entries(world.WORLD_SHAPES).map(([code, d]) => {
          const r = byCode.get(code)
          const v = r ? val(r) : 0
          const b = binOf(v, breaks)
          const sel = code === selected
          return (
            <path key={code} d={d} data-country={code}
              fill={b < 0 ? NO_DATA : stepOf(b, breaks.length)}
              stroke={sel ? '#ffffff' : hover?.code === code ? 'rgba(255,255,255,.7)' : 'rgba(255,255,255,.14)'}
              strokeWidth={sel ? 1.6 : 0.5} vectorEffect="non-scaling-stroke"
              style={{ cursor: r ? 'pointer' : 'default' }}
              onMouseMove={(e) => {
                const box = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect()
                setHover({ code, x: e.clientX - box.left, y: e.clientY - box.top })
              }}
              onClick={() => { if (r) onPick(code) }} />
          )
        })}
      </svg>
      {hover && (
        <div style={{
          position: 'absolute', pointerEvents: 'none', left: Math.max(0, hover.x + 12), top: Math.max(0, hover.y - 10),
          transform: hover.x > 260 ? 'translateX(calc(-100% - 24px))' : undefined,
          background: 'var(--panel-3)', border: '1px solid var(--border-2)', borderRadius: 6,
          padding: '6px 8px', fontSize: 'var(--fs-sm)', minWidth: 170, zIndex: 2,
        }}>
          <div style={{ fontWeight: 600, marginBottom: 3 }}>{nameOf(hover.code)}</div>
          {hr ? (
            <>
              <TipRow k="Blocked viewers" v={fmtInt(hr.blockedViewers)} />
              <TipRow k="Blocked requests" v={fmtInt(hr.blockedRequests)} />
              <TipRow k="Plays" v={fmtInt(hr.plays)} />
              {hr.afterWindowRequests > 0 && <TipRow k="After the window" v={fmtInt(hr.afterWindowRequests)} />}
              {hr.licensed != null && <TipRow k="Licensed here" v={hr.licensed ? 'Yes' : 'No'} />}
            </>
          ) : <div style={{ color: 'var(--faint)' }}>No refusals or plays</div>}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3" style={{ marginTop: 8, fontSize: 'var(--fs-sm)', color: 'var(--muted)' }}>
        <span>{label}</span>
        <span className="flex items-center gap-1">
          <span style={{ width: 14, height: 10, borderRadius: 2, background: NO_DATA, border: '1px solid var(--border-2)' }} /> None
        </span>
        {breaks.map((b, i) => (
          <span key={i} className="flex items-center gap-1" style={{ fontVariantNumeric: 'tabular-nums' }}>
            <span style={{ width: 14, height: 10, borderRadius: 2, background: stepOf(i, breaks.length) }} />
            {i === 0 ? `1 to ${fmtInt(b)}` : breaks[i - 1] + 1 === b ? fmtInt(b) : `${fmtInt(breaks[i - 1] + 1)} to ${fmtInt(b)}`}
          </span>
        ))}
        {missing > 0 && <span style={{ color: 'var(--faint)' }}>{missing} {missing === 1 ? 'country is' : 'countries are'} too small to draw: see the table</span>}
      </div>
    </div>
  )
}
function TipRow({ k, v }: { k: string; v: string }) {
  return (
    <div style={{ display: 'flex', gap: 10 }}>
      <span style={{ flex: 1, color: 'var(--muted)' }}>{k}</span>
      <span style={{ fontVariantNumeric: 'tabular-nums' }}>{v}</span>
    </div>
  )
}

// ---- a title's window, in words ------------------------------------------------
function WindowTag({ w }: { w: DemandWindow | null }) {
  if (!w || !w.state) return <span style={{ color: 'var(--faint)' }}>–</span>
  if (w.state === 'upcoming') return <span className="tag sched" title={`Opens ${fmtDate(w.from)}`}>Opens {fmtDate(w.from)}</span>
  if (w.state === 'expired') return <span className="tag idle" title={`Closed ${fmtDate(w.until)}`}>Closed {fmtDate(w.until)}</span>
  return <span className="tag live" title={w.until ? `Open until ${fmtDate(w.until)}` : 'Open with no end date'}>{w.until ? `Open to ${fmtDate(w.until)}` : 'Open'}</span>
}
function territoriesText(w: DemandWindow): string {
  const list = (a: string[]) => a.map(nameOf).join(', ')
  if (w.territoryMode === 'allow') return w.territories.length ? `Only in ${list(w.territories)}` : 'Nowhere'
  if (w.territoryMode === 'block' && w.territories.length) return `Everywhere except ${list([...w.territories, ...w.blockTerritories])}`
  return w.blockTerritories.length ? `Everywhere except ${list(w.blockTerritories)}` : 'Everywhere'
}

// ============================================================================
export default function RightsDemand() {
  const p = useDemandParams()
  const [d, setD] = useState<DemandReport | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  async function load() {
    try { setD(await apiRequest(`/analytics/rights-demand?${p.qs}`)); setErr('') } catch (e: any) { setErr(e.message) }
  }
  useEffect(() => { void load() }, [p.qs])

  // Every day of the period, with the days nothing was counted as zero.
  const days = useMemo(() => {
    const out: string[] = []
    for (let t = Date.parse(p.from); t <= Date.parse(p.to); t += DAY) out.push(utcDay(t))
    return out
  }, [p.from, p.to])
  const trend = useMemo(() => {
    const m = new Map((d?.trend ?? []).map((r) => [r.day, r]))
    return days.map((day) => m.get(day) ?? { day, blockedViewers: 0, blockedRequests: 0, plays: 0, afterWindowRequests: 0 })
  }, [d, days])
  const title = p.asset ? d?.byTitle.find((t) => t.assetId === p.asset) ?? null : null
  const marks = useMemo(() => {
    const w = title?.window
    if (!w) return []
    const out: { index: number; label: string }[] = []
    const at = (iso: string | null, label: string) => {
      if (!iso) return
      const i = days.indexOf(iso.slice(0, 10))
      if (i >= 0) out.push({ index: i, label })
    }
    at(w.from, 'Window opens'); at(w.until, 'Window closes')
    if (w.rightsUntil && w.rightsUntil !== w.until) at(w.rightsUntil, 'Rights end')
    return out
  }, [title, days])
  const anyAfter = trend.some((r) => r.afterWindowRequests > 0)
  const todayIndex = days.indexOf(p.today)

  const empty = d && !d.totals.blockedRequests && !d.totals.plays && !d.totals.afterWindowRequests

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Analytics</h1>
          <p>Viewers turned away for a region or the rights, beside the plays where each title is licensed.</p>
        </div>
        <div className="spacer" />
        <div className="flex flex-wrap items-center gap-2">
          <AnalyticsViewSwitch view="rights" />
          <button className="btn primary" disabled={busy || !d}
            onClick={async () => { setBusy(true); try { await downloadCsv(p.qs) } catch (e: any) { setErr(e.message) } finally { setBusy(false) } }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M12 3v12m0 0l-5-5m5 5l5-5M4 21h16" /></svg>
            {busy ? 'Preparing…' : 'Download CSV'}
          </button>
        </div>
      </div>

      <div className="card p-4" style={{ marginBottom: 16 }}>
        <div className="flex flex-wrap items-center gap-3" style={{ justifyContent: 'space-between' }}>
          <PeriodBar p={p} />
          <div className="seg-choice" aria-label="Kind">
            {(['', 'vod', 'channel', 'event'] as const).map((k) => (
              <button key={k || 'all'} className={p.kind === k ? 'sel' : ''} onClick={() => p.set({ kind: k || null, asset: null })}>
                {k ? (k === 'vod' ? 'On demand' : `${KIND_LABEL[k]}s`) : 'All'}
              </button>
            ))}
          </div>
        </div>
        {(p.country || p.asset) && (
          <div className="flex flex-wrap items-center gap-2" style={{ marginTop: 12 }}>
            <span style={{ color: 'var(--faint)', fontSize: 'var(--fs-sm)' }}>Showing</span>
            {p.country && (
              <button className="chip active" style={{ padding: '4px 10px' }} onClick={() => p.set({ country: null })} aria-label={`Remove the ${nameOf(p.country)} filter`}>
                {nameOf(p.country)} <span aria-hidden="true">×</span>
              </button>
            )}
            {p.asset && (
              <button className="chip active" style={{ padding: '4px 10px' }} onClick={() => p.set({ asset: null })} aria-label="Remove the title filter">
                {title?.title ?? 'One title'} <span aria-hidden="true">×</span>
              </button>
            )}
          </div>
        )}
      </div>

      {err && !d ? <PageError message={err} onRetry={load} /> : !d ? <div className="loading">Loading rights demand…</div> : (
        <>
          <div className="card p-4" style={{ marginBottom: 16 }}>
            <div className="flex flex-wrap gap-6">
              <Stat label="Blocked viewers" value={fmtInt(d.totals.blockedViewers)} sub="Different people across the period" />
              <Stat label="Blocked requests" value={fmtInt(d.totals.blockedRequests)} sub="Every time play was refused" />
              <Stat label="Plays" value={fmtInt(d.totals.plays)} sub="Where it was allowed" />
              <Stat label="After the window" value={fmtInt(d.totals.afterWindowRequests)} sub="Asked for once it had closed" />
            </div>
          </div>

          {empty ? (
            <div className="card p-4" style={{ color: 'var(--muted)' }}>
              No viewer was turned away for a region or the rights in this period, and nothing was played.
              Refusals are counted from release 0.78.0; choose a longer period or <b>All</b>.
            </div>
          ) : (
            <>
              {title && (
                <div className="card p-4" style={{ marginBottom: 16 }}>
                  <div className="flex flex-wrap items-center gap-3">
                    <h3 style={{ margin: 0, fontSize: 'var(--fs-h3)' }}>{title.title ?? 'Untitled'}</h3>
                    <span className="tag idle">{KIND_LABEL[title.kind ?? ''] ?? title.kind}</span>
                    <WindowTag w={title.window} />
                  </div>
                  {title.window ? (
                    <div className="flex flex-wrap gap-6" style={{ marginTop: 10, fontSize: 'var(--fs-sm)', color: 'var(--muted)' }}>
                      <span>Available {fmtDate(title.window.from)} to {title.window.until ? fmtDate(title.window.until) : 'no end date'}</span>
                      {(title.window.rightsFrom || title.window.rightsUntil) && <span>Rights {fmtDate(title.window.rightsFrom)} to {title.window.rightsUntil ? fmtDate(title.window.rightsUntil) : 'no end date'}</span>}
                      <span>{territoriesText(title.window)}</span>
                    </div>
                  ) : (
                    <div style={{ marginTop: 8, fontSize: 'var(--fs-sm)', color: 'var(--faint)' }}>Live streams have no on-demand window: their refusals come from the channel's or event's own rules.</div>
                  )}
                </div>
              )}

              <div className="card" style={{ marginBottom: 16 }}>
                <div className="card-h">
                  <h3>Where</h3>
                  <span className="sub">Choose a country to see only it</span>
                  <span className="spacer" />
                  <div className="seg-choice" aria-label="Map shows">
                    <button className={p.show === 'blocked' ? 'sel' : ''} onClick={() => p.set({ show: null })}>Blocked viewers</button>
                    <button className={p.show === 'plays' ? 'sel' : ''} onClick={() => p.set({ show: 'plays' })}>Plays</button>
                  </div>
                </div>
                <div className="card-b">
                  <DemandMap rows={d.byCountry} measure={p.show} selected={p.country} onPick={(c) => p.set({ country: c === p.country ? null : c })} />
                </div>
              </div>

              <div className="card" style={{ marginBottom: 16 }}>
                <div className="card-h"><h3>Trend</h3><span className="sub">Per day, UTC</span></div>
                <div className="card-b">
                  <LineChart days={days} unsealedFrom={todayIndex >= 0 ? todayIndex : undefined} marks={marks}
                    series={[
                      { key: 'bv', label: 'Blocked viewers', color: '#3987e5', values: trend.map((r) => r.blockedViewers) },
                      { key: 'pl', label: 'Plays', color: '#d95926', values: trend.map((r) => r.plays) },
                      ...(anyAfter ? [{ key: 'aw', label: 'Asked after the window', color: '#9085e9', values: trend.map((r) => r.afterWindowRequests) }] : []),
                    ]} />
                </div>
              </div>

              <div className="flex flex-col gap-4" style={{ marginBottom: 16 }}>
                <div className="card" data-demand-card="countries">
                  <div className="card-h"><h3>Countries</h3><span className="sub">Most blocked viewers first</span></div>
                  <div style={{ overflowX: 'auto' }}>
                    <table data-testid="demand-countries">
                      <thead><tr>
                        <th>Country</th><th style={NUM}>Blocked viewers</th><th style={NUM}>Blocked requests</th><th style={NUM}>Plays</th>
                        {d.filters.assetId && <th>Licensed</th>}
                      </tr></thead>
                      <tbody>
                        {d.byCountry.map((c) => (
                          <tr key={c.country ?? '-'} aria-selected={!!c.country && c.country === p.country}
                            style={{ cursor: c.country ? 'pointer' : 'default', background: c.country && c.country === p.country ? 'var(--brand-dim)' : undefined }}
                            onClick={() => c.country && p.set({ country: c.country === p.country ? null : c.country })}>
                            <td>{nameOf(c.country)}</td>
                            <td style={NUM}>{fmtInt(c.blockedViewers)}</td>
                            <td style={NUM}>{fmtInt(c.blockedRequests)}</td>
                            <td style={NUM}>{fmtInt(c.plays)}</td>
                            {d.filters.assetId && <td>{c.licensed == null ? '–' : c.licensed ? <span className="tag live">Licensed</span> : <span className="tag idle">Not licensed</span>}</td>}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                <div className="card">
                  <div className="card-h"><h3>Titles</h3><span className="sub">Choose one to see where it is wanted</span></div>
                  <div style={{ overflowX: 'auto' }}>
                    <table data-testid="demand-titles">
                      <thead><tr>
                        <th>Title</th><th style={NUM}>Blocked viewers</th><th style={NUM}>Plays</th><th style={NUM}>After the window</th><th>Window</th>
                      </tr></thead>
                      <tbody>
                        {d.byTitle.map((t) => (
                          <tr key={t.assetId} aria-selected={t.assetId === p.asset}
                            style={{ cursor: 'pointer', background: t.assetId === p.asset ? 'var(--brand-dim)' : undefined }}
                            onClick={() => p.set({ asset: t.assetId === p.asset ? null : t.assetId })}>
                            <td>
                              <div style={{ fontWeight: 550 }}>{t.title ?? 'Untitled'}</div>
                              <div style={{ fontSize: 'var(--fs-micro)', color: 'var(--faint)' }}>{KIND_LABEL[t.kind ?? ''] ?? t.kind ?? ''}</div>
                            </td>
                            <td style={NUM}>{fmtInt(t.blockedViewers)}</td>
                            <td style={NUM}>{fmtInt(t.plays)}</td>
                            <td style={NUM}>{fmtInt(t.afterWindowRequests)}</td>
                            <td><WindowTag w={t.window} /></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>

              {d.otherRefusals.length > 0 && (
                <div className="card" style={{ marginBottom: 16 }}>
                  <div className="card-h"><h3>Other refusals</h3><span className="sub">Not counted as regional demand</span></div>
                  <div className="card-b flex flex-wrap gap-6">
                    {d.otherRefusals.map((o) => <Stat key={o.reason} label={OTHER_REASON[o.reason] ?? o.reason} value={fmtInt(o.requests)} />)}
                  </div>
                </div>
              )}
            </>
          )}
        </>
      )}
    </>
  )
}
