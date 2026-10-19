import { useEffect, useState } from 'react'
import { api, type NotificationConfig, type NotificationRow, type DeliveryRow, type NotificationTemplate } from '../api'
import { PageHead } from '../scaffold'
import { FormStatus, useNotify, usePageNotice } from '../notices'

/* ============================================================================
   NOTIFICATIONS (Admin). What can be delivered here, what was sent and what
   happened to each copy, and the templates.

   The delivery log is the part that matters operationally. Every message fans
   out to one delivery per recipient and channel, and each delivery has its own
   fate: sent, retrying on the backoff, or given up with the reason (a rejected
   address, a dead device, a channel that is not configured). Retry acts on one
   delivery now; it never retries something that was given up, because the
   reasons for giving up are the ones a retry cannot fix.
   ========================================================================== */
const CH_LABEL: Record<string, string> = { in_app: 'Console inbox', email: 'Email', push: 'Device push' }
const fmt = (iso: string | null) => iso ? new Date(iso).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''

function deliveryState(d: DeliveryRow): { label: string; cls: string } {
  if (d.status === 'sent') return { label: 'Sent', cls: 'ok' }
  if (d.gave_up_at) return { label: 'Gave up', cls: 'bad' }
  if (d.status === 'failed') return { label: `Retrying ${d.next_attempt_at ? fmt(d.next_attempt_at) : ''}`.trim(), cls: 'warn' }
  return { label: 'Pending', cls: 'muted' }
}

export default function NotificationsPage() {
  const [cfg, setCfg] = useState<NotificationConfig | null>(null)
  const [rows, setRows] = useState<NotificationRow[] | null>(null)
  const [open, setOpen] = useState<Record<string, DeliveryRow[] | 'loading'>>({})
  const [templates, setTemplates] = useState<NotificationTemplate[] | null>(null)
  const [devices, setDevices] = useState<Awaited<ReturnType<typeof api.myDevices>> | null>(null)
  const [testMsg, setTestMsg] = useState<Record<string, string>>({})
  const [err, setErr] = useState('')
  const [tplErr, setTplErr] = useState('')
  const notify = useNotify()
  const fail = (e: any) => notify({ kind: 'error', message: e.message })
  const [tplEdit, setTplEdit] = useState<{ id?: string; key: string; subject: string; body: string } | null>(null)

  const load = () => {
    api.notificationConfig().then(setCfg).catch(e => setErr(e.message))
    api.notifications().then(setRows).catch(e => setErr(e.message))
    api.notificationTemplates().then(setTemplates).catch(() => setTemplates([]))
    api.myDevices().then(setDevices).catch(() => setDevices([]))
  }
  useEffect(load, [])

  async function toggle(id: string) {
    if (open[id]) { setOpen(o => { const n = { ...o }; delete n[id]; return n }); return }
    setOpen(o => ({ ...o, [id]: 'loading' }))
    try { const n = await api.notification(id); setOpen(o => ({ ...o, [id]: n.deliveries })) }
    catch (e: any) { fail(e) }
  }
  async function retry(nid: string, d: DeliveryRow) {
    try {
      await api.retryDelivery(d.id)
      const n = await api.notification(nid); setOpen(o => ({ ...o, [nid]: n.deliveries }))
      api.notifications().then(setRows)
    } catch (e: any) { fail(e) }
  }
  async function test(ch: 'email' | 'in_app' | 'push') {
    setTestMsg(m => ({ ...m, [ch]: 'Sending…' }))
    try {
      const r = await api.testNotification(ch)
      setTestMsg(m => ({ ...m, [ch]: r.status === 'sent' ? 'Sent to you. Check it arrived.' : `Not delivered: ${r.error ?? r.status}` }))
      api.notifications().then(setRows)
    } catch (e: any) { setTestMsg(m => ({ ...m, [ch]: e.message })) }
  }
  async function saveTpl() {
    if (!tplEdit) return
    setTplErr('')
    try {
      if (tplEdit.id) await api.updateNotificationTemplate(tplEdit.id, { subject: tplEdit.subject, body: tplEdit.body })
      else await api.createNotificationTemplate({ key: tplEdit.key.trim(), subject: tplEdit.subject, body: tplEdit.body })
      setTplEdit(null); api.notificationTemplates().then(setTemplates)
    } catch (e: any) { setTplErr(e.message) }
  }
  usePageNotice('load', err ? { kind: 'error', title: "Couldn't load notifications.", message: err, actions: [{ label: 'Retry', onClick: () => { setErr(''); load() } }] } : null)

  return (
    <>
      <PageHead title="Notifications" sub="Alerts Volt sends to the people who run this account: when auto connect gives up, an EPG import fails or a post cannot be published. Every message goes to the console inbox, and by email and device push where those are set up." />

      <div className="sec-label">Delivery channels</div>
      <div className="card" style={{ padding: 0 }}>
        {!cfg ? <div className="loading" style={{ padding: 14 }}>Loading…</div> : (['in_app', 'email', 'push'] as const).map((ch, i) => (
          <div key={ch} className="nt-row" style={{ borderTop: i ? '1px solid var(--border)' : undefined }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600 }}>{CH_LABEL[ch]} <span className={`nt-pill ${cfg.channels[ch].configured ? 'ok' : 'muted'}`}>{cfg.channels[ch].configured ? 'Ready' : 'Not set up'}</span></div>
              <div className="hintxt" style={{ marginTop: 2 }}>{cfg.channels[ch].detail}</div>
              {testMsg[ch] && <div className="hintxt" style={{ marginTop: 2, color: 'var(--text)' }}>{testMsg[ch]}</div>}
            </div>
            <button className="btn ghost" onClick={() => test(ch)}>Send me a test</button>
          </div>
        ))}
      </div>
      {cfg && <div className="hintxt" style={{ marginTop: 6 }}>A failed delivery is retried after {cfg.backoffMinutes.join(', ')} minutes, up to {cfg.maxAttempts} attempts. A rejected address or a dead device is not retried.</div>}

      <div className="sec-label" style={{ marginTop: 22, display: 'flex', alignItems: 'center' }}>
        <span>Sent</span><div style={{ flex: 1 }} />
        {rows?.some(r => r.retrying > 0) && <button className="btn ghost" onClick={() => api.retryAllDeliveries().then(load)}>Retry everything now</button>}
      </div>
      <div className="card" style={{ padding: 0 }}>
        {rows === null ? <div className="loading" style={{ padding: 14 }}>Loading…</div> : rows.length === 0 ? (
          <div className="hintxt" style={{ padding: 14 }}>Nothing sent yet. Use Send me a test above to try a channel.</div>
        ) : rows.map((n, i) => {
          const o = open[n.id]
          return (
            <div key={n.id} style={{ borderTop: i ? '1px solid var(--border)' : undefined }}>
              <div className="nt-row" style={{ cursor: 'pointer' }} onClick={() => toggle(n.id)}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{n.subject}</div>
                  <div className="hintxt" style={{ marginTop: 2 }}>{fmt(n.created_at)} · {n.topic}</div>
                </div>
                <div className="nt-counts">
                  <span className="nt-pill ok">{n.sent} sent</span>
                  {n.retrying > 0 && <span className="nt-pill warn">{n.retrying} retrying</span>}
                  {n.gave_up > 0 && <span className="nt-pill bad">{n.gave_up} gave up</span>}
                </div>
                <span style={{ color: 'var(--faint)', width: 14, textAlign: 'center' }}>{o ? '▾' : '▸'}</span>
              </div>
              {o === 'loading' && <div className="loading" style={{ padding: '0 14px 12px' }}>Loading deliveries…</div>}
              {Array.isArray(o) && (
                <div style={{ padding: '0 14px 12px' }}>
                  {n.body && <div className="nt-body">{n.body}</div>}
                  <table>
                    <thead><tr><th>Recipient</th><th>Channel</th><th>Status</th><th>Attempts</th><th></th></tr></thead>
                    <tbody>
                      {o.map(d => {
                        const st = deliveryState(d)
                        return (
                          <tr key={d.id}>
                            <td style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.recipient}</td>
                            <td style={{ color: 'var(--muted)' }}>{CH_LABEL[d.channel]}</td>
                            <td><span className={`nt-pill ${st.cls}`}>{st.label}</span>{d.last_error && <div className="hintxt" style={{ marginTop: 3, maxWidth: 340 }}>{d.last_error}</div>}</td>
                            <td style={{ color: 'var(--muted)' }}>{d.attempts}</td>
                            <td style={{ textAlign: 'right' }}>{d.status === 'failed' && !d.gave_up_at && <button className="btn ghost" onClick={() => retry(n.id, d)}>Retry now</button>}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )
        })}
      </div>

      <div className="sec-label" style={{ marginTop: 22, display: 'flex', alignItems: 'center' }}>
        <span>Templates</span><div style={{ flex: 1 }} />
        {!tplEdit && <button className="btn ghost" onClick={() => setTplEdit({ key: '', subject: '', body: '' })}>New template</button>}
      </div>
      <div className="hintxt" style={{ marginBottom: 8 }}>Wording for messages sent through the API with a template key. Use {'{{name}}'} style placeholders filled from the message's payload.</div>
      {tplEdit && (
        <div className="card" style={{ padding: 14, marginBottom: 10 }}>
          <div className="field"><label>Key</label>
            <input className="inp" value={tplEdit.key} disabled={!!tplEdit.id} onChange={e => setTplEdit({ ...tplEdit, key: e.target.value })} placeholder="event.reminder" style={{ fontFamily: 'ui-monospace,monospace' }} />
          </div>
          <div className="field"><label>Subject</label><input className="inp" value={tplEdit.subject} onChange={e => setTplEdit({ ...tplEdit, subject: e.target.value })} placeholder="Reminder: {{name}} starts at {{time}}" /></div>
          <div className="field"><label>Body</label><textarea className="inp" rows={4} value={tplEdit.body} onChange={e => setTplEdit({ ...tplEdit, body: e.target.value })} /></div>
          <div className="modal-f">
            <FormStatus error={tplErr} />
            <button className="btn ghost" onClick={() => { setTplEdit(null); setTplErr('') }}>Cancel</button>
            <button className="btn primary" disabled={!tplEdit.key.trim() || !tplEdit.subject.trim() || !tplEdit.body.trim()} onClick={saveTpl}>Save template</button>
          </div>
        </div>
      )}
      <div className="card" style={{ padding: 0 }}>
        {templates === null ? <div className="loading" style={{ padding: 14 }}>Loading…</div> : templates.length === 0 ? (
          <div className="hintxt" style={{ padding: 14 }}>No templates.</div>
        ) : templates.map((t, i) => (
          <div key={t.id} className="nt-row" style={{ borderTop: i ? '1px solid var(--border)' : undefined }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontFamily: 'ui-monospace,monospace', fontSize: 'var(--fs-sm)' }}>{t.key}</div>
              <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.subject}</div>
            </div>
            <button className="btn ghost" onClick={() => setTplEdit({ id: t.id, key: t.key, subject: t.subject, body: t.body })}>Edit</button>
            <button className="btn ghost" onClick={() => { if (window.confirm(`Delete the template "${t.key}"?`)) api.deleteNotificationTemplate(t.id).then(() => api.notificationTemplates().then(setTemplates)).catch(fail) }}>Delete</button>
          </div>
        ))}
      </div>

      <div className="sec-label" style={{ marginTop: 22 }}>Your devices</div>
      <div className="hintxt" style={{ marginBottom: 8 }}>Phones and tablets signed in to the Volt management app with notifications allowed. Push alerts for you go to these.</div>
      <div className="card" style={{ padding: 0 }}>
        {devices === null ? <div className="loading" style={{ padding: 14 }}>Loading…</div> : devices.length === 0 ? (
          <div className="hintxt" style={{ padding: 14 }}>No devices registered.</div>
        ) : devices.map((d, i) => (
          <div key={d.id} className="nt-row" style={{ borderTop: i ? '1px solid var(--border)' : undefined }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600 }}>{d.label || (d.platform === 'ios' ? 'iPhone or iPad' : d.platform === 'android' ? 'Android device' : 'Browser')}</div>
              <div className="hintxt" style={{ marginTop: 2 }}>{d.platform} · last seen {fmt(d.last_seen_at)} · <span style={{ fontFamily: 'ui-monospace,monospace' }}>{d.token_prefix}…</span></div>
            </div>
            <button className="btn ghost" onClick={() => api.removeDevice(d.id).then(() => api.myDevices().then(setDevices))}>Remove</button>
          </div>
        ))}
      </div>
    </>
  )
}
