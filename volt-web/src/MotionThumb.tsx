// ============================================================================
//  A LIBRARY THUMBNAIL THAT MOVES ON HOVER. Stills are served as resized first
//  frames (the image service never animates), so anything that moves, an alpha
//  video bug or an animated GIF / WebP, swaps to the real thing while the pointer
//  or keyboard focus is on it, and shows a small tag saying it moves.
// ============================================================================
import { useState, type CSSProperties, type ReactNode } from 'react'
import { thumbUrl, type MediaFile } from './api'

/** What moves: a video (metadata.motion) or an image with more than one frame. */
export function motionOf(f: MediaFile): { kind: 'video' | 'animated'; src: string; label: string } | null {
  const m = f.metadata?.motion
  if (m?.video) return { kind: 'video', src: '/' + m.video, label: `▶ video${m.alpha ? ' · alpha' : ''}` }
  const pages = Number(f.metadata?.pages ?? 1)
  if (pages > 1) {
    const fmt = String(f.metadata?.format ?? f.content_type ?? '').replace('image/', '').toUpperCase() || 'animated'
    return { kind: 'animated', src: f.url, label: `▶ ${fmt === 'GIF' ? 'GIF' : 'animated ' + fmt.toLowerCase()} · ${pages} frames` }
  }
  return null
}

const fill: CSSProperties = { maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }

export function MotionThumb({ f, w, h, style, children, always }: {
  f: MediaFile; w: number; h: number; style?: CSSProperties; children?: ReactNode
  /** Play without hover (a preview pane). */
  always?: boolean
}) {
  const [hover, setHover] = useState(false)
  const mo = motionOf(f)
  const play = !!mo && (always || hover)
  return (
    <div style={{ position: 'relative', display: 'grid', placeItems: 'center', ...style }}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} onFocus={() => setHover(true)} onBlur={() => setHover(false)}>
      {play && mo!.kind === 'video'
        ? <video src={mo!.src} poster={thumbUrl(f.url, w, h, 'inside')} autoPlay muted loop playsInline style={fill} />
        : play
          ? <img src={mo!.src} alt={f.name} style={fill} />
          : <img src={thumbUrl(f.url, w, h, 'inside')} alt={f.name} loading="lazy" style={fill} />}
      {mo && <span className="tag" title={always ? undefined : 'Hover to play'} style={{ position: 'absolute', top: 6, left: 6, fontSize: 'var(--fs-micro)', pointerEvents: 'none' }}>{mo.label}</span>}
      {children}
    </div>
  )
}
