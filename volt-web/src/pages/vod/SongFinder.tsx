// "Find song details" (docs/ASSET_IMAGES.md section 12): a person asks every
// music source at once, plus a page or image link they paste, compares what
// each found with what the asset has, ticks what to change, and applies it.
// Nothing changes until they do; an existing value changes only when ticked.
// What they apply is kept for the song, so later plays use it without a lookup.
import { useMemo, useState } from 'react'
import { apiRequest } from '../../api'

const J = (b: unknown): RequestInit => ({ body: JSON.stringify(b), headers: { 'content-type': 'application/json' } })
export const SOURCE_NAME: Record<string, string> = { musicbrainz: 'MusicBrainz', deezer: 'Deezer', apple: 'Apple', page: 'Web page', typed: 'Typed in' }
/** Field key -> the find's own key, for the values a person can edit. */
const EDIT: Record<string, string> = { title: 'title', artist: 'artist', album: 'album', released: 'released', label: 'label', isrc: 'isrc' }

const show = (v: unknown) => Array.isArray(v) ? v.join(', ') : v == null || v === '' ? '' : String(v)
const same = (a: unknown, b: unknown) => show(a).trim().toLowerCase() === show(b).trim().toLowerCase()

const ExtIcon = () => <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></svg>

export function SongFinder({ id, who, onClose, onApplied }: {
  id: string
  who: { artist: string; title: string } | null
  onClose: () => void
  onApplied: (view: any) => void
}) {
  const [q, setQ] = useState({ artist: who?.artist ?? '', title: who?.title ?? '', url: '' })
  const [busy, setBusy] = useState<'find' | 'use' | 'forget' | null>(null)
  const [err, setErr] = useState('')
  const [res, setRes] = useState<any | null>(null)
  const [pick, setPick] = useState<number | null>(null)
  const [draft, setDraft] = useState<any | null>(null)
  const [ticks, setTicks] = useState<Record<string, boolean>>({})
  const [useImage, setUseImage] = useState(false)
  const [setSong, setSetSong] = useState(false)

  const find = async () => {
    setBusy('find'); setErr(''); setPick(null); setDraft(null)
    try {
      const body: any = {}
      if (q.artist.trim() && q.title.trim()) { body.artist = q.artist.trim(); body.title = q.title.trim() }
      if (q.url.trim()) body.url = q.url.trim()
      setRes(await apiRequest(`/vod/${id}/song/find`, { method: 'POST', ...J(body) }))
    } catch (e: any) { setErr(e.message) } finally { setBusy(null) }
  }

  // Choosing a find: empty fields ticked, existing values not (they need a tick to change).
  const choose = (i: number, r: any) => {
    setPick(i)
    const d = { ...r, proposed: { ...(r.proposed ?? {}) } }
    setDraft(d)
    const cur = res?.current?.metadata ?? {}
    const t: Record<string, boolean> = {}
    for (const [k, v] of Object.entries(d.proposed)) if (!same(cur[k], v)) t[k] = !show(cur[k])
    setTicks(t)
    const src = res?.current?.imageSource
    setUseImage(!!r.coverUrl && !['cover_art', 'metadata', 'manual'].includes(src))
    // A song found: make it a Song. Ticked unless it already is one (a Clip cut from a
    // station recording is the usual case); untick to keep the type it has.
    setSetSong(!res?.contentType?.now?.song)
  }
  const typed = () => choose(-1, { provider: 'typed', state: 'hit', artist: q.artist, title: q.title, album: '', released: '', label: '', isrc: '', genres: [], coverUrl: q.url.trim() || null,
    proposed: { title: q.title, artist: q.artist, album: '', released: '', label: '', isrc: '' }, terms: 'Typed by a person.' })

  const edit = (k: string, v: string) => {
    if (!draft) return
    setDraft({ ...draft, [EDIT[k]]: v, proposed: { ...draft.proposed, [k]: v } })
    const cur = res?.current?.metadata ?? {}
    setTicks((t) => ({ ...t, [k]: same(cur[k], v) ? false : t[k] ?? !show(cur[k]) }))
  }

  const fields: any[] = res?.current?.fields ?? []
  const rows = useMemo(() => {
    if (!draft) return []
    const cur = res?.current?.metadata ?? {}
    return Object.keys(draft.proposed).filter((k) => k !== 'artwork').map((k) => ({
      key: k, label: fields.find((f) => f.key === k)?.label ?? k, now: cur[k], found: draft.proposed[k],
      editable: k in EDIT, same: same(cur[k], draft.proposed[k]), personal: !!show(cur[k]) && !['musicbrainz', 'deezer', 'apple', 'page', 'typed', 'station', 'auto'].includes(res?.current?.provenance?.[k]?.source),
    }))
  }, [draft, res]) // eslint-disable-line react-hooks/exhaustive-deps
  const changes = Object.entries(ticks).filter(([, on]) => on).map(([k]) => k)
  const hasArtwork = fields.some((f) => f.key === 'artwork')
  const ctNow = res?.contentType?.now ?? null
  const songAlready = !!ctNow?.song
  // Fields are kept on a content type: with none and Song not ticked, only the image and the song's details are saved.
  const fieldsWontSave = !ctNow && !setSong
  const nChanges = (fieldsWontSave ? 0 : changes.length) + (useImage ? 1 : 0) + (setSong && !songAlready ? 1 : 0)

  const apply = async () => {
    if (!draft) return
    setBusy('use'); setErr('')
    try {
      const imageUrl = draft.coverUrl && /^https?:/.test(draft.coverUrl) ? draft.coverUrl : null
      const v = await apiRequest(`/vod/${id}/song/use`, { method: 'POST', ...J({
        provider: draft.provider, artist: draft.artist || q.artist, title: draft.title || q.title, album: draft.album || null, released: draft.released || null,
        label: draft.label || null, isrc: draft.isrc || null, genres: draft.genres ?? [], link: draft.link ?? null, imageUrl,
        fields: [...changes, ...(useImage && imageUrl && hasArtwork ? ['artwork'] : [])], useImage: useImage && !!imageUrl, setSong: setSong && !songAlready,
      }) })
      onApplied(v)
    } catch (e: any) { setErr(e.message) } finally { setBusy(null) }
  }
  const forget = async () => {
    setBusy('forget'); setErr('')
    try { await apiRequest(`/vod/${id}/song/details`, { method: 'DELETE' }); await find() } catch (e: any) { setErr(e.message) } finally { setBusy(null) }
  }

  return (
    <div className="songf" role="region" aria-label="Find song details">
      <div className="songf-h">
        <div className="songf-t">Find song details</div>
        <div className="lib-faint">Asks MusicBrainz, Deezer and Apple, and reads a page or image you paste. Nothing changes until you apply it.</div>
      </div>
      <form className="songf-q" onSubmit={(e) => { e.preventDefault(); find() }}>
        <label><span>Artist</span><input className="inp" value={q.artist} onChange={(e) => setQ({ ...q, artist: e.target.value })} /></label>
        <label><span>Song</span><input className="inp" value={q.title} onChange={(e) => setQ({ ...q, title: e.target.value })} /></label>
        <label className="wide"><span>Page or image link <em>optional</em></span>
          <input className="inp" value={q.url} placeholder="https://… a song page (Apple Music, Bandcamp, a label site) or a cover image" onChange={(e) => setQ({ ...q, url: e.target.value })} /></label>
        <button className="btn primary sm" disabled={!!busy || (!(q.artist.trim() && q.title.trim()) && !q.url.trim())}>{busy === 'find' ? 'Searching…' : 'Search'}</button>
      </form>
      {err && <div className="asset-img-err">{err}</div>}

      {res?.searchLinks?.length > 0 && (
        <div className="songf-links">
          <span className="lib-faint">Search yourself, then paste the song's page or cover link above:</span>
          {res.searchLinks.map((l: any) => <a key={l.site} href={l.url} target="_blank" rel="noreferrer">{l.site} <ExtIcon /></a>)}
        </div>
      )}

      {res?.chosen && (
        <div className="songf-chosen">
          Details for this song were chosen by {res.chosen.chosenBy ?? 'someone'} from {SOURCE_NAME[res.chosen.provider] ?? res.chosen.provider}
          {res.chosen.chosenAt ? ` on ${new Date(res.chosen.chosenAt).toLocaleDateString()}` : ''}. Later plays use them.{' '}
          <button type="button" className="linklike" disabled={!!busy} onClick={forget}>Forget them</button>
        </div>
      )}

      {res && (
        <div className="songf-results">
          {res.results.map((r: any, i: number) => (
            <button key={`${r.provider}-${i}`} type="button" className={`songf-r${pick === i ? ' sel' : ''}${r.state !== 'hit' ? ' off' : ''}`} disabled={r.state !== 'hit' || !!busy} onClick={() => choose(i, r)}>
              {r.coverUrl ? <img src={r.coverUrl} alt="" /> : <span className="songf-noimg" />}
              <span className="songf-rb">
                <span className="songf-src">{SOURCE_NAME[r.provider] ?? r.provider}{r.site ? ` · ${r.site}` : ''}</span>
                {r.state === 'hit'
                  ? <><span className="songf-main">{r.artist} – {r.title}</span>
                      <span className="lib-faint">{[r.album, r.released, r.label].filter(Boolean).join(' · ') || 'No album details'}{r.confidence != null ? ` · ${r.confidence}/100` : ''}</span></>
                  : <span className="lib-faint">{r.state === 'miss' ? 'Nothing found' : r.state === 'blocked' ? 'Cannot be read' : 'Unavailable'}{r.reason ? `: ${r.reason}` : ''}</span>}
                {r.state === 'hit' && r.terms && <span className="songf-terms">{r.terms}</span>}
              </span>
            </button>
          ))}
          <button type="button" className={`songf-r${pick === -1 ? ' sel' : ''}`} disabled={!!busy} onClick={typed}>
            <span className="songf-noimg">+</span>
            <span className="songf-rb"><span className="songf-src">Type the details</span><span className="lib-faint">Enter them yourself, with the cover link pasted above</span></span>
          </button>
        </div>
      )}

      {draft && (
        <div className="songf-review">
          <div className="songf-rh">Review: tick what to change{draft.link ? <> · <a href={draft.link} target="_blank" rel="noreferrer">source page <ExtIcon /></a></> : null}</div>
          <table className="songf-t">
            <thead><tr><th /><th>Field</th><th>Now</th><th>Found</th></tr></thead>
            <tbody>
              {!songAlready && (
                <tr>
                  <td><input type="checkbox" aria-label="Make it a Song" checked={setSong} onChange={(e) => setSetSong(e.target.checked)} /></td>
                  <td>Content type</td>
                  <td>{ctNow ? ctNow.name : <span className="lib-faint">none</span>}{ctNow && <div className="songf-note">changes only if ticked</div>}</td>
                  <td>Song</td>
                </tr>
              )}
              {(draft.coverUrl || res?.current?.imageUrl) && (
                <tr>
                  <td><input type="checkbox" aria-label="Use this cover" checked={useImage} disabled={!draft.coverUrl} onChange={(e) => setUseImage(e.target.checked)} /></td>
                  <td>Image</td>
                  <td>{res?.current?.imageUrl ? <img className="songf-thumb" src={res.current.imageUrl} alt="Current" /> : <span className="lib-faint">none</span>}</td>
                  <td>{draft.coverUrl ? <img className="songf-thumb" src={draft.coverUrl} alt="Found" /> : <span className="lib-faint">no cover</span>}
                    {useImage && draft.coverUrl && <div className="songf-note">Copied into the Image Library, then set as the Artwork</div>}</td>
                </tr>
              )}
              {rows.map((r) => (
                <tr key={r.key} className={r.same ? 'same' : ''}>
                  <td>{r.same ? <span className="lib-faint" title="Already the same">=</span>
                    : <input type="checkbox" aria-label={`Change ${r.label}`} checked={!!ticks[r.key]} onChange={(e) => setTicks({ ...ticks, [r.key]: e.target.checked })} />}</td>
                  <td>{r.label}</td>
                  <td>{show(r.now) || <span className="lib-faint">empty</span>}{r.personal && !r.same && <div className="songf-note">entered by a person</div>}</td>
                  <td>{r.editable
                    ? <input className="inp sm" value={show(r.found)} aria-label={`${r.label} found`} onChange={(e) => edit(r.key, e.target.value)} />
                    : show(r.found) || <span className="lib-faint">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {fieldsWontSave && changes.length > 0 && <div className="songf-note" style={{ marginTop: 8 }}>This asset has no content type, so the fields are saved only when it is made a Song.</div>}
          <div className="songf-act">
            <button type="button" className="btn primary sm" disabled={!!busy || !nChanges} onClick={apply}>
              {busy === 'use' ? 'Applying…' : `Apply ${nChanges} change${nChanges === 1 ? '' : 's'}`}</button>
            <span className="lib-faint">Kept for this song: later plays and clips of it use these details without a lookup.</span>
          </div>
        </div>
      )}
      <div style={{ marginTop: 8 }}><button type="button" className="btn ghost sm" onClick={onClose}>Close</button></div>
    </div>
  )
}
