import { useEffect, useState } from 'react'
import { api, type PlayerConfigResponse, type PlayerConfig, type PlayerReport, type AppReg } from '../api'
import { pressable } from '../a11y'
import { PageError, useNotify } from '../notices'
import VoltPlayerView from '../VoltPlayerView'
import { DEFAULT_CONTROLS } from '@volt/player/theme'
import type { ControlToggles, PlayerState, Theme } from '@volt/player'

/* ============================================================================
   PLAYER SETUP — configure a station's embeddable player and copy the snippet.

   THE PREVIEW IS THE POINT. Colours are the thing customers change and the
   thing that is impossible to judge from two hex fields, so the panel on the
   right renders the actual card with the actual values as they are typed. It
   is a faithful copy of the card layout's markup rather than the real bundle:
   loading the bundle here would need a publishable key, an allowed origin and
   a live station, none of which are true while somebody is choosing a colour.
   Its job is to answer "what will this look like", and it does that exactly.

   THE SNIPPET IS THE DELIVERABLE. Everything else on this page exists so that
   the two lines at the bottom are right. It carries a real key belonging to a
   real app, because an embed with a placeholder key is a support ticket
   waiting to happen — so the app picker is part of the flow rather than
   something to work out afterwards.

   AND IT SAYS WHERE THE PLAYER IS ALLOWED TO RUN. The commonest failure with a
   key-gated embed is pasting it onto a domain that is not on the app's
   allow-list, which fails at runtime on somebody else's website. The allowed
   origins for the chosen app are shown right beside the snippet, so that is
   visible before the paste rather than after.
   ========================================================================== */

const DEFAULT_COLORS = { primary: '#3f7bff', secondary: '#0f1218' }

/** Black or white, whichever is readable on this background. Mirrors the
 *  bundle's own calculation so the preview cannot disagree with the player. */
function idealInk(bg: string, alpha = 1): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(bg.trim())
  if (!m) return alpha === 1 ? '#ffffff' : `rgba(255,255,255,${alpha})`
  const n = parseInt(m[1], 16)
  const lin = (v: number) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 }
  const L = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255)
  return L < 0.35
    ? (alpha === 1 ? '#ffffff' : `rgba(255,255,255,${alpha})`)
    : (alpha === 1 ? '#0b0e13' : `rgba(11,14,19,${alpha})`)
}

const HEX = /^#[0-9a-fA-F]{6}$/

function ColorField({ label, value, onChange, hint }: {
  label: string; value: string; onChange: (v: string) => void; hint?: string
}) {
  const valid = HEX.test(value)
  return (
    <div className="field">
      <label>{label} {hint && <span style={{ color: 'var(--faint)' }}>— {hint}</span>}</label>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        {/* The swatch and the text field edit the same value. The picker is
            how people choose; the hex box is how they paste a brand colour
            out of a style guide, which is what actually happens. */}
        <input type="color" value={valid ? value : DEFAULT_COLORS.primary}
               onChange={e => onChange(e.target.value)}
               style={{ width: 44, height: 34, padding: 2, background: 'none', border: '1px solid var(--border)', borderRadius: 8 }}
               aria-label={`${label} swatch`} />
        <input className="inp" value={value} onChange={e => onChange(e.target.value)}
               style={{ width: 120, fontFamily: 'ui-monospace,monospace' }} placeholder="#3f7bff" />
        {!valid && <span style={{ color: 'var(--down,#f87171)', fontSize: 'var(--fs-sm)' }}>needs #rrggbb</span>}
      </div>
    </div>
  )
}

/** A faithful copy of the card layout, driven by the values being edited. */
function Preview({ cfg }: { cfg: PlayerConfig }) {
  const bg = HEX.test(cfg.secondaryColor) ? cfg.secondaryColor : DEFAULT_COLORS.secondary
  const accent = HEX.test(cfg.primaryColor) ? cfg.primaryColor : DEFAULT_COLORS.primary
  const ink = idealInk(bg)
  const dim = idealInk(bg, 0.62)
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 14, padding: 14, borderRadius: 14,
      background: bg, color: ink, maxWidth: 480,
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif', fontSize: 14,
    }}>
      <div style={{ width: 72, height: 72, borderRadius: 10, background: 'rgba(127,127,127,.22)', flex: 'none', display: 'grid', placeItems: 'center' }}>
        {cfg.fallbackArtworkUrl
          ? <img src={cfg.fallbackArtworkUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 10 }} />
          : <svg viewBox="0 0 24 24" style={{ width: 26, opacity: .5 }} fill="none" stroke={ink} strokeWidth="1.6">
              <circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="2.5" />
            </svg>}
      </div>
      <div style={{ minWidth: 0, flex: 1 }}>
        {/* The preview shows a REAL track, because that is what the layout
            normally renders. Showing the station fallback here would make the
            common case look like the exception. */}
        <div style={{ fontWeight: 650, fontSize: 15, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>Dreams</div>
        <div style={{ color: dim, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>Fleetwood Mac</div>
        <div style={{ color: dim, fontSize: 12, marginTop: 2 }}>Rumours · 1977</div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 'none' }}>
        <div style={{ width: 44, height: 44, borderRadius: '50%', background: accent, display: 'grid', placeItems: 'center' }}>
          <svg viewBox="0 0 24 24" style={{ width: 22 }}><path d="M8 5v14l11-7z" fill="#fff" /></svg>
        </div>
      </div>
    </div>
  )
}

/* ---------------------------------------------------------------------------
   PLAYER SDK SKINS: the theme (options.theme) and a live preview drawn by the
   real player in demo mode, so what is shown is exactly what embeds render.
   ------------------------------------------------------------------------- */

const CONTROL_LABELS: Array<[keyof ControlToggles, string, 'video' | 'audio' | 'both']> = [
  ['title', 'Title', 'video'], ['seekButtons', '10 s back / forward', 'video'], ['volume', 'Volume', 'both'],
  ['quality', 'Quality menu', 'video'], ['subtitles', 'Subtitles menu', 'video'], ['audioTracks', 'Audio language', 'video'],
  ['startOver', 'Start over', 'video'], ['schedule', 'Schedule / playlist', 'video'], ['upNext', 'Up next', 'both'],
  ['history', 'Recently played', 'audio'], ['pip', 'Picture in picture', 'video'], ['fullscreen', 'Full screen', 'video'],
  ['cast', 'Chromecast', 'video'], ['airplay', 'AirPlay', 'video'],
]

function sampleState(layout: string, cfg: PlayerConfig, station: string): Partial<PlayerState> {
  const now = Date.now()
  const art = cfg.fallbackArtworkUrl || null
  const schedule = [
    { id: 'p1', title: cfg.fallbackTitle || station, subtitle: cfg.fallbackText || 'Live now', startsAt: now - 20 * 60_000, endsAt: now + 40 * 60_000 },
    { id: 'p2', title: 'The Late Show', subtitle: 'Music and conversation', startsAt: now + 40 * 60_000, endsAt: now + 160 * 60_000 },
    { id: 'p3', title: 'Overnight', startsAt: now + 160 * 60_000, endsAt: now + 400 * 60_000 },
  ]
  if (layout === 'video') {
    return {
      status: 'ready', live: true, atLiveEdge: true, dvr: true, seekable: { start: 0, end: 3600 }, currentTime: 3600,
      item: { id: 'demo', title: station, live: true },
      programme: schedule[0], nextProgramme: schedule[1], schedule, canStartOver: true,
      qualities: [{ id: '1', height: 1080, width: 1920, bitrate: 6e6, label: '1080p' }, { id: '2', height: 720, width: 1280, bitrate: 3e6, label: '720p' }],
      textTracks: [{ id: 't', lang: 'en', label: 'English', kind: 'subtitle' }],
      cast: { available: true, state: 'none', device: null },
    }
  }
  return {
    status: 'ready', live: true, atLiveEdge: true,
    item: { id: 'demo', title: station, artworkUrl: art, live: true },
    nowPlaying: { title: 'Dreams', artist: 'Fleetwood Mac', album: 'Rumours', year: 1977, artworkUrl: art },
    history: [
      { title: 'Running Up That Hill', artist: 'Kate Bush', startedAt: now - 5 * 60_000, artworkUrl: art },
      { title: 'Heroes', artist: 'David Bowie', startedAt: now - 9 * 60_000, artworkUrl: art },
      { title: 'Kiss', artist: 'Prince', startedAt: now - 13 * 60_000, artworkUrl: art },
      { title: 'Blue Monday', artist: 'New Order', startedAt: now - 20 * 60_000, artworkUrl: art },
      { title: 'Teardrop', artist: 'Massive Attack', startedAt: now - 26 * 60_000, artworkUrl: art },
    ],
    schedule, programme: schedule[0], nextProgramme: schedule[1],
  }
}

function sdkTheme(cfg: PlayerConfig): Partial<Theme> {
  return { primary: cfg.primaryColor, secondary: cfg.secondaryColor, ...((cfg.options?.theme as Partial<Theme>) ?? {}) }
}

function SdkPreview({ cfg, station }: { cfg: PlayerConfig; station: string }) {
  const demo = sampleState(cfg.layout, cfg, station)
  return (
    <div style={{ maxWidth: cfg.layout === 'audio_square' ? 320 : 560 }}>
      <VoltPlayerView key={cfg.layout === 'video' ? 'v' : 'a'} skin={cfg.layout} theme={sdkTheme(cfg)} demo={demo} />
    </div>
  )
}

function ThemeEditor({ cfg, setCfg, onBrand }: { cfg: PlayerConfig; setCfg: (c: PlayerConfig) => void; onBrand: () => void }) {
  const theme = (cfg.options?.theme ?? {}) as Partial<Theme>
  const set = (p: Partial<Theme>) => setCfg({ ...cfg, options: { ...cfg.options, theme: { ...theme, ...p } } })
  const controls = { ...DEFAULT_CONTROLS, ...(theme.controls ?? {}) }
  const kind = cfg.layout === 'video' ? 'video' : 'audio'
  return (
    <>
      <div className="sec-label" style={{ marginTop: 16, display: 'flex', alignItems: 'center' }}>
        <span>Skin</span><span className="spacer" style={{ flex: 1 }} />
        <button className="btn ghost sm" type="button" {...pressable(onBrand)}>Use account branding</button>
      </div>
      <div className="field"><label>Logo URL <span style={{ color: 'var(--faint)' }}>— https, shown on the player</span></label>
        <input className="inp" value={theme.logoUrl ?? ''} placeholder="https://…" onChange={e => set({ logoUrl: e.target.value || null })} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <div className="field"><label>Logo position</label>
          <select className="inp" value={theme.logoPosition ?? 'top-right'} onChange={e => set({ logoPosition: e.target.value as Theme['logoPosition'] })}>
            <option value="top-right">Top right</option><option value="top-left">Top left</option>
            <option value="bottom-right">Bottom right</option><option value="none">Hidden</option>
          </select>
        </div>
        <div className="field"><label>Corner radius: {theme.radius ?? 12}px</label>
          <input type="range" min={0} max={28} value={theme.radius ?? 12} onChange={e => set({ radius: Number(e.target.value) })} style={{ width: '100%' }} />
        </div>
        <div className="field"><label>Font <span style={{ color: 'var(--faint)' }}>— loaded by your page</span></label>
          <input className="inp" value={theme.font ?? ''} placeholder="System font" onChange={e => set({ font: e.target.value || null })} />
        </div>
        <div className="field"><label>Up next appears</label>
          <select className="inp" value={theme.upNextSeconds ?? 15} onChange={e => set({ upNextSeconds: Number(e.target.value) })}>
            {[10, 15, 20, 30, 60].map(n => <option key={n} value={n}>{n} s before the end</option>)}
          </select>
        </div>
      </div>
      {kind === 'video' && (
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 'var(--fs-sm)', margin: '4px 0 10px' }}>
          <input type="checkbox" checked={theme.autoAdvance !== false} onChange={e => set({ autoAdvance: e.target.checked })} />
          Play the next item in a playlist automatically
        </label>
      )}
      <div className="sec-label" style={{ marginTop: 8 }}>Controls</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0,1fr))', gap: '4px 12px' }}>
        {CONTROL_LABELS.filter(([, , k]) => k === 'both' || k === kind).map(([key, label]) => (
          <label key={key} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 'var(--fs-sm)' }}>
            <input type="checkbox" checked={controls[key]} onChange={e => set({ controls: { ...(theme.controls ?? {}), [key]: e.target.checked } })} />
            {label}
          </label>
        ))}
      </div>
      <div className="hintxt" style={{ marginTop: 8 }}>
        Menus only appear when there is something to choose: no subtitles menu on a stream without subtitles, no quality menu with one quality.
      </div>
    </>
  )
}

export default function PlayerSetup({ id, onBack }: { id: string; onBack: () => void }) {
  const [d, setD] = useState<PlayerConfigResponse | null>(null)
  const [cfg, setCfg] = useState<PlayerConfig | null>(null)
  const [apps, setApps] = useState<AppReg[]>([])
  const [appId, setAppId] = useState<string>('')
  const [keys, setKeys] = useState<Record<string, string>>({})
  const [report, setReport] = useState<PlayerReport | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState('')

  useEffect(() => {
    api.playerConfig(id).then(r => { setD(r); setCfg(r.config) }).catch(e => setErr(e.message))
    api.playerReport(id, 24).then(setReport).catch(() => {})
    // The snippet needs a real key. Web apps only: a server or mobile app's
    // key is not what goes in a page, and offering one here would produce an
    // embed that fails on the customer's site for a reason nothing explains.
    api.apps().then(async list => {
      const web = list.filter(a => a.type === 'web' && a.enabled)
      setApps(web)
      if (web.length) setAppId(web[0].id)
      const found: Record<string, string> = {}
      for (const a of web) {
        try {
          const detail = await api.app(a.id)
          const pk = detail.keys.find((k: any) => k.kind === 'publishable')
          if (pk) found[a.id] = `${pk.key_prefix}…`
        } catch { /* one app failing must not hide the others */ }
      }
      setKeys(found)
    }).catch(() => {})
  }, [id])

  function flash(m: string) { setToast(m); setTimeout(() => setToast(''), 2200) }

  async function applyBrand() {
    if (!cfg) return
    try {
      const b = await api.accountSettings()
      const theme = { ...(cfg.options?.theme ?? {}), logoUrl: b.logo ?? (cfg.options?.theme?.logoUrl ?? null) }
      setCfg({ ...cfg, primaryColor: b.primary, secondaryColor: b.secondary, options: { ...cfg.options, theme } })
      flash('Account logo and colours applied. Save to keep them.')
    } catch (e: any) { flash(e.message) }
  }
  const notify = useNotify()

  async function save() {
    if (!cfg) return
    setBusy(true)
    try {
      const saved = await api.savePlayerConfig(id, {
        layout: cfg.layout,
        primaryColor: cfg.primaryColor,
        secondaryColor: cfg.secondaryColor,
        fallbackTitle: cfg.fallbackTitle,
        fallbackText: cfg.fallbackText,
        fallbackArtworkUrl: cfg.fallbackArtworkUrl,
        options: cfg.options,
      })
      setCfg(saved)
      flash('Saved. Players already embedded will pick this up on their next load.')
    } catch (e: any) { notify({ kind: 'error', message: e.message }) } finally { setBusy(false) }
  }

  if (err && !d) return <PageError message={err} />
  if (!d || !cfg) return <div className="card p-4"><div className="loading">Loading player setup…</div></div>

  const chosen = apps.find(a => a.id === appId)
  const keyHint = keys[appId] ?? 'pk_live_…'
  const origins: string[] = (chosen?.restrictions?.referrers || chosen?.restrictions?.origins || []) as string[]
  const base = window.location.origin
  const snippet = `<div data-volt-player
     data-app-key="${keyHint.replace('…', 'YOUR_KEY')}"
     data-channel-id="${d.channel.id}"></div>
<script src="${base}/player/volt-player.js"></script>`

  return (
    <>
      <div style={{ marginBottom: 10 }}>
        <button className="btn ghost" onClick={onBack}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 14 }}><path d="M19 12H5M12 19l-7-7 7-7" /></svg>
          {d.channel.name}
        </button>
      </div>
      <div className="page-head">
        <div>
          <h1>Player</h1>
          <p>Style the embeddable player for {d.channel.name}, then copy the snippet into any website or app.</p>
        </div>
        <div className="spacer" />
        <button className="btn primary" disabled={busy} {...pressable(() => save())}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>

      {cfg.source !== 'channel' && (
        <div className="hintxt" style={{ marginBottom: 10 }}>
          This station has no player of its own yet, so it is using {cfg.source === 'account' ? 'your account default' : 'the built-in defaults'}. Saving creates one for {d.channel.name}.
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 16, alignItems: 'start' }}>
        <div className="card p-4">
          <div className="sec-label">Layout</div>
          {d.layouts.map((l, i) => (<div key={l.id}>
            {(i === 0 || !!d.layouts[i - 1].sdk !== !!l.sdk) && (
              <div style={{ fontSize: 'var(--fs-micro)', color: 'var(--faint)', textTransform: 'uppercase', letterSpacing: '.06em', margin: i ? '12px 0 6px' : '0 0 6px' }}>
                {l.sdk ? 'Player SDK skins: same on web, apps and TVs' : 'Station embeds'}
              </div>
            )}
            <div key={l.id}
                 {...pressable(() => setCfg({ ...cfg, layout: l.id }))}
                 data-a11y-click=""
                 style={{
                   display: 'flex', gap: 11, alignItems: 'flex-start', padding: '10px 12px',
                   marginBottom: 6, borderRadius: 10, cursor: 'pointer',
                   border: `1px solid ${cfg.layout === l.id ? 'var(--brand,#3f7bff)' : 'var(--border)'}`,
                   background: cfg.layout === l.id ? 'var(--brand-dim,rgba(63,123,255,.14))' : 'transparent',
                 }}>
              <span style={{
                width: 15, height: 15, borderRadius: 8, marginTop: 2, flex: 'none',
                border: `2px solid ${cfg.layout === l.id ? 'var(--brand,#3f7bff)' : 'var(--border-2,rgba(255,255,255,.2))'}`,
                display: 'grid', placeItems: 'center',
              }}>
                {cfg.layout === l.id && <span style={{ width: 7, height: 7, borderRadius: 4, background: 'var(--brand,#3f7bff)' }} />}
              </span>
              <span style={{ minWidth: 0 }}>
                <span style={{ display: 'block', fontWeight: 600 }}>
                  {l.name}
                </span>
                <span style={{ display: 'block', fontSize: 'var(--fs-sm)', color: 'var(--muted)' }}>{l.detail}</span>
              </span>
            </div>
          </div>))}

          <div className="sec-label" style={{ marginTop: 16 }}>Colours</div>
          <ColorField label="Primary" value={cfg.primaryColor}
                      onChange={v => setCfg({ ...cfg, primaryColor: v })}
                      hint="the play control" />
          <ColorField label="Background" value={cfg.secondaryColor}
                      onChange={v => setCfg({ ...cfg, secondaryColor: v })}
                      hint="text contrast is chosen automatically" />
          {d.layouts.find(l => l.id === cfg.layout)?.sdk && <ThemeEditor cfg={cfg} setCfg={setCfg} onBrand={applyBrand} />}

          <div className="sec-label" style={{ marginTop: 16 }}>
            When there is no track information
          </div>
          {/* Said plainly, because it is the difference between a player that
              looks broken between songs and one that does not. Idents, news
              and ad breaks have no track, and neither does a song MusicBrainz
              has never heard of. */}
          <div className="hintxt" style={{ marginBottom: 8 }}>
            Idents, news, ad breaks and unrecognised tracks all fall back to this. Leave it blank to use the station's own name and description.
          </div>
          <div className="field"><label>Title</label>
            <input className="inp" value={cfg.fallbackTitle ?? ''} placeholder={d.channel.name}
                   onChange={e => setCfg({ ...cfg, fallbackTitle: e.target.value || null })} />
          </div>
          <div className="field"><label>Strapline</label>
            <input className="inp" value={cfg.fallbackText ?? ''} placeholder="e.g. Smooth all night"
                   onChange={e => setCfg({ ...cfg, fallbackText: e.target.value || null })} />
          </div>
          <div className="field"><label>Artwork URL <span style={{ color: 'var(--faint)' }}>— also used when a track has no cover</span></label>
            <input className="inp" value={cfg.fallbackArtworkUrl ?? ''} placeholder="https://…"
                   onChange={e => setCfg({ ...cfg, fallbackArtworkUrl: e.target.value || null })} />
          </div>
        </div>

        <div>
          <div className="card p-4" style={{ marginBottom: 16 }}>
            <div className="sec-label">Preview</div>
            {d.layouts.find(l => l.id === cfg.layout)?.sdk
              ? <SdkPreview cfg={cfg} station={d.channel.name} />
              : <Preview cfg={cfg} />}
            <div className="hintxt" style={{ marginTop: 10 }}>
              Track, artist and album come from the station's own metadata, enriched with MusicBrainz and the Cover Art Archive.
            </div>
          </div>

          <div className="card p-4" style={{ marginBottom: 16 }}>
            <div className="sec-label">Embed</div>
            {apps.length === 0 ? (
              <div className="hintxt">
                You have no web apps yet. Register one in API Keys &amp; Apps to get a publishable key for the player.
              </div>
            ) : (
              <>
                <div className="field"><label>App <span style={{ color: 'var(--faint)' }}>— the key the player identifies with</span></label>
                  <select className="inp" value={appId} onChange={e => setAppId(e.target.value)}>
                    {apps.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                </div>
                {/* THE THING THAT ACTUALLY BREAKS EMBEDS. A key-gated player
                    pasted onto a domain that is not on the list fails at
                    runtime on the customer's own website, and nothing on that
                    page explains why. Shown here, before the paste. */}
                <div style={{ fontSize: 'var(--fs-sm)', marginBottom: 10 }}>
                  {origins.length
                    ? <>Works on: <b>{origins.join(', ')}</b>. Anywhere else is refused.</>
                    : <span style={{ color: 'var(--warn,#fbbf24)' }}>
                        This app has no origin restriction, so the key works on any site that copies it. Add your domains in API Keys &amp; Apps.
                      </span>}
                </div>
                <pre style={{
                  background: 'var(--panel-2,rgba(255,255,255,.03))', border: '1px solid var(--border)',
                  borderRadius: 10, padding: 12, fontSize: 'var(--fs-sm)', overflowX: 'auto',
                  fontFamily: 'ui-monospace,monospace', whiteSpace: 'pre',
                }}>{snippet}</pre>
                <div className="flex items-center gap-2" style={{ marginTop: 10 }}>
                  <button className="btn" {...pressable(async () => {
                    try { await navigator.clipboard.writeText(snippet); flash('Snippet copied') }
                    catch { flash('Select the snippet and copy it') }
                  })}>Copy snippet</button>
                  <span style={{ fontSize: 'var(--fs-micro)', color: 'var(--faint)' }}>
                    Replace YOUR_KEY with the app's full publishable key ({keyHint}).
                  </span>
                </div>
              </>
            )}
          </div>

          <div className="card p-4">
            <div className="sec-label">Player health, last 24 hours</div>
            {!report || !report.totals.length ? (
              <div className="hintxt">Nothing reported yet. Events appear here once a player has loaded somewhere.</div>
            ) : (
              <>
                <div className="flex" style={{ gap: 18, flexWrap: 'wrap', marginBottom: 10 }}>
                  {report.totals.slice(0, 5).map(t => (
                    <span key={t.event} style={{ fontSize: 'var(--fs-sm)' }}>
                      <b style={{ fontVariantNumeric: 'tabular-nums' }}>{t.sessions}</b>
                      <span style={{ color: 'var(--faint)' }}> {t.event}</span>
                    </span>
                  ))}
                </div>
                {/* Per origin, because "it works on one of our sites and not
                    the other" is the question this data exists to answer. */}
                {report.byOrigin.length > 0 && (
                  <table style={{ width: '100%', fontSize: 'var(--fs-sm)' }}>
                    <thead><tr style={{ color: 'var(--faint)' }}>
                      <th style={{ textAlign: 'left' }}>Site</th>
                      <th style={{ textAlign: 'right' }}>Sessions</th>
                      <th style={{ textAlign: 'right' }}>Errors</th>
                    </tr></thead>
                    <tbody>
                      {report.byOrigin.map(o => (
                        <tr key={o.origin} style={{ borderTop: '1px solid var(--border)' }}>
                          <td style={{ padding: '5px 0', wordBreak: 'break-all' }}>{o.origin}</td>
                          <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{o.sessions}</td>
                          <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: o.errors ? 'var(--down,#f87171)' : undefined }}>{o.errors}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      {toast && (
        <div style={{ position: 'fixed', left: '50%', bottom: 26, transform: 'translateX(-50%)', zIndex: 60, background: 'var(--panel-3,#161b26)', border: '1px solid var(--border)', padding: '10px 16px', borderRadius: 10, fontSize: 'var(--fs-body)' }}>{toast}</div>
      )}
    </>
  )
}
