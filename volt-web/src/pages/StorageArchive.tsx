// ============================================================================
//  MIRROR AND ARCHIVE on the Storage page (build queue H3-6, HYBRID_SITES.md
//  "Add-on: Mirror and Archive to external storage").
//
//  Two lists, because they answer two different questions:
//
//    STORAGE TARGETS  where at your sites copies may go: a folder (a disk or a
//                     NAS share mounted on the site's server) or an
//                     S3-compatible store on your network. Each says how fast
//                     copies may run and how often they are read back again.
//    COPIES           what is actually there, and whether Volt can still vouch
//                     for it: a copy only counts as Verified once the site
//                     agent has read it back and it matched the original.
//
//  Shown only to account administrators of an account with the
//  `mirror_archive` add-on (Storage.tsx); the API refuses everyone else the
//  same way. Keys for an S3-compatible store are never typed here: they stay
//  on the site's server under a key name (H3-4), so the form asks for that
//  name only and says why.
// ============================================================================
import { useEffect, useState } from 'react'
import { api, type ArchiveTarget, type ArchiveCopy, type ArchiveCopyState, type ArchiveOriginal, type SiteRow } from '../api'
import { FormStatus, useNotify } from '../notices'
import { navigate } from '../router'

const ic = (d: React.ReactNode) => <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">{d}</svg>
const IC = {
  folder: ic(<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />),
  bucket: ic(<><ellipse cx="12" cy="6" rx="8" ry="3" /><path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6" /><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" /></>),
  plus: ic(<path d="M12 5v14M5 12h14" />),
  edit: ic(<><path d="M4 20h4L19 9l-4-4L4 16z" /><path d="M13 7l4 4" /></>),
  check: ic(<path d="M5 12l5 5 9-10" />),
  shield: ic(<><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" /><path d="M9 12l2 2 4-4" /></>),
  site: ic(<><path d="M3 21h18" /><path d="M5 21V8l7-5 7 5v13" /><path d="M9 21v-6h6v6" /></>),
  wait: ic(<><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>),
  archived: ic(<><path d="M3 7h18v13H3z" /><path d="M1 3h22v4H1z" /><path d="M10 12h4" /></>),
  restore: ic(<><path d="M12 19V7" /><path d="M7 11l5-5 5 5" /><path d="M5 21h14" /></>),
}

/** What to do about an original that waits (services/archive/originals.ts codes). */
const ORIGINAL_HINT: Record<string, string> = {
  no_copy: 'Add a copy rule for originals in Publishing Rules, or copy this asset to a storage target.',
  copy_pending: 'Nothing: it goes once the copy is verified.',
  copy_failed: 'See the copy above for the reason, fix it at the site and copy again.',
  copy_corrupt: 'Copy the original again; the old copy no longer matches.',
  copy_missing: 'Copy the original again; the old copy is gone from the target.',
  copy_stale: 'The original was replaced: copy the new one.',
  copy_unchecked: 'Copy it again so the copy can be compared with the original.',
  in_use: 'Nothing: it goes after the job finishes.',
  no_licence: 'Turn on Mirror and Archive for the account.',
  not_removable: 'Ask whoever runs Volt: the file is not where Volt keeps originals.',
}

/** Originals a retention rule removed from the cloud, and those waiting for their copy (H3-5). */
function Originals() {
  const notify = useNotify()
  const [items, setItems] = useState<ArchiveOriginal[] | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const load = () => api.archiveOriginals().then(r => { setItems(r.items); setErr('') }).catch(e => setErr(e?.message || 'Could not load originals'))
  useEffect(() => { load() }, [])
  async function restore(o: ArchiveOriginal) {
    setBusy(o.vodAssetId)
    try { await api.restoreArchiveOriginal(o.vodAssetId); notify({ kind: 'ok', message: `Restoring ${o.title || 'the original'}: a server at the site uploads the archive copy and Volt checks it before the asset uses it.` }); load() }
    catch (e: any) { notify({ kind: 'error', message: e?.message || 'Could not start the restore' }) } finally { setBusy(null) }
  }
  if (err) return <FormStatus error={err} />
  if (!items) return null
  const waiting = items.filter(i => i.state === 'waiting').length
  return (
    <div data-originals>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 16 }}>
        <div className="sec-label" style={{ margin: 0 }}>Originals out of the cloud</div>
        <span style={{ flex: 1 }} />
        <span className="hintxt" style={{ margin: 0 }}>{items.length - waiting} removed · {waiting} waiting</span>
      </div>
      {items.length === 0 ? (
        <div className="hintxt">None yet. A retention rule on this page can remove originals from the cloud once a verified archive copy is held; the renditions stay.</div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table>
            <thead><tr><th>Asset</th><th>Original</th><th>Archive copy</th><th>Since</th><th /></tr></thead>
            <tbody>
              {items.map(o => (
                <tr key={o.vodAssetId} data-original={o.state} style={{ cursor: 'default' }}>
                  <td><a href={`/vod?asset=${o.vodAssetId}`} onClick={e => { e.preventDefault(); navigate(`/vod?asset=${o.vodAssetId}`) }}>{o.title || 'Untitled'}</a></td>
                  <td>{o.state === 'removed'
                    ? <>
                        <span className="tag live" style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>{IC.archived} In the archive only</span>
                        {o.restoring && <div className="hintxt" style={{ margin: '4px 0 0' }} data-original-restoring>Being restored: a server at the site is uploading the copy</div>}
                        {o.restoreError && <div style={{ margin: '4px 0 0', fontSize: 'var(--fs-sm)', color: 'var(--down)', maxWidth: 420 }} data-original-restore-error>The last restore failed: {o.restoreError}</div>}
                      </>
                    : <>
                        <span className="tag idle" style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>{IC.wait} Kept, waiting</span>
                        <div style={{ margin: '4px 0 0', fontSize: 'var(--fs-sm)', maxWidth: 420 }} data-original-wait={o.waitCode ?? ''}>
                          <div style={{ color: 'var(--warn)' }}>{o.why}</div>
                          {o.waitCode && ORIGINAL_HINT[o.waitCode] && <div className="hintxt" style={{ margin: '2px 0 0' }}><b>What to do:</b> {ORIGINAL_HINT[o.waitCode]}</div>}
                        </div>
                      </>}</td>
                  <td>{o.copy ? <><div>{o.copy.targetName ?? '–'}</div><div className="mono hintxt" style={{ margin: 0, overflowWrap: 'anywhere' }}>{o.copy.storedPath}</div></> : '–'}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>{when(o.removedAt ?? o.checkedAt)}</td>
                  <td style={{ width: 1 }}>{o.state === 'removed' && !o.restoring && o.copy?.state === 'verified' &&
                    <button className="btn sm ghost" disabled={busy === o.vodAssetId} onClick={() => restore(o)} title="Bring the original back to the cloud from its archive copy, for a re-encode">{IC.restore} Restore</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

export const COPY_STATE: Record<ArchiveCopyState, { label: string; cls: string; about: string }> = {
  queued: { label: 'Queued', cls: 'sched', about: 'Waiting for a server at the site (or for the off-peak window) to make the copy.' },
  copying: { label: 'Copying', cls: 'sched', about: 'A server at the site is making the copy now.' },
  verified: { label: 'Verified', cls: 'live', about: 'Read back from the target and matched the original.' },
  failed: { label: 'Failed', cls: 'down', about: 'The copy could not be made after every retry. Copy it again once the cause is fixed.' },
  corrupt: { label: 'Corrupt', cls: 'down', about: 'The copy on the target no longer matches the original: it was changed or damaged after it was made.' },
  missing: { label: 'Missing', cls: 'down', about: 'The copy is no longer on the target: it was moved or deleted there.' },
}

// What to do about each of the site agent's error codes (volt-agent
// siteArchive.ts, s3Target.ts), in words for whoever runs the site. The
// agent's own reason is shown above it, so this says only what to do next.
const ERROR_HINT: Record<string, string> = {
  keys_missing: 'Add keys under this key name on every server of the site (see the guide). The copy retries by itself.',
  keys_unprotected: 'Make the keys file on the site\'s server readable by its owner only (chmod 600). The copy retries by itself.',
  keys_unreadable: 'Fix the keys file on the site\'s server: it must be valid JSON. The copy retries by itself.',
  target_unavailable: 'Mount the share, or start the store, at the site. The copy retries by itself.',
  target_refused: 'Check that the keys on the site\'s server may write to this bucket.',
  no_such_bucket: 'Create the bucket in the store, or make a new target for a bucket that exists.',
  target_error: 'Look at the store\'s own logs at the site. The copy retries by itself.',
  target_not_supported: 'The target\'s settings cannot be used. Make a new target with a valid folder or store.',
  outside_target: 'The copy would land outside the target. Make a new target for that place.',
  transfer_refused: 'Volt could not hand the site the original. Check that the asset still has its original file.',
  download_failed: 'The site\'s server could not fetch the original from Volt. Check its internet connection; the copy retries by itself.',
  name_taken: 'Nothing to do: it is retried under a free name.',
  checksum_mismatch: 'Check the storage at the site. A copy is made again by itself; a re-check that fails means the file changed after it was made.',
  size_mismatch: 'Check the storage at the site, then copy it again.',
  missing: 'Find out what removed it at the site, then copy it again.',
  site_error: 'Look at the agent\'s log on the site\'s server. The copy retries by itself.',
}

const fmtBytes = (n: number | null) => {
  if (!n) return '–'
  const u = ['B', 'kB', 'MB', 'GB', 'TB']; let i = 0, v = n
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++ }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${u[i]}`
}
const when = (t: string | null) => t ? new Date(t).toLocaleString() : '–'
const recheckText = (d: number | null) => d == null ? 'Never on a schedule' : d === 1 ? 'Every day' : `Every ${d} days`

/** Where a target writes, in one line. */
export function targetWhere(t: ArchiveTarget): string {
  // A store is described in words (bucket, folder, address), not as an
  // s3:// address: that is how people at the site name it.
  if (t.kind === 's3' && t.s3) return `Bucket ${t.s3.bucket}${t.s3.prefix ? `, folder ${t.s3.prefix}` : ''} at ${t.s3.endpoint}`
  return t.path
}

// ---------------------------------------------------------------------------
//  The target form: new, or change one
// ---------------------------------------------------------------------------
function TargetForm({ sites, target, onDone, onCancel }: {
  sites: SiteRow[]; target: ArchiveTarget | null; onDone: () => void; onCancel: () => void
}) {
  const editing = !!target
  const [name, setName] = useState(target?.name ?? '')
  const [siteId, setSiteId] = useState(target?.siteId ?? sites.find(s => s.status === 'active')?.id ?? '')
  const [kind, setKind] = useState<'path' | 's3'>(target?.kind ?? 'path')
  const [path, setPath] = useState(target?.kind === 'path' ? target.path : '')
  const [endpoint, setEndpoint] = useState(target?.s3?.endpoint ?? '')
  const [bucket, setBucket] = useState(target?.s3?.bucket ?? '')
  const [prefix, setPrefix] = useState(target?.s3?.prefix ?? '')
  const [region, setRegion] = useState(target?.s3?.region ?? '')
  const [keyName, setKeyName] = useState(target?.s3?.credentialRef ?? '')
  const [cap, setCap] = useState(target?.bandwidthMbps != null ? String(target.bandwidthMbps) : '')
  const [recheck, setRecheck] = useState(target ? (target.recheckDays == null ? '' : String(target.recheckDays)) : '30')
  const [status, setStatus] = useState<'active' | 'disabled'>(target?.status ?? 'active')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  async function save() {
    setBusy(true); setErr('')
    const bandwidthMbps = cap.trim() === '' ? null : Number(cap)
    const recheckDays = recheck.trim() === '' ? null : Number(recheck)
    const s3 = { endpoint: endpoint.trim(), bucket: bucket.trim(), ...(prefix.trim() ? { prefix: prefix.trim() } : {}), ...(region.trim() ? { region: region.trim() } : {}), ...(keyName.trim() ? { credentialRef: keyName.trim() } : {}) }
    try {
      if (editing) {
        await api.patchArchiveTarget(target!.id, {
          name: name.trim(), bandwidthMbps, recheckDays, status,
          ...(kind === 'path' ? { path: path.trim() } : { s3 }),
        })
      } else {
        await api.createArchiveTarget({
          name: name.trim(), siteId, kind, bandwidthMbps, recheckDays,
          ...(kind === 'path' ? { path: path.trim() } : { s3 }),
        })
      }
      onDone()
    } catch (e: any) { setErr(e?.message || 'Could not save the target') } finally { setBusy(false) }
  }
  const ready = name.trim() && siteId && (kind === 'path' ? path.trim() : endpoint.trim() && bucket.trim())

  return (
    <div className="card" style={{ padding: 18, margin: '12px 0' }} data-target-form>
      <div className="sec-label" style={{ marginTop: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
        {kind === 's3' ? IC.bucket : IC.folder} {editing ? `Change ${target!.name}` : 'New storage target'}
      </div>
      <div className="field"><label htmlFor="at-name">Name</label>
        <input id="at-name" className="inp" style={{ maxWidth: 420 }} value={name} maxLength={120} placeholder="Machine room NAS" onChange={e => setName(e.target.value)} autoFocus /></div>
      {!editing && (
        <>
          <div className="field"><label htmlFor="at-site">Site</label>
            <select id="at-site" className="inp sel-sm" style={{ maxWidth: 420 }} value={siteId} onChange={e => setSiteId(e.target.value)}>
              {sites.map(s => <option key={s.id} value={s.id} disabled={s.status !== 'active'}>{s.name}{s.status !== 'active' ? ' (disabled)' : ''}</option>)}
            </select>
            <div className="hintxt">The site whose servers write the copies. The cloud never reaches into the site: its servers fetch each file and write it.</div></div>
          <div className="field"><label>Kind</label>
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 'var(--fs-sm)' }}>
              <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}><input type="radio" name="at-kind" checked={kind === 'path'} onChange={() => setKind('path')} />{IC.folder} A folder or NAS share</label>
              <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}><input type="radio" name="at-kind" checked={kind === 's3'} onChange={() => setKind('s3')} />{IC.bucket} An S3-compatible store (MinIO and similar)</label>
            </div></div>
        </>
      )}
      {kind === 'path' ? (
        <div className="field"><label htmlFor="at-path">Folder on the site's server</label>
          <input id="at-path" className="inp mono" style={{ maxWidth: 420 }} value={path} placeholder="/mnt/nas/archive" onChange={e => setPath(e.target.value)} />
          <div className="hintxt">An absolute path, for example /mnt/nas/archive, D:\Archive or \\nas\archive. A target that already holds copies keeps its folder.</div></div>
      ) : (
        <>
          <div className="field"><label htmlFor="at-endpoint">Store address</label>
            <input id="at-endpoint" className="inp mono" style={{ maxWidth: 420 }} value={endpoint} placeholder="https://minio.local:9000" onChange={e => setEndpoint(e.target.value)} disabled={editing} /></div>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <div className="field"><label htmlFor="at-bucket">Bucket</label>
              <input id="at-bucket" className="inp mono" style={{ width: 200 }} value={bucket} placeholder="volt-archive" onChange={e => setBucket(e.target.value)} disabled={editing} /></div>
            <div className="field"><label htmlFor="at-prefix">Folder in the bucket (optional)</label>
              <input id="at-prefix" className="inp mono" style={{ width: 200 }} value={prefix} placeholder="originals" onChange={e => setPrefix(e.target.value)} disabled={editing} /></div>
            <div className="field"><label htmlFor="at-region">Region (optional)</label>
              <input id="at-region" className="inp mono" style={{ width: 140 }} value={region} placeholder="us-east-1" onChange={e => setRegion(e.target.value)} /></div>
          </div>
          {editing && <div className="hintxt" style={{ marginTop: 0 }}>The store, bucket and folder of a target are fixed once it holds copies; make a new target to write somewhere else.</div>}
          <div className="field"><label htmlFor="at-key">Key name</label>
            <input id="at-key" className="inp mono" style={{ maxWidth: 260 }} value={keyName} placeholder="nas1" onChange={e => setKeyName(e.target.value)} />
            <div className="hintxt" style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>{IC.shield}<span>The store's access keys never come to Volt's cloud. They stay on the site's server under this name, and each copy job names it. Leave it empty to use the server's default keys.</span></div></div>
        </>
      )}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <div className="field"><label htmlFor="at-cap">Speed cap (Mbit/s)</label>
          <input id="at-cap" className="inp" type="number" min={1} style={{ width: 140 }} value={cap} placeholder="No cap" onChange={e => setCap(e.target.value)} />
          <div className="hintxt">So copies never compete with live contribution.</div></div>
        <div className="field"><label htmlFor="at-recheck">Read copies back every (days)</label>
          <input id="at-recheck" className="inp" type="number" min={1} style={{ width: 140 }} value={recheck} placeholder="Never" onChange={e => setRecheck(e.target.value)} />
          <div className="hintxt">Catches copies changed or removed on the target. Empty: only when you ask.</div></div>
        {editing && (
          <div className="field"><label htmlFor="at-status">Status</label>
            <select id="at-status" className="inp sel-sm" value={status} onChange={e => setStatus(e.target.value as 'active' | 'disabled')}>
              <option value="active">Active</option><option value="disabled">Disabled: no new copies, existing ones kept</option>
            </select></div>
        )}
      </div>
      <div className="acct-actions">
        <FormStatus error={err} />
        <button className="btn ghost" onClick={onCancel} disabled={busy}>Cancel</button>
        <button className="btn primary" onClick={save} disabled={busy || !ready}>{editing ? IC.check : IC.plus} {busy ? 'Saving…' : editing ? 'Save target' : 'Add target'}</button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
//  The section
// ---------------------------------------------------------------------------
export function MirrorArchive() {
  const notify = useNotify()
  const [targets, setTargets] = useState<ArchiveTarget[] | null>(null)
  const [sites, setSites] = useState<SiteRow[]>([])
  const [copies, setCopies] = useState<ArchiveCopy[]>([])
  const [err, setErr] = useState('')
  const [form, setForm] = useState<'new' | ArchiveTarget | null>(null)
  const [fTarget, setFTarget] = useState('')
  const [fState, setFState] = useState('')
  const [busy, setBusy] = useState<string | null>(null)

  async function load() {
    try {
      const [t, s, c] = await Promise.all([api.archiveTargets(), api.sites(), api.archiveCopies({ targetId: fTarget || undefined, state: fState || undefined })])
      setTargets(t.items); setSites(s.items); setCopies(c.items); setErr('')
    } catch (e: any) { setErr(e?.message || 'Could not load Mirror and Archive') }
  }
  useEffect(() => { load() /* eslint-disable-next-line */ }, [fTarget, fState])

  async function check(c: ArchiveCopy) {
    setBusy(c.id)
    try { await api.verifyArchiveCopy(c.id); notify({ kind: 'ok', message: `Checking ${c.fileName}: a server at the site reads it back and compares it with the original.` }); load() }
    catch (e: any) { notify({ kind: 'error', message: e?.message || 'Could not ask for a check' }) } finally { setBusy(null) }
  }

  const counts = copies.reduce((m, c) => { m[c.state] = (m[c.state] ?? 0) + 1; return m }, {} as Record<string, number>)
  return (
    <div className="card p-4" style={{ marginBottom: 16 }} data-mirror-archive>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div className="sec-label" style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 6 }}>{IC.shield} Mirror and Archive</div>
        <span style={{ flex: 1 }} />
        {targets && sites.length > 0 && <button className="btn" onClick={() => setForm('new')} disabled={!!form}>{IC.plus} Add a storage target</button>}
      </div>
      <p style={{ color: 'var(--muted)', fontSize: 'var(--fs-sm)', marginTop: 6 }}>
        Extra copies of your originals and recordings on storage you own at your sites. A copy counts as verified only once a server at the site has read it back and it matched what Volt sent. Copy rules in{' '}
        <a href="/publishing" onClick={e => { e.preventDefault(); navigate('/publishing') }}>Publishing Rules</a> decide what is copied and when.
      </p>
      {err && <FormStatus error={err} />}
      {!targets ? (!err && <div className="loading">Loading…</div>) : (
        <>
          {sites.length === 0 && (
            <div className="hintxt" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>{IC.site}<span>Copies are written by a server at one of your sites. Create a site and add a server in{' '}
              <a href="/sites" onClick={e => { e.preventDefault(); navigate('/sites') }}>Sites</a> first.</span></div>
          )}
          {form && <TargetForm key={form === 'new' ? 'new' : form.id} sites={sites} target={form === 'new' ? null : form}
            onCancel={() => setForm(null)} onDone={() => { notify({ kind: 'ok', message: form === 'new' ? 'Storage target added.' : 'Storage target saved.' }); setForm(null); load() }} />}

          <div className="sec-label">Storage targets</div>
          {targets.length === 0 ? (
            <div className="hintxt" style={{ marginTop: 0 }}>No storage targets yet.{sites.length > 0 ? ' Add one for a folder, a NAS share or an S3-compatible store at a site.' : ''}</div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table>
                <thead><tr><th>Target</th><th>Site</th><th>Where</th><th>Speed cap</th><th>Read back</th><th>Status</th><th /></tr></thead>
                <tbody>
                  {targets.map(t => (
                    <tr key={t.id} data-target={t.name} style={{ cursor: 'default' }}>
                      <td><span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>{t.kind === 's3' ? IC.bucket : IC.folder}<b>{t.name}</b></span>
                        <div className="hintxt" style={{ margin: 0 }}>{t.kind === 's3' ? `S3-compatible store${t.s3?.credentialRef ? `, keys "${t.s3.credentialRef}" on the site's server` : ''}` : 'Folder or NAS share'}</div></td>
                      <td>{t.siteName ?? '–'}</td>
                      <td className="mono" style={{ fontSize: 'var(--fs-sm)', overflowWrap: 'anywhere' }}>{targetWhere(t)}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>{t.bandwidthMbps ? `${t.bandwidthMbps} Mbit/s` : 'No cap'}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>{recheckText(t.recheckDays)}</td>
                      <td><span className={`tag ${t.status === 'active' ? 'live' : 'idle'}`}>{t.status === 'active' ? 'Active' : 'Disabled'}</span></td>
                      <td style={{ width: 1 }}><button className="btn sm ghost" onClick={() => setForm(t)} disabled={!!form}>{IC.edit} Change</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 16 }}>
            <div className="sec-label" style={{ margin: 0 }}>Copies</div>
            <span style={{ flex: 1 }} />
            <select className="inp sel-sm" aria-label="Show copies on" style={{ width: 200 }} value={fTarget} onChange={e => setFTarget(e.target.value)}>
              <option value="">Every target</option>
              {targets.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
            <select className="inp sel-sm" aria-label="Show copies that are" style={{ width: 200 }} value={fState} onChange={e => setFState(e.target.value)}>
              <option value="">Any state</option>
              {(['queued', 'verified', 'failed', 'corrupt', 'missing'] as ArchiveCopyState[]).map(s => <option key={s} value={s}>{COPY_STATE[s].label}</option>)}
            </select>
            <span className="hintxt" style={{ margin: 0 }}>{Object.entries(counts).map(([s, n]) => `${n} ${COPY_STATE[s as ArchiveCopyState]?.label.toLowerCase() ?? s}`).join(' · ')}</span>
          </div>
          {copies.length === 0 ? (
            <div className="hintxt">{fTarget || fState ? 'No copies match.' : 'No copies yet. They are made by copy rules, or through the API.'}</div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table>
                <thead><tr><th>File</th><th>Target</th><th>State</th><th>Size</th><th>Last confirmed</th><th /></tr></thead>
                <tbody>
                  {copies.map(c => {
                    const st = COPY_STATE[c.state] ?? { label: c.state, cls: 'idle', about: '' }
                    const hint = c.errorCode ? ERROR_HINT[c.errorCode] : undefined
                    const canCheck = ['verified', 'corrupt', 'missing'].includes(c.state) && !c.checking
                    return (
                      <tr key={c.id} data-copy={c.fileName} style={{ cursor: 'default' }}>
                        <td><div className="mono" style={{ fontSize: 'var(--fs-sm)', overflowWrap: 'anywhere' }}>{c.storedPath ?? c.fileName}</div>
                          {c.vodAssetId && c.what === 'clip' && <div className="hintxt" style={{ margin: 0 }} data-copy-clip>Clip file, as made</div>}
                          {c.vodAssetId && c.what === 'package' && <div className="hintxt" style={{ margin: 0 }} data-copy-package>HLS/DASH package, a folder{c.bytes != null ? ` of ${(c.bytes / 1e6).toFixed(1)} MB` : ''}</div>}
                          {c.vodAssetId && c.what && c.what !== 'source' && c.what !== 'clip' && c.what !== 'package' && <div className="hintxt" style={{ margin: 0 }} data-copy-sidecar>{c.what === 'metadata' ? 'Metadata file' : c.what === 'poster' ? 'Poster' : c.what.startsWith('captions:') ? 'Caption file' : 'File that came with the asset'}, beside the original</div>}
                          {c.vodAssetId && <a className="hintxt" style={{ margin: 0 }} href={`/vod?asset=${c.vodAssetId}`} onClick={e => { e.preventDefault(); navigate(`/vod?asset=${c.vodAssetId}`) }}>Open the asset</a>}
                          {c.streamId && <div className="hintxt" style={{ margin: 0 }} data-copy-recording>
                            {c.what === 'recording-sidecar' ? 'Metadata of the recording of ' : 'Recording of '}{c.streamName ?? 'a deleted stream'}{c.rangeStart && c.rangeEnd ? `, ${new Date(c.rangeStart).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })} to ${new Date(c.rangeEnd).toLocaleTimeString([], { timeStyle: 'short' })}` : ''}{' '}
                            {c.streamName && <a href={`/recordings/source/${c.streamId}`} onClick={e => { e.preventDefault(); navigate(`/recordings/source/${c.streamId}`) }}>Open the recording</a>}</div>}</td>
                        <td>{c.targetName ?? '–'}</td>
                        <td><span className={`tag ${st.cls}`} title={st.about}>{st.label}</span>
                          {c.checking && <div className="hintxt" style={{ margin: 0 }}>Being read back now</div>}
                          {(c.error || hint) && c.state !== 'verified' && (
                            <div style={{ margin: '4px 0 0', fontSize: 'var(--fs-sm)', maxWidth: 380 }} data-copy-error={c.errorCode ?? ''}>
                              {c.error && <div style={{ color: c.state === 'queued' || c.state === 'copying' ? 'var(--warn)' : 'var(--down)' }}>{c.error}</div>}
                              {hint && <div className="hintxt" style={{ margin: '2px 0 0' }}><b>What to do:</b> {hint}</div>}
                            </div>)}</td>
                        <td style={{ whiteSpace: 'nowrap' }}>{fmtBytes(c.bytes)}</td>
                        <td style={{ whiteSpace: 'nowrap' }}>{when(c.checkedAt ?? c.verifiedAt)}</td>
                        <td style={{ width: 1 }}>{canCheck && <button className="btn sm ghost" disabled={busy === c.id} onClick={() => check(c)} title="Read the copy back from the target now">{IC.check} Check now</button>}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
          <Originals />
        </>
      )}
    </div>
  )
}
