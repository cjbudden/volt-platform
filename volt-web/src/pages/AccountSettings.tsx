// ============================================================================
//  ACCOUNT SETTINGS (Admin > Account settings, docs/ACCOUNT_SETTINGS.md).
//
//  The account's own look for the pages it shows to outsiders: a logo, a
//  primary colour (buttons, the player badge, avatars) and a secondary colour
//  (the information band and the access card). The share page uses them now.
//  A live preview shows the share page header as a recipient will see it.
//  Account administrators and owners change it; everyone else sees it.
// ============================================================================
import { useEffect, useMemo, useState } from 'react'
import { api, type AccountSettings as AS } from '../api'
import { PageHead } from '../scaffold'
import { navigate } from '../router'
import { ImageRefField } from '../ImageRefField'
import { usePageNotice, useNotify, FormStatus, FieldError } from '../notices'
import { COUNTRIES, countryName, toCountryCode } from '../lib/countries'

const HEX = /^#[0-9a-f]{6}$/i
function lum(h: string) {
  const n = parseInt(h.slice(1), 16)
  const c = [n >> 16 & 255, n >> 8 & 255, n & 255].map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) })
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
}
const inkOn = (h: string) => HEX.test(h) && lum(h) > 0.45 ? '#0f172a' : '#ffffff'
/** WCAG contrast of two colours. */
function contrast(a: string, b: string) { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05) }

function ColourField({ label, hint, value, onChange, fallback, disabled }: {
  label: string; hint: string; value: string; onChange: (v: string) => void; fallback: string; disabled?: boolean
}) {
  const valid = HEX.test(value)
  return (
    <div className="field">
      <label>{label} <span className="hintxt" style={{ display: 'inline', marginLeft: 4 }}>{hint}</span></label>
      <div className="colour-row">
        <input type="color" className="colour-swatch" value={valid ? value : fallback} disabled={disabled}
          onChange={e => onChange(e.target.value)} aria-label={`${label} picker`} />
        <input className="inp mono" style={{ maxWidth: 130 }} value={value} disabled={disabled} maxLength={7}
          onChange={e => { let v = e.target.value.trim(); if (v && !v.startsWith('#')) v = '#' + v; onChange(v) }} aria-label={`${label} hex`} />
        {value.toLowerCase() !== fallback.toLowerCase() && !disabled && (
          <button type="button" className="chip" onClick={() => onChange(fallback)}>Use the default</button>
        )}
      </div>
      <FieldError>{value && !valid ? 'Use #RRGGBB, for example #2563eb' : ''}</FieldError>
    </div>
  )
}

/** The share page header as a recipient sees it, in the chosen colours. */
function SharePreview({ name, logo, primary, secondary }: { name: string; logo: string; primary: string; secondary: string }) {
  const p = HEX.test(primary) ? primary : '#2563eb'
  const s = HEX.test(secondary) ? secondary : '#eef2ff'
  const sInk = lum(s) > 0.45 ? '#1e293b' : '#ffffff'
  return (
    <div className="share-preview" aria-label="Preview of the share page">
      <div className="sp-top">
        <div className="sp-brand">{logo ? <img src={logo} alt="" /> : <><span className="sp-logo" style={{ background: p }} />{name}</>}</div>
        <span className="sp-pill">Private share</span>
      </div>
      <div className="sp-info" style={{ background: s, color: sInk, borderColor: lum(s) > 0.45 ? 'rgba(15,23,42,.1)' : 'rgba(255,255,255,.25)' }}>
        Secure preview shared with you · access expires in <b>7 days</b>
      </div>
      <div className="sp-title">Evening News, 17 October</div>
      <div className="sp-player"><span className="sp-badge">PREVIEW</span><span className="sp-play" style={{ background: p, color: inkOn(p) }}>▶</span></div>
      <div className="sp-under">
        <span className="sp-btn">Metadata</span>
        <span className="sp-btn" style={{ background: p, borderColor: p, color: inkOn(p) }}>Download hi-res</span>
      </div>
    </div>
  )
}


/* ============================================================================
   WHERE THE ACCOUNT'S CONTENT CAN BE WATCHED. One account-wide rule above every
   other: channels, events, stations, on-demand assets and share links. A
   country blocked here cannot be let back in by a channel or an access rule.
   ========================================================================== */
type Geo = { mode: 'block' | 'allow'; countries: string[] } | null
/**
 * TRICK-PLAY (build queue 3.2b): I-frame playlists for the players that scrub
 * and fast-forward with them (AVPlayer on Apple devices and Safari, many
 * smart TVs). Off by default, per output profile; the account default is what
 * a new profile starts with. Each switch saves on its own: there is nothing
 * to discard, and the change reaches the profile's media within a minute.
 */
function TrickPlayCard({ accountDefault, canEdit, onSaved }: { accountDefault: boolean; canEdit: boolean; onSaved: (a: AS) => void }) {
  const [profiles, setProfiles] = useState<{ id: string; name: string; trick_play?: boolean; rungs?: { height: number }[] }[] | null>(null)
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState('')
  const notify = useNotify()
  useEffect(() => { api.outputProfiles().then(setProfiles).catch(e => setErr(e?.message || 'Could not load the output profiles')) }, [])
  async function setDefault(on: boolean) {
    setBusy('default'); setErr('')
    try { onSaved(await api.patchAccountSettings({ trickPlayDefault: on })); notify({ kind: 'ok', message: on ? 'New output profiles start with trick-play on.' : 'New output profiles start with trick-play off.' }) }
    catch (e: any) { setErr(e?.message || 'Could not save') } finally { setBusy('') }
  }
  async function setProfile(id: string, name: string, on: boolean) {
    setBusy(id); setErr('')
    try {
      const r = await api.patchOutputProfile(id, { trickPlay: on })
      setProfiles(ps => (ps ?? []).map(p => p.id === id ? { ...p, trick_play: r.trick_play } : p))
      notify({ kind: 'ok', message: on
        ? `Trick-play is on for ${name}. Its on-demand media gets I-frame playlists within a few minutes, without a re-encode; its live channels and events from their next start.`
        : `Trick-play is off for ${name}. Its media no longer lists I-frame playlists.` })
    } catch (e: any) { setErr(e?.message || 'Could not save') } finally { setBusy('') }
  }
  const sw = (on: boolean, key: string, label: string, onPress: () => void) => (
    <div className={`sw ${on ? '' : 'off'}`} role="switch" aria-checked={on} aria-label={label}
      aria-disabled={!canEdit || busy === key || undefined} tabIndex={canEdit ? 0 : -1}
      onClick={() => { if (canEdit && !busy) onPress() }}
      onKeyDown={e => { if ((e.key === ' ' || e.key === 'Enter') && canEdit && !busy) { e.preventDefault(); onPress() } }}
      style={!canEdit ? { cursor: 'default', opacity: .6 } : undefined}><i /></div>
  )
  return (
    <div className="card trickplay-card" style={{ padding: 18, marginTop: 20 }}>
      <div className="sec-label" style={{ marginTop: 0 }}>Trick-play for Apple and smart-TV players</div>
      <div className="hintxt" style={{ marginTop: 0, marginBottom: 12 }}>
        Apple devices, Safari and many smart TVs show pictures while scrubbing and fast-forwarding from a keyframe list (I-frame playlists).
        With it on, Volt lists one for on-demand media made with that output profile, and for its live channels and events from their next start, read from the segments it already has: nothing is re-encoded.
        The Volt web player scrubs with its own preview images either way. Off by default.
      </div>
      <div className="toggle-row">
        <div><div className="tt">New output profiles start with it on</div><div className="td">Profiles that exist keep their own setting.</div></div>
        {sw(accountDefault, 'default', 'New output profiles start with trick-play on', () => setDefault(!accountDefault))}
      </div>
      {profiles === null && !err && <div className="loading" style={{ padding: 8 }}>Loading…</div>}
      {profiles?.length === 0 && <div className="hintxt">No output profiles yet. Each channel group has one (Channel Groups).</div>}
      {profiles?.map(p => {
        const heights = (p.rungs ?? []).map(r => r.height).filter(Boolean)
        return (
          <div className="toggle-row" key={p.id}>
            <div><div className="tt">{p.name}</div>{heights.length > 0 && <div className="td">{heights.map(h => `${h}p`).join(' · ')}</div>}</div>
            {sw(!!p.trick_play, p.id, `Trick-play for ${p.name}`, () => setProfile(p.id, p.name, !p.trick_play))}
          </div>
        )
      })}
      {!canEdit && <div className="hintxt">Account administrators and owners change these settings.</div>}
      <FormStatus error={err} />
    </div>
  )
}

function GeoAccessCard({ value, canEdit, onSaved }: { value: Geo; canEdit: boolean; onSaved: (a: AS) => void }) {
  const [mode, setMode] = useState<'anywhere' | 'block' | 'allow'>(value ? value.mode : 'anywhere')
  const [list, setList] = useState<string[]>(value?.countries ?? [])
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const notify = useNotify()
  useEffect(() => { setMode(value ? value.mode : 'anywhere'); setList(value?.countries ?? []) }, [JSON.stringify(value)])
  const add = (t: string) => {
    const c = toCountryCode(t)
    if (!c) { setErr(t.trim() ? `"${t.trim()}" is not a country: pick one from the list or type its two-letter code` : ''); return }
    setErr(''); setText(''); setList(l => l.includes(c) ? l : [...l, c])
  }
  const next: Geo = mode === 'anywhere' ? null : { mode, countries: list }
  const dirty = JSON.stringify(next) !== JSON.stringify(value)
  const invalid = mode !== 'anywhere' && list.length === 0
  async function save() {
    setBusy(true); setErr('')
    try {
      const out = await api.patchAccountSettings({ geoAccess: next })
      onSaved(out)
      notify({ kind: 'ok', message: next ? `Saved. ${next.mode === 'block' ? 'Nothing of this account plays in' : 'This account plays only in'} ${next.countries.map(countryName).join(', ')}, everywhere: channels, events, stations, on demand and share links.` : 'Saved. No account-wide geo restriction.' })
    } catch (e: any) { setErr(e?.message || 'Could not save') } finally { setBusy(false) }
  }
  return (
    <div className="card" style={{ padding: 18, marginTop: 20 }}>
      <div className="sec-label" style={{ marginTop: 0 }}>Where content can be watched</div>
      <div className="hintxt" style={{ marginTop: 0, marginBottom: 12 }}>One rule above all others, for everything this account has: channels, events, radio stations, on-demand assets and share links. A channel's geo setting or an access rule can narrow it further, never open it up.</div>
      <div className="field"><label>Account-wide</label>
        <select className="inp" value={mode} disabled={!canEdit} onChange={e => setMode(e.target.value as any)} style={{ maxWidth: 360 }}>
          <option value="anywhere">Anywhere (no account-wide restriction)</option>
          <option value="block">Everywhere except these countries</option>
          <option value="allow">Only in these countries</option>
        </select>
      </div>
      {mode !== 'anywhere' && (
        <div className="field">
          <label>{mode === 'block' ? 'Blocked countries' : 'Allowed countries'}</label>
          <div className="geo-chips">
            {list.map(c => (
              <span key={c} className={`geo-chip ${mode}`}>{countryName(c)} <span className="cc">{c}</span>
                {canEdit && <button type="button" aria-label={`Remove ${countryName(c)}`} onClick={() => setList(l => l.filter(x => x !== c))}>✕</button>}
              </span>
            ))}
            {list.length === 0 && <span className="hintxt" style={{ margin: 0 }}>No countries yet.</span>}
          </div>
          {canEdit && (
            <div className="colour-row" style={{ marginTop: 8 }}>
              <input className="inp" list="geo-country-list" placeholder="Type a country or its code, then Enter" value={text} style={{ maxWidth: 340 }}
                onChange={e => { setText(e.target.value); if (toCountryCode(e.target.value) && /\([A-Z]{2}\)$/.test(e.target.value)) add(e.target.value) }}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add(text) } }} />
              <button type="button" className="chip" onClick={() => add(text)} disabled={!text.trim()}>Add</button>
              <datalist id="geo-country-list">{COUNTRIES.map(c => <option key={c.code} value={`${c.name} (${c.code})`} />)}</datalist>
            </div>
          )}
          <FieldError>{err}</FieldError>
          {mode === 'allow' && <div className="hintxt">A viewer whose country cannot be told is not let in by an allow list.</div>}
        </div>
      )}
      {canEdit && (
        <div className="acct-actions">
          <FormStatus blocked={invalid ? 'Add at least one country, or choose Anywhere.' : undefined} />
          <button className="btn ghost" disabled={!dirty || busy} onClick={() => { setMode(value ? value.mode : 'anywhere'); setList(value?.countries ?? []); setErr('') }}>Discard</button>
          <button className="btn primary" disabled={!dirty || invalid || busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      )}
    </div>
  )
}

export default function AccountSettings() {
  const [a, setA] = useState<AS | null>(null)
  const [err, setErr] = useState('')
  const [logo, setLogo] = useState('')
  const [primary, setPrimary] = useState('')
  const [secondary, setSecondary] = useState('')
  const [busy, setBusy] = useState(false)
  const [saveErr, setSaveErr] = useState('')
  const notify = useNotify()
  const seed = (x: AS) => { setA(x); setLogo(x.logo ?? ''); setPrimary(x.primary); setSecondary(x.secondary) }
  const load = () => api.accountSettings().then(x => { seed(x); setErr('') }).catch((e: any) => setErr(e?.message || 'Could not load the account settings'))
  useEffect(() => { load() }, [])
  usePageNotice('load', err ? { kind: 'error', title: "Couldn't load the account settings.", message: err, actions: [{ label: 'Retry', onClick: () => { load() } }] } : null)
  usePageNotice('who', a && !a.canEdit ? { kind: 'info', message: a.editReason ?? 'You can see these settings but not change them.' } : null)

  const dirty = !!a && (logo !== (a.logo ?? '') || primary.toLowerCase() !== a.primary.toLowerCase() || secondary.toLowerCase() !== a.secondary.toLowerCase())
  const valid = HEX.test(primary) && HEX.test(secondary)
  // Mid-tone: neither white nor dark text reaches the 4.5:1 that body text
  // needs. The bar used to be 2.2, which no colour can miss on both sides
  // (white and this dark text are about 18:1 apart, so one of the two is
  // always above 4.2), so the warning the guide promises never appeared.
  const lowContrast = useMemo(() => HEX.test(primary) && contrast(primary, '#ffffff') < 4.5 && contrast(primary, '#0f172a') < 4.5, [primary])

  async function save() {
    if (!a || !valid) return
    setBusy(true); setSaveErr('')
    try {
      const out = await api.patchAccountSettings({
        logo: logo.trim() || null,
        // the default colour is stored as "no custom colour", so a change of default later still applies
        primary: primary.toLowerCase() === a.defaults.primary ? null : primary.toLowerCase(),
        secondary: secondary.toLowerCase() === a.defaults.secondary ? null : secondary.toLowerCase(),
      })
      seed(out)
      notify({ kind: 'ok', message: 'Branding saved. Share pages use it from now on, including links already sent.' })
    } catch (e: any) { setSaveErr(e?.message || 'Could not save') } finally { setBusy(false) }
  }

  if (!a) return <><PageHead title="Account settings" sub="The account's logo and colours." />{!err && <div className="loading">Loading…</div>}</>
  const ro = !a.canEdit
  return (
    <>
      <PageHead title="Account settings" sub={`${a.name}: its logo and colours, and where its content can be watched.`}
        action={<button className="btn ghost" onClick={() => navigate('/plan')}>Plan &amp; limits</button>} />
      <div className="acct-grid">
        <div className="card" style={{ padding: 18 }}>
          <div className="sec-label" style={{ marginTop: 0 }}>Branding</div>
          {ro
            ? <div className="field"><label>Logo</label>{a.logo ? <img src={a.logo} alt="" className="acct-logo-ro" /> : <div className="hintxt">No logo: the account name is shown.</div>}</div>
            : <ImageRefField label="Logo" hint="shown at the top of the share page and on its PIN screen; a wide logo on a transparent background works best"
                value={logo} onChange={setLogo} pickerTitle="Choose or upload the account logo" kinds={['brand', 'other']} uploadFolder="brands" />}
          <ColourField label="Primary colour" hint="buttons, the play control, avatars" value={primary} onChange={setPrimary} fallback={a.defaults.primary} disabled={ro} />
          {lowContrast && <div className="hintxt" style={{ color: 'var(--warn)', marginTop: -6, marginBottom: 10 }}>This colour is mid-tone: text on it will be hard to read whatever its colour.</div>}
          <ColourField label="Secondary colour" hint="the information band and the access card" value={secondary} onChange={setSecondary} fallback={a.defaults.secondary} disabled={ro} />
          <div className="hintxt">Text on each colour is set to black or white automatically, whichever reads better.</div>
          {!ro && (
            <div className="acct-actions">
              <FormStatus error={saveErr} />
              <button className="btn ghost" disabled={!dirty || busy} onClick={() => seed(a)}>Discard</button>
              <button className="btn primary" disabled={!dirty || !valid || busy} onClick={save}>{busy ? 'Saving…' : 'Save branding'}</button>
            </div>
          )}
        </div>
        <div>
          <div className="sec-label" style={{ marginTop: 0 }}>Share page preview</div>
          <SharePreview name={a.name} logo={logo} primary={primary} secondary={secondary} />
          <div className="hintxt">What a recipient sees at the top of a share link. Links already sent pick up changes the next time they are opened.</div>
        </div>
      </div>
      <GeoAccessCard value={a.geoAccess} canEdit={a.canEdit} onSaved={seed} />
      <TrickPlayCard accountDefault={!!a.trickPlayDefault} canEdit={a.canEdit} onSaved={seed} />
    </>
  )
}
