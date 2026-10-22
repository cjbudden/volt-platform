// The History tab's timeline (GET /api/vod/:id/history): when and how the asset
// was made, built or encoded, its image and song details, review and QC, where
// it was published, access removed, and the changes people made. Newest first.
import { useEffect, useState, type ReactElement } from 'react'
import { apiRequest } from '../../api'

interface Ev { at: string; kind: string; title: string; detail?: string | null; by?: string | null; link?: string | null }

const s = { viewBox: '0 0 24 24', width: 14, height: 14, fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true }
const ICON: Record<string, ReactElement> = {
  created: <svg {...s}><path d="M12 5v14M5 12h14" /></svg>,
  built: <svg {...s}><path d="M4 7h16M4 12h10M4 17h7" /></svg>,
  encoded: <svg {...s}><rect x="3" y="6" width="18" height="12" rx="2" /><path d="M7 10v4M11 9v6M15 10v4" /></svg>,
  image: <svg {...s}><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="9" cy="10" r="2" /><path d="m21 17-5-5-9 8" /></svg>,
  song: <svg {...s}><path d="M9 18V6l10-2v12" /><circle cx="6.5" cy="18" r="2.5" /><circle cx="16.5" cy="16" r="2.5" /></svg>,
  review: <svg {...s}><path d="m5 12 4 4 10-10" /></svg>,
  qc: <svg {...s}><path d="M12 3 4 6v6c0 4.5 3.4 8 8 9 4.6-1 8-4.5 8-9V6z" /></svg>,
  published: <svg {...s}><path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7M12 3v12M7 8l5-5 5 5" /></svg>,
  withdrawn: <svg {...s}><circle cx="12" cy="12" r="9" /><path d="M5.6 5.6l12.8 12.8" /></svg>,
  edit: <svg {...s}><path d="M4 20h4L19 9l-4-4L4 16z" /></svg>,
  deleted: <svg {...s}><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" /></svg>,
}

const when = (iso: string) => {
  const d = new Date(iso)
  return { day: d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }), time: d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) }
}

export function AssetHistory({ id, refreshKey }: { id: string; refreshKey?: number }) {
  const [ev, setEv] = useState<Ev[] | null>(null)
  const [err, setErr] = useState('')
  const [all, setAll] = useState(false)
  useEffect(() => {
    setEv(null)
    apiRequest(`/vod/${id}/history`).then((r: any) => setEv(r.events ?? []), (e: any) => setErr(e.message))
  }, [id, refreshKey])
  if (err) return <div className="asset-img-err">{err}</div>
  if (!ev) return <div className="lib-faint">Loading the history…</div>
  const shown = all ? ev : ev.slice(0, 12)
  return (
    <div className="hist">
      <ol className="hist-l">
        {shown.map((e, i) => {
          const w = when(e.at)
          return (
            <li key={i} className={`hist-r k-${e.kind}`}>
              <span className="hist-when"><b>{w.day}</b><span>{w.time}</span></span>
              <span className="hist-ic">{ICON[e.kind] ?? ICON.edit}</span>
              <span className="hist-what">
                <span className="hist-t">{e.title}{e.link && <> · <a href={e.link} target="_blank" rel="noreferrer">open</a></>}</span>
                {(e.detail || e.by) && <span className="hist-d">{[e.detail, e.by ? `by ${e.by}` : null].filter(Boolean).join(' · ')}</span>}
              </span>
            </li>
          )
        })}
      </ol>
      {ev.length > 12 && <button type="button" className="btn ghost sm" onClick={() => setAll(!all)}>{all ? 'Show less' : `Show all ${ev.length}`}</button>}
    </div>
  )
}
