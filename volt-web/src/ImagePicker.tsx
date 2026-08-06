// Reusable "pick an image from the library" modal. Used by the slate/brand pickers in
// the channel create + settings forms so you choose from the Image Library instead of
// pasting a URL. Returns the picked image's /library URL.
import { useEffect, useState } from 'react'
import { api, thumbUrl, type MediaFile } from './api'

export function ImagePicker({ open, onClose, onPick, kinds, title }: {
  open: boolean
  onClose: () => void
  onPick: (url: string, file: MediaFile) => void
  kinds?: string[]           // restrict to these usage types (e.g. ['slate','brand'])
  title?: string
}) {
  const [files, setFiles] = useState<MediaFile[] | null>(null)
  const [q, setQ] = useState('')
  useEffect(() => {
    if (!open) return
    setFiles(null)
    api.files({ q: q || undefined }).then(all => {
      setFiles(kinds?.length ? all.filter(f => kinds.includes(f.kind)) : all)
    }).catch(() => setFiles([]))
  }, [open, q, kinds])

  if (!open) return null
  const shown = files || []
  return (
    <div className="drawer-scrim" onClick={onClose} style={{ alignItems: 'center', justifyContent: 'center' }}>
      <div className="card" onClick={e => e.stopPropagation()} style={{ width: 640, maxWidth: '95vw', maxHeight: '82vh', display: 'flex', flexDirection: 'column' }}>
        <div className="card-h"><h3>{title || 'Choose an image'}</h3><div className="spacer" style={{ flex: 1 }} />
          <input className="inp" style={{ maxWidth: 200 }} placeholder="Search…" value={q} onChange={e => setQ(e.target.value)} />
          <button className="xbtn" onClick={onClose} style={{ marginLeft: 8 }}>✕</button>
        </div>
        <div className="card-b" style={{ overflow: 'auto' }}>
          {files === null ? <div className="loading">Loading…</div>
            : shown.length === 0 ? (
              <div style={{ textAlign: 'center', color: 'var(--muted)', padding: 24, fontSize: 13 }}>
                No {kinds?.length ? kinds.join('/') + ' ' : ''}images yet. Add some in <b>Media → Image Library</b>.
              </div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(120px,1fr))', gap: 12 }}>
                {shown.map(f => (
                  <div key={f.id} className="card" style={{ overflow: 'hidden', cursor: 'pointer' }} onClick={() => onPick(f.url, f)}>
                    <div style={{ aspectRatio: '16/10', background: 'repeating-conic-gradient(#1a1f2b 0% 25%, #141821 0% 50%) 50% / 14px 14px', display: 'grid', placeItems: 'center' }}>
                      <img src={thumbUrl(f.url, 240, 150)} alt={f.name} loading="lazy" style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
                    </div>
                    <div style={{ padding: '7px 9px' }}>
                      <div style={{ fontSize: 11.5, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={f.path}>{f.name}</div>
                      <div style={{ fontSize: 10, color: 'var(--faint)' }}>{f.kind} · {f.width && f.height ? `${f.width}×${f.height}` : ''}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
        </div>
      </div>
    </div>
  )
}
