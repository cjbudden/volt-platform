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
import type { SchemaValues } from './wikidataLookup';

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

/** One page a person pasted, fetched: its HTML, or the note that the address is an image. */
export type FetchedPage = { kind: 'image'; url: string; site: string } | { kind: 'html'; url: string; site: string; html: string };

const BLOCKED_SONG = 'Open the page in your browser, right-click the cover, choose "Copy image address", and paste that here. Then type the details.';

/**
 * Fetch one page (or image) a person pasted, like a link preview. Shared by
 * the song finder and the general one (build queue F2), which differ only in
 * what they read from the HTML and in what to suggest when a site refuses.
 * Throws PageBlocked when the site will not answer a program.
 */
export async function fetchPage(raw: string, blockedHint = BLOCKED_SONG): Promise<FetchedPage> {
  const { assertPublicUrl } = await import('../graphics/runtime');
  const u = await assertPublicUrl(raw);
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 12_000);
  try {
    const res = await fetch(u, { signal: ac.signal, redirect: 'follow', headers: { 'User-Agent': 'VoltStream/0.1 (link preview; one page on request)', Accept: 'text/html,application/xhtml+xml,image/*;q=0.8,*/*;q=0.5', 'Accept-Language': 'en' } });
    const ct = String(res.headers.get('content-type') ?? '').toLowerCase();
    if (res.ok && ct.startsWith('image/')) return { kind: 'image', url: u.toString(), site: u.hostname.replace(/^www\./, '') };
    const reader = res.body?.getReader();
    let html = '', got = 0;
    if (reader) {
      const dec = new TextDecoder();
      for (;;) { const { done, value } = await reader.read(); if (done) break; got += value.length; html += dec.decode(value, { stream: true }); if (got > MAX_HTML) { ac.abort(); break; } }
    }
    if (looksBlocked(res.status, html)) throw new PageBlocked(`${u.hostname.replace(/^www\./, '')} does not let programs read its pages. ${blockedHint}`);
    if (!res.ok) throw new Error(`the page answered ${res.status}`);
    if (!/html/.test(ct) && !/<html|<meta/i.test(html.slice(0, 2000))) throw new Error('that address is not a web page or an image');
    const url = res.url || u.toString();
    return { kind: 'html', url, site: (() => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return u.hostname; } })(), html };
  } finally { clearTimeout(t); }
}

/** Fetch one page (or image) a person pasted and read it as a song. Throws PageBlocked when the site will not answer a program. */
export async function readSongPage(raw: string): Promise<PageSong> {
  const pg = await fetchPage(raw);
  if (pg.kind === 'image') {
    return { url: pg.url, site: pg.site, imageOnly: true, artist: null, title: null, album: null, released: null, label: null, isrc: null, genres: [], lengthMs: null, image: bestImage(pg.url), from: { image: 'link' } };
  }
  return songFromHtml(pg.html, pg.url);
}

/** The page says nothing about a song (a search page, a home page). */
export const saysNothing = (p: PageSong) => !p.imageOnly && !p.image && !p.artist && !p.album && !p.released;

/** A page's details as a match, for the same cover and field filling as a provider's. */
export const pageToMatch = (p: PageSong): MusicMatch => ({
  state: 'hit', provider: 'page', artist: p.artist, title: p.title, album: p.album, released: p.released, label: p.label, isrc: p.isrc,
  genres: p.genres, lengthMs: p.lengthMs, coverUrl: p.image, link: p.url, confidence: undefined, reason: `From ${p.site}`,
});

// ============================================================================
//  ANY PAGE, ANY CONTENT TYPE (build queue F2).
//
//  The same one-page read for every content type the general Find details
//  serves: a film's page on a studio or festival site, an episode's on a
//  broadcaster's, a news article, a podcast episode, a person's profile.
//  schema.org names a JSON-LD property exactly as a content type names its
//  field's `schemaOrg`, so a page's values are kept under their own property
//  names and mapped onto the type's fields the way Wikidata's are
//  (wikidataLookup.ts mapToFields). Open Graph and the page's <title> and
//  description fill what JSON-LD does not say.
// ============================================================================

export interface PageDetails {
  url: string;
  site: string;
  imageOnly: boolean;
  /** What the page says it is: its JSON-LD @type, else Open Graph's og:type read as one. */
  kind: string | null;
  label: string | null;
  description: string | null;
  values: SchemaValues;
  /** Where each value came from (json-ld, og, title, link), by schema.org property. */
  from: Record<string, string>;
  /** Its kind is the content type's (or one of its narrower types): a Movie page for a Movie. */
  likely: boolean;
}

// Things a page describes about itself or its publisher rather than its subject.
const NOT_SUBJECT = new Set(['WebSite', 'WebPage', 'Organization', 'Corporation', 'NewsMediaOrganization', 'BreadcrumbList', 'ListItem', 'ItemList',
  'SearchAction', 'ImageObject', 'Offer', 'AggregateOffer', 'AggregateRating', 'Rating', 'Review', 'Brand', 'SiteNavigationElement', 'WPHeader', 'WPFooter', 'CollectionPage', 'FAQPage', 'Question', 'Answer', 'EntryPoint']);
const OG_KIND: Record<string, string> = {
  'video.movie': 'Movie', 'video.episode': 'TVEpisode', 'video.tv_show': 'TVSeries', 'video.other': 'VideoObject',
  article: 'Article', 'music.song': 'MusicRecording', 'music.album': 'MusicAlbum', 'music.radio_station': 'RadioStation', profile: 'Person', book: 'Book',
};
const IMAGE_KEYS = new Set(['image', 'thumbnailUrl', 'logo', 'photo', 'primaryImageOfPage']);
const URL_KEYS = new Set(['url', 'sameAs', 'contentUrl', 'embedUrl', 'mainEntityOfPage']);
// Properties that hold several values even when a page gives one (a field of tags takes them as a list).
const PEOPLE_AND_GENRE = new Set(['genre', 'actor', 'director', 'author', 'performer', 'byArtist', 'character']);
const isDateKey = (k: string) => /^date|Date$|^uploadDate$|^startDate$|^endDate$|^birthDate$|^deathDate$/.test(k);

/** A Movie page for a Movie, a TVEpisode for an Episode, a NewsArticle for an Article. Pure. */
export function kindMatches(pageKind: string | null, typeKind: string | null): boolean {
  if (!pageKind || !typeKind) return false;
  return pageKind === typeKind || pageKind.endsWith(typeKind) || typeKind.endsWith(pageKind);
}

/** ISO 8601 duration as minutes (Wikidata's unit for a running time, so both finders agree). */
const minutes = (v: unknown) => { const ms = durationMs(v); return ms == null ? null : Math.round(ms / 60000); };

/** One JSON-LD property as a value the field mapper understands, or null. Pure. */
function ldValue(key: string, v: any, base: string): SchemaValues[string] | null {
  if (v == null || v === '') return null;
  const abs = (u: string) => { try { return new URL(u, base).toString(); } catch { return null; } };
  if (IMAGE_KEYS.has(key)) { const u = imageOf(v); const a = u ? abs(u) : null; return a ? { kind: 'image', value: a } : null; }
  if (URL_KEYS.has(key)) { const u = typeof v === 'string' ? v : Array.isArray(v) ? (typeof v[0] === 'string' ? v[0] : null) : (typeof v?.['@id'] === 'string' ? v['@id'] : typeof v?.url === 'string' ? v.url : null); const a = u ? abs(u) : null; return a && /^https?:/.test(a) ? { kind: 'url', value: a } : null; }
  if (key === 'duration' || key === 'timeRequired') { const m = minutes(v); return m == null ? null : { kind: 'number', value: m }; }
  if (isDateKey(key)) { const d = isoDate(v); return d ? { kind: 'date', value: d, precision: d.length === 4 ? 9 : d.length === 7 ? 10 : 11 } : null; }
  if (typeof v === 'number') return Number.isFinite(v) ? { kind: 'number', value: v } : null;
  if (typeof v === 'boolean') return null;
  if (key === 'partOfSeason' && typeof v === 'object' && !Array.isArray(v) && v.seasonNumber != null) return { kind: 'number', value: Number(v.seasonNumber) };
  if (key === 'keywords' && typeof v === 'string') { const l = v.split(',').map((x) => decode(x)).filter(Boolean); return l.length ? { kind: 'list', value: l.slice(0, 20) } : null; }
  if (typeof v === 'string') {
    if (/^\d+$/.test(v.trim()) && /Number$/.test(key)) return { kind: 'number', value: Number(v) };
    const t = decode(v);
    return t ? (PEOPLE_AND_GENRE.has(key) ? { kind: 'list', value: [t] } : { kind: 'text', value: t }) : null;
  }
  if (Array.isArray(v)) {
    const l = [...new Set(v.map((x) => (typeof x === 'string' ? decode(x) : nameOf(x))).filter(Boolean) as string[])].slice(0, 20);
    return l.length ? (l.length === 1 && !PEOPLE_AND_GENRE.has(key) && key !== 'keywords' ? { kind: 'text', value: l[0] } : { kind: 'list', value: l }) : null;
  }
  if (typeof v === 'object') { const n = nameOf(v); return n ? (PEOPLE_AND_GENRE.has(key) ? { kind: 'list', value: [n] } : { kind: 'text', value: n }) : null; }
  return null;
}

/** The page's subject among its JSON-LD objects: the content type's kind first, then the first that is not about the site itself. Pure. */
export function subjectOf(ld: any[], typeKind: string | null): any | null {
  // A WebPage's mainEntity is its subject.
  const all = [...ld, ...ld.map((o) => o?.mainEntity).filter((m) => m && typeof m === 'object' && !Array.isArray(m))];
  const typed = all.filter((o) => typeOf(o).some((t) => t && !NOT_SUBJECT.has(t)));
  return typed.find((o) => typeOf(o).some((t) => kindMatches(t, typeKind))) ?? typed[0] ?? null;
}

/** Everything a page says about its subject, by schema.org property. Pure: the HTML in, the values out. Tested. */
export function detailsFromHtml(html: string, url: string, typeKind: string | null): PageDetails {
  const site = (() => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } })();
  const values: SchemaValues = {};
  const from: Record<string, string> = {};
  const set = (k: string, v: SchemaValues[string] | null, src: string) => { if (v && !values[k]) { values[k] = v; from[k] = src; } };

  // 1. schema.org JSON-LD: every property of the subject, under its own name.
  const subject = subjectOf(jsonLd(html), typeKind);
  let kind: string | null = subject ? (typeOf(subject).find((t) => kindMatches(t, typeKind)) ?? typeOf(subject).find((t) => t && !NOT_SUBJECT.has(t)) ?? null) : null;
  if (subject) for (const [k, v] of Object.entries(subject)) if (!k.startsWith('@') && k !== 'mainEntity') set(k, ldValue(k, v, url), 'json-ld');

  // 2. Open Graph (og:, video:, article:), Twitter cards, then the page's own <title> and description.
  const meta = metaTags(html);
  const m = (...ks: string[]) => ks.map((k) => meta.get(k)).find((v) => v) ?? null;
  const notUrl = (v: string | null) => (v && !/^https?:\/\//.test(v) ? v : null);
  const ogKind = OG_KIND[String(meta.get('og:type') ?? '').toLowerCase()] ?? null;
  if (!kind) kind = ogKind;
  const siteName = meta.get('og:site_name');
  // "Harbour Lights | Example TV" is the title "Harbour Lights" when the site is Example TV.
  const bare = (t: string | null) => (t && siteName ? t.replace(new RegExp(`\\s*[|\\-–—:]\\s*${siteName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i'), '').trim() || t : t);
  const ogTitle = bare(m('og:title', 'twitter:title'));
  set('name', ogTitle ? { kind: 'text', value: ogTitle } : null, 'og');
  const ogDesc = m('og:description', 'twitter:description');
  set('description', ogDesc ? { kind: 'text', value: ogDesc } : null, 'og');
  const ogImg = m('og:image:secure_url', 'og:image', 'twitter:image', 'twitter:image:src');
  set('image', ogImg ? ldValue('image', ogImg, url) : null, 'og');
  const ogUrl = m('og:url');
  set('url', ogUrl ? ldValue('url', ogUrl, url) : null, 'og');
  set('datePublished', ldValue('datePublished', m('video:release_date', 'article:published_time', 'music:release_date', 'og:release_date'), url), 'og');
  set('dateModified', ldValue('dateModified', m('article:modified_time', 'og:updated_time'), url), 'og');
  const secs = Number(m('video:duration', 'music:duration'));
  set('duration', Number.isFinite(secs) && secs > 0 ? { kind: 'number', value: Math.round(secs / 60) } : null, 'og');
  const tags = [...html.matchAll(/<meta\b[^>]*(?:property|name)\s*=\s*["'](?:article|video|book):tag["'][^>]*>/gi)]
    .map((x) => /\bcontent\s*=\s*["']([^"']*)["']/i.exec(x[0])?.[1]).filter(Boolean).map((x) => decode(x!));
  set('keywords', tags.length ? { kind: 'list', value: [...new Set(tags)].slice(0, 20) } : ldValue('keywords', meta.get('keywords') ?? null, url), 'og');
  set('genre', notUrl(m('article:section')) ? { kind: 'list', value: [m('article:section')!] } : null, 'og');
  for (const [prop, key] of [['video:director', 'director'], ['video:actor', 'actor'], ['article:author', 'author'], ['music:musician', 'byArtist']] as const) {
    const names = [...html.matchAll(new RegExp(`<meta\\b[^>]*(?:property|name)\\s*=\\s*["']${prop}["'][^>]*>`, 'gi'))]
      .map((x) => /\bcontent\s*=\s*["']([^"']*)["']/i.exec(x[0])?.[1]).map((x) => notUrl(x ? decode(x) : null)).filter(Boolean) as string[];
    set(key, names.length ? { kind: 'list', value: [...new Set(names)].slice(0, 20) } : null, 'og');
  }
  set('partOfSeries', notUrl(m('video:series')) ? { kind: 'text', value: m('video:series')! } : null, 'og');
  const title = bare(decode(/<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1] ?? '') || null);
  set('name', title ? { kind: 'text', value: title } : null, 'title');
  const metaDesc = meta.get('description');
  set('description', metaDesc ? { kind: 'text', value: metaDesc } : null, 'title');

  // What one name says another does, as the Wikidata finder fills them, so a
  // Clip's Headline, a Movie's Year and a Clip's Thumbnail are filled too.
  if (values.name) set('headline', values.name, from.name);
  if (values.headline) set('name', values.headline, from.headline);
  if (values.image) set('thumbnailUrl', values.image, from.image);
  if (values.thumbnailUrl) set('image', values.thumbnailUrl, from.thumbnailUrl);
  const year = values.datePublished?.kind === 'date' ? Number(String(values.datePublished.value).slice(0, 4)) : values.dateCreated?.kind === 'date' ? Number(String(values.dateCreated.value).slice(0, 4)) : NaN;
  if (Number.isFinite(year)) set('copyrightYear', { kind: 'number', value: year }, values.datePublished ? from.datePublished : from.dateCreated);

  const label = values.name?.kind === 'text' ? String(values.name.value) : null;
  const description = values.description?.kind === 'text' ? String(values.description.value) : null;
  return { url, site, imageOnly: false, kind, label, description, values, from, likely: kindMatches(kind, typeKind) };
}

/** A pasted image address: it can fill the type's image fields and nothing else. */
export function imageDetails(url: string, site: string): PageDetails {
  const v = { kind: 'image' as const, value: url };
  return { url, site, imageOnly: true, kind: null, label: null, description: null,
    values: { image: v, thumbnailUrl: v, logo: v }, from: { image: 'link', thumbnailUrl: 'link', logo: 'link' }, likely: false };
}

/** The page said nothing beyond its <title>: no structured data, no Open Graph. */
export const pageSaysNothing = (p: PageDetails) => !p.imageOnly && Object.values(p.from).every((f) => f === 'title');

/** Fetch one page (or image) a person pasted and read it for any content type. Throws PageBlocked when the site will not answer a program. */
export async function readDetailsPage(raw: string, typeKind: string | null): Promise<PageDetails> {
  const pg = await fetchPage(raw, 'Open the page in your browser and copy the details into the fields yourself, or paste the address of its image.');
  return pg.kind === 'image' ? imageDetails(pg.url, pg.site) : detailsFromHtml(pg.html, pg.url, typeKind);
}
