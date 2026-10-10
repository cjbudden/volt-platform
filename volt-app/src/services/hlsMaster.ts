// ============================================================================
//  HLS MASTER PLAYLISTS: what a source URL really is before we take it.
//
//  An HLS address is either a MEDIA playlist (one rendition: segments) or a
//  MASTER playlist listing several variants (bitrates, codecs, resolutions)
//  and, sometimes, alternative audio or subtitle renditions in their own
//  playlists. Given a master, the encoder picks a variant itself, and which
//  one can change when the provider reorders the list. So the console reads
//  the playlist, lists what is in it, and lets the operator pick the variant
//  the station or channel takes (its own address becomes the source).
//
//  ABC Jazz, 10 Oct 2026, is the shape this was built on:
//    #EXT-X-STREAM-INF:BANDWIDTH=252000,AVERAGE-BANDWIDTH=246000,CODECS="mp4a.40.2"
//    https://…/abcjazz/v0-221.m3u8
//    #EXT-X-STREAM-INF:BANDWIDTH=140000,AVERAGE-BANDWIDTH=112000,CODECS="mp4a.40.29"
//    https://…/abcjazz/v0-222.m3u8
//  and its older address redirects to a DIFFERENT station's master (NewsRadio),
//  which is why every redirect is reported.
//
//  A variant whose audio lives in a separate playlist (EXT-X-MEDIA TYPE=AUDIO
//  with a URI) cannot be taken on its own: its address carries no sound. It is
//  listed, marked, and not offered as a choice.
//
//  The fetch is network-only (http/https on every hop), bounded in time and
//  size, and reads the playlist text only, never segments.
// ============================================================================

export interface HlsVariant {
  uri: string;
  bandwidth: number | null;
  averageBandwidth: number | null;
  codecs: string[];
  /** Human names for the codecs ("AAC-LC", "H.264"). */
  codecNames: string[];
  resolution: string | null;
  frameRate: number | null;
  audioGroup: string | null;
  /** True when the audio comes from a separate rendition playlist, so this variant cannot be used alone. */
  externalAudio: boolean;
  audioOnly: boolean;
}
export interface HlsRendition { type: string; groupId: string; name: string; language: string | null; default: boolean; channels: string | null; uri: string | null }
export interface HlsInspection {
  ok: boolean;
  error?: string;
  /** The address the playlist was finally read from, when redirects changed it. */
  redirectedTo?: string | null;
  kind?: 'master' | 'media';
  variants?: HlsVariant[];
  renditions?: HlsRendition[];
  /** Media playlist facts. */
  live?: boolean;
  targetDuration?: number | null;
}

const CODEC_NAMES: [RegExp, string][] = [
  [/^mp4a\.40\.2$/i, 'AAC-LC'], [/^mp4a\.40\.5$/i, 'HE-AAC'], [/^mp4a\.40\.29$/i, 'HE-AAC v2'], [/^mp4a\.40\.34$/i, 'MP3'],
  [/^mp4a\.6b$/i, 'MP3'], [/^mp4a/i, 'AAC'], [/^ac-3$/i, 'AC-3'], [/^ec-3$/i, 'E-AC-3'], [/^opus$/i, 'Opus'], [/^flac$/i, 'FLAC'],
  [/^avc[13]/i, 'H.264'], [/^(hvc1|hev1)/i, 'HEVC'], [/^av01/i, 'AV1'], [/^vp0?9/i, 'VP9'],
  [/^(wvtt|stpp)/i, 'subtitles'],
];
export const codecName = (c: string) => CODEC_NAMES.find(([rx]) => rx.test(c.trim()))?.[1] ?? c.trim();
const VIDEO = /^(avc|hvc1|hev1|av01|vp0?9)/i;

/** The attribute list of an #EXT-X tag: KEY=VALUE, values quoted or not, commas inside quotes kept. */
export function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  const rx = /([A-Z0-9-]+)=("([^"]*)"|[^,]*)/g;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(s))) out[m[1]] = m[3] !== undefined ? m[3] : m[2];
  return out;
}

const abs = (uri: string, base: string) => { try { return new URL(uri, base).toString(); } catch { return uri; } };
const num = (v?: string) => { const n = Number(v); return v != null && Number.isFinite(n) ? n : null; };

/** Pure: a playlist's text, read against the address it came from. */
export function parsePlaylist(text: string, baseUrl: string): HlsInspection {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines[0] !== '#EXTM3U') return { ok: false, error: 'This address does not return an HLS playlist (no #EXTM3U).' };
  const renditions: HlsRendition[] = [];
  for (const l of lines) {
    if (!l.startsWith('#EXT-X-MEDIA:')) continue;
    const a = parseAttrs(l.slice(13));
    renditions.push({ type: a.TYPE ?? '', groupId: a['GROUP-ID'] ?? '', name: a.NAME ?? '', language: a.LANGUAGE ?? null,
      default: a.DEFAULT === 'YES', channels: a.CHANNELS ?? null, uri: a.URI ? abs(a.URI, baseUrl) : null });
  }
  const variants: HlsVariant[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('#EXT-X-STREAM-INF:')) continue;
    const a = parseAttrs(lines[i].slice(18));
    const uri = lines.slice(i + 1).find((l) => !l.startsWith('#'));
    if (!uri) continue;
    const codecs = (a.CODECS ?? '').split(',').map((c) => c.trim()).filter(Boolean);
    const group = a.AUDIO ?? null;
    const externalAudio = !!group && renditions.some((r) => r.type === 'AUDIO' && r.groupId === group && r.uri);
    variants.push({
      uri: abs(uri, baseUrl), bandwidth: num(a.BANDWIDTH), averageBandwidth: num(a['AVERAGE-BANDWIDTH']),
      codecs, codecNames: [...new Set(codecs.map(codecName))], resolution: a.RESOLUTION ?? null, frameRate: num(a['FRAME-RATE']),
      audioGroup: group, externalAudio, audioOnly: !a.RESOLUTION && !codecs.some((c) => VIDEO.test(c)),
    });
  }
  if (variants.length || renditions.length) return { ok: true, kind: 'master', variants, renditions };
  const td = lines.find((l) => l.startsWith('#EXT-X-TARGETDURATION:'));
  const isMedia = !!td || lines.some((l) => l.startsWith('#EXTINF'));
  if (!isMedia) return { ok: false, error: 'The playlist lists neither variants nor segments.' };
  return { ok: true, kind: 'media', live: !lines.includes('#EXT-X-ENDLIST'), targetDuration: td ? num(td.split(':')[1]) : null };
}

/** Does this source look like HLS worth reading as a playlist? */
export function looksLikeHls(url: string, protocol?: string | null): boolean {
  if (!/^https?:\/\//i.test(url.trim())) return false;
  return (protocol ?? '').toLowerCase() === 'hls' || /\.m3u8?(\?|#|$)/i.test(url.trim());
}

const MAX_BYTES = 1024 * 1024;
const MAX_HOPS = 5;

/** Read an HLS playlist (following redirects, each hop http/https only) and describe it. */
export async function inspectHls(url: string, timeoutMs = 8000): Promise<HlsInspection> {
  let current = url.trim();
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    for (let hop = 0; hop <= MAX_HOPS; hop++) {
      let u: URL;
      try { u = new URL(current); } catch { return { ok: false, error: 'Not a valid URL.' }; }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, error: 'Only http and https playlists can be read.' };
      const r = await fetch(u, { redirect: 'manual', signal: ac.signal, headers: { 'user-agent': 'Volt-Source-Check/1.0', accept: 'application/vnd.apple.mpegurl, application/x-mpegurl, */*' } });
      if (r.status >= 300 && r.status < 400 && r.headers.get('location')) {
        current = new URL(r.headers.get('location')!, u).toString();
        continue;
      }
      if (!r.ok || !r.body) return { ok: false, error: `The playlist answered ${r.status} ${r.statusText}`.trim(), redirectedTo: current !== url.trim() ? current : null };
      // Read at most 1 MB: a playlist is text, never a stream.
      const reader = r.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > MAX_BYTES) { await reader.cancel(); return { ok: false, error: 'The response is larger than a playlist should be (over 1 MB): it looks like a stream, not HLS.' }; }
        chunks.push(value);
      }
      const text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
      const res = parsePlaylist(text, current);
      return { ...res, redirectedTo: current !== url.trim() ? current : null };
    }
    return { ok: false, error: `More than ${MAX_HOPS} redirects.` };
  } catch (e: any) {
    return { ok: false, error: e?.name === 'AbortError' ? 'The playlist did not answer in time.' : `Could not read the playlist: ${e?.cause?.code ?? e?.message ?? e}` };
  } finally {
    clearTimeout(t);
  }
}
