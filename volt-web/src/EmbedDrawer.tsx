import { useEffect, useMemo, useState } from 'react'
import { api, type AppReg } from './api'
import { pressable } from './a11y'
import { FormStatus } from './notices'
import { useAccess } from './access'
import VoltPlayerView from './VoltPlayerView'
import type { PlayerState, Theme } from '@volt/player'

/* ============================================================================
   EMBED PLAYER: the tag a web developer pastes to put this channel or event on
   a website (docs/PLAYER_SDK.md, "Embedding").

   Video skins only: a channel gets the video player (schedule, start over,
   quality, subtitles, casting); an event gets the event player (countdown,
   promo, postponed / cancelled, replay, and Buy when the event is paid) which
   becomes the video player when it goes live, or the plain video player.

   THE SNIPPET CARRIES ITS OWN SETTINGS (data- attributes), so two sites can
   embed the same event differently and nothing here is saved. The key is the
   one thing it cannot carry by itself: keys are stored hashed, so the drawer
   offers to create one for this embed, shown once, rather than a placeholder.
   ========================================================================== */

export interface EmbedTarget {
  kind: 'channel' | 'event'
  id: string
  name: string
  /** Event start (ISO), for the preview's countdown. */
  startsAt?: string | null
}

type EventPreview = 'pre' | 'paywall' | 'live' | 'postponed' | 'replay'

const HEX = /^#[0-9a-f]{6}$/i
/** For a value in single quotes (the JSON theme): only & and ' need escaping, so the JSON stays readable. */
const attr1 = (v: string) => v.replace(/&/g, '&amp;').replace(/'/g, '&#39;')
const attr = (v: string) => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;')

function sampleState(target: EmbedTarget, skin: string, phase: EventPreview, now: number): Partial<PlayerState> {
  const start = target.startsAt ? new Date(target.startsAt).getTime() : NaN
  const startsAt = Number.isFinite(start) && start > now ? start : now + 2 * 86400_000 + 5 * 3600_000 + 17 * 60_000
  const base: Partial<PlayerState> = {
    item: { id: target.id, title: target.name, live: true },
    live: true, atLiveEdge: true, dvr: true, seekable: { start: 0, end: 3600 }, currentTime: 3600,
    qualities: [{ id: '1', height: 1080, width: 1920, bitrate: 6e6, label: '1080p' }, { id: '2', height: 720, width: 1280, bitrate: 3e6, label: '720p' }],
    textTracks: [{ id: 't', lang: 'en', label: 'English', kind: 'subtitle' }],
    cast: { available: true, state: 'none', device: null },
    status: 'ready', access: { mode: null, message: null, products: [] },
  }
  if (target.kind === 'channel') {
    const schedule = [
      { id: 'p1', title: 'The Morning Show', subtitle: 'News, weather and guests', startsAt: now - 30 * 60_000, endsAt: now + 30 * 60_000 },
      { id: 'p2', title: 'Midday Report', startsAt: now + 30 * 60_000, endsAt: now + 90 * 60_000 },
    ]
    return { ...base, schedule, programme: schedule[0], nextProgramme: schedule[1], canStartOver: true }
  }
  if (skin !== 'event' || phase === 'live') return { ...base, event: null, presentation: 'live', msToStart: null }
  const event = {
    id: target.id, title: target.name, startsAt, endsAt: startsAt + 3 * 3600_000,
    previousStartsAt: phase === 'postponed' ? startsAt - 7 * 86400_000 : null,
    presentation: (phase === 'paywall' ? 'pre' : phase) as any,
    preMessage: 'Coverage starts 30 minutes before the start.',
    endedMessage: phase === 'replay' ? 'Missed it? The full event is ready to watch.' : null,
    replayAssetId: phase === 'replay' ? 'replay' : null,
    promo: { template: 'plain' as const, headline: 'Live event', subhead: null },
  }
  return {
    ...base, event, presentation: event.presentation, msToStart: phase === 'replay' ? null : startsAt - now,
    status: phase === 'paywall' ? 'locked' : 'offline',
    access: phase === 'paywall'
      ? { mode: 'paywall', message: null, products: [
          { productKey: 'event-pass', name: 'Event pass', kind: 'published_dates', priceCents: 1499, currency: 'AUD' },
          { productKey: 'season', name: 'Season pass', kind: 'period', count: 1, unit: 'year', priceCents: 9900, currency: 'AUD' },
        ] }
      : { mode: null, message: null, products: [] },
  }
}

export function EmbedDrawer({ target, onClose }: { target: EmbedTarget; onClose: () => void }) {
  const { can } = useAccess()
  const isEvent = target.kind === 'event'
  const [skin, setSkin] = useState(isEvent ? 'event' : 'video')
  const [apps, setApps] = useState<AppReg[]>([])
  const [appId, setAppId] = useState('')
  const [prefixes, setPrefixes] = useState<Record<string, string>>({})
  const [fullKey, setFullKey] = useState<Record<string, string>>({})
  const [brand, setBrand] = useState<{ logo: string | null; primary: string; secondary: string } | null>(null)
  const [useBrand, setUseBrand] = useState(true)
  const [primary, setPrimary] = useState('#3f7bff')
  const [radius, setRadius] = useState(12)
  const [autoplay, setAutoplay] = useState(false)
  const [cast, setCast] = useState(true)
  const [airplay, setAirplay] = useState(true)
  const [schedule, setSchedule] = useState(true)
  const [purchaseUrl, setPurchaseUrl] = useState('')
  const [signInUrl, setSignInUrl] = useState('')
  const [size, setSize] = useState<'fill' | 'fixed'>('fill')
  const [width, setWidth] = useState(640)
  const [phase, setPhase] = useState<EventPreview>('pre')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [copied, setCopied] = useState(false)
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    api.apps().then(async list => {
      const web = list.filter(a => a.type === 'web' && a.enabled)
      setApps(web)
      if (web.length) setAppId(web[0].id)
      const found: Record<string, string> = {}
      for (const a of web) {
        try { const d = await api.app(a.id); const pk = d.keys.find(k => k.kind === 'publishable' && k.enabled); if (pk) found[a.id] = pk.key_prefix } catch { /* one app failing must not hide the others */ }
      }
      setPrefixes(found)
    }).catch(() => {})
    api.accountSettings().then(b => { setBrand({ logo: b.logo, primary: b.primary, secondary: b.secondary }); setPrimary(b.primary) }).catch(() => {})
  }, [])
  // the preview's countdown ticks
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t) }, [])

  const chosen = apps.find(a => a.id === appId)
  const origins: string[] = (chosen?.restrictions?.referrers || chosen?.restrictions?.origins || []) as string[]
  const key = fullKey[appId] ?? (prefixes[appId] ? `${prefixes[appId]}…YOUR_KEY` : 'pk_live_YOUR_KEY')
  const keyIsReal = !!fullKey[appId]

  const theme: Partial<Theme> = useMemo(() => {
    const t: Partial<Theme> = {
      primary: useBrand && brand ? brand.primary : primary,
      radius,
      controls: { cast, airplay, schedule: !isEvent && schedule, startOver: schedule || isEvent },
    }
    if (useBrand && brand?.logo) t.logoUrl = brand.logo
    return t
  }, [useBrand, brand, primary, radius, cast, airplay, schedule, isEvent])

  const snippet = useMemo(() => {
    const lines = [`<div data-volt-player`, `     data-app-key="${attr(key)}"`]
    if (isEvent && skin === 'event') lines.push(`     data-event-id="${target.id}"`)
    else lines.push(`     data-asset-id="${target.id}"`)
    lines.push(`     data-skin="${skin}"`)
    if (!isEvent && schedule) lines.push(`     data-epg-channel="${target.id}"`)
    // Only what differs from the built-in defaults goes in the theme.
    const t: Record<string, any> = { primary: theme.primary }
    if (theme.logoUrl) t.logoUrl = theme.logoUrl
    if (radius !== 12) t.radius = radius
    const ctl: Record<string, boolean> = {}
    if (!cast) ctl.cast = false
    if (!airplay) ctl.airplay = false
    if (!isEvent && !schedule) { ctl.schedule = false; ctl.startOver = false }
    if (Object.keys(ctl).length) t.controls = ctl
    lines.push(`     data-theme='${attr1(JSON.stringify(t))}'`)
    if (autoplay) lines.push(`     data-autoplay="true" data-muted="true"`)
    if (isEvent && purchaseUrl.trim()) lines.push(`     data-purchase-url="${attr(purchaseUrl.trim())}"`)
    if (isEvent && signInUrl.trim()) lines.push(`     data-sign-in-url="${attr(signInUrl.trim())}"`)
    if (size === 'fixed') lines.push(`     style="max-width:${Math.max(240, Math.round(width))}px"`)
    lines[lines.length - 1] += '></div>'
    return `${lines.join('\n')}\n<script src="${location.origin}/player/volt-player.js" async></script>`
  }, [key, isEvent, skin, target.id, schedule, theme, radius, cast, airplay, autoplay, purchaseUrl, signInUrl, size, width])

  async function createKey() {
    if (!appId) return
    setBusy(true); setErr('')
    try {
      const k = await api.rotateAppKey(appId)
      setFullKey(m => ({ ...m, [appId]: k.key }))
      setPrefixes(m => ({ ...m, [appId]: k.key_prefix }))
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }
  async function copy() {
    try { await navigator.clipboard.writeText(snippet); setCopied(true); setTimeout(() => setCopied(false), 1600) } catch { setErr('Select the snippet and copy it.') }
  }

  const demo = sampleState(target, skin, phase, now)
  const check = (label: string, value: boolean, set: (v: boolean) => void, hint?: string) => (
    <label className="embed-check"><input type="checkbox" checked={value} onChange={e => set(e.target.checked)} /><span>{label}{hint && <small>{hint}</small>}</span></label>
  )

  return (
    <div {...pressable((e: any) => { ((onClose) as any)(e) })} data-a11y-click="" className="embed-scrim">
      <div {...pressable((e: any) => { (((e: any) => e.stopPropagation()) as any)(e) })} data-a11y-click="" className="embed-modal" role="dialog" aria-label="Embed player">
        <div className="embed-head">
          <div>
            <div className="embed-title">Embed player</div>
            <div className="embed-sub">Put {target.name} on a website: copy the tag into the page where the player should appear.</div>
          </div>
          <button className="xbtn" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="embed-grid">
          <div className="embed-col">
            <div className="sec-label">Player</div>
            {isEvent ? (
              <div className="embed-skins">
                {[
                  ['event', 'Event player', 'Countdown, teams or line-up, postponed and cancelled notices, Buy when the event is paid, the replay afterwards. Becomes the full video player when it goes live.'],
                  ['video', 'Video player', 'The live stream only: quality, subtitles, start over, casting.'],
                ].map(([id, name, detail]) => (
                  <button key={id} type="button" className={`embed-skin${skin === id ? ' on' : ''}`} onClick={() => setSkin(id)}>
                    <b>{name}</b><span>{detail}</span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="embed-skin on static"><b>Video player</b><span>The live channel with its schedule, start over, quality, subtitles, Chromecast and AirPlay.</span></div>
            )}

            <div className="sec-label" style={{ marginTop: 16 }}>Key</div>
            {apps.length === 0 ? (
              <div className="hintxt">You have no web apps yet. Register one in API Keys &amp; Apps to get a key for the player.</div>
            ) : (
              <>
                <div className="field"><label>App <span style={{ color: 'var(--faint)' }}>— which site this is for</span></label>
                  <select className="inp" value={appId} onChange={e => setAppId(e.target.value)}>
                    {apps.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                </div>
                {keyIsReal
                  ? <div className="embed-ok">A new key is in the tag. It is shown once: copy the tag now.</div>
                  : can('apps', 'manage')
                    ? <button className="btn ghost sm" disabled={busy} onClick={createKey}>{busy ? 'Creating…' : 'Create a key for this embed'}</button>
                    : <div className="hintxt">Ask an admin for the app's key and replace YOUR_KEY in the tag.</div>}
                <div className={`embed-origins${origins.length ? '' : ' warn'}`}>
                  {origins.length
                    ? <>Plays on: <b>{origins.join(', ')}</b>. Anywhere else is refused.</>
                    : <>This app has no site restriction, so the key works wherever the tag is copied. Add your domains in API Keys &amp; Apps.</>}
                </div>
              </>
            )}

            <div className="sec-label" style={{ marginTop: 16 }}>Look</div>
            {check('Use account branding', useBrand, setUseBrand, brand ? ' logo and colour from Account settings' : undefined)}
            {!useBrand && (
              <div className="field" style={{ marginTop: 6 }}><label>Colour</label>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <input type="color" value={HEX.test(primary) ? primary : '#3f7bff'} onChange={e => setPrimary(e.target.value)} className="embed-swatch" aria-label="Colour swatch" />
                  <input className="inp" value={primary} onChange={e => setPrimary(e.target.value)} style={{ width: 120, fontFamily: 'ui-monospace,monospace' }} />
                </div>
              </div>
            )}
            <div className="field" style={{ marginTop: 6 }}><label>Corners</label>
              <select className="inp" value={radius} onChange={e => setRadius(Number(e.target.value))}>
                <option value={0}>Square</option><option value={6}>Slightly rounded</option><option value={12}>Rounded</option><option value={20}>Very rounded</option>
              </select>
            </div>

            <div className="sec-label" style={{ marginTop: 16 }}>Playback</div>
            {check('Start playing on its own (muted)', autoplay, setAutoplay, ' browsers only allow sound after a click')}
            {!isEvent && check('Schedule and Start over', schedule, setSchedule, ' from the channel guide')}
            {check('Chromecast', cast, setCast)}
            {check('AirPlay', airplay, setAirplay)}

            {isEvent && skin === 'event' && (
              <>
                <div className="sec-label" style={{ marginTop: 16 }}>Paid events</div>
                <div className="hintxt" style={{ marginBottom: 6 }}>
                  When access rules charge for this event the player lists the passes with their prices. Buy opens your checkout page; leave it empty if your site handles the purchase itself (the player tells the page which pass was chosen).
                </div>
                <div className="field"><label>Checkout page <span style={{ color: 'var(--faint)' }}>— {'{productKey}'}, {'{assetId}'}, {'{price}'}, {'{currency}'} are filled in</span></label>
                  <input className="inp" value={purchaseUrl} onChange={e => setPurchaseUrl(e.target.value)} placeholder="https://shop.example.com/buy?pass={productKey}" />
                </div>
                <div className="field"><label>Sign-in page <span style={{ color: 'var(--faint)' }}>— for members-only events</span></label>
                  <input className="inp" value={signInUrl} onChange={e => setSignInUrl(e.target.value)} placeholder="https://example.com/login" />
                </div>
              </>
            )}

            <div className="sec-label" style={{ marginTop: 16 }}>Size</div>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <label className="embed-check"><input type="radio" checked={size === 'fill'} onChange={() => setSize('fill')} /><span>Fill the width of the page</span></label>
              <label className="embed-check"><input type="radio" checked={size === 'fixed'} onChange={() => setSize('fixed')} /><span>Up to</span></label>
              <input className="inp" type="number" min={240} step={10} value={width} disabled={size !== 'fixed'} onChange={e => setWidth(Number(e.target.value))} style={{ width: 90 }} />
              <span style={{ color: 'var(--faint)', fontSize: 'var(--fs-sm)' }}>px wide</span>
            </div>
          </div>

          <div className="embed-col">
            <div className="sec-label" style={{ display: 'flex', alignItems: 'center' }}>
              <span>Preview</span><span style={{ flex: 1 }} />
              {isEvent && skin === 'event' && (
                <div className="embed-seg" role="tablist" aria-label="Preview the event at">
                  {([['pre', 'Countdown'], ['paywall', 'Paid'], ['postponed', 'Postponed'], ['live', 'Live'], ['replay', 'Replay']] as [EventPreview, string][]).map(([id, l]) => (
                    <button key={id} type="button" role="tab" aria-selected={phase === id} className={phase === id ? 'on' : ''} onClick={() => setPhase(id)}>{l}</button>
                  ))}
                </div>
              )}
            </div>
            <div style={{ maxWidth: size === 'fixed' ? Math.max(240, width) : undefined }}>
              <VoltPlayerView key={skin} skin={skin} theme={theme} demo={demo} />
            </div>
            <div className="hintxt" style={{ marginTop: 6 }}>Sample data: the embed shows this {isEvent ? 'event' : 'channel'} live.</div>

            <div className="sec-label" style={{ marginTop: 16 }}>Tag</div>
            <pre className="embed-code">{snippet}</pre>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
              <button className="btn primary" onClick={copy}>{copied ? 'Copied' : 'Copy tag'}</button>
              {!keyIsReal && <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--faint)' }}>Replace YOUR_KEY with the app's full key, or create one above.</span>}
            </div>
            <details className="embed-dev">
              <summary>For developers: events and purchases</summary>
              <pre className="embed-code">{`document.addEventListener('volt-player-ready', (e) => {
  const player = e.detail
  player.on('purchase', ({ productKey }) => { /* run your checkout */ })
  // after a purchase or sign-in, with the viewer's Volt session token:
  // player.setViewerToken(token)
})`}</pre>
              <div className="hintxt">Full reference: docs/PLAYER_SDK.md.</div>
            </details>
            <FormStatus error={err} />
          </div>
        </div>
      </div>
    </div>
  )
}
