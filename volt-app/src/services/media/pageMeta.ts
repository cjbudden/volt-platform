// ============================================================================
//  READ A WEB PAGE FOR A SONG'S DETAILS (docs/ASSET_IMAGES.md section 12).
//
//  A person pastes the link to a page about a song (Apple Music, Spotify, a
//  label's or artist's site, a Bandcamp track) or straight to its cover image.
//  Volt fetches that ONE page, like a link preview, and reads what the page
//  publishes about itself for sharing:
//
//    * schema.org JSON-LD (MusicRecording, MusicComposition, MusicAlbum,
//      Product): name, byArtist, inAlbum, datePublished, isrcCode, genre,
//      recordLabel, duration, image;
//    * Open Graph and music: tags (og:title, og:image, music:release_date...);
//    * Twitter cards, then <title>, as a last resort.
//
//  Only when a person asks, one page at a time: never a crawl, never a site's
//  search. Sites that protect pages from programs (Bandcamp, Beatport and
//  Discogs answer with a browser check) cannot be read this way; the answer
//  says so and how to get the image instead (copy the cover's image address).
// ============================================================================
import type { MusicMatch } from './musicLookup';

export interface PageSong {
  url: string;
  site: string;
  /** The image is the page itself (a pasted image address). */
  imageOnly: boolean;
  artist: string | null;
  title: string | null;
  album: string | null;
  released: string | null;
  label: string | null;
  isrc: string | null;
  genres: string[];
  lengthMs: number | null;
  image: string | null;
  /** Where each value came from (json-ld, og, title), for the console. */
  from: Record<string, string>;
}

export class PageBlocked extends Error {}

const MAX_HTML = 3 * 1024 * 1024;

const decode = (s: string) => s
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
  .trim();

/** <meta property|name="x" content="y"> in any attribute order. Pure. */
export function metaTags(html: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    const k = /\b(?:property|name|itemprop)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]?.toLowerCase();
    const v = /\bcontent\s*=\s*"([^"]*)"|\bcontent\s*=\s*'([^']*)'/i.exec(tag);
    const val = v ? decode(v[1] ?? v[2] ?? '') : '';
    if (k && val && !out.has(k)) out.set(k, val);
  }
  return out;
}

/** Every JSON-LD object on the page, @graph flattened. Pure. */
export function jsonLd(html: string): any[] {
  const out: any[] = [];
  for (const m of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const j = JSON.parse(m[1].trim());
      const walk = (x: any) => { if (Array.isArray(x)) x.forEach(walk); else if (x && typeof x === 'object') { out.push(x); if (x['@graph']) walk(x['@graph']); } };
      walk(j);
    } catch { /* a broken block is skipped */ }
  }
  return out;
}

const typeOf = (o: any) => (Array.isArray(o?.['@type']) ? o['@type'] : [o?.['@type']]).map((t: any) => String(t ?? ''));
const nameOf = (v: any): string | null => {
  if (!v) return null;
  if (typeof v === 'string') return decode(v) || null;
  if (Array.isArray(v)) { const n = v.map(nameOf).filter(Boolean); return n.length ? n.join(', ') : null; }
  return typeof v.name === 'string' ? decode(v.name) || null : null;
};
const imageOf = (v: any): string | null => {
  if (!v) return null;
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return imageOf(v[0]);
  return typeof v.url === 'string' ? v.url : typeof v.contentUrl === 'string' ? v.contentUrl : null;
};
/** "2020-12-17", "18 Dec 2020 00:00:00 GMT", "2020" as YYYY-MM-DD (or YYYY). Pure. */
export function isoDate(v: unknown): string | null {
  const s = String(v ?? '').trim();
  if (!s) return null;
  const iso = /^(\d{4})(-\d{2})?(-\d{2})?/.exec(s);
  if (iso) return iso[0];
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
}

/** "Infinite Lights - Single" is the single "Infinite Lights". Pure. */
export const albumName = (v: string | null) => (v ? v.replace(/\s+-\s+(Single|EP)$/i, '').trim() || null : null);

/** ISO 8601 PT4M42S, or "4:42", in milliseconds. */
export function durationMs(v: unknown): number | null {
  const s = String(v ?? '').trim();
  const iso = /^P(?:T)?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/i.exec(s);
  if (iso && (iso[1] || iso[2] || iso[3])) return Math.round(((+(iso[1] ?? 0)) * 3600 + (+(iso[2] ?? 0)) * 60 + +(iso[3] ?? 0)) * 1000);
  const c = /^(?:(\d+):)?(\d{1,2}):(\d{2})$/.exec(s);
  return c ? ((+(c[1] ?? 0)) * 3600 + +c[2] * 60 + +c[3]) * 1000 : null;
}

/**
 * Larger copies of covers whose address says the size: Apple's
 * .../cover.jpg/1200x630bb.jpg is a padded share card; 1200x1200bb is the
 * cover itself. Bandcamp's _10 is the original, _16 a 700 px copy. Pure.
 */
export function bestImage(u: string | null): string | null {
  if (!u) return null;
  if (/mzstatic\.com\/image\/thumb\//.test(u)) return u.replace(/\/\d+x\d+[a-z]*(-\d+)?\.(jpg|jpeg|png|webp)$/i, '/1200x1200bb.jpg');
  if (/bcbits\.com\/img\/a\d+_\d+\.(jpg|png)$/.test(u)) return u.replace(/_\d+\.(jpg|png)$/, '_10.$1');
  return u;
}

/** "Infinite Lights by Orange Crush on Apple Music", "Infinite Lights, by Orange Crush", "Orange Crush - Infinite Lights". Pure. */
export function splitTitle(t: string | null): { artist: string; title: string } | null {
  if (!t) return null;
  const s = t.replace(/\s+(on|\|)\s+(Apple Music|Spotify|YouTube Music|Deezer|SoundCloud|Bandcamp|Tidal|Amazon Music)\b.*$/i, '').replace(/\s+\|\s+.*$/, '').trim();
  let m = /^(.+?),?\s+by\s+(.+)$/i.exec(s);
  if (m) return { title: m[1].trim(), artist: m[2].trim() };
  m = /^(.+?)\s+[-–—]\s+(.+)$/.exec(s);
  if (m) return { artist: m[1].trim(), title: m[2].replace(/\s*[-–—]\s*(song|single).*$/i, '').trim() };
  return null;
}

/** Everything a page says about one song. Pure: the HTML in, the details out. Tested. */
export function songFromHtml(html: string, url: string): PageSong {
  const site = (() => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } })();
  const out: PageSong = { url, site, imageOnly: false, artist: null, title: null, album: null, released: null, label: null, isrc: null, genres: [], lengthMs: null, image: null, from: {} };
  const set = (k: keyof PageSong, v: any, from: string) => {
    if (v == null || v === '' || (Array.isArray(v) && !v.length)) return;
    if (out[k] != null && !(Array.isArray(out[k]) && !(out[k] as any[]).length)) return;
    (out as any)[k] = v; out.from[k] = from;
  };

  // 1. schema.org: the recording (or the composition's audio), then the album.
  const ld = jsonLd(html);
  const rec = ld.find((o) => typeOf(o).includes('MusicRecording'))
    ?? ld.map((o) => o.audio).find((a) => a && typeOf(a).includes('MusicRecording'))
    ?? ld.find((o) => typeOf(o).includes('MusicComposition'));
  const comp = ld.find((o) => typeOf(o).includes('MusicComposition'));
  const album = ld.find((o) => typeOf(o).includes('MusicAlbum')) ?? (rec?.inAlbum && typeof rec.inAlbum === 'object' ? rec.inAlbum : null);
  for (const o of [rec, comp].filter(Boolean)) {
    set('title', nameOf(o.name), 'json-ld');
    set('artist', nameOf(o.byArtist) ?? nameOf(o.composer) ?? nameOf(o.creator), 'json-ld');
    set('album', nameOf(o.inAlbum), 'json-ld');
    set('released', isoDate(o.datePublished), 'json-ld');
    set('isrc', typeof o.isrcCode === 'string' ? o.isrcCode : null, 'json-ld');
    set('lengthMs', durationMs(o.duration ?? o.timeRequired), 'json-ld');
    set('genres', (Array.isArray(o.genre) ? o.genre : o.genre ? [o.genre] : []).map(String).slice(0, 5), 'json-ld');
    set('label', nameOf(o.recordLabel ?? o.publisher), 'json-ld');
    set('image', imageOf(o.image), 'json-ld');
  }
  if (album) {
    set('album', nameOf(album.name), 'json-ld');
    set('artist', nameOf(album.byArtist), 'json-ld');
    set('released', isoDate(album.datePublished), 'json-ld');
    set('label', nameOf(album.recordLabel ?? album.publisher), 'json-ld');
    set('genres', (Array.isArray(album.genre) ? album.genre : album.genre ? [album.genre] : []).map(String).slice(0, 5), 'json-ld');
    set('image', imageOf(album.image), 'json-ld');
  }

  // 2. Open Graph, music: and Twitter tags.
  const meta = metaTags(html);
  set('image', meta.get('og:image:secure_url') ?? meta.get('og:image') ?? meta.get('twitter:image') ?? meta.get('twitter:image:src') ?? null, 'og');
  set('released', isoDate(meta.get('music:release_date')), 'og');
  set('lengthMs', meta.get('music:duration') ? Number(meta.get('music:duration')) * 1000 || null : null, 'og');
  set('artist', /^https?:/.test(meta.get('music:musician') ?? 'http') ? null : meta.get('music:musician'), 'og');
  const ogTitle = meta.get('og:title') ?? meta.get('twitter:title') ?? decode(/<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1] ?? '') ?? null;
  const split = splitTitle(ogTitle);
  if (split) { set('title', split.title, 'og'); set('artist', split.artist, 'og'); }
  else set('title', ogTitle || null, 'og');

  out.album = albumName(out.album);
  out.image = bestImage(out.image ? new URL(out.image, url).toString() : null);
  return out;
}

const looksBlocked = (status: number, html: string) =>
  [401, 403, 429, 503].includes(status) || /<title>\s*(Client Challenge|Just a moment|Attention Required|Access denied|Are you a robot)/i.test(html.slice(0, 4000));

/** Fetch one page (or image) a person pasted and read it. Throws PageBlocked when the site will not answer a program. */
export async function readSongPage(raw: string): Promise<PageSong> {
  const { assertPublicUrl } = await import('../graphics/runtime');
  const u = await assertPublicUrl(raw);
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 12_000);
  try {
    const res = await fetch(u, { signal: ac.signal, redirect: 'follow', headers: { 'User-Agent': 'VoltStream/0.1 (link preview; one page on request)', Accept: 'text/html,application/xhtml+xml,image/*;q=0.8,*/*;q=0.5', 'Accept-Language': 'en' } });
    const ct = String(res.headers.get('content-type') ?? '').toLowerCase();
    if (res.ok && ct.startsWith('image/')) {
      return { url: u.toString(), site: u.hostname.replace(/^www\./, ''), imageOnly: true, artist: null, title: null, album: null, released: null, label: null, isrc: null, genres: [], lengthMs: null, image: bestImage(u.toString()), from: { image: 'link' } };
    }
    const reader = res.body?.getReader();
    let html = '', got = 0;
    if (reader) {
      const dec = new TextDecoder();
      for (;;) { const { done, value } = await reader.read(); if (done) break; got += value.length; html += dec.decode(value, { stream: true }); if (got > MAX_HTML) { ac.abort(); break; } }
    }
    if (looksBlocked(res.status, html)) throw new PageBlocked(`${u.hostname.replace(/^www\./, '')} does not let programs read its pages. Open the page in your browser, right-click the cover, choose "Copy image address", and paste that here. Then type the details.`);
    if (!res.ok) throw new Error(`the page answered ${res.status}`);
    if (!/html/.test(ct) && !/<html|<meta/i.test(html.slice(0, 2000))) throw new Error('that address is not a web page or an image');
    return songFromHtml(html, res.url || u.toString());
  } finally { clearTimeout(t); }
}

/** The page says nothing about a song (a search page, a home page). */
export const saysNothing = (p: PageSong) => !p.imageOnly && !p.image && !p.artist && !p.album && !p.released;

/** A page's details as a match, for the same cover and field filling as a provider's. */
export const pageToMatch = (p: PageSong): MusicMatch => ({
  state: 'hit', provider: 'page', artist: p.artist, title: p.title, album: p.album, released: p.released, label: p.label, isrc: p.isrc,
  genres: p.genres, lengthMs: p.lengthMs, coverUrl: p.image, link: p.url, confidence: undefined, reason: `From ${p.site}`,
});
