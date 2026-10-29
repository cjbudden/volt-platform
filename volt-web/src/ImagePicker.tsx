// Reusable "pick from the library" modal used by the slate / brand / loop pickers in
// the channel create + settings forms. You can BROWSE existing library items and, for
// image kinds, UPLOAD a new one right here (it's added to the library and auto-picked).
// Returns the picked item's /library URL.
import { useEffect, useRef, useState } from 'react'
import { api, apiRequest, isMotionFile, type MediaFile } from './api'
import { MotionThumb } from './MotionThumb'
import { pressable, useEscape } from './a11y'
import { Notice } from './notices'

function fileToDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(r.error)
    r.readAsDataURL(file)
  })
}

export function ImagePicker({ open, onClose, onPick, kinds, title, allowUpload = true, uploadKind, uploadFolder, uploadHint, assetId }: {
  open: boolean
  onClose: () => void
  onPick: (url: string, file: MediaFile) => void
  kinds?: string[]           // restrict to these usage types (e.g. ['slate','brand'])
  title?: string
  allowUpload?: boolean      // show the Upload button (image kinds only)
  uploadKind?: string        // kind to tag an uploaded file (default kinds[0] or 'other')
  uploadFolder?: string      // library folder for uploads (default 'slates')
  uploadHint?: string        // note shown instead of the Upload button (e.g. for video)
  /** Open on this asset's own images first (GET /vod/:id/images/related): what it uses, what was
   *  made or uploaded for it, its song's cover, stills from while it aired. Then the library. */
  assetId?: string
}) {
  const [related, setRelated] = useState<{ key: string; label: string; files: MediaFile[] }[] | null>(null)
  useEffect(() => {
    if (!open || !assetId) { setRelated(null); return }
    apiRequest(`/vod/${assetId}/images/related`).then((r: any) => setRelated(r.groups ?? []), () => setRelated([]))
  }, [open, assetId])
  const [files, setFiles] = useState<MediaFile[] | null>(null)
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const fileInput = useRef<HTMLInputElement | null>(null)
  useEscape(open, onClose)

  function reload() {
    setFiles(null)
    api.files({ q: q || undefined }).then(all => {
      setFiles(kinds?.length ? all.filter(f => kinds.includes(f.kind)) : all)
    }).catch(() => setFiles([]))
  }
  useEffect(() => { if (open) reload() /* eslint-disable-next-line */ }, [open, q, kinds])

  async function onUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (e.target) e.target.value = ''   // allow re-selecting the same file later
    if (!file) return
    setErr(''); setBusy(true)
    try {
      // A video (an animated bug) goes up raw and comes back as an alpha WebM item.
      if (isMotionFile(file)) {
        const created = await api.uploadMotion(file, { folder: uploadFolder || 'bugs', name: file.name, kind: uploadKind || kinds?.[0] || 'bug' })
        if (created.warning) setErr(created.warning)
        setFiles(prev => (prev ? [created, ...prev] : [created]))
        onPick(created.url, created)
        return
      }
      const dataBase64 = await fileToDataURL(file)
      const created = await api.uploadFile({
        folder: uploadFolder || 'slates',
        name: file.name,
        kind: uploadKind || kinds?.[0] || 'slate',
        contentType: file.type,
        dataBase64,
      })
      setFiles(prev => (prev ? [created, ...prev] : [created]))
      onPick(created.url, created)   // auto-select the freshly uploaded item
    } catch (e2: any) {
      setErr(e2?.message || 'Upload failed')
    } finally { setBusy(false) }
  }

  if (!open) return null
  const shown = files || []
  return (
    <div className="drawer-scrim" {...pressable((e: any) => { ((onClose) as any)(e) })} data-a11y-click="" style={{ alignItems: 'center', justifyContent: 'center' }}>
      <div className="card" {...pressable((e: any) => { (((e: any) => e.stopPropagation()) as any)(e) })} data-a11y-click="" style={{ width: 640, maxWidth: '95vw', maxHeight: '82vh', display: 'flex', flexDirection: 'column' }}>
        <div className="card-h"><h3>{title || 'Choose from library'}</h3><div className="spacer" style={{ flex: 1 }} />
          <input className="inp" style={{ maxWidth: 200 }} placeholder="Search…" value={q} onChange={e => setQ(e.target.value)} />
          {allowUpload ? (
            <>
              <input ref={fileInput} type="file" accept="image/*,video/*,.mov,.webm" style={{ display: 'none' }} onChange={onUpload} />
              <button className="btn primary" style={{ marginLeft: 8 }} disabled={busy} onClick={() => fileInput.current?.click()}>
                {busy ? 'Uploading…' : '⬆ Upload'}
              </button>
            </>
          ) : uploadHint ? (
            <span style={{ marginLeft: 8, fontSize: 'var(--fs-label)', color: 'var(--faint)', maxWidth: 220 }}>{uploadHint}</span>
          ) : null}
          <button className="xbtn" onClick={onClose} style={{ marginLeft: 8 }}>✕</button>
        </div>
        {err && <div style={{ margin: '0 14px' }}><Notice kind="error" variant="compact" message={err} /></div>}
        <div className="card-b" style={{ overflow: 'auto' }}>
          {!q && related && related.map(g => (
            <div key={g.key} style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 'var(--fs-label)', fontWeight: 600, color: 'var(--muted)', marginBottom: 6 }}>{g.label}</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(120px,1fr))', gap: 12 }}>
                {g.files.map(f => (
                  <div key={f.id} className="card" style={{ overflow: 'hidden', cursor: 'pointer' }} {...pressable((e: any) => { ((() => onPick(f.url, f)) as any)(e) })} data-a11y-click="" title={f.path}>
                    <MotionThumb f={f} w={480} h={300} style={{ aspectRatio: '16/10', background: 'repeating-conic-gradient(#1a1f2b 0% 25%, #141821 0% 50%) 50% / 14px 14px' }} />
                    <div style={{ padding: '7px 9px', fontSize: 'var(--fs-micro)', color: 'var(--faint)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {f.captured_at ? new Date(f.captured_at).toLocaleTimeString() : f.name}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
          {!q && related && related.length > 0 && <div style={{ fontSize: 'var(--fs-label)', fontWeight: 600, color: 'var(--muted)', margin: '4px 0 6px' }}>All images</div>}
          {files === null ? <div className="loading">Loading…</div>
            : shown.length === 0 ? (
              <div style={{ textAlign: 'center', color: 'var(--muted)', padding: 24, fontSize: 'var(--fs-body)' }}>
                Nothing here yet. {allowUpload ? 'Use Upload above, or add items in ' : 'Add items in '}<b>Media → Image Library</b>.
              </div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(120px,1fr))', gap: 12 }}>
                {shown.map(f => (
                  <div key={f.id} className="card" style={{ overflow: 'hidden', cursor: 'pointer' }} {...pressable((e: any) => { ((() => onPick(f.url, f)) as any)(e) })} data-a11y-click="">
                    <MotionThumb f={f} w={480} h={300} style={{ aspectRatio: '16/10', background: 'repeating-conic-gradient(#1a1f2b 0% 25%, #141821 0% 50%) 50% / 14px 14px' }} />
                    <div style={{ padding: '7px 9px' }}>
                      <div style={{ fontSize: 'var(--fs-xs)', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={f.path}>{f.name}</div>
                      <div style={{ fontSize: 'var(--fs-micro)', color: 'var(--faint)' }}>{f.kind} · {f.width && f.height ? `${f.width}×${f.height}` : ''}</div>
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
