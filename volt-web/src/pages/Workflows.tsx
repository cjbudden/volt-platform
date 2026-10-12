import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import {
  api, type WorkflowMap, type WorkflowStage, type WorkflowHook, type AddonRun, type AddonRunDetail,
  type AddonService, type AddonTrigger, type WorkflowEvent, type WorkflowTrace, type AddonCategory, type AddonRunState,
  type Channel,
} from '../api'
import { PageHead } from '../scaffold'
import { navigate, useRoute } from '../router'
import { pressable } from '../a11y'
import '../workflows.css'

/* ============================================================================
   WORKFLOWS. The base pipeline every channel, recording and file follows, the
   hooks each stage fires, the add-on services attached to them, and where any
   piece of work is right now.

   Three views, one page:
     Map      the pipeline as a graph. Hooks hang under their stage; add-ons
              hang under their hook with live run counts. Select a run or a
              recording and the map TRACES it: the stages it has passed light
              up, the stage it is at is outlined, its add-on runs show progress.
     Runs     every add-on run, filterable, each opening a detail drawer with
              the step tracker, event log and result.
     Add-ons  the external services (AI agents, transcription, QC vendors) and
              the triggers that attach them to hooks. Admin only for changes.

   URLs: /workflows, /workflows/runs, /workflows/addons,
         /workflows/run/<id>, /workflows/trace/<recording|vod_asset>/<id>
   ========================================================================== */

// ---------------------------------------------------------------- vocabulary
const RUN_STATE: Record<AddonRunState, { label: string; cls: string }> = {
  queued: { label: 'Queued', cls: 'idle' },
  dispatched: { label: 'Sent', cls: 'sched' },
  running: { label: 'Running', cls: 'sched' },
  succeeded: { label: 'Done', cls: 'live' },
  failed: { label: 'Failed', cls: 'down' },
  cancelled: { label: 'Cancelled', cls: 'idle' },
  timed_out: { label: 'Timed out', cls: 'warn' },
}
const OPEN: AddonRunState[] = ['queued', 'dispatched', 'running']
const isOpen = (s: AddonRunState) => OPEN.includes(s)

const CAT_LABEL: Record<AddonCategory, string> = {
  ai_agent: 'AI agent', transcription: 'Transcription', qc: 'Quality control',
  metadata: 'Metadata', distribution: 'Distribution', other: 'Other',
}
const SUBJECT_LABEL: Record<string, string> = { recording: 'Recording', vod_asset: 'Asset', channel: 'Channel', event: 'Event' }

const sv = { fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }
const CAT_ICON: Record<AddonCategory, ReactElement> = {
  ai_agent: <svg viewBox="0 0 24 24" {...sv}><path d="M12 3l1.9 4.6L18.5 9.5l-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9z" /><path d="M19 15l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z" /></svg>,
  transcription: <svg viewBox="0 0 24 24" {...sv}><path d="M4 6h16M4 10h12M4 14h16M4 18h9" /></svg>,
  qc: <svg viewBox="0 0 24 24" {...sv}><path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z" /><path d="M9 12l2 2 4-4" /></svg>,
  metadata: <svg viewBox="0 0 24 24" {...sv}><path d="M3 12V4h8l10 10-8 8z" /><circle cx="7.5" cy="7.5" r="1.5" /></svg>,
  distribution: <svg viewBox="0 0 24 24" {...sv}><path d="M22 2L11 13" /><path d="M22 2l-7 20-4-9-9-4z" /></svg>,
  other: <svg viewBox="0 0 24 24" {...sv}><path d="M9 3h6v4a2 2 0 104 0h2v6h-4a2 2 0 100 4h4v4H3V3h4a2 2 0 104 0z" /></svg>,
}

const fmtTime = (iso: string | null | undefined) => iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : ''
/** On the map the stage already says what the hook is about, so the port shows the verb. */
const shortHook = (id: string) => { const v = id.split('.').pop() ?? id; return v.charAt(0).toUpperCase() + v.slice(1) }
const fmtWhen = (iso: string | null | undefined) => {
  if (!iso) return ''
  const d = new Date(iso); const s = (Date.now() - d.getTime()) / 1000
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return d.toLocaleDateString([], { day: '2-digit', month: 'short' })
}
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`
const elapsed = (r: AddonRun) => {
  const end = r.finished_at ? new Date(r.finished_at).getTime() : Date.now()
  const s = Math.max(0, Math.round((end - new Date(r.created_at).getTime()) / 1000))
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}

function RunPill({ state }: { state: AddonRunState }) {
  const m = RUN_STATE[state]
  return <span className={`tag ${m.cls}`}><span className={`dot-s ${m.cls}`} />{m.label}</span>
}

/** Visible only while the tab is: a hidden console should not poll. */
function usePoll(fn: () => void, ms: number, deps: unknown[]) {
  const ref = useRef(fn); ref.current = fn
  useEffect(() => {
    ref.current()
    const t = setInterval(() => { if (document.visibilityState === 'visible') ref.current() }, ms)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
}

// ===================================================================== page
type Tab = 'map' | 'runs' | 'addons'

export default function WorkflowsPage({ canManage }: { canManage: boolean }) {
  const route = useRoute()
  const parts = route.path.replace(/^\/+|\/+$/g, '').split('/')
  const tab: Tab = parts[1] === 'runs' ? 'runs' : parts[1] === 'addons' ? 'addons' : 'map'
  const runParam = parts[1] === 'run' ? parts[2] : null
  const traceParam = parts[1] === 'trace' && parts[2] && parts[3] ? { type: parts[2], id: parts[3] } : null

  const [map, setMap] = useState<WorkflowMap | null>(null)
  const [runs, setRuns] = useState<AddonRun[]>([])
  const [events, setEvents] = useState<WorkflowEvent[]>([])
  const [err, setErr] = useState('')
  const [openRun, setOpenRun] = useState<string | null>(runParam)
  const [trace, setTrace] = useState<WorkflowTrace | null>(null)
  const [traceKey, setTraceKey] = useState<{ type: string; id: string } | null>(traceParam)
  const [hookSel, setHookSel] = useState<string | null>(null)

  useEffect(() => { if (runParam) setOpenRun(runParam) }, [runParam])
  useEffect(() => { if (traceParam) setTraceKey(traceParam) }, [traceParam?.type, traceParam?.id])

  usePoll(() => {
    api.workflowMap().then(setMap).catch(e => setErr(e.message))
    api.workflowRuns({ limit: 60 }).then(r => setRuns(r.runs)).catch(() => {})
    api.workflowEvents(30).then(r => setEvents(r.events)).catch(() => {})
  }, 4000, [])

  usePoll(() => {
    if (!traceKey) { setTrace(null); return }
    api.workflowTrace(traceKey.type, traceKey.id).then(setTrace).catch(e => { setErr(e.message); setTraceKey(null) })
  }, 4000, [traceKey?.type, traceKey?.id])

  const go = (t: Tab) => navigate(t === 'map' ? '/workflows' : `/workflows/${t}`)
  const openRuns = runs.filter(r => isOpen(r.state))
  const counts = useMemo(() => {
    const day = Date.now() - 86_400_000
    const recent = runs.filter(r => new Date(r.created_at).getTime() > day)
    return {
      open: openRuns.length,
      ok: recent.filter(r => r.state === 'succeeded').length,
      bad: recent.filter(r => r.state === 'failed' || r.state === 'timed_out').length,
      fired: map?.hooks.reduce((n, h) => n + h.fired24h, 0) ?? 0,
    }
  }, [runs, map])

  function traceRun(r: AddonRun) {
    setTraceKey({ type: r.subject_type, id: r.subject_id })
    navigate(`/workflows/trace/${r.subject_type}/${r.subject_id}`)
  }

  return (
    <>
      <PageHead title="Workflows"
        sub="The pipeline every channel, recording and file follows, the hooks where add-on services attach, and where each piece of work is right now."
        action={canManage ? <button className="btn primary" onClick={() => go('addons')}>Add-on services</button> : undefined} />
      {err && <div className="err" style={{ marginBottom: 10 }}>{err}</div>}

      <div className="stats wf-stats">
        <Stat label="Running now" value={counts.open} tone={counts.open ? 'sched' : undefined} />
        <Stat label="Completed, 24h" value={counts.ok} tone={counts.ok ? 'live' : undefined} />
        <Stat label="Failed or timed out, 24h" value={counts.bad} tone={counts.bad ? 'down' : undefined} />
        <Stat label="Hooks fired, 24h" value={counts.fired} />
      </div>

      <div className="pill-row" style={{ marginBottom: 14 }}>
        {([['map', 'Map'], ['runs', 'Runs'], ['addons', 'Add-ons and triggers']] as const).map(([k, l]) => (
          <button key={k} className={`chip ${tab === k ? 'active' : ''}`} onClick={() => go(k)}>
            {l}{k === 'runs' && counts.open > 0 && <span className="ct">{counts.open}</span>}
          </button>
        ))}
      </div>

      {tab === 'map' && (
        <>
          {trace && (
            <div className="wf-tracebar">
              <span className="wf-tracedot" />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 650 }}>Tracing {SUBJECT_LABEL[trace.subject.type]?.toLowerCase()}: {trace.subject.title}</div>
                <div className="hintxt">{trace.events.length} stage event{trace.events.length === 1 ? '' : 's'} · {trace.runs.length} add-on run{trace.runs.length === 1 ? '' : 's'}. Lit stages are where it has been, the outlined stage is where it is now.</div>
              </div>
              <span style={{ flex: 1 }} />
              {trace.subject.type === 'recording' && <button className="btn ghost" onClick={() => navigate(`/recordings/${trace.subject.id}`)}>Open recording</button>}
              <button className="btn ghost" onClick={() => { setTraceKey(null); navigate('/workflows') }}>Clear trace</button>
            </div>
          )}
          {!map ? <div className="loading">Loading the workflow…</div>
            : <PipelineMap map={map} runs={runs} trace={trace} hookSel={hookSel} onHook={setHookSel} onRun={id => setOpenRun(id)} />}

          {hookSel && map && (
            <HookPanel hook={map.hooks.find(h => h.id === hookSel)!} stage={map.stages.find(s => s.id === map.hooks.find(h => h.id === hookSel)?.stage)}
              canManage={canManage} onClose={() => setHookSel(null)} onChanged={() => api.workflowMap().then(setMap)} />
          )}

          <div className="wf-cols">
            <div>
              <div className="sec-label">In flight</div>
              {openRuns.length === 0
                ? <div className="card wf-quiet">Nothing running. Send a recording to an add-on from its page, or attach one to a hook and it will start here on its own.</div>
                : <div className="wf-runcards">{openRuns.map(r => <RunCard key={r.id} r={r} onOpen={() => setOpenRun(r.id)} onTrace={() => traceRun(r)} />)}</div>}
              <div className="sec-label">Recently finished</div>
              <div className="card" style={{ padding: 0 }}>
                {runs.filter(r => !isOpen(r.state)).slice(0, 8).map((r, i) => (
                  <div key={r.id} className="wf-row" style={{ borderTop: i ? '1px solid var(--border)' : undefined }} {...pressable(() => setOpenRun(r.id))} data-a11y-click="">
                    <span className="wf-catic sm">{CAT_ICON[r.category]}</span>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div className="wf-ellip"><b>{r.addon_name}</b> <span style={{ color: 'var(--muted)' }}>on {r.subject_title ?? SUBJECT_LABEL[r.subject_type]}</span></div>
                      <div className="hintxt">{r.hook === 'manual' ? 'Sent by hand' : `On ${r.hook}`} · {elapsed(r)} · {fmtWhen(r.finished_at)}</div>
                    </div>
                    <RunPill state={r.state} />
                  </div>
                ))}
                {runs.filter(r => !isOpen(r.state)).length === 0 && <div className="wf-quiet">No finished runs yet.</div>}
              </div>
            </div>
            <div>
              <div className="sec-label">Stage activity</div>
              <div className="card" style={{ padding: '4px 14px' }}>
                <div className="log" style={{ maxHeight: 520 }}>
                  {events.length === 0 && <div className="wf-quiet" style={{ padding: '14px 0' }}>No hooks have fired yet. They appear here as streams start and stop, recordings close, clips are cut and reviewed.</div>}
                  {events.map(e => {
                    const h = map?.hooks.find(x => x.id === e.hook)
                    const traceable = e.subject_type === 'recording' || e.subject_type === 'vod_asset'
                    return (
                      <div key={e.id} className="logrow">
                        <span className="ts">{fmtTime(e.created_at)}</span>
                        <span className="ic" style={{ background: 'var(--sched)' }} />
                        <span className="tx" style={{ minWidth: 0 }}>
                          {h?.label ?? e.hook}
                          <small className="wf-ellip">{SUBJECT_LABEL[e.subject_type]}: {e.title ?? e.subject_id.slice(0, 8)}
                            {traceable && <> · <span className="wf-link" {...pressable(() => { setTraceKey({ type: e.subject_type, id: e.subject_id }); navigate(`/workflows/trace/${e.subject_type}/${e.subject_id}`); window.scrollTo({ top: 0, behavior: 'smooth' }) })} data-a11y-click="">trace</span></>}
                          </small>
                        </span>
                      </div>
                    )
                  })}
                </div>
              </div>
            </div>
          </div>
        </>
      )}

      {tab === 'runs' && <RunsView runs={runs} onOpen={setOpenRun} onTrace={traceRun} />}
      {tab === 'addons' && <AddonsView canManage={canManage} map={map} onChanged={() => api.workflowMap().then(setMap)} />}

      {openRun && <RunDrawer id={openRun} onClose={() => { setOpenRun(null); if (runParam) navigate('/workflows/runs', { replace: true }) }}
        onTrace={r => { setOpenRun(null); traceRun(r) }} />}
    </>
  )
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className="card stat">
      <div className="lbl">{label}</div>
      <div className="val" style={tone ? { color: `var(--${tone})` } : undefined}>{value}</div>
    </div>
  )
}

// ================================================================ the map
const NODE_H = 50
const PORT_H = 24
const CHIP_H = 24
const LANE_TOP = 34      // room for the lane label above the nodes
const LANE_PAD = 16
const MAP_X = 14

interface Placed { stage: WorkflowStage; x: number; y: number; hooks: WorkflowHook[] }

/** Column width follows the card, within limits: wide screens get roomy nodes,
 *  narrow ones scroll sideways rather than squashing labels. */
function layout(map: WorkflowMap, avail: number) {
  const cols = Math.max(...map.stages.map(s => s.col)) + 1
  const COL_W = Math.round(Math.min(178, Math.max(136, (avail - MAP_X * 2) / cols)))
  const NODE_W = COL_W - 18
  const laneY: Record<string, number> = {}
  const laneH: Record<string, number> = {}
  let y = 0
  for (const lane of map.lanes) {
    const stages = map.stages.filter(s => s.lane === lane.id)
    let tallest = NODE_H
    for (const s of stages) {
      const hooks = map.hooks.filter(h => h.stage === s.id)
      const h = NODE_H + 8 + hooks.reduce((n, hk) => n + PORT_H + 4 + hk.triggers.length * (CHIP_H + 4), 0)
      tallest = Math.max(tallest, h)
    }
    laneY[lane.id] = y
    laneH[lane.id] = tallest + LANE_TOP + LANE_PAD
    y += laneH[lane.id]
  }
  const placed: Record<string, Placed> = {}
  for (const s of map.stages) {
    placed[s.id] = { stage: s, x: MAP_X + s.col * COL_W, y: laneY[s.lane] + LANE_TOP, hooks: map.hooks.filter(h => h.stage === s.id) }
  }
  return { placed, laneY, laneH, width: MAP_X * 2 + cols * COL_W - 18, height: y, NODE_W }
}

/** Every stage upstream of `id` along the edges. */
function ancestors(edges: [string, string][], id: string, seen = new Set<string>()): Set<string> {
  for (const [a, b] of edges) if (b === id && !seen.has(a)) { seen.add(a); ancestors(edges, a, seen) }
  return seen
}

function PipelineMap({ map, runs, trace, hookSel, onHook, onRun }: {
  map: WorkflowMap; runs: AddonRun[]; trace: WorkflowTrace | null
  hookSel: string | null; onHook: (id: string | null) => void; onRun: (id: string) => void
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [avail, setAvail] = useState(1400)
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setAvail(el.clientWidth))
    ro.observe(el); setAvail(el.clientWidth)
    return () => ro.disconnect()
  }, [])
  const L = useMemo(() => layout(map, avail), [map, avail])
  const NODE_W = L.NODE_W

  // Trace state per stage: done (a hook fired), implied (upstream of one), current (latest).
  const traceState = useMemo(() => {
    if (!trace) return null
    const st: Record<string, 'done' | 'implied' | 'current'> = {}
    const fired = trace.events.map(e => map.hooks.find(h => h.id === e.hook)?.stage).filter(Boolean) as string[]
    for (const s of fired) for (const a of ancestors(map.edges, s)) st[a] = 'implied'
    for (const s of fired) st[s] = 'done'
    const last = fired[fired.length - 1]
    if (last) st[last] = 'current'
    return st
  }, [trace, map])

  const runsByTrigger = useMemo(() => {
    const m: Record<string, AddonRun[]> = {}
    for (const r of (trace ? trace.runs : runs)) if (r.trigger_id) (m[r.trigger_id] ||= []).push(r)
    return m
  }, [runs, trace])
  const manualTraceRuns = trace ? trace.runs.filter(r => !r.trigger_id) : []

  const edgePath = (a: Placed, b: Placed) => {
    const x1 = a.x + NODE_W, y1 = a.y + NODE_H / 2
    const x2 = b.x, y2 = b.y + NODE_H / 2
    const dx = Math.max(24, (x2 - x1) / 2)
    // Same lane but skipping a stage (package -> record jumps deliver): dip
    // under the stage in between instead of drawing straight through it.
    if (a.stage.lane === b.stage.lane && b.stage.col - a.stage.col > 1) {
      const dip = NODE_H * 1.25
      return `M${x1},${y1} C${x1 + 30},${y1 + dip} ${x2 - 30},${y2 + dip} ${x2},${y2}`
    }
    return `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`
  }

  return (
    <div className="card wf-mapcard">
      <div className="wf-mapscroll" ref={scrollRef}>
        <div className="wf-map" style={{ width: L.width, height: L.height }}>
          {map.lanes.map((lane, i) => (
            <div key={lane.id} className="wf-lane" style={{ top: L.laneY[lane.id], height: L.laneH[lane.id], background: i % 2 ? 'rgba(255,255,255,.012)' : 'transparent' }}>
              <div className="wf-lanelabel" title={lane.description}>{lane.label}</div>
            </div>
          ))}
          <svg className="wf-edges" width={L.width} height={L.height}>
            <defs>
              <marker id="wf-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0,0 L8,4 L0,8 z" fill="currentColor" />
              </marker>
            </defs>
            {map.edges.map(([a, b]) => {
              const on = traceState && traceState[a] && traceState[b]
              return <path key={a + b} d={edgePath(L.placed[a], L.placed[b])} className={`wf-edge ${on ? 'on' : ''} ${traceState && !on ? 'dim' : ''}`} markerEnd="url(#wf-arrow)" />
            })}
          </svg>
          {Object.values(L.placed).map(p => {
            const ts = traceState?.[p.stage.id]
            let cursorY = p.y + NODE_H + 8
            return (
              <div key={p.stage.id}>
                <div className={`wf-node ${ts ?? ''} ${traceState && !ts ? 'dim' : ''}`} style={{ left: p.x, top: p.y, width: NODE_W, height: NODE_H }} title={`${p.stage.description}\n\n${p.stage.impl}`}>
                  <div className="wf-nodelabel">{ts === 'done' || ts === 'implied' ? '✓ ' : ''}{p.stage.label}</div>
                  <div className="wf-nodesub">{ts === 'current' ? 'Here now' : p.hooks.length ? plural(p.hooks.reduce((n, h) => n + h.fired24h, 0), 'event') + ' · 24h' : 'no hooks'}</div>
                </div>
                {p.hooks.map(h => {
                  const top = cursorY
                  cursorY += PORT_H + 4
                  const chips = h.triggers.map(t => {
                    const chipTop = cursorY
                    cursorY += CHIP_H + 4
                    const tr = runsByTrigger[t.id] ?? []
                    const open = tr.filter(r => isOpen(r.state))
                    const failed = tr.filter(r => r.state === 'failed' || r.state === 'timed_out')
                    const latest = tr[0]
                    const tracedRun = trace ? tr[tr.length - 1] : null
                    return (
                      <div key={t.id} className={`wf-chip ${!t.enabled || !t.addon_enabled ? 'off' : ''}`} style={{ left: p.x + 10, top: chipTop, width: NODE_W + 4 }}
                        title={`${t.addon_name} (${CAT_LABEL[t.category]})${!t.enabled ? ' · trigger off' : ''}`}
                        {...pressable(() => { const r = tracedRun ?? latest; if (r) onRun(r.id); else onHook(h.id) })} data-a11y-click="">
                        <span className="wf-catic xs">{CAT_ICON[t.category]}</span>
                        <span className="wf-ellip" style={{ flex: 1 }}>{t.addon_name}</span>
                        {tracedRun ? <span className={`wf-mini ${RUN_STATE[tracedRun.state].cls}`}>{isOpen(tracedRun.state) ? `${tracedRun.progress_pct}%` : RUN_STATE[tracedRun.state].label}</span>
                          : <>{open.length > 0 && <span className="wf-mini sched">{open.length}</span>}{failed.length > 0 && <span className="wf-mini down">{failed.length}</span>}</>}
                      </div>
                    )
                  })
                  return (
                    <div key={h.id}>
                      <svg className="wf-stub" style={{ left: p.x + 4, top: top - 8, height: cursorY - top + 4 }} width="8">
                        <path d={`M4,0 V${cursorY - top - 10}`} />
                      </svg>
                      <div className={`wf-port ${h.live ? '' : 'planned'} ${hookSel === h.id ? 'sel' : ''}`} style={{ left: p.x + 10, top, width: NODE_W + 4, height: PORT_H }}
                        title={`${h.id}\n${h.description}${h.live ? '' : '\n(planned: not fired yet)'}`}
                        {...pressable(() => onHook(hookSel === h.id ? null : h.id))} data-a11y-click="">
                        <span className={`wf-portdot ${h.fired24h ? 'on' : ''}`} />
                        <span className="wf-ellip">{shortHook(h.id)}</span>
                      </div>
                      {chips}
                    </div>
                  )
                })}
              </div>
            )
          })}
        </div>
      </div>
      <div className="wf-legend">
        <span><span className="wf-portdot on" /> hook fired in the last 24h</span>
        <span><span className="wf-swatch" /> add-on attached to a hook (click for its latest run)</span>
        <span><span className="wf-swatch planned" /> planned hook, not fired yet</span>
        <span><span className="wf-mini sched">2</span> running</span>
        <span><span className="wf-mini down">1</span> failed, 24h</span>
        <span>Click a hook to see what it carries and attach an add-on.</span>
        {manualTraceRuns.length > 0 && <span style={{ marginLeft: 'auto' }}>Sent by hand: {manualTraceRuns.map(r => (
          <span key={r.id} className="wf-link" style={{ marginLeft: 6 }} {...pressable(() => onRun(r.id))} data-a11y-click="">{r.addon_name} ({isOpen(r.state) ? `${r.progress_pct}%` : RUN_STATE[r.state].label.toLowerCase()})</span>
        ))}</span>}
      </div>
    </div>
  )
}

// ============================================================== hook panel
function HookPanel({ hook, stage, canManage, onClose, onChanged }: {
  hook: WorkflowHook; stage?: WorkflowStage; canManage: boolean; onClose: () => void; onChanged: () => void
}) {
  const [addons, setAddons] = useState<AddonService[] | null>(null)
  const [channels, setChannels] = useState<Channel[]>([])
  const [addonId, setAddonId] = useState('')
  const [scope, setScope] = useState<string[]>([])
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const hookSubjects = hook.id.startsWith('stream.') ? ['channel', 'event'] : [hook.subject]

  useEffect(() => {
    api.addons().then(r => setAddons(r.addons)).catch(() => setAddons([]))
    api.channels().then(setChannels).catch(() => {})
  }, [hook.id])

  const eligible = (addons ?? []).filter(a => a.accepts.some(t => hookSubjects.includes(t)))

  async function attach() {
    if (!addonId) return
    setBusy(true); setErr('')
    try {
      await api.createAddonTrigger({ addonId, hook: hook.id, filter: scope.length ? { channelIds: scope } : {} })
      setAddonId(''); setScope([]); onChanged()
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }
  async function toggle(id: string, enabled: boolean) {
    try { await api.updateAddonTrigger(id, { enabled }); onChanged() } catch (e: any) { setErr(e.message) }
  }
  async function remove(id: string) {
    try { await api.deleteAddonTrigger(id); onChanged() } catch (e: any) { setErr(e.message) }
  }

  return (
    <div className="card wf-hookpanel">
      <div className="card-h">
        <h3>{hook.label}</h3>
        <span className="tag type">{stage?.label ?? hook.stage}</span>
        {!hook.live && <span className="tag warn">Planned</span>}
        <span className="spacer" />
        <button className="xbtn" onClick={onClose} aria-label="Close">✕</button>
      </div>
      <div className="card-b">
        <p style={{ margin: '0 0 10px', color: 'var(--muted)' }}>{hook.description}</p>
        <div style={{ display: 'flex', gap: '6px 18px', flexWrap: 'wrap', fontSize: 'var(--fs-sm)', color: 'var(--muted)', marginBottom: 12 }}>
          <span>Hook id <code className="wf-code">{hook.id}</code></span>
          <span>About a {hookSubjects.map(s => SUBJECT_LABEL[s].toLowerCase()).join(' or ')}</span>
          <span>Fired {hook.fired24h} time{hook.fired24h === 1 ? '' : 's'} in 24h{hook.lastFiredAt ? `, last ${fmtWhen(hook.lastFiredAt)}` : ''}</span>
        </div>

        <div className="sec-label" style={{ marginTop: 6 }}>Attached add-ons</div>
        {hook.triggers.length === 0 && <div className="hintxt" style={{ marginBottom: 10 }}>Nothing attached. When this hook fires, the base workflow simply carries on.</div>}
        {hook.triggers.map(t => (
          <div key={t.id} className="wf-row" style={{ padding: '8px 0' }}>
            <span className="wf-catic sm">{CAT_ICON[t.category]}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div><b>{t.addon_name}</b>{!t.addon_enabled && <span className="nt-pill">add-on off</span>}</div>
              <div className="hintxt">{t.filter?.channelIds?.length ? `Only ${t.filter.channelIds.map((id: string) => channels.find(c => c.id === id)?.name ?? id.slice(0, 8)).join(', ')}` : 'Every channel and event in the account'}</div>
            </div>
            {canManage && <>
              <div className={`switch ${t.enabled ? '' : 'off'}`} style={{ transform: 'scale(.7)' }} {...pressable(() => toggle(t.id, !t.enabled))} role="switch" aria-checked={t.enabled} data-a11y-click=""><i /></div>
              <button className="btn ghost" onClick={() => remove(t.id)}>Detach</button>
            </>}
          </div>
        ))}

        {canManage && hook.live && (
          <>
            <div className="sec-label">Attach an add-on</div>
            {addons && eligible.length === 0
              ? <div className="hintxt">No add-on accepts a {hookSubjects.map(s => SUBJECT_LABEL[s].toLowerCase()).join(' or ')} yet. Create one under Add-ons and triggers.</div>
              : (
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-start' }}>
                  <select value={addonId} onChange={e => setAddonId(e.target.value)} style={{ minWidth: 220 }}>
                    <option value="">Choose an add-on…</option>
                    {eligible.map(a => <option key={a.id} value={a.id}>{a.name}{a.kind === 'demo' ? ' (demo)' : ''}</option>)}
                  </select>
                  <select multiple value={scope} onChange={e => setScope(Array.from(e.target.selectedOptions).map(o => o.value))} style={{ minWidth: 220, height: 74 }} title="Leave empty for every channel">
                    {channels.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                  <button className="btn primary" disabled={!addonId || busy} onClick={attach}>{busy ? 'Attaching…' : 'Attach'}</button>
                  <div className="hintxt" style={{ flexBasis: '100%' }}>Select channels to limit it (Ctrl or Cmd to pick several). Leave the list empty and it runs for every channel and event.</div>
                </div>
              )}
          </>
        )}
        {err && <div className="err">{err}</div>}
      </div>
    </div>
  )
}

// ============================================================== run views
function StepTrack({ r }: { r: AddonRun }) {
  const steps = r.steps?.length ? r.steps : []
  if (!steps.length) return null
  const cur = r.step ? steps.indexOf(r.step) : -1
  const done = r.state === 'succeeded'
  return (
    <div className="wf-steps">
      {steps.map((s, i) => {
        const st = done || (cur >= 0 && i < cur) ? 'done' : i === cur && isOpen(r.state) ? 'cur' : i === cur && (r.state === 'failed' || r.state === 'timed_out') ? 'bad' : ''
        return (
          <div key={s} className={`wf-step ${st}`} title={s}>
            <span className="wf-stepdot">{st === 'done' ? '✓' : i + 1}</span>
            <span className="wf-ellip">{s}</span>
          </div>
        )
      })}
    </div>
  )
}

function Progress({ r }: { r: AddonRun }) {
  const cls = RUN_STATE[r.state].cls
  return (
    <div className="wf-bar"><div className={`wf-fill ${cls} ${isOpen(r.state) ? 'anim' : ''}`} style={{ width: `${Math.max(r.progress_pct, isOpen(r.state) ? 4 : 0)}%` }} /></div>
  )
}

function RunCard({ r, onOpen, onTrace }: { r: AddonRun; onOpen: () => void; onTrace: () => void }) {
  return (
    <div className="card wf-runcard" {...pressable(onOpen)} data-a11y-click="">
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <span className="wf-catic">{CAT_ICON[r.category]}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="wf-ellip" style={{ fontWeight: 650 }}>{r.addon_name}</div>
          <div className="hintxt wf-ellip">{SUBJECT_LABEL[r.subject_type]}: {r.subject_title ?? r.subject_id.slice(0, 8)}</div>
        </div>
        <RunPill state={r.state} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--fs-sm)', margin: '10px 0 6px', color: 'var(--muted)' }}>
        <span className="wf-ellip">{r.step ?? (r.state === 'queued' ? 'Waiting to send' : r.state === 'dispatched' ? 'Accepted, waiting for progress' : '')}</span>
        <span className="mono">{r.progress_pct}% · {elapsed(r)}</span>
      </div>
      <Progress r={r} />
      <StepTrack r={r} />
      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <span className="hintxt" style={{ flex: 1 }}>{r.hook === 'manual' ? 'Sent by hand' : `On ${r.hook}`}{r.external_ref ? ` · ref ${r.external_ref}` : ''}</span>
        {(r.subject_type === 'recording' || r.subject_type === 'vod_asset') &&
          <span className="wf-link" {...pressable((e: any) => { e?.stopPropagation?.(); onTrace() })} data-a11y-click="">Show on map</span>}
      </div>
    </div>
  )
}

function RunsView({ runs, onOpen, onTrace }: { runs: AddonRun[]; onOpen: (id: string) => void; onTrace: (r: AddonRun) => void }) {
  const [f, setF] = useState<'all' | 'open' | 'succeeded' | 'problem'>('all')
  const shown = runs.filter(r => f === 'all' ? true : f === 'open' ? isOpen(r.state) : f === 'succeeded' ? r.state === 'succeeded' : ['failed', 'timed_out', 'cancelled'].includes(r.state))
  const n = (k: typeof f) => runs.filter(r => k === 'all' ? true : k === 'open' ? isOpen(r.state) : k === 'succeeded' ? r.state === 'succeeded' : ['failed', 'timed_out', 'cancelled'].includes(r.state)).length
  return (
    <>
      <div className="pill-row" style={{ marginBottom: 12 }}>
        {([['all', 'All'], ['open', 'In flight'], ['succeeded', 'Done'], ['problem', 'Failed, timed out, cancelled']] as const).map(([k, l]) => (
          <button key={k} className={`chip ${f === k ? 'active' : ''}`} onClick={() => setF(k)}>{l} <span className="ct">{n(k)}</span></button>
        ))}
      </div>
      <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
        <table>
          <thead><tr><th>Add-on</th><th>About</th><th>Started by</th><th>Progress</th><th>State</th><th>When</th><th></th></tr></thead>
          <tbody>
            {shown.map(r => (
              <tr key={r.id} style={{ cursor: 'pointer' }} {...pressable(() => onOpen(r.id))} data-a11y-click="">
                <td><div style={{ display: 'flex', gap: 8, alignItems: 'center' }}><span className="wf-catic sm">{CAT_ICON[r.category]}</span><b>{r.addon_name}</b></div></td>
                <td><div className="wf-ellip" style={{ maxWidth: 260 }}>{r.subject_title ?? r.subject_id.slice(0, 8)}</div><div className="hintxt">{SUBJECT_LABEL[r.subject_type]}</div></td>
                <td style={{ color: 'var(--muted)' }}>{r.hook === 'manual' ? 'By hand' : r.hook}</td>
                <td style={{ minWidth: 160 }}><div className="hintxt wf-ellip" style={{ marginBottom: 4 }}>{r.step ?? ''}</div><Progress r={r} /></td>
                <td><RunPill state={r.state} />{r.error && <div className="hintxt wf-ellip" style={{ maxWidth: 220, color: 'var(--down)' }}>{r.error}</div>}</td>
                <td className="mono" style={{ color: 'var(--muted)', whiteSpace: 'nowrap' }}>{fmtWhen(r.created_at)} · {elapsed(r)}</td>
                <td style={{ textAlign: 'right' }}>{(r.subject_type === 'recording' || r.subject_type === 'vod_asset') &&
                  <span className="wf-link" {...pressable((e: any) => { e?.stopPropagation?.(); onTrace(r) })} data-a11y-click="">Map</span>}</td>
              </tr>
            ))}
            {shown.length === 0 && <tr><td colSpan={7}><div className="wf-quiet">No runs here.</div></td></tr>}
          </tbody>
        </table>
      </div>
    </>
  )
}

function RunDrawer({ id, onClose, onTrace }: { id: string; onClose: () => void; onTrace: (r: AddonRun) => void }) {
  const [run, setRun] = useState<AddonRunDetail | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  usePoll(() => { api.workflowRun(id).then(setRun).catch(e => setErr(e.message)) }, 2500, [id])

  async function act(fn: () => Promise<any>) {
    setBusy(true); setErr('')
    try { await fn(); api.workflowRun(id).then(setRun) } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }

  return (
    <div className="drawer-scrim" {...pressable(onClose)} data-a11y-click="">
      <div className="drawer" {...pressable((e: any) => e.stopPropagation())} data-a11y-click="">
        <div className="drawer-h"><div className="t">Add-on run</div><button className="xbtn" onClick={onClose}>✕</button></div>
        <div className="drawer-b">
          {!run ? <div className="loading">{err || 'Loading…'}</div> : (
            <>
              <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 6 }}>
                <span className="wf-catic lg">{CAT_ICON[run.category]}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 'var(--fs-h2)' }}>{run.addon_name}</div>
                  <div className="hintxt">{CAT_LABEL[run.category]}{run.addon_kind === 'demo' ? ' · built-in demo (simulated)' : ''}</div>
                </div>
                <RunPill state={run.state} />
              </div>
              <div className="wf-kv">
                <span>About</span><b className="wf-ellip">{SUBJECT_LABEL[run.subject_type]}: {run.subject_title ?? run.subject_id}</b>
                <span>Started by</span><b>{run.hook === 'manual' ? 'Sent by hand' : `Hook ${run.hook}`}</b>
                <span>Started</span><b>{new Date(run.created_at).toLocaleString()}</b>
                <span>Elapsed</span><b>{elapsed(run)}</b>
                {run.external_ref && <><span>Vendor ref</span><b><code className="wf-code">{run.external_ref}</code></b></>}
                {isOpen(run.state) && <><span>Deadline</span><b>{new Date(run.deadline_at).toLocaleString()}</b></>}
              </div>

              <div className="sec-label">Progress</div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--fs-sm)', color: 'var(--muted)', marginBottom: 6 }}>
                <span>{run.step ?? '…'}</span><span className="mono">{run.progress_pct}%</span>
              </div>
              <Progress r={run} />
              <StepTrack r={run} />
              {run.error && <div className="err" style={{ marginTop: 10 }}>{run.error}</div>}

              {run.result != null && (
                <>
                  <div className="sec-label">Result</div>
                  {typeof run.result?.summary === 'string' && <p style={{ margin: '0 0 8px' }}>{run.result.summary}</p>}
                  {Array.isArray(run.result?.chapters) && (
                    <div style={{ marginBottom: 8 }}>
                      {run.result.chapters.map((c: any, i: number) => (
                        <div key={i} className="wf-row" style={{ padding: '4px 0' }}>
                          <span className="mono" style={{ color: 'var(--faint)', width: 64 }}>{fmtMs(c.atMs)}</span><span>{c.title}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  <details><summary className="hintxt" style={{ cursor: 'pointer' }}>Raw result</summary>
                    <pre className="wf-pre">{JSON.stringify(run.result, null, 2)}</pre>
                  </details>
                </>
              )}

              <div className="sec-label">Event log</div>
              <div className="log" style={{ maxHeight: 280 }}>
                {run.events.map(e => (
                  <div key={e.id} className="logrow">
                    <span className="ts">{fmtTime(e.ts)}</span>
                    <span className="ic" style={{ background: e.type === 'error' ? 'var(--down)' : e.type === 'state' ? 'var(--sched)' : 'var(--idle)' }} />
                    <span className="tx">{e.message ?? (e.step ? `${e.step}${e.progress_pct != null ? ` · ${e.progress_pct}%` : ''}` : e.type)}<small>{e.type}{e.state ? ` · ${e.state}` : ''}</small></span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
        {run && (
          <div className="drawer-f">
            {(run.subject_type === 'recording' || run.subject_type === 'vod_asset') && <button className="btn ghost" onClick={() => onTrace(run)}>Show on map</button>}
            <span style={{ flex: 1 }} />
            {err && <span className="drawer-f-err">{err}</span>}
            {isOpen(run.state)
              ? <button className="btn ghost" disabled={busy} onClick={() => act(() => api.cancelAddonRun(run.id))}>Cancel run</button>
              : <button className="btn primary" disabled={busy} onClick={() => act(() => api.retryAddonRun(run.id))}>Run again</button>}
          </div>
        )}
      </div>
    </div>
  )
}

const fmtMs = (ms: number) => { const s = Math.floor((ms || 0) / 1000); return `${Math.floor(s / 3600) ? Math.floor(s / 3600) + ':' : ''}${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` }

// ============================================================== add-ons
function AddonsView({ canManage, map, onChanged }: { canManage: boolean; map: WorkflowMap | null; onChanged: () => void }) {
  const [addons, setAddons] = useState<AddonService[] | null>(null)
  const [triggers, setTriggers] = useState<AddonTrigger[]>([])
  const [edit, setEdit] = useState<AddonService | 'new' | null>(null)
  const [secret, setSecret] = useState<{ name: string; secret: string } | null>(null)
  const [test, setTest] = useState<Record<string, string>>({})
  const [err, setErr] = useState('')

  const load = () => {
    api.addons().then(r => setAddons(r.addons)).catch(e => setErr(e.message))
    api.addonTriggers().then(r => setTriggers(r.triggers)).catch(() => {})
  }
  useEffect(load, [])

  async function runTest(a: AddonService) {
    setTest(t => ({ ...t, [a.id]: 'Sending a signed ping…' }))
    try { const r = await api.testAddon(a.id); setTest(t => ({ ...t, [a.id]: `${r.message}${r.status ? ` (${r.status}, ${r.ms} ms)` : ''}` })) }
    catch (e: any) { setTest(t => ({ ...t, [a.id]: e.message })) }
  }
  async function toggle(a: AddonService) {
    try { await api.updateAddon(a.id, { enabled: !a.enabled }); load(); onChanged() } catch (e: any) { setErr(e.message) }
  }
  async function rotate(a: AddonService) {
    try { const r = await api.rotateAddonSecret(a.id); setSecret({ name: a.name, secret: r.signingSecret }) } catch (e: any) { setErr(e.message) }
  }
  // Two presses, no browser dialog: deleting an add-on also deletes its run history.
  const [confirmDel, setConfirmDel] = useState<string | null>(null)
  async function remove(a: AddonService) {
    if (confirmDel !== a.id) { setConfirmDel(a.id); setTimeout(() => setConfirmDel(c => (c === a.id ? null : c)), 4000); return }
    try { await api.deleteAddon(a.id); setConfirmDel(null); load(); onChanged() } catch (e: any) { setErr(e.message) }
  }

  return (
    <>
      {err && <div className="err">{err}</div>}
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 10 }}>
        <div className="sec-label" style={{ margin: 0, flex: 1 }}>Add-on services</div>
        {canManage && <button className="btn primary" onClick={() => setEdit('new')}>New add-on</button>}
      </div>
      {!addons ? <div className="loading">Loading…</div> : addons.length === 0 ? (
        <div className="empty">
          <div className="ic">{CAT_ICON.ai_agent}</div>
          <h3>No add-on services yet</h3>
          <p>An add-on is an external platform Volt sends work to, such as an AI agent that summarises a recording, a transcription house, or a QC vendor. Volt sends it a signed request with links to the media and a callback URL, and shows its progress here.</p>
          {canManage && <button className="btn primary" onClick={() => setEdit('new')}>Create one, or start with the demo agent</button>}
        </div>
      ) : (
        <div className="wf-addongrid">
          {addons.map(a => (
            <div key={a.id} className={`card wf-addon ${a.enabled ? '' : 'off'}`}>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <span className="wf-catic">{CAT_ICON[a.category]}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 650 }} className="wf-ellip">{a.name}</div>
                  <div className="hintxt">{CAT_LABEL[a.category]} · {a.kind === 'demo' ? 'Built-in demo' : hostOf(a.endpoint_url)}</div>
                </div>
                {canManage && <div className={`switch ${a.enabled ? '' : 'off'}`} style={{ transform: 'scale(.7)' }} {...pressable(() => toggle(a))} role="switch" aria-checked={a.enabled} data-a11y-click=""><i /></div>}
              </div>
              {a.description && <p className="hintxt" style={{ margin: '8px 0 0' }}>{a.description}</p>}
              <div className="wf-addonmeta">
                <span>Accepts {a.accepts.map(t => SUBJECT_LABEL[t]?.toLowerCase() ?? t).join(', ')}</span>
                <span>{a.open_runs ?? 0} running</span>
                {(a.failed_24h ?? 0) > 0 && <span style={{ color: 'var(--down)' }}>{a.failed_24h} failed, 24h</span>}
                <span>Last run {a.last_run_at ? fmtWhen(a.last_run_at) : 'never'}</span>
                <span>Attached to {triggers.filter(t => t.addon_id === a.id).length} hook{triggers.filter(t => t.addon_id === a.id).length === 1 ? '' : 's'}</span>
              </div>
              {test[a.id] && <div className="hintxt" style={{ marginTop: 8, color: 'var(--text)' }}>{test[a.id]}</div>}
              {canManage && (
                <div style={{ display: 'flex', gap: 6, marginTop: 12, flexWrap: 'wrap' }}>
                  <button className="btn ghost" onClick={() => runTest(a)}>Test</button>
                  <button className="btn ghost" onClick={() => setEdit(a)}>Edit</button>
                  {a.kind === 'webhook' && <button className="btn ghost" onClick={() => rotate(a)}>New secret</button>}
                  <button className="btn ghost" style={confirmDel === a.id ? { color: 'var(--down)' } : undefined} onClick={() => remove(a)}>{confirmDel === a.id ? 'Delete it and its runs' : 'Delete'}</button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="sec-label">Triggers</div>
      <div className="card" style={{ padding: 0 }}>
        {triggers.length === 0 && <div className="wf-quiet">No triggers. Open the Map, click a hook, and attach an add-on to it.</div>}
        {triggers.map((t, i) => {
          const h = map?.hooks.find(x => x.id === t.hook)
          return (
            <div key={t.id} className="wf-row" style={{ borderTop: i ? '1px solid var(--border)' : undefined, padding: '10px 14px' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div>When <b>{h?.label ?? t.hook}</b> fires, run <b>{t.addon_name}</b></div>
                <div className="hintxt">{t.filter?.channelIds?.length ? `${t.filter.channelIds.length} channel${t.filter.channelIds.length === 1 ? '' : 's'} only` : 'Every channel and event'}{h && !h.live ? ' · this hook is planned and does not fire yet' : ''}</div>
              </div>
              <span className={`nt-pill ${t.enabled ? 'ok' : ''}`}>{t.enabled ? 'On' : 'Off'}</span>
              {canManage && <button className="btn ghost" onClick={async () => { try { await api.deleteAddonTrigger(t.id); load(); onChanged() } catch (e: any) { setErr(e.message) } }}>Detach</button>}
            </div>
          )
        })}
      </div>

      <div className="sec-label">For developers</div>
      <div className="card card-b hintxt" style={{ lineHeight: 1.6 }}>
        Volt POSTs <code className="wf-code">run.dispatch</code> to the endpoint, signed in <code className="wf-code">X-Volt-Signature</code> (HMAC SHA-256 of <code className="wf-code">timestamp.body</code> with the add-on's secret).
        The body carries the subject, media links, options and a per-run <code className="wf-code">callbackUrl</code> and <code className="wf-code">callbackToken</code>.
        The add-on reports back with <code className="wf-code">POST callbackUrl</code>, <code className="wf-code">Authorization: Bearer callbackToken</code> and
        {' '}<code className="wf-code">{'{ progress, step, state, result }'}</code>. Full contract in WORKFLOWS.md.
      </div>

      {edit && <AddonForm addon={edit === 'new' ? null : edit} onClose={() => setEdit(null)}
        onSaved={(s) => { setEdit(null); load(); onChanged(); if (s) setSecret(s) }} />}
      {secret && <SecretModal name={secret.name} secret={secret.secret} onClose={() => setSecret(null)} />}
    </>
  )
}

const hostOf = (u: string | null) => { try { return u ? new URL(u).host : '' } catch { return u ?? '' } }

function AddonForm({ addon, onClose, onSaved }: { addon: AddonService | null; onClose: () => void; onSaved: (secret?: { name: string; secret: string }) => void }) {
  const [name, setName] = useState(addon?.name ?? '')
  const [description, setDescription] = useState(addon?.description ?? '')
  const [category, setCategory] = useState<AddonCategory>(addon?.category ?? 'ai_agent')
  const [kind, setKind] = useState<'webhook' | 'demo'>(addon?.kind ?? 'webhook')
  const [endpoint, setEndpoint] = useState(addon?.endpoint_url ?? '')
  const [accepts, setAccepts] = useState<string[]>(addon?.accepts ?? ['recording', 'vod_asset'])
  const [steps, setSteps] = useState((addon?.steps ?? []).join(', '))
  const [timeoutMin, setTimeoutMin] = useState(String(Math.round((addon?.timeout_sec ?? 3600) / 60)))
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  async function save() {
    setBusy(true); setErr('')
    const body = {
      name: name.trim(), description: description.trim() || null, category, kind,
      endpointUrl: kind === 'webhook' ? endpoint.trim() : null, accepts,
      steps: steps.split(',').map(s => s.trim()).filter(Boolean),
      timeoutSec: Math.max(30, Math.round(Number(timeoutMin) * 60) || 3600),
    }
    try {
      if (addon) { await api.updateAddon(addon.id, body); onSaved() }
      else { const r = await api.createAddon(body); onSaved(kind === 'webhook' ? { name: r.name, secret: r.signingSecret } : undefined) }
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }

  return (
    <div className="drawer-scrim" {...pressable(onClose)} data-a11y-click="">
      <div className="drawer" {...pressable((e: any) => e.stopPropagation())} data-a11y-click="">
        <div className="drawer-h"><div className="t">{addon ? `Edit ${addon.name}` : 'New add-on service'}</div><button className="xbtn" onClick={onClose}>✕</button></div>
        <div className="drawer-b">
          <div className="field"><label>Type</label>
            <div className="choices">
              {([['webhook', 'External service', 'Volt sends a signed request to your endpoint and tracks the callbacks. Use this for a real AI agent, transcription or QC platform.'],
                 ['demo', 'Demo agent (simulated)', 'Runs inside Volt and walks through five steps in about fifteen seconds, returning a sample summary and chapters. For trying the workflow end to end.']] as const).map(([k, t, d]) => (
                <div key={k} className={`choice ${kind === k ? 'on' : ''}`} {...pressable(() => setKind(k), { pressed: kind === k })} data-a11y-click="">
                  <span className="radio" /><div><div className="t">{t}</div><div className="d">{d}</div></div>
                </div>
              ))}
            </div>
          </div>
          <div className="field"><label>Name</label><input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Newsroom AI summariser" /></div>
          <div className="field"><label>What it does</label><input value={description} onChange={e => setDescription(e.target.value)} placeholder="One line for operators" /></div>
          <div className="field"><label>Category</label>
            <div className="pill-row">
              {(Object.keys(CAT_LABEL) as AddonCategory[]).map(c => (
                <button key={c} className={`chip ${category === c ? 'active' : ''}`} onClick={() => setCategory(c)} style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                  <span className="wf-catic xs">{CAT_ICON[c]}</span>{CAT_LABEL[c]}
                </button>
              ))}
            </div>
          </div>
          {kind === 'webhook' && (
            <div className="field"><label>Endpoint URL</label><input value={endpoint} onChange={e => setEndpoint(e.target.value)} placeholder="https://agent.example.com/volt" />
              <div className="hintxt">Must be https. http is accepted for localhost while developing.</div></div>
          )}
          <div className="field"><label>Accepts</label>
            <div className="pill-row">
              {(['recording', 'vod_asset', 'channel', 'event'] as const).map(t => (
                <button key={t} className={`chip ${accepts.includes(t) ? 'active' : ''}`}
                  onClick={() => setAccepts(a => a.includes(t) ? a.filter(x => x !== t) : [...a, t])}>{SUBJECT_LABEL[t]}s</button>
              ))}
            </div>
            <div className="hintxt">What this service can work on. Recordings and assets can also be sent by hand from their pages.</div>
          </div>
          {kind === 'webhook' && (
            <div className="field"><label>Steps (optional)</label><input value={steps} onChange={e => setSteps(e.target.value)} placeholder="Fetch media, Transcribe, Summarise, Deliver" />
              <div className="hintxt">Shown as a step tracker. The service can also send its own list when it accepts the job.</div></div>
          )}
          <div className="field"><label>Give up after (minutes)</label><input type="number" min={1} value={timeoutMin} onChange={e => setTimeoutMin(e.target.value)} style={{ width: 120 }} />
            <div className="hintxt">A run with no outcome by then is marked timed out.</div></div>
        </div>
        <div className="drawer-f">
          {err && <span className="drawer-f-err">{err}</span>}
          <span style={{ flex: 1 }} />
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy || !name.trim() || !accepts.length || (kind === 'webhook' && !endpoint.trim())} onClick={save}>{busy ? 'Saving…' : addon ? 'Save' : 'Create'}</button>
        </div>
      </div>
    </div>
  )
}

function SecretModal({ name, secret, onClose }: { name: string; secret: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="drawer-scrim" {...pressable(onClose)} data-a11y-click="" style={{ display: 'grid', placeItems: 'center' }}>
      <div className="card" {...pressable((e: any) => e.stopPropagation())} data-a11y-click="" style={{ width: 540, maxWidth: 'calc(100vw - 32px)', padding: 22 }}>
        <div style={{ fontWeight: 700, fontSize: 'var(--fs-h2)' }}>Signing secret for {name}</div>
        <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--warn)', margin: '8px 0 12px' }}>
          Copy it into the service now. It verifies that requests really come from Volt, and it is shown only once.
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input readOnly value={secret} style={{ fontFamily: 'ui-monospace,monospace', fontSize: 'var(--fs-sm)' }} onFocus={e => e.currentTarget.select()} />
          <button className="btn primary" onClick={async () => { try { await navigator.clipboard.writeText(secret) } catch { /* manual copy */ } setCopied(true); setTimeout(() => setCopied(false), 1500) }}>{copied ? 'Copied ✓' : 'Copy'}</button>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}><button className="btn ghost" onClick={onClose}>Done, I saved it</button></div>
      </div>
    </div>
  )
}

// ============================================================ send-to menu
/** The "Send to add-on" control for a recording or asset page. */
export function SendToAddon({ subjectType, subjectId }: { subjectType: 'recording' | 'vod_asset'; subjectId: string }) {
  const [open, setOpen] = useState(false)
  const [addons, setAddons] = useState<AddonService[] | null>(null)
  const [msg, setMsg] = useState<{ text: string; runId?: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [runs, setRuns] = useState<AddonRun[]>([])

  usePoll(() => { api.workflowRuns({ subjectType, subjectId, limit: 5 }).then(r => setRuns(r.runs)).catch(() => {}) }, 5000, [subjectId])
  useEffect(() => { if (open && !addons) api.addons().then(r => setAddons(r.addons.filter(a => a.enabled && a.accepts.includes(subjectType)))).catch(() => setAddons([])) }, [open])

  async function send(a: AddonService) {
    setBusy(true); setMsg(null)
    try {
      const r = await api.startAddonRun({ addonId: a.id, subjectType, subjectId })
      setMsg({ text: `Sent to ${a.name}.`, runId: r.id }); setOpen(false)
      api.workflowRuns({ subjectType, subjectId, limit: 5 }).then(x => setRuns(x.runs))
    } catch (e: any) { setMsg({ text: e.message }) } finally { setBusy(false) }
  }
  const live = runs.filter(r => isOpen(r.state))

  return (
    <div style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      {live.length > 0 && (
        <span className="wf-link" style={{ fontSize: 'var(--fs-sm)' }} {...pressable(() => navigate(`/workflows/trace/${subjectType}/${subjectId}`))} data-a11y-click="">
          {live[0].addon_name}: {live[0].step ?? RUN_STATE[live[0].state].label} {live[0].progress_pct}%{live.length > 1 ? ` (+${live.length - 1})` : ''}
        </span>
      )}
      {msg && <span className="hintxt">{msg.text} {msg.runId && <span className="wf-link" {...pressable(() => navigate(`/workflows/run/${msg.runId}`))} data-a11y-click="">Track it</span>}</span>}
      <button className="btn ghost" onClick={() => setOpen(o => !o)} disabled={busy}>
        <span className="wf-catic xs" style={{ background: 'none', border: 'none', width: 15, height: 15 }}>{CAT_ICON.ai_agent}</span>Send to add-on
      </button>
      {open && (
        <div className="card wf-menu">
          {!addons ? <div className="loading" style={{ padding: 10 }}>Loading…</div>
            : addons.length === 0 ? <div className="hintxt" style={{ padding: 10 }}>No add-on accepts a {SUBJECT_LABEL[subjectType].toLowerCase()}. An admin can add one under Workflows.</div>
            : addons.map(a => (
              <div key={a.id} className="wf-menuitem" {...pressable(() => send(a))} data-a11y-click="">
                <span className="wf-catic sm">{CAT_ICON[a.category]}</span>
                <div style={{ minWidth: 0 }}><div className="wf-ellip" style={{ fontWeight: 600 }}>{a.name}</div><div className="hintxt wf-ellip">{a.description ?? CAT_LABEL[a.category]}</div></div>
              </div>
            ))}
          <div className="wf-menuitem" style={{ borderTop: '1px solid var(--border)' }} {...pressable(() => navigate(`/workflows/trace/${subjectType}/${subjectId}`))} data-a11y-click="">
            <span className="hintxt">Show this {SUBJECT_LABEL[subjectType].toLowerCase()} on the workflow map</span>
          </div>
        </div>
      )}
    </div>
  )
}
