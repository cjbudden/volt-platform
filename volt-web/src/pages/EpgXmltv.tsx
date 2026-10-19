import { useEffect, useState } from 'react'
import { api, thumbUrl, type GuideChannel, type XmltvFeed } from '../api'
import { ImagePicker } from '../ImagePicker'
import { pressable } from '../a11y'
import { FormStatus, Notice } from '../notices'

/* ============================================================================
   XMLTV EXPORT drawer, opened from the EPG list.

   Three jobs, in the order an operator meets them:
     1. Download the guide now (a file for a partner, or to check the output).
     2. Partner feeds: a URL a PVR, IPTV middleware or guide aggregator polls.
        Each feed has its own scope and can be disabled, rotated or revoked
        without touching any other partner. The URL is shown once.
     3. Channel IDs: what each channel is called in <channel id=…>. Defaults to
        the channel's UUID, which works but is not what partners want to read.
   ========================================================================== */

const mono = { fontFamily: 'ui-monospace,monospace' } as const
/** Where the image the guide shows comes from (services/guideIcon.ts). */
const ICON_FROM: Record<string, string> = {
  guide: 'Guide icon, set here', brand: 'The channel logo', feed: 'From the imported guide', metadata: 'From the metadata logo',
}
const fmtWhen = (iso: string | null) => iso ? new Date(iso).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'never'

function CopyField({ value }: { value: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div style={{ display: 'flex', gap: 8 }}>
      <input className="inp" readOnly value={value} style={{ ...mono, fontSize: 'var(--fs-sm)' }} onFocus={e => e.currentTarget.select()} />
      <button className="btn" onClick={async () => { try { await navigator.clipboard.writeText(value) } catch { /* clipboard blocked */ } setCopied(true); setTimeout(() => setCopied(false), 1500) }}>
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  )
}

export default function XmltvDrawer({ onClose }: { onClose: () => void }) {
  const [channels, setChannels] = useState<GuideChannel[] | null>(null)
  const [iconFor, setIconFor] = useState<GuideChannel | null>(null)
  const [iconMsg, setIconMsg] = useState<Record<string, string>>({})
  async function setIcon(c: GuideChannel, ref: string | null) {
    try {
      const r = await api.setGuideIcon(c.id, ref)
      setChannels(cs => cs && cs.map(x => x.id === c.id ? { ...x, guideIconRef: r.guideIconRef, iconRef: r.iconRef, iconFrom: r.iconFrom, icon: r.icon } : x))
      setIconMsg(m => ({ ...m, [c.id]: '' }))
    } catch (e: any) { setIconMsg(m => ({ ...m, [c.id]: e.message })) }
  }
  const [feeds, setFeeds] = useState<XmltvFeed[] | null>(null)
  const [err, setErr] = useState('')
  const [feedErr, setFeedErr] = useState('')

  // download
  const [pastDays, setPastDays] = useState(1)
  const [futureDays, setFutureDays] = useState(7)
  const [times, setTimes] = useState<'scheduled' | 'asrun'>('scheduled')
  const [tz, setTz] = useState<'local' | 'utc'>('local')
  const [includeEvents, setIncludeEvents] = useState(false)
  const [dlBusy, setDlBusy] = useState(false)
  const [dlNote, setDlNote] = useState('')

  // new feed
  const [newOpen, setNewOpen] = useState(false)
  const [fName, setFName] = useState('')
  const [fAll, setFAll] = useState(true)
  const [fPick, setFPick] = useState<string[]>([])
  const [fFuture, setFFuture] = useState(7)
  const [fPast, setFPast] = useState(1)
  const [fTimes, setFTimes] = useState<'scheduled' | 'asrun'>('scheduled')
  const [fTz, setFTz] = useState<'local' | 'utc'>('local')
  const [fEvents, setFEvents] = useState(false)
  const [revealed, setRevealed] = useState<{ name: string; url: string; gzipUrl: string } | null>(null)

  // channel ids
  const [ids, setIds] = useState<Record<string, string>>({})
  const [idMsg, setIdMsg] = useState<Record<string, string>>({})

  const load = () => {
    api.guideChannels().then(c => {
      setChannels(c)
      setIds(Object.fromEntries(c.map(x => [x.id, x.xmltvIdSet ? x.xmltvId : ''])))
    }).catch((e: any) => setErr(e.message))
    api.xmltvFeeds().then(setFeeds).catch((e: any) => setErr(e.message))
  }
  useEffect(load, [])

  async function download() {
    setErr(''); setDlNote(''); setDlBusy(true)
    try {
      const r = await api.downloadXmltv({ pastDays, futureDays, times, tz, includeEvents })
      setDlNote(`Saved ${(r.bytes / 1024).toFixed(0)} KB${r.programmes ? ` (${r.programmes.replace(/;/g, ',')})` : ''}`)
    } catch (e: any) { setErr(e.message) } finally { setDlBusy(false) }
  }

  async function createFeed() {
    setFeedErr('')
    if (!fName.trim()) { setFeedErr('Name the feed after the partner who will poll it'); return }
    if (!fAll && fPick.length === 0) { setFeedErr('Pick at least one channel, or choose all channels'); return }
    try {
      const f = await api.createXmltvFeed({
        name: fName.trim(), channelIds: fAll ? null : fPick, includeEvents: fEvents,
        pastDays: fPast, futureDays: fFuture, timeBasis: fTimes, tzMode: fTz,
      })
      setRevealed({ name: f.name, url: f.url, gzipUrl: f.gzipUrl })
      setNewOpen(false); setFName(''); setFAll(true); setFPick([])
      load()
    } catch (e: any) { setFeedErr(e.message) }
  }

  async function toggleFeed(f: XmltvFeed) {
    try { await api.patchXmltvFeed(f.id, { enabled: !f.enabled }); load() } catch (e: any) { setErr(e.message) }
  }
  async function rotate(f: XmltvFeed) {
    if (!window.confirm(`Issue a new URL for "${f.name}"? The current URL stops working immediately, so the partner must be sent the new one.`)) return
    try { const r = await api.rotateXmltvFeed(f.id); setRevealed({ name: r.name, url: r.url, gzipUrl: r.gzipUrl }); load() } catch (e: any) { setErr(e.message) }
  }
  async function revoke(f: XmltvFeed) {
    if (!window.confirm(`Revoke "${f.name}"? Its URL stops working and the feed is deleted.`)) return
    try { await api.deleteXmltvFeed(f.id); load() } catch (e: any) { setErr(e.message) }
  }

  async function saveId(c: GuideChannel) {
    const v = (ids[c.id] ?? '').trim()
    setIdMsg(m => ({ ...m, [c.id]: '' }))
    try {
      await api.setXmltvId(c.id, v || null)
      setIdMsg(m => ({ ...m, [c.id]: 'Saved' }))
      load()
    } catch (e: any) { setIdMsg(m => ({ ...m, [c.id]: e.message })) }
  }

  const scopeText = (f: XmltvFeed) => {
    const ch = f.channelIds === null ? 'All channels' : `${f.channelIds.length} channel${f.channelIds.length === 1 ? '' : 's'}`
    return `${ch}${f.includeEvents ? ' + events' : ''} · −${f.pastDays}d / +${f.futureDays}d · ${f.timeBasis === 'asrun' ? 'as-run' : 'scheduled'} · ${f.tzMode === 'utc' ? 'UTC' : 'local time'}`
  }

  return (
    <div className="drawer-scrim" {...pressable((e: any) => { ((onClose) as any)(e) })} data-a11y-click="">
      <div className="drawer" style={{ width: 640, maxWidth: '100vw' }} {...pressable((e: any) => { (((e: any) => e.stopPropagation()) as any)(e) })} data-a11y-click="">
        <div className="drawer-h"><div className="t">XMLTV export</div><button className="xbtn" onClick={onClose} aria-label="Close">✕</button></div>
        <div className="drawer-b">
          {err && <Notice kind="error" variant="compact" message={err} />}

          {/* ---------------------------------------------------- download */}
          <div className="sec-label">Download the guide</div>
          <div className="hintxt" style={{ marginBottom: 10 }}>Every guide-enabled channel and station, as one XMLTV file. Scheduled times are the forward guide; as-run uses the observed airing where it was recorded, for a catch-up guide.</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 10 }}>
            <div className="field"><label>Days back</label>
              <input className="inp" type="number" min={0} max={31} value={pastDays} onChange={e => setPastDays(Math.max(0, Math.min(31, +e.target.value || 0)))} />
            </div>
            <div className="field"><label>Days ahead</label>
              <input className="inp" type="number" min={1} max={62} value={futureDays} onChange={e => setFutureDays(Math.max(1, Math.min(62, +e.target.value || 1)))} />
            </div>
            <div className="field"><label>Times</label>
              <select className="inp" value={times} onChange={e => setTimes(e.target.value as any)}>
                <option value="scheduled">Scheduled</option>
                <option value="asrun">As-run</option>
              </select>
            </div>
            <div className="field"><label>Time zone</label>
              <select className="inp" value={tz} onChange={e => setTz(e.target.value as any)}>
                <option value="local">Channel local</option>
                <option value="utc">UTC</option>
              </select>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 'var(--fs-sm)', color: 'var(--muted)' }}>
              <input type="checkbox" checked={includeEvents} onChange={e => setIncludeEvents(e.target.checked)} /> Include event schedules
            </label>
            <div style={{ flex: 1 }} />
            {dlNote && <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)' }}>{dlNote}</span>}
            <button className="btn primary" disabled={dlBusy} onClick={download}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" width="14" height="14" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14" /></svg>
              {dlBusy ? 'Preparing…' : 'Download .xml'}
            </button>
          </div>

          {/* ---------------------------------------------------- feeds */}
          <div className="sec-label" style={{ marginTop: 22, display: 'flex', alignItems: 'center' }}>
            <span>Partner feeds</span><div style={{ flex: 1 }} />
            {!newOpen && <button className="btn ghost" onClick={() => setNewOpen(true)}>New feed</button>}
          </div>
          <div className="hintxt" style={{ marginBottom: 10 }}>A URL a set-top box, IPTV middleware or guide provider polls. No login needed, so treat the URL as the password: one feed per partner, and rotate it if it leaks.</div>

          {revealed && (
            <div className="card" style={{ padding: 14, marginBottom: 12 }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>{revealed.name}: copy the URL now</div>
              <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)', marginBottom: 8 }}>Only a fingerprint is stored, so this URL is shown once.</div>
              <CopyField value={revealed.url} />
              <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--faint)', margin: '8px 0 4px' }}>Compressed (.xml.gz), for consumers that ask for it:</div>
              <CopyField value={revealed.gzipUrl} />
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 10 }}>
                <button className="btn ghost" onClick={() => setRevealed(null)}>Done</button>
              </div>
            </div>
          )}

          {newOpen && (
            <div className="card" style={{ padding: 14, marginBottom: 12 }}>
              <div className="field"><label>Partner / feed name</label>
                <input className="inp" value={fName} onChange={e => setFName(e.target.value)} placeholder="e.g. Sky NZ guide, Jellyfin test box" />
              </div>
              <div className="field"><label>Channels</label>
                <select className="inp" value={fAll ? 'all' : 'pick'} onChange={e => setFAll(e.target.value === 'all')}>
                  <option value="all">All guide-enabled channels, including new ones</option>
                  <option value="pick">Only the channels I pick</option>
                </select>
              </div>
              {!fAll && (
                <div style={{ maxHeight: 180, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 8, marginBottom: 10 }}>
                  {(channels ?? []).map(c => (
                    <label key={c.id} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '7px 10px', borderTop: '1px solid var(--border)', fontSize: 'var(--fs-sm)' }}>
                      <input type="checkbox" checked={fPick.includes(c.id)} onChange={e => setFPick(p => e.target.checked ? [...p, c.id] : p.filter(x => x !== c.id))} />
                      <span style={{ flex: 1 }}>{c.name}</span>
                      <span style={{ color: 'var(--faint)' }}>{c.medium === 'radio' ? 'Radio' : 'Channel'}</span>
                    </label>
                  ))}
                </div>
              )}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 10 }}>
                <div className="field"><label>Days back</label>
                  <input className="inp" type="number" min={0} max={31} value={fPast} onChange={e => setFPast(Math.max(0, Math.min(31, +e.target.value || 0)))} />
                </div>
                <div className="field"><label>Days ahead</label>
                  <input className="inp" type="number" min={1} max={62} value={fFuture} onChange={e => setFFuture(Math.max(1, Math.min(62, +e.target.value || 1)))} />
                </div>
                <div className="field"><label>Times</label>
                  <select className="inp" value={fTimes} onChange={e => setFTimes(e.target.value as any)}>
                    <option value="scheduled">Scheduled</option>
                    <option value="asrun">As-run</option>
                  </select>
                </div>
                <div className="field"><label>Time zone</label>
                  <select className="inp" value={fTz} onChange={e => setFTz(e.target.value as any)}>
                    <option value="local">Channel local</option>
                    <option value="utc">UTC</option>
                  </select>
                </div>
              </div>
              <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 'var(--fs-sm)', color: 'var(--muted)' }}>
                <input type="checkbox" checked={fEvents} onChange={e => setFEvents(e.target.checked)} /> Include event schedules
              </label>
              <div className="modal-f">
                <FormStatus error={feedErr} />
                <button className="btn ghost" onClick={() => { setNewOpen(false); setFeedErr('') }}>Cancel</button>
                <button className="btn primary" onClick={createFeed}>Create feed</button>
              </div>
            </div>
          )}

          {feeds === null ? <div className="loading">Loading feeds…</div> : feeds.length === 0 ? (
            <div className="hintxt">No partner feeds yet.</div>
          ) : (
            <div style={{ border: '1px solid var(--border)', borderRadius: 8 }}>
              {feeds.map((f, i) => (
                <div key={f.id} style={{ display: 'flex', gap: 12, alignItems: 'center', padding: '10px 12px', borderTop: i ? '1px solid var(--border)' : undefined }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, opacity: f.enabled ? 1 : 0.55 }}>{f.name}{!f.enabled && <span style={{ color: 'var(--faint)', fontWeight: 400 }}> · disabled</span>}</div>
                    <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--faint)' }}>{scopeText(f)}</div>
                    <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--faint)' }}>
                      <span style={mono}>…/xmltv/{f.tokenPrefix}…</span> · last polled {fmtWhen(f.lastPolledAt)} · {f.pollCount} poll{f.pollCount === 1 ? '' : 's'}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                    <button className="btn ghost" onClick={() => toggleFeed(f)}>{f.enabled ? 'Disable' : 'Enable'}</button>
                    <button className="btn ghost" onClick={() => rotate(f)}>New URL</button>
                    <button className="btn ghost" onClick={() => revoke(f)}>Revoke</button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* ---------------------------------------------------- channel ids */}
          <div className="sec-label" style={{ marginTop: 22 }}>Channels in the guide</div>
          <div className="hintxt" style={{ marginBottom: 10 }}>How each channel is identified to partners. Blank uses the channel's internal ID. A readable, stable ID such as <span style={mono}>news.yourbrand.com</span> is what most guide systems expect. Changing it later breaks the partner's mapping, so agree it once.</div>
          {channels === null ? <div className="loading">Loading channels…</div> : (
            <table>
              <thead><tr><th>Channel</th><th>Guide icon</th><th>XMLTV ID</th><th></th></tr></thead>
              <tbody>
                {channels.map(c => (
                  <tr key={c.id}>
                    <td>
                      <div style={{ fontWeight: 600 }}>{c.name}</div>
                      <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--faint)' }}>{c.medium === 'radio' ? 'Radio' : 'Channel'} · {c.tz}{!c.epgEnabled && ' · guide off, not exported'}</div>
                    </td>
                    <td style={{ minWidth: 190 }}>
                      <div className="guide-icon-cell">
                        <span className="imgref-prev" style={{ width: 40, height: 40 }}>
                          {c.iconRef ? <img src={thumbUrl(c.iconRef, 80, 80, 'inside')} alt="" /> : <span className="imgref-bad" style={{ color: 'var(--faint)' }}>None</span>}
                        </span>
                        <div style={{ minWidth: 0 }}>
                          <div className="hintxt" style={{ marginTop: 0 }}>{ICON_FROM[c.iconFrom ?? ''] ?? 'No image yet'}</div>
                          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 3 }}>
                            <button type="button" className="btn ghost sm" onClick={() => setIconFor(c)}>{c.guideIconRef ? 'Change' : 'Set guide icon'}</button>
                            {c.guideIconRef && <button type="button" className="btn ghost sm" onClick={() => setIcon(c, null)}>Use {c.medium === 'radio' ? 'artwork' : 'logo'}</button>}
                          </div>
                          {iconMsg[c.id] && <div className="err" style={{ fontSize: 'var(--fs-xs)' }}>{iconMsg[c.id]}</div>}
                        </div>
                      </div>
                    </td>
                    <td style={{ width: '40%' }}>
                      <input className="inp" value={ids[c.id] ?? ''} placeholder={c.id} style={{ ...mono, fontSize: 'var(--fs-sm)' }}
                        onChange={e => setIds(m => ({ ...m, [c.id]: e.target.value }))} />
                      {idMsg[c.id] && <div style={{ fontSize: 'var(--fs-xs)', color: idMsg[c.id] === 'Saved' ? 'var(--muted)' : 'var(--danger, #f87171)', marginTop: 3 }}>{idMsg[c.id]}</div>}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <button className="btn ghost" disabled={(ids[c.id] ?? '') === (c.xmltvIdSet ? c.xmltvId : '')} onClick={() => saveId(c)}>Save</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <ImagePicker open={!!iconFor} kinds={['brand', 'poster', 'other']} title={`Guide icon for ${iconFor?.name ?? ''}`}
            uploadKind="brand" uploadFolder="brands" allowUpload
            onClose={() => setIconFor(null)} onPick={(url) => { const c = iconFor!; setIconFor(null); setIcon(c, url) }} />
        </div>
      </div>
    </div>
  )
}
