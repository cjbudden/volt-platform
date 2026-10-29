// The image that represents an asset (docs/ASSET_IMAGES.md): what it is,
// where it came from and why, the frames that were considered, the song it
// was matched to, and the controls to choose another or let Volt pick again.
import { useEffect, useState } from 'react'
import { apiRequest } from '../../api'
import { ImagePicker } from '../../ImagePicker'
import { SongFinder, SOURCE_NAME } from './SongFinder'
import { AssetImageSet } from './AssetImageSet'

interface Cand { key: string; atMs: number | null; origin: string; score: number | null; notes: string[]; rejected: string | null; url: string | null }
interface ImageView {
  key: string | null; url: string | null; source: string | null; shape: 'wide' | 'square' | null; reason: string | null; locked: boolean; pickedAt: string | null
  audio: boolean; song: boolean; songIdentity: { artist: string; title: string; from: string } | null
  candidates: Cand[]; music: any; pending?: boolean
  upload?: boolean; sprite?: { sheets: number; intervalMs: number; tiles: number } | null
  folder?: string | null; providersEnabled?: string[]
}

const SOURCE: Record<string, string> = {
  manual: 'Chosen by hand', cover_art: 'Album cover', programme: 'Programme image', station: 'Station artwork',
  frame: 'Best frame', live_frame: 'Frame from the live stream', metadata: 'From the metadata', none: 'No image yet',
}
const FROM: Record<string, string> = { metadata: 'the song fields', icy: 'the station\'s now-playing line', id3: 'the file\'s tags', title: 'the title', override: 'a correction made here' }
const PROVIDER = SOURCE_NAME
const J = (b: unknown): RequestInit => ({ body: JSON.stringify(b), headers: { 'content-type': 'application/json' } })
const clock = (ms: number) => { const s = Math.round(ms / 1000); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` }

export function AssetImage({ id, onChanged }: { id: string; onChanged?: () => void }) {
  const [v, setV] = useState<ImageView | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState('')
  const [picker, setPicker] = useState(false)
  const load = () => apiRequest(`/vod/${id}/image`).then((nv: ImageView) => {
    setV((prev) => { if (prev?.pending && !nv.pending) window.setTimeout(() => onChanged?.(), 0); return nv })
  }, (e: any) => setErr(e.message))
  useEffect(() => { setV(null); load() }, [id]) // eslint-disable-line react-hooks/exhaustive-deps
  // A pick still running in the background (a slow song lookup): look again shortly.
  useEffect(() => { if (!v?.pending) return; const t = setTimeout(load, 4000); return () => clearTimeout(t) }, [v]) // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (label: string, fn: () => Promise<ImageView>) => {
    setBusy(label); setErr('')
    try { setV(await fn()); onChanged?.() } catch (e: any) { setErr(e.message) } finally { setBusy(null) }
  }
  const choose = (ref: string) => act('choose', () => apiRequest(`/vod/${id}/image`, { method: 'PUT', ...J({ ref }) }))
  const auto = () => act('auto', () => apiRequest(`/vod/${id}/image/auto`, { method: 'POST', ...J({}) }))
  const rebuild = () => act('rebuild', () => apiRequest(`/vod/${id}/image/auto`, { method: 'POST', ...J({ rebuild: true }) }))

  const [finder, setFinder] = useState(false)

  if (!v) return <div className="asset-img">{err ? <div className="asset-img-err">{err}</div> : <div className="lib-faint">Loading the image…</div>}</div>
  const m = v.music
  const square = v.shape === 'square'
  return (
    <div className="asset-img">
      <div className="asset-img-h">
        <div className="sec-label" style={{ margin: 0 }}>{v.audio ? 'Cover' : 'Thumbnail'}</div>
        {v.source && <span className={`asset-img-src ${v.locked ? 'manual' : ''}`}>{SOURCE[v.source] ?? v.source}{v.locked ? '' : v.music?.reason?.startsWith('Chosen') ? ' · chosen' : ' · automatic'}</span>}
        <div style={{ flex: 1 }} />
        <button className="btn ghost sm" disabled={!!busy} onClick={() => setPicker(true)}>Choose from library</button>
        <button className="btn ghost sm" disabled={!!busy} onClick={auto} title="Let Volt pick again: album cover, station artwork or the best frame">
          {busy === 'auto' ? 'Picking…' : v.locked ? 'Pick automatically' : 'Pick again'}</button>
      </div>
      {err && <div className="asset-img-err">{err}</div>}
      <div className="asset-img-main">
        <div className={`asset-img-cur ${square ? 'square' : ''}`}>
          {v.url ? <img src={v.url} alt="" /> : <span className="lib-faint">No image</span>}
        </div>
        <div className="asset-img-why">
          <div>{v.pending ? 'Still working: looking the song up…' : v.reason ?? 'Not picked yet.'}</div>
          {v.song && v.songIdentity && (
            <div className="lib-faint" style={{ marginTop: 6 }}>Song: {v.songIdentity.artist} – {v.songIdentity.title}, from {FROM[v.songIdentity.from] ?? v.songIdentity.from}.{' '}
              <button type="button" className="linklike" disabled={!!busy} onClick={() => setFinder(true)}>Find song details…</button></div>
          )}
          {m && m.state === 'hit' && (
            <dl className="asset-img-music">
              <dt>Album</dt><dd>{m.album ?? '—'}{m.released ? ` (${String(m.released).slice(0, 4)})` : ''}</dd>
              {m.label && <><dt>Label</dt><dd>{m.label}</dd></>}
              {m.isrc && <><dt>ISRC</dt><dd className="mono">{m.isrc}</dd></>}
              {m.genres?.length > 0 && <><dt>Genres</dt><dd>{m.genres.slice(0, 3).join(', ')}</dd></>}
              <dt>{m.reason?.startsWith('Chosen') ? 'Chosen' : 'Match'}</dt><dd>{m.reason?.startsWith('Chosen') ? `${m.reason.replace(/^Chosen by /, 'by ')} · ` : `${m.confidence}/100 · `}{m.link ? <a href={m.link} target="_blank" rel="noreferrer">{PROVIDER[m.provider ?? 'musicbrainz'] ?? m.provider}</a> : (PROVIDER[m.provider ?? 'musicbrainz'] ?? m.provider)}</dd>
              {m.filled?.length > 0 && <><dt>Filled</dt><dd>{m.filled.join(', ')} (empty fields only)</dd></>}
              {m.at && <><dt>Looked up</dt><dd>{new Date(m.at).toLocaleString()} (once, when created; again only when you check)</dd></>}
            </dl>
          )}
          {m && m.state === 'error' && v.song && <div className="lib-faint" style={{ marginTop: 6 }}>{m.reason ?? 'The lookup failed'}. It is tried again automatically (three tries in all), or use Find song details.</div>}
          {m && m.state === 'miss' && v.song && <div className="lib-faint" style={{ marginTop: 6 }}>{m.reason}</div>}
        </div>
      </div>
      {finder && <SongFinder id={id} who={v.songIdentity} onClose={() => setFinder(false)} onApplied={(nv) => { setV(nv); setFinder(false); onChanged?.() }} />}
      {v.upload && (
        <div className="asset-img-sprite">
          <span>{v.sprite ? `Sprite sheets: ${v.sprite.tiles} previews, one every ${Math.round(v.sprite.intervalMs / 1000)} s, on ${v.sprite.sheets} sheet${v.sprite.sheets === 1 ? '' : 's'}.` : 'No sprite sheets yet.'}</span>
          <button className="btn ghost sm" disabled={!!busy} onClick={rebuild} title="Take the stills and sprite sheets again from the source file">{busy === 'rebuild' ? 'Rebuilding…' : 'Rebuild from source'}</button>
        </div>
      )}
      {v.candidates.length > 0 && (
        <>
          <div className="lib-faint" style={{ margin: '12px 0 6px', fontSize: 'var(--fs-sm)' }}>Frames considered, best first. Click one to use it.</div>
          <div className="asset-img-cands">
            {v.candidates.map((c) => {
              const cur = v.key && (c.key === v.key)
              return (
                <button key={c.key} type="button" className={`asset-img-cand${c.rejected ? ' rej' : ''}${cur ? ' cur' : ''}`} disabled={!!busy || !c.url}
                  onClick={() => choose(c.key)} title={[c.atMs != null ? clock(c.atMs) : '', c.rejected ? `skipped: ${c.rejected}` : `score ${c.score}`, ...c.notes].filter(Boolean).join(' · ')}>
                  {c.url ? <img src={c.url} alt="" loading="lazy" /> : <span />}
                  <span className="t">{c.atMs != null ? clock(c.atMs) : ''}</span>
                  <span className="s">{c.rejected ?? c.score}</span>
                </button>
              )
            })}
          </div>
        </>
      )}
      <AssetImageSet id={id} folder={v.folder} candidates={v.candidates} primaryKey={v.key} />
      <ImagePicker open={picker} title={v.audio ? 'Cover for this asset' : 'Thumbnail for this asset'} assetId={id}
        kinds={v.audio ? ['cover', 'poster', 'brand', 'other', 'imported'] : ['poster', 'brand', 'other', 'keyframe']} uploadKind={v.audio ? 'cover' : 'poster'} uploadFolder={v.folder ?? 'posters'}
        onClose={() => setPicker(false)} onPick={(url) => { setPicker(false); choose(url) }} />
    </div>
  )
}
