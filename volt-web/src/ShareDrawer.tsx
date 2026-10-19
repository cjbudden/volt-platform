// ============================================================================
//  SHARE — one private-preview flow for EVERY kind of stream.
//
//  A share link is a private, time-boxed preview of a channel, a radio station,
//  an event or a VOD asset, for a client or reviewer to approve BEFORE go-live.
//  It is not publishing: it ignores geo/access rules, does not put anything on
//  air, and can be revoked at any moment.
//
//  This lives in one place so Channels, Radio and Events cannot drift apart in
//  what sharing means or how it is secured.
//
//  LAYOUT — "Sections" (Direction A).
//  The form is four labelled sections in the order a person actually decides:
//     How to send it  →  How long it lasts  →  Who can open it  →  Label
//  Every mutually exclusive choice that needs an explanation is a full-width
//  CHOICE ROW (.choice), not an inline radio: the description is part of the
//  decision, so it has to be readable at a glance. Dependent inputs (recipients,
//  period, view count, PIN) are nested INSIDE the row they belong to, so the
//  form never shows a control whose owner is not selected.
// ============================================================================
import { useEffect, useState, type ReactNode } from 'react'
import { api, type ShareLinkRow } from './api'
import { pressable } from './a11y'
import { FormStatus } from './notices'

/** What is being shared. `kind` maps onto the API's resource kinds; radio
 *  stations ARE channels, so they share as a channel with radio wording. */
export interface ShareTarget {
  kind: 'channel' | 'event' | 'vod' | 'radio'
  id: string
  name: string
}

const NOUN: Record<ShareTarget['kind'], string> = {
  channel: 'channel', radio: 'station', event: 'event', vod: 'asset',
}

const SHARE_PERIODS: { label: string; sec: number }[] = [
  { label: '1 day', sec: 86400 }, { label: '3 days', sec: 3 * 86400 },
  { label: '7 days', sec: 7 * 86400 }, { label: '14 days', sec: 14 * 86400 },
  { label: '30 days', sec: 30 * 86400 },
]

/** One option in a mutually exclusive set: title, one line of plain English,
 *  and (when selected) the controls that option needs.
 *
 *  It is a div with role="radio", NOT a <button>: a selected row can contain a
 *  select or an input, and interactive content nested inside a button is invalid
 *  HTML that browsers handle inconsistently (the dropdown may refuse to open). */
function Choice({ on, onPick, title, desc, children }:
  { on: boolean; onPick: () => void; title: string; desc: string; children?: ReactNode }) {
  return (
    <div className={`choice ${on ? 'on' : ''}`} role="radio" aria-checked={on} tabIndex={0}
      onClick={onPick}
      onKeyDown={e => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); onPick() } }}>
      <span className="radio" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="t">{title}</div>
        <div className="d">{desc}</div>
        {on && children ? <div className="mt-2">{children}</div> : null}
      </div>
    </div>
  )
}

/** Stop clicks inside a nested control from re-triggering the row's onPick. */
function Nested({ children }: { children: ReactNode }) {
  return <div {...pressable((e: any) => { (((e: any) => e.stopPropagation()) as any)(e) })} data-a11y-click="" onKeyDown={e => e.stopPropagation()}>{children}</div>
}

export function ShareDrawer({ target, onClose }: { target: ShareTarget; onClose: () => void }) {
  const noun = NOUN[target.kind]
  const [label, setLabel] = useState('')
  // DELIVERY: 'link' = create a URL you copy into your own email/WhatsApp;
  //           'email' = the SYSTEM emails the link + your message + instructions.
  const [delivery, setDelivery] = useState<'link' | 'email'>('link')
  const [recipients, setRecipients] = useState('')
  const [message, setMessage] = useState('')
  // EXPIRY: by TIME (dropdown) or by VIEW COUNT (expires after N opens; 30-day backstop)
  const [expiryMode, setExpiryMode] = useState<'time' | 'views'>('time')
  const [ttlSec, setTtlSec] = useState(7 * 86400)
  const [maxViews, setMaxViews] = useState('1')
  // SECURITY: none | pin (you set it, share it separately) | email_pin (viewer confirms
  // the recipient email; a one-time PIN is emailed to them)
  const [authMode, setAuthMode] = useState<'none' | 'pin' | 'email_pin'>('none')
  const [pin, setPin] = useState('')
  const [busy, setBusy] = useState(false)
  const [created, setCreated] = useState<{ url: string; expiresAt: string; emailed: number } | null>(null)
  const [copied, setCopied] = useState(false)
  const [err, setErr] = useState('')
  const [links, setLinks] = useState<ShareLinkRow[]>([])

  const recipientList = recipients.split(/[\s,;]+/).map(s => s.trim()).filter(s => /.+@.+\..+/.test(s))
  const needRecipients = delivery === 'email' || authMode === 'email_pin'
  // Show the ACTUAL date the link dies, not just "7 days": the person is usually
  // checking it against a client deadline.
  const expiryDate = new Date(Date.now() + ttlSec * 1000).toLocaleDateString(undefined,
    { weekday: 'short', day: 'numeric', month: 'short' })

  async function loadLinks() {
    try { const all = await api.shareLinks(); setLinks(all.filter(l => l.resource_id === target.id)) } catch { /* ignore */ }
  }
  useEffect(() => { loadLinks() /* eslint-disable-next-line */ }, [target.id])

  async function create() {
    setErr('')
    if (needRecipients && recipientList.length === 0) { setErr('Add at least one recipient email address.'); return }
    if (authMode === 'pin' && pin.trim().length < 3) { setErr('Set a PIN of at least 3 characters, or choose a different security option.'); return }
    setBusy(true)
    try {
      const out = await api.createShareLink({
        resourceKind: target.kind === 'radio' ? 'channel' : target.kind, resourceId: target.id,
        ttlSec: expiryMode === 'time' ? ttlSec : 30 * 86400,   // view-capped links keep a 30-day backstop
        label: label || undefined, message: message || undefined,
        pin: authMode === 'pin' ? pin.trim() : undefined,
        maxViews: expiryMode === 'views' ? Math.max(1, Number(maxViews) || 1) : null,
        recipients: recipientList.length ? recipientList : undefined,
        authMode, sendEmail: delivery === 'email',
      })
      setCreated({ url: absUrl(out.url), expiresAt: out.expiresAt, emailed: out.emailed || 0 })
      await loadLinks()
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }
  function absUrl(u: string) { return /^https?:\/\//i.test(u) ? u : `${location.origin}${u}` }
  async function copy() { if (!created) return; try { await navigator.clipboard.writeText(created.url); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch { /* ignore */ } }
  async function revoke(id: string) { try { await api.revokeShareLink(id); await loadLinks() } catch (e: any) { setErr(e.message) } }

  return (
    <div {...pressable((e: any) => { ((onClose) as any)(e) })} data-a11y-click="" style={{ position: 'fixed', inset: 0, background: 'rgba(2,6,14,.6)', zIndex: 60, display: 'grid', placeItems: 'center', padding: 20 }}>
      <div {...pressable((e: any) => { (((e: any) => e.stopPropagation()) as any)(e) })} data-a11y-click="" style={{ width: 'min(560px,96vw)', maxHeight: '92vh', overflow: 'auto', background: 'var(--panel,#0e1420)', border: '1px solid var(--border)', borderRadius: 14, padding: 20 }}>
        <div className="flex items-center" style={{ marginBottom: 4 }}>
          <h2 style={{ margin: 0, fontSize: 'var(--fs-h1)', letterSpacing: 'var(--ls-title)' }}>Share</h2>
          <div className="flex-1" />
          <button className="btn ghost" onClick={onClose}>Close</button>
        </div>
        <p style={{ color: 'var(--muted)', marginTop: 4 }}>
          A private preview of <b>{target.name}</b> for a client or reviewer to approve before go-live.
          This does not put the {noun} on air and ignores geo/access rules.
        </p>

        {!created ? (
          <>
            {/* ---- 1. HOW TO SEND IT ------------------------------------- */}
            <div className="sec-label" style={{ marginTop: 16 }}>How to send it</div>
            <div className="choices" role="radiogroup">
              <Choice on={delivery === 'link'} onPick={() => setDelivery('link')}
                title="Create a link"
                desc="You get a URL to paste into your own email, WhatsApp or ticket." />
              <Choice on={delivery === 'email'} onPick={() => setDelivery('email')}
                title="Send by email"
                desc="VOLT emails the link, your message and viewing instructions to each recipient.">
                <Nested>
                  <input value={recipients} onChange={e => setRecipients(e.target.value)}
                    className="w-full" placeholder="client@example.com, reviewer@example.com" />
                  <div style={{ fontSize: 'var(--fs-micro)', color: 'var(--faint)', marginTop: 4 }}>
                    Separate addresses with commas.
                  </div>
                </Nested>
              </Choice>
            </div>
            {delivery === 'link' && authMode === 'email_pin' && (
              <label className="grid gap-1" style={{ marginTop: 8 }}>
                <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)' }}>Recipient emails (needed for verification) — separate with commas</span>
                <input value={recipients} onChange={e => setRecipients(e.target.value)} placeholder="client@example.com" />
              </label>
            )}
            <label className="grid gap-1" style={{ marginTop: 10 }}>
              <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)' }}>
                Message to recipient (optional{delivery === 'email' ? ', included in the email' : ''})
              </span>
              <textarea value={message} onChange={e => setMessage(e.target.value)} rows={2}
                placeholder="Please review and let me know if we're good to go live." style={{ resize: 'vertical' }} />
            </label>

            {/* ---- 2. HOW LONG IT LASTS --------------------------------- */}
            <div className="sec-label" style={{ marginTop: 18 }}>How long it lasts</div>
            <div className="choices" role="radiogroup">
              <Choice on={expiryMode === 'time'} onPick={() => setExpiryMode('time')}
                title="For a period"
                desc={`The link stops working on a fixed date, currently ${expiryDate}.`}>
                <Nested>
                  <select value={ttlSec} onChange={e => setTtlSec(Number(e.target.value))} style={{ width: 160 }}>
                    {SHARE_PERIODS.map(p => <option key={p.sec} value={p.sec}>{p.label}</option>)}
                  </select>
                </Nested>
              </Choice>
              <Choice on={expiryMode === 'views'} onPick={() => setExpiryMode('views')}
                title="For a number of views"
                desc="The link dies after it has been opened that many times. 30-day backstop.">
                <Nested>
                  <span className="flex items-center gap-2">
                    <input value={maxViews} onChange={e => setMaxViews(e.target.value.replace(/[^0-9]/g, ''))}
                      inputMode="numeric" style={{ width: 64 }} />
                    <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--faint)' }}>
                      view{Number(maxViews) === 1 ? ' (a single open)' : 's'}
                    </span>
                  </span>
                </Nested>
              </Choice>
            </div>

            {/* ---- 3. WHO CAN OPEN IT ----------------------------------- */}
            <div className="sec-label" style={{ marginTop: 18 }}>Who can open it</div>
            <div className="choices" role="radiogroup">
              <Choice on={authMode === 'none'} onPick={() => setAuthMode('none')}
                title="Anyone with the link"
                desc="No challenge. Anyone the link is forwarded to can watch." />
              <Choice on={authMode === 'pin'} onPick={() => setAuthMode('pin')}
                title="A PIN you set"
                desc="Viewers enter this PIN. Send it separately from the link.">
                <Nested>
                  <input value={pin} onChange={e => setPin(e.target.value)} inputMode="numeric"
                    placeholder="e.g. 4823" style={{ width: 110 }} />
                </Nested>
              </Choice>
              <Choice on={authMode === 'email_pin'} onPick={() => setAuthMode('email_pin')}
                title="Verified recipients only"
                desc="Most secure. The viewer confirms the email the link was sent to and enters a one-time code we email them." />
            </div>

            {/* ---- 4. LABEL --------------------------------------------- */}
            <div className="sec-label" style={{ marginTop: 18 }}>Label</div>
            <input value={label} onChange={e => setLabel(e.target.value)} className="w-full"
              placeholder="e.g. Client approval — cooking show" />
            <div style={{ fontSize: 'var(--fs-micro)', color: 'var(--faint)', marginTop: 4 }}>
              Internal only. It is how you will recognise this link in the list below.
            </div>

            <div className="modal-f">
              <FormStatus error={err} />
              <button className="btn ghost" onClick={onClose}>Cancel</button>
              <button className="btn primary" disabled={busy} onClick={create}>
                {busy ? (delivery === 'email' ? 'Sending…' : 'Creating…') : delivery === 'email' ? 'Create and send email' : 'Create link'}
              </button>
            </div>
          </>
        ) : (
          <div style={{ margin: '12px 0' }}>
            <div style={{ padding: '12px 14px', borderRadius: 10, background: 'rgba(74,222,128,.10)', border: '1px solid rgba(74,222,128,.4)', marginBottom: 12 }}>
              <div style={{ fontWeight: 700, color: '#4ade80', marginBottom: 6 }}>
                {created.emailed > 0 ? `Invitation emailed to ${created.emailed} recipient${created.emailed === 1 ? '' : 's'}` : 'Link created'}
              </div>
              <div className="flex items-center gap-2">
                <code style={{ flex: 1, fontSize: 'var(--fs-sm)', wordBreak: 'break-all', background: 'rgba(148,163,184,.12)', padding: '8px 10px', borderRadius: 8 }}>{created.url}</code>
                <button className="btn primary" onClick={copy} style={{ whiteSpace: 'nowrap' }}>{copied ? 'Copied' : 'Copy'}</button>
              </div>
              <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)', marginTop: 8 }}>
                Expires {new Date(created.expiresAt).toLocaleString()}
                {expiryMode === 'views' ? ` or after ${Math.max(1, Number(maxViews) || 1)} view${Number(maxViews) === 1 ? '' : 's'}, whichever comes first` : ''}
                {authMode === 'pin' ? ' · PIN protected (share the PIN separately)' : authMode === 'email_pin' ? ' · verified recipients only' : ''}. The full link is shown once here.
              </div>
            </div>
            <div className="flex gap-2 justify-end">
              <button className="btn ghost" onClick={() => { setCreated(null); setPin(''); setLabel(''); setMessage(''); setMaxViews('1'); setRecipients('') }}>Create another</button>
              <button className="btn primary" onClick={onClose}>Done</button>
            </div>
          </div>
        )}

        {links.length > 0 && (
          <div style={{ marginTop: 18, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
            <div className="sec-label" style={{ marginTop: 0 }}>Existing links for this {noun}</div>
            {links.map(l => (
              <div key={l.id} className="flex items-center gap-3" style={{ padding: '8px 0', borderTop: '1px solid var(--border)', fontSize: 'var(--fs-sm)' }}>
                <span className={`dot-s ${l.revoked ? 'idle' : new Date(l.expires_at).getTime() < Date.now() ? 'warn' : 'live'}`} />
                <div className="flex-1 min-w-0">
                  <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.label || l.token_prefix + '…'}</div>
                  <div style={{ color: 'var(--faint)' }}>{l.revoked ? 'revoked' : `expires ${new Date(l.expires_at).toLocaleDateString()}`} · {l.view_count} view{l.view_count === 1 ? '' : 's'}</div>
                </div>
                {!l.revoked && <button className="btn ghost" style={{ padding: '4px 10px', color: '#fca5a5', borderColor: 'rgba(248,113,113,.5)' }} onClick={() => revoke(l.id)}>Revoke</button>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
