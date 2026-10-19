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
  const lowContrast = useMemo(() => HEX.test(primary) && contrast(primary, '#ffffff') < 2.2 && contrast(primary, '#0f172a') < 2.2, [primary])

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
    </>
  )
}
