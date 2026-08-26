/* ------------------------------------------------------- share preview link */
/* A PRIVATE preview link for a client/reviewer to approve before go-live. This is a
   SEPARATE workflow from on air / public playback: it is secured only by an optional
   PIN + an expiry (and an optional view cap), ignores geo/access rules, and plays the
   packaged output whenever the source is active — it does NOT publish the channel.

   Two steps: set the link up, then the created link (URL + QR + who it went to). The
   raw URL exists only at that moment — we store a hash — so it is shown once and can
   only be re-issued by regenerating the token. */
const SHARE_PERIODS: { label: string; sec: number }[] = [
  { label: '1 day', sec: 86400 }, { label: '3 days', sec: 3 * 86400 },
  { label: '7 days', sec: 7 * 86400 }, { label: '14 days', sec: 14 * 86400 },
  { label: '30 days', sec: 30 * 86400 },
]
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
function absUrl(u: string) { return /^https?:\/\//i.test(u) ? u : `${location.origin}${u}` }
/** "in 6 days" / "in 4 hours" / "expired" — the number that actually matters here. */
function untilLabel(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now()
  if (ms <= 0) return 'expired'
  const h = ms / 3600000
  if (h < 1) return `in ${Math.max(1, Math.round(ms / 60000))} min`
  if (h < 48) return `in ${Math.round(h)} h`
  return `in ${Math.round(h / 24)} days`
}
/** local datetime-local value (no seconds) for an ISO instant */
function toLocalInput(iso: string): string {
  const d = new Date(iso)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

function ShareDrawer({ d, onClose }: { d: CD; onClose: () => void }) {
  // --- step 1: set up -------------------------------------------------------
  const [label, setLabel] = useState('')
  const [ttlSec, setTtlSec] = useState(7 * 86400)
  const [customExpiry, setCustomExpiry] = useState('')          // datetime-local, '' = use the preset
  const [recipients, setRecipients] = useState<string[]>([])
  const [recipInput, setRecipInput] = useState('')
  const [sendEmail, setSendEmail] = useState(true)
  const [pin, setPin] = useState('')
  const [maxViews, setMaxViews] = useState('')
  const [message, setMessage] = useState('')
  const [watermark, setWatermark] = useState(true)
  const [notifyOnOpen, setNotifyOnOpen] = useState(true)

  // --- step 2: the created link --------------------------------------------
  const [created, setCreated] = useState<(ShareCreated & { pinShown?: string }) | null>(null)
  const [copied, setCopied] = useState(false)

  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [links, setLinks] = useState<ShareLinkRow[]>([])
  const [showLinks, setShowLinks] = useState(false)

  async function loadLinks() {
    try { setLinks(await api.shareLinks({ resourceKind: 'channel', resourceId: d.id })) } catch { /* ignore */ }
  }
  useEffect(() => { loadLinks() /* eslint-disable-next-line */ }, [d.id])

  function addRecipient(raw?: string) {
    const parts = (raw ?? recipInput).split(/[,;\s]+/).map(s => s.trim()).filter(Boolean)
    if (!parts.length) return
    const bad = parts.find(p => !EMAIL_RE.test(p))
    if (bad) { setErr(`"${bad}" is not a valid email address`); return }
    setRecipients(r => Array.from(new Set([...r, ...parts])))
    setRecipInput(''); setErr('')
  }
  const expiresAtIso = customExpiry ? new Date(customExpiry).toISOString() : undefined
  const pinOk = !pin.trim() || pin.trim().length >= 3

  async function create() {
    if (!pinOk) { setErr('A PIN needs at least 3 characters — or leave it empty for no PIN.'); return }
    setBusy(true); setErr('')
    try {
      const out = await api.createShareLink({
        resourceKind: 'channel', resourceId: d.id,
        ...(expiresAtIso ? { expiresAt: expiresAtIso } : { ttlSec }),
        label: label || undefined, message: message || undefined,
        recipients: recipients.length ? recipients : undefined,
        sendEmail: sendEmail && recipients.length > 0,
        watermark, notifyOnOpen,
        pin: pin.trim() ? pin.trim() : undefined,
        maxViews: maxViews.trim() ? Number(maxViews) : null,
      })
      setCreated({ ...out, url: absUrl(out.url), pinShown: pin.trim() || undefined })
      await loadLinks()
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }

  async function copy(text: string) {
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1600) } catch { /* ignore */ }
  }
  async function extend(l: ShareLinkRow, sec: number) {
    setErr('')
    try { await api.updateShareLink(l.id, { extendSec: sec }); await loadLinks() } catch (e: any) { setErr(e.message) }
  }
  async function regenerate(l: ShareLinkRow) {
    if (!confirm('Regenerate this link?\n\nThe URL already sent stops working immediately and a new one is issued.')) return
    setBusy(true); setErr('')
    try {
      const out = await api.rotateShareLink(l.id, l.recipients?.length > 0)
      setCreated({ ...out, url: absUrl(out.url) })
      await loadLinks()
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }
  async function revoke(id: string) {
    try { await api.revokeShareLink(id); await loadLinks() } catch (e: any) { setErr(e.message) }
  }

  function resetForm() {
    setCreated(null); setPin(''); setLabel(''); setMessage(''); setMaxViews('')
    setRecipients([]); setRecipInput(''); setCustomExpiry('')
  }

  const live = links.filter(l => !l.revoked && new Date(l.expires_at).getTime() > Date.now())

  return (
    <div className="drawer-scrim" onClick={onClose}>
      <div className="drawer" onClick={e => e.stopPropagation()} style={{ width: 520 }}>
        <div className="drawer-h">
          <div className="t">{created ? 'Share link ready' : 'Share a preview'}</div>
          <button className="xbtn" onClick={onClose}>✕</button>
        </div>

        <div className="drawer-b">
          {/* what this is — the distinction from going on air matters */}
          <div style={{ display: 'flex', gap: 10, padding: '11px 13px', borderRadius: 11, background: 'var(--brand-dim)', border: '1px solid rgba(63,123,255,.32)', marginBottom: 16 }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="#9db8ff" strokeWidth="2" style={{ width: 16, height: 16, flex: 'none', marginTop: 2 }}>
              <circle cx="12" cy="12" r="10" /><path d="M12 16v-4M12 8h.01" />
            </svg>
            <div style={{ fontSize: 12.5, color: '#c8d5f5', lineHeight: 1.5 }}>
              A private link to preview <b>{d.name}</b> before go-live. Secured by an expiry and an optional PIN,
              it ignores geo and access rules, and does <b>not</b> put the channel on air.
            </div>
          </div>

          {!created ? (
            <>
              <div className="field">
                <label>Label <span style={{ color: 'var(--faint)', fontWeight: 500 }}>— internal, so you can tell links apart</span></label>
                <input className="inp" value={label} onChange={e => setLabel(e.target.value)} placeholder="e.g. Client approval — cooking show" />
              </div>

              <div style={SEC}>Who it goes to</div>
              <div className="field">
                <label>Recipients</label>
                {recipients.length > 0 && (
                  <div className="chipset" style={{ marginBottom: 8 }}>
                    {recipients.map(r => (
                      <span key={r} className="selchip sel" style={{ cursor: 'default' }}>
                        {r}
                        <button className="xbtn" style={{ fontSize: 13, lineHeight: 1, padding: 0 }} title="Remove"
                          onClick={() => setRecipients(list => list.filter(x => x !== r))}>✕</button>
                      </span>
                    ))}
                  </div>
                )}
                <div style={{ display: 'flex', gap: 8 }}>
                  <input className="inp" value={recipInput} onChange={e => setRecipInput(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addRecipient() } }}
                    onBlur={() => recipInput.trim() && addRecipient()}
                    placeholder="name@client.com — Enter to add" />
                  <button type="button" className="btn ghost" onClick={() => addRecipient()}>Add</button>
                </div>
                <div className="hintxt">Optional. Anyone with the link can open it, so recipients are a record of who you sent it to.</div>
              </div>
              <div className="toggle-row">
                <div>
                  <div className="tt">Email the link to them</div>
                  <div className="td">{recipients.length ? `Sends to ${recipients.length} recipient${recipients.length === 1 ? '' : 's'} now.` : 'Add a recipient to enable.'}</div>
                </div>
                <div className={`sw ${sendEmail && recipients.length ? '' : 'off'}`} onClick={() => recipients.length && setSendEmail(v => !v)} />
              </div>

              <div style={SEC}>How long it lives</div>
              <div className="field">
                <label>Expires</label>
                <div className="chipset">
                  {SHARE_PERIODS.map(p => (
                    <div key={p.sec} className={`selchip ${!customExpiry && ttlSec === p.sec ? 'sel' : ''}`}
                      onClick={() => { setTtlSec(p.sec); setCustomExpiry('') }}>{p.label}</div>
                  ))}
                  <div className={`selchip ${customExpiry ? 'sel' : ''}`}
                    onClick={() => setCustomExpiry(customExpiry ? '' : toLocalInput(new Date(Date.now() + ttlSec * 1000).toISOString()))}>
                    Pick a date
                  </div>
                </div>
                {customExpiry && (
                  <input className="inp" type="datetime-local" value={customExpiry} style={{ marginTop: 9 }}
                    min={toLocalInput(new Date(Date.now() + 60000).toISOString())}
                    onChange={e => setCustomExpiry(e.target.value)} />
                )}
                <div className="hintxt">
                  Dies {customExpiry ? new Date(customExpiry).toLocaleString() : new Date(Date.now() + ttlSec * 1000).toLocaleString()} — 90 days maximum.
                </div>
              </div>

              <div style={SEC}>Protection</div>
              <div className="field">
                <label>PIN <span style={{ color: 'var(--faint)', fontWeight: 500 }}>— optional, share it separately</span></label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input className="inp" value={pin} onChange={e => setPin(e.target.value)} inputMode="numeric" placeholder="No PIN" />
                  <button type="button" className="btn ghost" style={{ whiteSpace: 'nowrap' }}
                    onClick={() => setPin(String(Math.floor(1000 + Math.random() * 9000)))}>Generate</button>
                  {pin && <button type="button" className="btn ghost" onClick={() => setPin('')}>Clear</button>}
                </div>
                {!pinOk && <div className="err">At least 3 characters.</div>}
              </div>
              <div className="field">
                <label>View limit <span style={{ color: 'var(--faint)', fontWeight: 500 }}>— optional</span></label>
                <input className="inp" value={maxViews} inputMode="numeric" placeholder="Unlimited"
                  onChange={e => setMaxViews(e.target.value.replace(/[^0-9]/g, ''))} />
                <div className="hintxt">The link stops working after this many opens.</div>
              </div>
              <div className="toggle-row">
                <div>
                  <div className="tt">Watermark the preview</div>
                  <div className="td">Overlays who it was shared with, to discourage re-sharing.</div>
                </div>
                <div className={`sw ${watermark ? '' : 'off'}`} onClick={() => setWatermark(v => !v)} />
              </div>
              <div className="toggle-row">
                <div>
                  <div className="tt">Tell me when it is opened</div>
                  <div className="td">A notification the first time someone views it.</div>
                </div>
                <div className={`sw ${notifyOnOpen ? '' : 'off'}`} onClick={() => setNotifyOnOpen(v => !v)} />
              </div>

              <div style={SEC}>Message</div>
              <div className="field">
                <label>Note to the recipient <span style={{ color: 'var(--faint)', fontWeight: 500 }}>— optional</span></label>
                <textarea className="inp" value={message} rows={3} style={{ resize: 'vertical' }}
                  onChange={e => setMessage(e.target.value)}
                  placeholder="Please review and let me know if we're good to go live." />
                <div className="hintxt">Shown on the preview page, and in the email if you send one.</div>
              </div>
              {err && <div className="err">{err}</div>}
            </>
          ) : (
            <>
              <div style={{ padding: 16, borderRadius: 12, background: 'rgba(74,222,128,.08)', border: '1px solid rgba(74,222,128,.35)' }}>
                <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 700, color: '#4ade80', marginBottom: 8, fontSize: 13 }}>Copy it now — this is the only time it is shown</div>
                    <code style={{ display: 'block', fontSize: 12, wordBreak: 'break-all', background: 'rgba(148,163,184,.12)', padding: '9px 11px', borderRadius: 8, marginBottom: 10 }}>{created.url}</code>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button className="btn primary" onClick={() => copy(created.url)}>{copied ? 'Copied' : 'Copy link'}</button>
                      <a className="btn ghost" href={created.url} target="_blank" rel="noreferrer">Open</a>
                    </div>
                  </div>
                  <div style={{ flex: 'none', background: '#fff', padding: 6, borderRadius: 10 }}
                    title="Scan to open the preview on a phone or tablet"
                    dangerouslySetInnerHTML={{ __html: qrSvg(created.url, 118) }} />
                </div>
              </div>

              <div style={{ marginTop: 14 }}>
                <div className="kv"><span className="k">Expires</span><span className="v">{new Date(created.expiresAt).toLocaleString()} ({untilLabel(created.expiresAt)})</span></div>
                <div className="kv"><span className="k">PIN</span><span className="v">{created.pinShown ? `${created.pinShown} — send this separately` : 'None'}</span></div>
                <div className="kv"><span className="k">Emailed</span><span className="v">{created.sent ? `Sent to ${created.sent} recipient${created.sent === 1 ? '' : 's'}` : 'Not sent'}</span></div>
              </div>
              {err && <div className="err">{err}</div>}
            </>
          )}

          {/* existing links for this channel */}
          {links.length > 0 && (
            <div style={{ marginTop: 20, borderTop: '1px solid var(--border)', paddingTop: 14 }}>
              <button className="btn ghost" style={{ width: '100%', justifyContent: 'space-between' }} onClick={() => setShowLinks(v => !v)}>
                <span>Links for this channel — {live.length} active of {links.length}</span>
                <span style={{ color: 'var(--faint)' }}>{showLinks ? '▲' : '▼'}</span>
              </button>
              {showLinks && links.map(l => {
                const expired = new Date(l.expires_at).getTime() < Date.now()
                const cls = l.revoked ? 'idle' : expired ? 'warn' : 'live'
                const capped = l.max_views != null && l.view_count >= l.max_views
                return (
                  <div key={l.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '11px 0', borderBottom: '1px solid var(--border)', fontSize: 12.5 }}>
                    <span className={`dot-s ${cls}`} style={{ marginTop: 5 }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {l.label || `${l.token_prefix}…`}
                        {l.has_pin && <span className="tag idle" style={{ marginLeft: 7 }}>PIN</span>}
                        {capped && !l.revoked && <span className="tag warn" style={{ marginLeft: 7 }}>view limit hit</span>}
                      </div>
                      <div style={{ color: 'var(--faint)', marginTop: 3 }}>
                        {l.revoked ? 'Revoked' : expired ? 'Expired' : `Expires ${untilLabel(l.expires_at)}`}
                        {' · '}{l.view_count} view{l.view_count === 1 ? '' : 's'}{l.max_views != null ? ` of ${l.max_views}` : ''}
                        {l.last_viewed_at ? ` · last opened ${new Date(l.last_viewed_at).toLocaleDateString()}` : ' · never opened'}
                      </div>
                      {l.recipients?.length > 0 && (
                        <div style={{ color: 'var(--faint)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          Sent to {l.recipients.join(', ')}
                        </div>
                      )}
                      <div style={{ display: 'flex', gap: 6, marginTop: 7, flexWrap: 'wrap' }}>
                        {!l.revoked && <button className="btn ghost" style={SMALL_BTN} onClick={() => extend(l, 7 * 86400)}>Extend 7 days</button>}
                        <button className="btn ghost" style={SMALL_BTN} onClick={() => regenerate(l)} disabled={busy}>New URL</button>
                        {!l.revoked
                          ? <button className="btn ghost" style={{ ...SMALL_BTN, color: '#fca5a5', borderColor: 'rgba(248,113,113,.5)' }} onClick={() => revoke(l.id)}>Revoke</button>
                          : <span style={{ color: 'var(--faint)', alignSelf: 'center' }}>Regenerating also un-revokes</span>}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        <div className="drawer-f">
          {!created ? (
            <>
              <button className="btn ghost" onClick={onClose}>Cancel</button>
              <button className="btn primary" disabled={busy || !pinOk} onClick={create}>
                {busy ? 'Creating…' : sendEmail && recipients.length ? 'Create and send' : 'Create link'}
              </button>
            </>
          ) : (
            <>
              <button className="btn ghost" onClick={resetForm}>Create another</button>
              <button className="btn primary" onClick={onClose}>Done</button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
const SMALL_BTN: React.CSSProperties = { padding: '4px 10px', fontSize: 11.5 }

