import { useEffect, useMemo, useState } from 'react'
import { api, type SocialAccount, type SocialPlatformsStatus, type SocialPost, type SocialPublication, type SocialPlatformId } from '../api'
import { navigate } from '../router'
import { pressable } from '../a11y'
import { FormStatus, Notice, useNotify, usePageNotice } from '../notices'

/* ============================================================================
   PUBLISH A CLIP TO SOCIAL: the composer and the status of what went out.

   ONE POST, ADAPTED PER PLATFORM. The person writes once (title, description,
   tags, privacy, prefilled from the asset), then can open any platform's tab
   to adjust its version. Each version is checked against that platform's
   limits as it is typed: a YouTube title over 100 characters or an X caption
   over 280 (hashtags count) stops the Publish button with the reason next to
   the field, rather than failing on the platform minutes later.

   THE STATUS LIST polls while anything is still going up, shows the stage the
   platform is at, and for a failure shows the platform's own words with a
   Retry that can carry an edited post.
   ========================================================================== */
const LABEL: Record<string, string> = { youtube: 'YouTube', facebook: 'Facebook', x: 'X', tiktok: 'TikTok', dailymotion: 'Dailymotion' }
const PRIVACY_LABEL: Record<string, string> = { public: 'Public', unlisted: 'Unlisted', private: 'Private' }

type Limits = SocialPlatformsStatus['platforms'][number]

function captionLength(l: Limits, p: SocialPost): number {
  const tags = l.limits.tags && l.limits.title == null ? p.tags.map(t => `#${t.replace(/^#/, '').replace(/\s+/g, '')}`).join(' ') : ''
  return p.description.trim().length + (tags ? (p.description.trim() ? 1 : 0) + tags.length : 0)
}
export function postProblems(l: Limits, p: SocialPost): string[] {
  const out: string[] = []
  if (l.limits.title != null && !p.title.trim()) out.push('needs a title')
  if (l.limits.title != null && p.title.trim().length > l.limits.title) out.push(`title is ${p.title.trim().length} of ${l.limits.title} characters`)
  const n = captionLength(l, p)
  if (n > l.limits.description) out.push(`${l.limits.title == null ? 'caption' : 'description'} is ${n} of ${l.limits.description} characters`)
  if (l.limits.title == null && n === 0) out.push('needs a caption')
  return out
}

export function SocialComposer({ assetId, onClose, onPublished }: { assetId: string; onClose: () => void; onPublished: () => void }) {
  const [st, setSt] = useState<SocialPlatformsStatus | null>(null)
  const [accounts, setAccounts] = useState<SocialAccount[] | null>(null)
  const [defaults, setDefaults] = useState<Record<string, SocialPost> | null>(null)
  const [picked, setPicked] = useState<string[]>([])
  const [base, setBase] = useState<SocialPost>({ title: '', description: '', tags: [], privacy: 'public' })
  const [tagText, setTagText] = useState('')
  const [over, setOver] = useState<Record<string, SocialPost>>({})
  const [tab, setTab] = useState<'all' | SocialPlatformId>('all')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  useEffect(() => {
    api.socialPlatforms().then(setSt).catch(e => setErr(e.message))
    // An X account is kept while X is off for the account (build queue 1.14h), but not offered.
    api.socialAccounts().then(a => setAccounts(a.filter(x => x.enabled && !(x as { off?: boolean }).off))).catch(e => setErr(e.message))
    api.socialDefaults(assetId).then(d => {
      setDefaults(d)
      const y = d.youtube
      setBase({ title: y.title, description: y.description, tags: y.tags, privacy: 'public' })
      setTagText(y.tags.join(', '))
    }).catch(e => setErr(e.message))
  }, [assetId])

  const platformsPicked = useMemo(() => {
    const set = new Set((accounts ?? []).filter(a => picked.includes(a.id)).map(a => a.platform))
    return (['youtube', 'facebook', 'x', 'tiktok', 'dailymotion'] as SocialPlatformId[]).filter(p => set.has(p))
  }, [accounts, picked])

  const limitsOf = (p: SocialPlatformId) => st!.platforms.find(x => x.id === p)!
  /** A platform's post: its override if edited, else the shared one adapted (caption platforms get the title in the caption). */
  function postFor(p: SocialPlatformId): SocialPost {
    if (over[p]) return over[p]
    const l = limitsOf(p)
    const tags = tagText.split(',').map(t => t.trim()).filter(Boolean)
    const privacy = l.privacy.includes(base.privacy) ? base.privacy : l.privacy[0]
    if (l.limits.title == null) return { title: '', description: [base.title, base.description].filter(s => s.trim()).join('\n\n'), tags, privacy }
    return { ...base, tags, privacy }
  }
  const problems = st ? platformsPicked.flatMap(p => postProblems(limitsOf(p), postFor(p)).map(x => `${LABEL[p]}: ${x}`)) : []

  async function submit() {
    setErr('')
    if (!picked.length) { setErr('Pick at least one account'); return }
    if (problems.length) { setErr(problems.join('. ')); return }
    setBusy(true)
    try {
      await api.socialPublish(assetId, (accounts ?? []).filter(a => picked.includes(a.id)).map(a => ({ targetId: a.id, post: postFor(a.platform) })))
      onPublished(); onClose()
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }

  const editing = tab === 'all' ? null : tab
  const cur = editing ? postFor(editing) : base
  const setCur = (p: Partial<SocialPost>) => editing ? setOver(o => ({ ...o, [editing]: { ...postFor(editing), ...p } })) : setBase(b => ({ ...b, ...p }))
  const l = editing && st ? limitsOf(editing) : null

  return (
    <div className="drawer-scrim" {...pressable((e: any) => { ((onClose) as any)(e) })} data-a11y-click="">
      <div className="drawer" style={{ width: 640, maxWidth: '100vw' }} {...pressable((e: any) => { (((e: any) => e.stopPropagation()) as any)(e) })} data-a11y-click="">
        <div className="drawer-h"><div className="t">Publish to social</div><button className="xbtn" onClick={onClose} aria-label="Close">✕</button></div>
        <div className="drawer-b">
          {!st || !accounts || !defaults ? <div className="loading">Loading…</div> : accounts.length === 0 ? (
            <div className="hintxt">No social accounts are linked. <button className="btn ghost" onClick={() => navigate('/social')}>Link one</button></div>
          ) : (
            <>
              <div className="sec-label">Publish to</div>
              <div className="sp-accounts">
                {accounts.map(a => {
                  const off = a.link_status === 'expired'
                  return (
                    <label key={a.id} className={`sp-acct ${picked.includes(a.id) ? 'on' : ''}`} style={{ opacity: off ? 0.55 : 1 }}>
                      <input type="checkbox" disabled={off} checked={picked.includes(a.id)}
                        onChange={e => setPicked(p => e.target.checked ? [...p, a.id] : p.filter(x => x !== a.id))} />
                      <span style={{ minWidth: 0 }}>
                        <span style={{ fontWeight: 600 }}>{a.account_label ?? a.name}</span>
                        <span className="hintxt" style={{ display: 'block', marginTop: 0 }}>{LABEL[a.platform]}{a.mode === 'sandbox' ? ' · sandbox' : ''}{off ? ' · reconnect needed' : ''}</span>
                      </span>
                    </label>
                  )
                })}
              </div>

              <div className="sec-label" style={{ marginTop: 18 }}>The post</div>
              <div className="sp-tabs" role="tablist">
                <button role="tab" aria-selected={tab === 'all'} className={`btn ${tab === 'all' ? 'primary' : 'ghost'}`} onClick={() => setTab('all')}>Shared</button>
                {platformsPicked.map(p => {
                  const n = postProblems(limitsOf(p), postFor(p)).length
                  return <button key={p} role="tab" aria-selected={tab === p} className={`btn ${tab === p ? 'primary' : 'ghost'}`} onClick={() => setTab(p)}>
                    {LABEL[p]}{over[p] ? ' (edited)' : ''}{n ? ` · ${n} to fix` : ''}
                  </button>
                })}
              </div>
              <div className="hintxt" style={{ marginBottom: 8 }}>
                {editing ? <>This is the {LABEL[editing]} version. {over[editing] ? <button className="btn ghost" onClick={() => setOver(o => { const n = { ...o }; delete n[editing]; return n })}>Go back to the shared post</button> : 'Change anything here and it stops following the shared post.'}</>
                  : 'Written once for every account. Open a platform to adjust its version: X and TikTok use one caption, with tags as hashtags.'}
              </div>

              {(!l || l.limits.title != null) && (
                <div className="field"><label>Title {l?.limits.title ? <span className="sp-count">{cur.title.trim().length}/{l.limits.title}</span> : null}</label>
                  <input className="inp" value={cur.title} onChange={e => setCur({ title: e.target.value })} />
                </div>
              )}
              <div className="field"><label>{l && l.limits.title == null ? 'Caption' : 'Description'} {l ? <span className={`sp-count ${captionLength(l, cur) > l.limits.description ? 'bad' : ''}`}>{captionLength(l, cur)}/{l.limits.description}</span> : null}</label>
                <textarea className="inp" rows={l && l.limits.title == null ? 4 : 5} value={cur.description} onChange={e => setCur({ description: e.target.value })} />
                {l && l.limits.title == null && cur.tags.length > 0 && (
                  <div className="hintxt">Added at the end, and counted: {cur.tags.map(t => `#${t.replace(/^#/, '').replace(/\s+/g, '')}`).join(' ')}</div>
                )}
              </div>
              {!editing && (
                <div className="field"><label>Tags <span style={{ color: 'var(--faint)' }}>comma separated</span></label>
                  <input className="inp" value={tagText} onChange={e => setTagText(e.target.value)} placeholder="rugby, final" />
                </div>
              )}
              <div className="field"><label>Visibility</label>
                <select className="inp" value={cur.privacy} onChange={e => setCur({ privacy: e.target.value as any })}>
                  {(l ? l.privacy : (['public', 'unlisted', 'private'] as const)).map(p => <option key={p} value={p}>{PRIVACY_LABEL[p]}</option>)}
                </select>
                {!editing && <div className="hintxt">A platform without that option uses its nearest: Facebook and X posts are public. TikTok posts privately until TikTok has audited the app.</div>}
              </div>
            </>
          )}
        </div>
        <div className="drawer-f">
          <FormStatus error={err} blocked={problems.length > 0 ? `${problems.join('. ')}.` : undefined} />
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy || !picked.length || problems.length > 0} onClick={submit}>{busy ? 'Publishing…' : `Publish to ${picked.length || ''} account${picked.length === 1 ? '' : 's'}`}</button>
        </div>
      </div>
    </div>
  )
}

const ST: Record<string, { label: string; cls: string }> = {
  pending: { label: 'Publishing', cls: 'muted' }, published: { label: 'Published', cls: 'ok' }, failed: { label: 'Failed', cls: 'bad' },
  removed: { label: 'Taken down', cls: 'muted' }, withdrawn: { label: 'Withdrawn', cls: 'muted' },
}

/** Where this asset went on social, live while anything is still going up. */
export function SocialPanel({ assetId, refreshKey }: { assetId: string; refreshKey: number }) {
  const [rows, setRows] = useState<SocialPublication[] | null>(null)
  const [err, setErr] = useState('')
  const notify = useNotify()
  const fail = (e: any) => notify({ kind: 'error', message: e.message })
  const load = () => api.socialPublications(assetId).then(r => { setRows(r); setErr('') }).catch(e => setErr(e.message))
  useEffect(() => { load() }, [assetId, refreshKey])
  const active = (rows ?? []).some(r => r.status === 'pending')
  useEffect(() => {
    if (!active) return
    const t = setInterval(load, 1500)
    return () => clearInterval(t)
  }, [active, assetId])

  usePageNotice('social-load', err && rows ? { kind: 'error', title: "Couldn't refresh the social posts.", message: err, actions: [{ label: 'Retry', onClick: () => { load() } }] } : null)

  if (!rows) return err ? <Notice kind="error" variant="compact" title="Couldn't load the social posts." message={err} actions={[{ label: 'Retry', onClick: () => { load() } }]} /> : null
  if (!rows.length) return null
  return (
    <div style={{ marginTop: 16 }}>
      <div className="sec-label" style={{ display: 'flex', alignItems: 'center' }}>
        <span>Social</span><div style={{ flex: 1 }} />
        <button className="btn ghost" onClick={() => api.socialSyncViews().then(load).catch(fail)}>Refresh views</button>
      </div>
      <div className="card" style={{ padding: 0 }}>
        {rows.map((r, i) => {
          const s = ST[r.status] ?? ST.pending
          return (
            <div key={r.id} className="nt-row" style={{ borderTop: i ? '1px solid var(--border)' : undefined, alignItems: 'flex-start' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>{r.account_label ?? r.target_name} <span className="hintxt" style={{ fontWeight: 400 }}>{LABEL[r.platform]}{r.mode === 'sandbox' ? ' sandbox' : ''}</span>
                  <span className={`nt-pill ${s.cls}`}>{s.label}</span>
                  {r.stale && <span className="nt-pill warn">re-cut since</span>}
                </div>
                <div className="hintxt" style={{ marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.post?.title || r.post?.description || ''}</div>
                {r.status === 'pending' && (
                  <div className="sp-progress" aria-label={`${r.progress ?? 0}%`}><i style={{ width: `${r.progress ?? 0}%` }} /></div>
                )}
                {r.status === 'pending' && r.stage && <div className="hintxt" style={{ marginTop: 2 }}>{r.stage === 'will retry' ? `Will retry: ${r.error ?? ''}` : r.stage}</div>}
                {r.status === 'failed' && r.error && <div className="err" style={{ marginTop: 4 }}>{r.error}</div>}
                {r.status === 'published' && <div className="hintxt" style={{ marginTop: 2 }}>{r.views} views{r.last_synced_at ? ` (checked ${new Date(r.last_synced_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})` : ''}{r.published_at ? ` · ${new Date(r.published_at).toLocaleString()}` : ''}</div>}
              </div>
              {r.external_url && r.status === 'published' && <a className="btn ghost" href={r.external_url} target="_blank" rel="noreferrer">Open</a>}
              {r.status === 'failed' && <button className="btn" onClick={() => api.socialRetry(r.id).then(load).catch(fail)}>Retry</button>}
              {r.status === 'published' && <button className="btn ghost" onClick={() => {
                if (window.confirm(`Take this down from ${LABEL[r.platform]}? It is deleted there; the clip stays in Volt.`)) api.socialTakeDown(r.id).then(load).catch(fail)
              }}>Take down</button>}
            </div>
          )
        })}
      </div>
    </div>
  )
}
