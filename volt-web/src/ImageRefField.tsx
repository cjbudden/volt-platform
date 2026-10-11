import { useEffect, useState } from 'react'
import { thumbUrl } from './api'
import { ImagePicker } from './ImagePicker'

/* ============================================================================
   ONE IMAGE FIELD for every "pick a logo" in the app: channel logo, station
   artwork, guide icon, watermark image. Before this each form had its own copy
   and they had drifted: one had a preview, one a tiny one, one none at all.

   A library image is stored as /library/<account id>/<folder>/<file>. The
   account id keeps one account's files apart from another's on disk, but it
   means nothing to the person picking a logo, so the field shows the file name
   and its folder instead of the raw path. Pasting an http(s) URL still works.
   ========================================================================== */

const LIB_RX = /^\/?library\/[0-9a-f-]{36}\/(.+)$/i

/** "brands/rtm-logo.png" for a library reference, null for anything else. */
export function libraryLabel(ref: string): { file: string; folder: string } | null {
  const m = LIB_RX.exec(ref.trim())
  if (!m) return null
  const parts = decodeURIComponent(m[1]).split('/')
  const file = parts.pop() || m[1]
  return { file, folder: parts.join('/') }
}

export function ImagePreview({ src, size = 64, wide = false, empty }: { src: string; size?: number; wide?: boolean; empty?: React.ReactNode }) {
  const [broken, setBroken] = useState('')
  const s = src.trim()
  const w = wide ? Math.round(size * 16 / 9) : size
  return (
    <span className="imgref-prev" style={{ width: w, height: size }} aria-hidden={!s || undefined}>
      {s && broken !== s
        ? <img src={thumbUrl(s, w * 2, size * 2, 'inside')} alt="Preview" onError={() => setBroken(s)} />
        : s
          ? <span className="imgref-bad">Can't load</span>
          : (empty ?? <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="var(--faint)" strokeWidth="2"><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="9" cy="10" r="2" /><path d="m21 17-5-5-9 8" /></svg>)}
    </span>
  )
}

export function ImageRefField({
  label, hint, value, onChange, pickerTitle, kinds = ['brand', 'other'], uploadFolder = 'brands',
  preview = true, wide = false, placeholder = 'Paste an image URL, or browse the library', help,
}: {
  label: React.ReactNode
  hint?: string
  value: string
  onChange: (v: string) => void
  pickerTitle: string
  kinds?: string[]
  uploadFolder?: string
  /** False when the caller shows its own preview (the watermark frame). */
  preview?: boolean
  wide?: boolean
  placeholder?: string
  help?: React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  const lib = libraryLabel(value)
  // A library pick shows its name; "Paste a URL" swaps in the text box.
  const [typing, setTyping] = useState(!lib)
  useEffect(() => { if (lib) setTyping(false) }, [value]) // eslint-disable-line react-hooks/exhaustive-deps
  const showInput = typing || !lib
  return (
    <div className="field">
      <label>{label}{hint && <span className="imgref-hint">: {hint}</span>}</label>
      <div className="imgref">
        {preview && <ImagePreview src={value} wide={wide} />}
        <div className="imgref-body">
          {showInput ? (
            <input className="inp" value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} aria-label={typeof label === 'string' ? label : undefined} />
          ) : (
            <div className="imgref-chip" title={value}>
              <span className="imgref-file">{lib!.file}</span>
              <span className="imgref-where">Library{lib!.folder ? ` · ${lib!.folder}` : ''}</span>
            </div>
          )}
          <div className="imgref-acts">
            <button type="button" className="btn ghost sm" onClick={() => setOpen(true)}>Browse / upload…</button>
            {lib && !typing && <button type="button" className="btn ghost sm" onClick={() => setTyping(true)}>Paste a URL</button>}
            {value.trim() && <button type="button" className="btn ghost sm" onClick={() => { onChange(''); setTyping(true) }}>Clear</button>}
          </div>
        </div>
      </div>
      {help && <div className="hintxt">{help}</div>}
      <ImagePicker open={open} kinds={kinds} title={pickerTitle} uploadKind="brand" uploadFolder={uploadFolder} allowUpload
        onClose={() => setOpen(false)} onPick={(url) => { onChange(url); setTyping(false); setOpen(false) }} />
    </div>
  )
}

/* ============================================================================
   GUIDE ICON: the image a channel or station carries in the EPG. By default
   it is the channel's own logo, so one image set once shows everywhere. Set a
   different one only when the guide needs it (a square icon for a partner
   whose grid crops a wide logo, say).
   ========================================================================== */
export function GuideIconField({ value, onChange, brandRef, what = 'channel' }: {
  value: string
  onChange: (v: string) => void
  brandRef: string
  what?: 'channel' | 'station'
}) {
  const [own, setOwn] = useState(!!value.trim())
  useEffect(() => { if (value.trim()) setOwn(true) }, [value])
  const shown = own && value.trim() ? value : brandRef
  return (
    <div className="field">
      <label>Guide icon<span className="imgref-hint">: the image this {what} carries in the EPG and partner guides</span></label>
      <div className="imgref">
        <ImagePreview src={shown} />
        <div className="imgref-body">
          <div className="seg-choice" role="radiogroup" aria-label="Guide icon">
            <button type="button" role="radio" aria-checked={!own} className={!own ? 'sel' : ''} onClick={() => { setOwn(false); onChange('') }}>Use the {what} {what === 'station' ? 'artwork' : 'logo'}</button>
            <button type="button" role="radio" aria-checked={own} className={own ? 'sel' : ''} onClick={() => setOwn(true)}>A different image</button>
          </div>
          <div className="hintxt" style={{ marginTop: 4 }}>
            {own ? 'Shown in the guide instead of the ' + (what === 'station' ? 'artwork' : 'logo') + '.'
              : brandRef.trim() ? `The guide shows the ${what === 'station' ? 'artwork' : 'logo'} from Settings.`
                : `No ${what === 'station' ? 'artwork' : 'logo'} is set on Settings yet. Until one is, a linked imported guide's icon is used if it has one.`}
          </div>
        </div>
      </div>
      {own && (
        <ImageRefField label="Guide image" value={value} onChange={onChange} preview={false}
          pickerTitle="Choose or upload a guide icon" help="A square PNG with transparency, at least 256 × 256, suits most guides." />
      )}
    </div>
  )
}
