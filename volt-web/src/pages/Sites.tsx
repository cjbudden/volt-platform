// ============================================================================
//  SITES (Admin > Sites, build queue H1, HYBRID_SITES.md).
//
//  The Hybrid Sites add-on: customer locations running the Volt site agent.
//  Shown only to account administrators of an account licensed for
//  `hybrid_sites` or `mirror_archive` (App.tsx, build queue H3-6: a Mirror and
//  Archive account needs sites for the servers that write its copies); the
//  API refuses everyone else the same way.
//
//  Per site: its health (from its APPROVED hosts only: a host waiting for
//  approval does no work, so it neither makes a site healthy nor drags it
//  down), agent and encoder versions, last contact, and its hosts with what
//  each reported. A host joins with a one-time enrolment token shown here
//  once; it then waits for Approve or Reject.
// ============================================================================
import { useEffect, useState } from 'react'
import { api, type SiteRow, type SiteDetail, type SiteHost, type SiteHealth, type HostHealth } from '../api'
import { PageHead } from '../scaffold'
import { usePageNotice, useNotify, FormStatus } from '../notices'

const ic = (d: React.ReactNode) => <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">{d}</svg>
const IC = {
  site: ic(<><path d="M3 21h18" /><path d="M5 21V8l7-5 7 5v13" /><path d="M9 21v-6h6v6" /></>),
  host: ic(<><rect x="3" y="4" width="18" height="7" rx="1.5" /><rect x="3" y="13" width="18" height="7" rx="1.5" /><path d="M7 7.5h.01M7 16.5h.01" /></>),
  plus: ic(<><path d="M12 5v14M5 12h14" /></>),
  key: ic(<><circle cx="7.5" cy="15.5" r="3.5" /><path d="M10 13l8-8M15 6l3 3" /></>),
  check: ic(<path d="M5 12l5 5 9-10" />),
  x: ic(<><path d="M6 6l12 12M18 6L6 18" /></>),
  copy: ic(<><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></>),
  power: ic(<><path d="M12 3v9" /><path d="M6.3 7.3a8 8 0 1 0 11.4 0" /></>),
  rotate: ic(<><path d="M20 11a8 8 0 1 0-2.3 5.7" /><path d="M20 4v7h-7" /></>),
}

const SITE_HEALTH: Record<SiteHealth, { label: string; cls: string; about: string }> = {
  healthy: { label: 'Healthy', cls: 'live', about: 'Every approved host reported in the last few heartbeats.' },
  degraded: { label: 'Degraded', cls: 'warn', about: 'Some approved hosts have stopped reporting.' },
  offline: { label: 'Offline', cls: 'down', about: 'No approved host has reported recently.' },
  no_hosts: { label: 'No hosts', cls: 'idle', about: 'No host has been approved yet.' },
  disabled: { label: 'Disabled', cls: 'idle', about: 'Its agents are refused until the site is enabled.' },
}
const HOST_HEALTH: Record<HostHealth, { label: string; cls: string }> = {
  online: { label: 'Online', cls: 'live' }, stale: { label: 'Stale', cls: 'warn' }, offline: { label: 'Offline', cls: 'down' }, never: { label: 'Not heard from', cls: 'idle' },
}
const HOST_STATUS: Record<SiteHost['status'], { label: string; cls: string }> = {
  pending: { label: 'Waiting for approval', cls: 'sched' }, approved: { label: 'Approved', cls: 'live' }, rejected: { label: 'Rejected', cls: 'down' },
}

const gb = (b: number | null) => b == null ? '–' : b >= 1e12 ? `${(b / 1e12).toFixed(1)} TB` : `${Math.round(b / 1e9)} GB`
// Memory is sold in binary sizes: 128 GB of RAM is 128 x 2^30 bytes.
const ram = (b: number | null) => b == null ? '–' : `${Math.round(b / 2 ** 30)} GB`
function ago(t: string | null) {
  if (!t) return 'never'
  const s = Math.max(0, Math.round((Date.now() - new Date(t).getTime()) / 1000))
  if (s < 60) return `${s} s ago`
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86400) return `${Math.round(s / 3600)} h ago`
  return new Date(t).toLocaleString()
}

function NewSite({ onDone, onCancel }: { onDone: (s: SiteRow) => void; onCancel: () => void }) {
  const [name, setName] = useState('')
  const [desc, setDesc] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  async function save() {
    setBusy(true); setErr('')
    try { onDone(await api.createSite({ name: name.trim(), description: desc.trim() || null })) } catch (e: any) { setErr(e?.message || 'Could not create the site') } finally { setBusy(false) }
  }
  return (
    <div className="card" style={{ padding: 18, marginBottom: 14 }}>
      <div className="sec-label" style={{ marginTop: 0, display: 'flex', alignItems: 'center', gap: 6 }}>{IC.site} New site</div>
      <div className="field"><label htmlFor="site-name">Name</label>
        <input id="site-name" className="inp" style={{ maxWidth: 420 }} value={name} maxLength={120} placeholder="Main broadcast centre" onChange={e => setName(e.target.value)} autoFocus /></div>
      <div className="field"><label htmlFor="site-desc">Description</label>
        <input id="site-desc" className="inp" style={{ maxWidth: 420 }} value={desc} maxLength={1000} placeholder="Where it is, who looks after it" onChange={e => setDesc(e.target.value)} /></div>
      <div className="acct-actions">
        <FormStatus error={err} />
        <button className="btn ghost" onClick={onCancel} disabled={busy}>Cancel</button>
        <button className="btn primary" onClick={save} disabled={busy || !name.trim()}>{IC.plus} {busy ? 'Creating…' : 'Create site'}</button>
      </div>
    </div>
  )
}

function Enrol({ site, onChanged }: { site: SiteDetail; onChanged: () => void }) {
  const [made, setMade] = useState<{ token: string; expiresAt: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [copied, setCopied] = useState(false)
  const cmd = made ? `volt-agent site enrol ${window.location.origin} ${made.token}` : ''
  async function make() {
    setBusy(true); setErr('')
    try { const t = await api.createEnrolmentToken(site.id); setMade({ token: t.token, expiresAt: t.expiresAt }); onChanged() } catch (e: any) { setErr(e?.message || 'Could not make a token') } finally { setBusy(false) }
  }
  async function copy() { try { await navigator.clipboard.writeText(cmd); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch { setErr('Select the command and copy it.') } }
  return (
    <div style={{ marginTop: 14 }}>
      <div className="sec-label" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>{IC.key} Add a host</div>
      {made ? (
        <>
          <div className="hintxt" style={{ marginTop: 0 }}>Run this on the server at the site. The token works once and until {new Date(made.expiresAt).toLocaleString()}; it is not shown again.</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'stretch', flexWrap: 'wrap', marginTop: 8 }}>
            <code className="mono" data-enrol-command style={{ flex: '1 1 280px', minWidth: 0, overflowWrap: 'anywhere', padding: '9px 12px', background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 'var(--fs-sm)' }}>{cmd}</code>
            <button className="btn ghost" onClick={copy}>{IC.copy} {copied ? 'Copied' : 'Copy'}</button>
          </div>
          <div className="hintxt">The host then appears below, waiting for approval.</div>
        </>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <button className="btn" onClick={make} disabled={busy || site.status !== 'active'}>{IC.key} {busy ? 'Making…' : 'Make an enrolment token'}</button>
          <span className="hintxt" style={{ margin: 0 }}>{site.status !== 'active' ? 'Enable the site to add hosts.' : 'One token per host, valid for 24 hours.'}</span>
        </div>
      )}
      {site.enrolmentTokens.length > 0 && (
        <div className="hintxt">Unused tokens: {site.enrolmentTokens.map((t, i) => (
          <span key={t.id}>{i ? ', ' : ''}<code>{t.prefix}…</code> until {new Date(t.expiresAt).toLocaleString()}{' '}
            <button className="btn ghost sm" style={{ padding: '1px 8px' }} onClick={async () => { try { await api.withdrawEnrolmentToken(site.id, t.id); onChanged() } catch (e: any) { setErr(e?.message || 'Could not withdraw it') } }}>Withdraw</button></span>
        ))}</div>
      )}
      <FormStatus error={err} />
    </div>
  )
}

function Hosts({ site, onChanged }: { site: SiteDetail; onChanged: () => void }) {
  const notify = useNotify()
  const [busy, setBusy] = useState<string | null>(null)
  async function act(h: SiteHost, what: 'approve' | 'reject' | 'rotate') {
    setBusy(h.id + what)
    try {
      if (what === 'rotate') { await api.rotateHostCredential(site.id, h.id); notify({ kind: 'ok', message: `New credential for ${h.hostname}. The agent picks it up on its next heartbeat and the old one stops working.` }) }
      else { await api.decideHost(site.id, h.id, what); notify({ kind: 'ok', message: what === 'approve' ? `${h.hostname} approved. It may take work at this site.` : `${h.hostname} rejected. Its credential no longer works.` }) }
      onChanged()
    } catch (e: any) { notify({ kind: 'error', message: e?.message || 'That did not work' }) } finally { setBusy(null) }
  }
  if (!site.hostList.length) return <div className="hintxt">No hosts yet. Make an enrolment token and run the command on the site's server.</div>
  return (
    <div style={{ overflowX: 'auto', margin: '0 -18px' }}>
      <table className="sites-hosts">
        <thead><tr><th>Host</th><th>Standing</th><th>Health</th><th>Capacity</th><th>Free disk</th><th>Versions</th><th>Last contact</th><th /></tr></thead>
        <tbody>
          {site.hostList.map(h => (
            <tr key={h.id} data-host={h.hostname} style={{ cursor: 'default' }}>
              <td><div className="cell-name">{IC.host}<div><div className="nm" style={{ whiteSpace: 'nowrap' }}>{h.hostname}</div><div className="id" style={{ whiteSpace: 'nowrap' }}>{[h.os, h.arch].filter(Boolean).join(' · ')}</div></div></div></td>
              <td><span className={`tag ${HOST_STATUS[h.status].cls}`}>{HOST_STATUS[h.status].label}</span></td>
              <td><span className={`tag ${HOST_HEALTH[h.health].cls}`}>{HOST_HEALTH[h.health].label}</span></td>
              <td style={{ whiteSpace: 'nowrap' }}>{h.cpuCores ?? '–'} cores · {ram(h.memoryBytes)}
                <div className="hintxt" style={{ margin: 0 }}>{h.gpus.length ? h.gpus.map(g => `${g.name}${g.encodeSessions ? `, ${g.encodeSessions} encode sessions` : ''}`).join('; ') : 'CPU only'}</div></td>
              <td style={{ whiteSpace: 'nowrap' }}>{gb(h.diskFreeBytes)}{h.diskTotalBytes ? <span className="hintxt" style={{ margin: 0 }}> of {gb(h.diskTotalBytes)}</span> : null}</td>
              <td style={{ whiteSpace: 'nowrap' }}>agent {h.agentVersion ?? '–'}<div className="hintxt" style={{ margin: 0 }}>encoder {h.encoderVersion ?? '–'}</div></td>
              <td style={{ whiteSpace: 'nowrap' }}>{ago(h.lastHeartbeatAt)}</td>
              <td style={{ width: 1 }}><div className="rowact" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
                {h.status !== 'approved' && <button className="btn sm primary" disabled={!!busy} onClick={() => act(h, 'approve')}>{IC.check} Approve</button>}
                {h.status !== 'rejected' && <button className="btn sm ghost" disabled={!!busy} onClick={() => act(h, 'reject')}>{IC.x} Reject</button>}
                {h.status === 'approved' && <button className="btn sm ghost" disabled={!!busy} onClick={() => act(h, 'rotate')} title="Make a new credential for this host">{IC.rotate} Rotate credential</button>}
              </div></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function SiteCard({ row, open, onToggle, onChanged }: { row: SiteRow; open: boolean; onToggle: () => void; onChanged: () => void }) {
  const [d, setD] = useState<SiteDetail | null>(null)
  const [err, setErr] = useState('')
  const load = () => api.site(row.id).then(x => { setD(x); setErr('') }).catch((e: any) => setErr(e?.message || 'Could not load the site'))
  useEffect(() => { if (open) load() }, [open, row.version, row.configVersion])
  const h = SITE_HEALTH[row.health]
  const changed = () => { load(); onChanged() }
  async function toggleStatus() {
    try { await api.patchSite(row.id, { status: row.status === 'active' ? 'disabled' : 'active' }); changed() } catch (e: any) { setErr(e?.message || 'Could not change the site') }
  }
  return (
    <div className="card" style={{ padding: 18, marginBottom: 14 }} data-site={row.name}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <button className="btn ghost" style={{ padding: '4px 8px' }} aria-expanded={open} onClick={onToggle}>{IC.site} <b>{row.name}</b></button>
        <span className={`tag ${h.cls}`} title={h.about}>{h.label}</span>
        <span className="hintxt" style={{ margin: 0 }}>{row.hosts.approved} approved{row.hosts.pending ? `, ${row.hosts.pending} waiting` : ''}{row.hosts.approved ? `, ${row.hosts.online} online` : ''}</span>
        <span style={{ flex: 1 }} />
        <span className="hintxt" style={{ margin: 0 }}>Last contact {ago(row.lastContactAt)}</span>
      </div>
      {row.description && <div className="hintxt" style={{ marginTop: 6 }}>{row.description}</div>}
      {(row.agentVersions.length > 0 || row.encoderVersions.length > 0) && (
        <div className="hintxt" style={{ marginTop: 4 }}>Agent {row.agentVersions.join(', ') || '–'} · encoder {row.encoderVersions.join(', ') || '–'}</div>
      )}
      {open && (
        <div style={{ marginTop: 12 }}>
          {err && <FormStatus error={err} />}
          {!d ? <div className="loading">Loading…</div> : (
            <>
              <div className="sec-label" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>{IC.host} Hosts</div>
              <Hosts site={d} onChanged={changed} />
              <Enrol site={d} onChanged={load} />
              <div className="acct-actions">
                <span className="hintxt" style={{ margin: 0 }}>Agents report every {d.heartbeatSeconds} s; a host is stale after {d.staleAfterSeconds} s and offline after {Math.round(d.offlineAfterSeconds / 60)} min.</span>
                <button className="btn ghost" onClick={toggleStatus}>{IC.power} {row.status === 'active' ? 'Disable site' : 'Enable site'}</button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

export default function SitesPage() {
  const [rows, setRows] = useState<SiteRow[] | null>(null)
  const [err, setErr] = useState('')
  const [adding, setAdding] = useState(false)
  const [open, setOpen] = useState<string | null>(null)
  const load = () => api.sites().then(x => { setRows(x.items); setErr('') }).catch((e: any) => setErr(e?.message || 'Could not load the sites'))
  useEffect(() => { load(); const t = setInterval(load, 30_000); return () => clearInterval(t) }, [])
  usePageNotice('load', err ? { kind: 'error', title: "Couldn't load the sites.", message: err, actions: [{ label: 'Retry', onClick: () => { load() } }] } : null)
  const sub = 'Your own locations running the Volt site agent: their health, their hosts and adding new ones.'
  const action = <button className="btn primary" onClick={() => setAdding(true)} disabled={adding}>{IC.plus} New site</button>
  if (!rows) return <><PageHead title="Sites" sub={sub} />{!err && <div className="loading">Loading…</div>}</>
  return (
    <>
      <PageHead title="Sites" sub={sub} action={action} />
      {adding && <NewSite onCancel={() => setAdding(false)} onDone={(s) => { setAdding(false); setOpen(s.id); load() }} />}
      {rows.length === 0 && !adding ? (
        <div className="empty"><div className="ic">{IC.site}</div><h3>No sites yet</h3>
          <p>A site is a location of yours, such as a broadcast centre, where servers run the Volt site agent. Create one, then add its servers with an enrolment token.</p>
          <button className="btn primary" onClick={() => setAdding(true)}>{IC.plus} New site</button></div>
      ) : rows.map(r => <SiteCard key={r.id} row={r} open={open === r.id} onToggle={() => setOpen(open === r.id ? null : r.id)} onChanged={load} />)}
    </>
  )
}
