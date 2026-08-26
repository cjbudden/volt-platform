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
// ============================================================================
import { useEffect, useState } from 'react'
import { api, type ShareLinkRow } from './api'

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

/* A PRIVATE preview link for a client/reviewer to approve before go-live. This is a
   SEPARATE workflow from on air / public playback: it is secured only by an optional
   PIN + an expiry (and an optional view cap), ignores geo/access rules, and plays the
   packaged output whenever the source is active — it does NOT publish the channel. */
const SHARE_PERIODS: { label: string; sec: number }[] = [
  { label: '1 day', sec: 86400 }, { label: '3 days', sec: 3 * 86400 },
  { label: '7 days', sec: 7 * 86400 }, { label: '14 days', sec: 14 * 86400 },
  { label: '30 days', sec: 30 * 86400 },
]
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
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(2,6,14,.6)', zIndex: 60, display: 'grid', placeItems: 'center', padding: 20 }}>
      <div onClick={e => e.stopPropagation()} style={{ width: 'min(560px,96vw)', maxHeight: '92vh', overflow: 'auto', background: 'var(--panel,#0e1420)', border: '1px solid var(--border)', borderRadius: 14, padding: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 4 }}>
          <h2 style={{ margin: 0, fontSize: 'var(--fs-h1)', letterSpacing: 'var(--ls-title)' }}>Share</h2>
          <div style={{ flex: 1 }} />
          <button className="btn ghost" onClick={onClose}>Close</button>
        </div>
        <p style={{ color: 'var(--muted)', marginTop: 4 }}>
          A private preview of <b>{target.name}</b> for a client or reviewer to approve before go-live.
          This does not put the {noun} on air and ignores geo/access rules.
        </p>

        {!created ? (
          <>
            <div style={{ display: 'grid', gap: 14, margin: '12px 0' }}>
              {/* 1 — delivery */}
              <div>
                <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)', marginBottom: 6 }}>How do you want to share it?</div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className={`btn ${delivery === 'link' ? 'primary' : 'ghost'}`} onClick={() => setDelivery('link')} style={{ flex: 1 }}
                    title="Create a URL you copy into your own email, WhatsApp or any app">Create a share URL</button>
                  <button className={`btn ${delivery === 'email' ? 'primary' : 'ghost'}`} onClick={() => setDelivery('email')} style={{ flex: 1 }}
                    title="The system emails the link, your message and viewing instructions to each recipient">Send by email</button>
                </div>
              </div>
              {(needRecipients) && (
                <label style={{ display: 'grid', gap: 5 }}>
                  <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)' }}>
                    Recipient email{delivery === 'email' ? 's (the system sends the invitation to each)' : ' (needed for email verification)'} — separate with commas
                  </span>
                  <input value={recipients} onChange={e => setRecipients(e.target.value)} placeholder="client@example.com, reviewer@example.com" />
                </label>
              )}
              <label style={{ display: 'grid', gap: 5 }}>
                <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)' }}>Message to recipient (optional{delivery === 'email' ? ', included in the email' : ''})</span>
                <textarea value={message} onChange={e => setMessage(e.target.value)} rows={2} placeholder="Please review and let me know if we're good to go live." style={{ resize: 'vertical' }} />
              </label>

              {/* 2 — expiry */}
              <div>
                <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)', marginBottom: 6 }}>When does the link expire?</div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                  <button className={`btn ${expiryMode === 'time' ? 'primary' : 'ghost'}`} onClick={() => setExpiryMode('time')}>After a period</button>
                  <button className={`btn ${expiryMode === 'views' ? 'primary' : 'ghost'}`} onClick={() => setExpiryMode('views')}>After a number of views</button>
                  {expiryMode === 'time' ? (
                    <select value={ttlSec} onChange={e => setTtlSec(Number(e.target.value))} style={{ flex: '1 1 130px' }}>
                      {SHARE_PERIODS.map(p => <option key={p.sec} value={p.sec}>{p.label}</option>)}
                    </select>
                  ) : (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <input value={maxViews} onChange={e => setMaxViews(e.target.value.replace(/[^0-9]/g, ''))} inputMode="numeric" style={{ width: 64 }} />
                      <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)' }}>view{Number(maxViews) === 1 ? '' : 's'} (1 = single open; 30-day backstop)</span>
                    </span>
                  )}
                </div>
              </div>

              {/* 3 — security */}
              <div>
                <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)', marginBottom: 6 }}>Who can open it?</div>
                <div style={{ display: 'grid', gap: 6 }}>
                  <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 'var(--fs-body)' }}>
                    <input type="radio" checked={authMode === 'none'} onChange={() => setAuthMode('none')} />
                    Anyone with the link
                  </label>
                  <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 'var(--fs-body)' }}>
                    <input type="radio" checked={authMode === 'pin'} onChange={() => setAuthMode('pin')} />
                    Anyone with the link and a PIN you set
                    {authMode === 'pin' && <input value={pin} onChange={e => setPin(e.target.value)} inputMode="numeric" placeholder="e.g. 4823" style={{ width: 90 }} />}
                  </label>
                  <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 'var(--fs-body)' }}>
                    <input type="radio" checked={authMode === 'email_pin'} onChange={() => setAuthMode('email_pin')} style={{ marginTop: 3 }} />
                    <span>Verified recipients only (most secure): the viewer confirms the email the link was sent to, receives a one-time code by email, and enters it to watch.</span>
                  </label>
                </div>
              </div>

              <label style={{ display: 'grid', gap: 5 }}>
                <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)' }}>Internal label (optional, only you see it)</span>
                <input value={label} onChange={e => setLabel(e.target.value)} placeholder="e.g. Client approval — cooking show" />
              </label>
            </div>
            {err && <div className="err" style={{ marginBottom: 10 }}>{err}</div>}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn ghost" onClick={onClose}>Cancel</button>
              <button className="btn primary" disabled={busy} onClick={create}>
                {busy ? (delivery === 'email' ? 'Sending…' : 'Creating…') : delivery === 'email' ? 'Create and send email' : 'Create share URL'}
              </button>
            </div>
          </>
        ) : (
          <div style={{ margin: '12px 0' }}>
            <div style={{ padding: '12px 14px', borderRadius: 10, background: 'rgba(74,222,128,.10)', border: '1px solid rgba(74,222,128,.4)', marginBottom: 12 }}>
              <div style={{ fontWeight: 700, color: '#4ade80', marginBottom: 6 }}>
                {created.emailed > 0 ? `Invitation emailed to ${created.emailed} recipient${created.emailed === 1 ? '' : 's'}` : 'Share URL created'}
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <code style={{ flex: 1, fontSize: 'var(--fs-sm)', wordBreak: 'break-all', background: 'rgba(148,163,184,.12)', padding: '8px 10px', borderRadius: 8 }}>{created.url}</code>
                <button className="btn primary" onClick={copy} style={{ whiteSpace: 'nowrap' }}>{copied ? 'Copied' : 'Copy'}</button>
              </div>
              <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)', marginTop: 8 }}>
                Expires {new Date(created.expiresAt).toLocaleString()}
                {expiryMode === 'views' ? ` or after ${Math.max(1, Number(maxViews) || 1)} view${Number(maxViews) === 1 ? '' : 's'}, whichever comes first` : ''}
                {authMode === 'pin' ? ' · PIN protected (share the PIN separately)' : authMode === 'email_pin' ? ' · verified recipients only' : ''}. The full link is shown once here.
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn ghost" onClick={() => { setCreated(null); setPin(''); setLabel(''); setMessage(''); setMaxViews('1'); setRecipients('') }}>Create another</button>
              <button className="btn primary" onClick={onClose}>Done</button>
            </div>
          </div>
        )}

        {links.length > 0 && (
          <div style={{ marginTop: 8, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
            <h3 style={{ margin: '0 0 8px', fontSize: 'var(--fs-h3)' }}>Existing links for this {noun}</h3>
            {links.map(l => (
              <div key={l.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderTop: '1px solid var(--border)', fontSize: 'var(--fs-sm)' }}>
                <span className={`dot-s ${l.revoked ? 'idle' : new Date(l.expires_at).getTime() < Date.now() ? 'warn' : 'live'}`} />
                <div style={{ flex: 1, minWidth: 0 }}>
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

