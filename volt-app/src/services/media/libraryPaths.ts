// ============================================================================
//  WHERE AN IMAGE GOES IN THE IMAGE LIBRARY (docs/ASSET_IMAGES.md section 7).
//
//  Every image Volt downloads or a person adds for something (an album cover,
//  a station logo, a poster, an image pasted as a URL into a metadata field)
//  lands in a folder named after what it belongs to, under media/, with no
//  spaces, so the library reads like a catalogue and paths are safe in URLs:
//
//    media/<artist>/<album>/<song>/cover.jpg        a song
//    media/<station>/<show>/<date>/<name>.<ext>     a radio programme or clip
//    media/<station>/<name>.<ext>                   the station itself
//    media/<show>/<episode>/<name>.<ext>            an episode
//    media/<event>/<date>/<name>.<ext>              an event
//    media/<title>/<date>/<name>.<ext>              anything else (an upload)
//
//  Names are lower case, accents dropped, anything but letters and digits a
//  single hyphen ("Orange Crush" > orange-crush). PURE; tested.
// ============================================================================

export function slug(s: unknown, fallback = 'untitled'): string {
  const v = String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');
  return v || fallback;
}

/** YYYY-MM-DD of a time (epoch ms, Date or ISO string); today when unknown. An epoch of 0
 *  (an upload has no broadcast start, stored as 0) is unknown, never 1970-01-01. */
export function day(t: unknown): string {
  const d = t instanceof Date ? t : typeof t === 'number' || (typeof t === 'string' && /^\d+$/.test(t)) ? new Date(Number(t)) : t ? new Date(String(t)) : new Date();
  return Number.isNaN(d.getTime()) || d.getTime() < 86_400_000 * 366 ? new Date().toISOString().slice(0, 10) : d.toISOString().slice(0, 10);
}

/** A media file's extension, which is not part of what it is called ("sintel_1080p.mkv" > "sintel_1080p"). */
const MEDIA_EXT = /\.(mkv|mp4|m4v|mov|mxf|webm|ts|m2ts|mts|avi|wmv|flv|mpg|mpeg|3gp|mp3|m4a|aac|wav|flac|ogg|opus|wma|aif|aiff)$/i;
export const withoutExt = (title: unknown) => String(title ?? '').trim().replace(MEDIA_EXT, '');

/**
 * The file name of an image Volt saves for an asset: the asset's name (no file
 * extension, no spaces), the image type when it is not the main image, and a
 * short hash of the picture, so a different frame is a different file:
 *   sintel-1080p-21fe57ffc0.jpg          the main image (thumbnail / cover)
 *   sintel-1080p-hero-9a0c33b2e1.jpg     a typed image
 */
export function assetImageName(title: unknown, sha256: string, type?: string | null): string {
  return `${slug(withoutExt(title), 'asset')}${type ? `-${slug(type)}` : ''}-${sha256.slice(0, 10)}.jpg`;
}

export const songFolder = (artist: unknown, album: unknown, song: unknown) => `media/${slug(artist, 'unknown-artist')}/${slug(album, 'singles')}/${slug(song)}`;
export const stationFolder = (station: unknown) => `media/${slug(station, 'station')}`;
export const programmeFolder = (station: unknown, show: unknown, when: unknown) => `media/${slug(station, 'station')}/${slug(show, 'programme')}/${day(when)}`;
export const episodeFolder = (show: unknown, episode: unknown) => `media/${slug(show, 'series')}/${slug(episode, 'episode')}`;
export const eventFolder = (event: unknown, when: unknown) => `media/${slug(event, 'event')}/${day(when)}`;

/** A file name from a label and the image type: "Station logo" + image/png > station-logo.png. */
export function fileName(base: unknown, contentType: string): string {
  const ext = /svg/.test(contentType) ? 'svg' : (contentType.split('/')[1] ?? 'jpg').replace('jpeg', 'jpg').replace(/[^a-z0-9]/g, '') || 'jpg';
  return `${slug(base, 'image')}.${ext}`;
}

export interface AssetPlace {
  title?: string | null;
  metadata?: Record<string, any> | null;
  schemaKey?: string | null;
  channelName?: string | null;
  channelKind?: string | null;
  eventName?: string | null;
  programmeTitle?: string | null;
  when?: unknown;
}

/**
 * The folder for an asset's images, by what it is: a song, an episode, an
 * event, a station programme, or (anything else) its own title and date.
 */
export function assetFolder(a: AssetPlace): string {
  const m = a.metadata ?? {};
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : '');
  if (a.schemaKey === 'song' || m.class === 'song') {
    const artist = str(m.artist), song = str(m.title) || str(a.title);
    if (artist && song) return songFolder(artist, str(m.album), song);
  }
  const series = str(m.series) || str(m.seriesTitle) || str(m.show);
  const episode = str(m.episode) || str(m.episodeTitle) || (m.episodeNumber != null ? `episode ${m.episodeNumber}` : '');
  if (series && (episode || a.schemaKey === 'episode')) return episodeFolder(series, episode || withoutExt(a.title));
  if (a.eventName) return eventFolder(a.eventName, a.when);
  if (a.channelName) return programmeFolder(a.channelName, withoutExt(a.programmeTitle || a.title), a.when);
  return `media/${slug(withoutExt(a.title))}/${day(a.when)}`;
}
