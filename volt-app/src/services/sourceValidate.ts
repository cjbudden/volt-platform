// ============================================================================
//  VALIDATE SOURCE: is this address playable as it is, right now?
//
//  The question an operator asks when adding or changing a source is not "what
//  does ffprobe make of it" but "does it work". For the pull sources a radio
//  station (and most channels) take, that can be answered from the protocol
//  itself, with plain HTTP and no ffmpeg on the control plane:
//
//    ICECAST  connect, read the ICY headers and one metadata block (the station
//             name, genre, bitrate, now playing), then read a few kilobytes of
//             the audio and find real MP3 / AAC (ADTS) / Ogg frames in it. A
//             mount that answers 200 with an HTML error page fails here.
//    HLS      read the playlist; for a master, read the lowest variant that
//             carries its own audio; then fetch the start of the newest segment
//             and recognise its container (MPEG-TS, fMP4, packed AAC/MP3).
//    DASH     read the MPD (static or live, adaptation sets, codecs, DRM), then
//             fetch the start of an initialisation segment and recognise it.
//
//  Every check says pass, warn, fail or skip and why, so the panel can show
//  the reasoning rather than a bare yes or no. Push protocols (SRT listener,
//  RTMP) have nothing to dial and get a note. ffprobe (sourceProbe.ts) stays as
//  the deeper "received broadcast details" view on channels; this is the quick
//  gate, bounded in time and bytes.
//
//  Network-only: http and https on every hop, the same fence as the probe.
// ============================================================================
import { inspectHls, type HlsInspection, type HlsVariant } from './hlsMaster';
import { probeIcySource, resolveStreamUrl, type IcyProbe } from './radio/icyMeta';
import { probeUrlProblem } from './sourceProbe';

export type CheckState = 'pass' | 'warn' | 'fail' | 'skip';
export interface SourceCheck { id: string; label: string; state: CheckState; detail: string }
export type SourceKind = 'icecast' | 'hls' | 'dash' | 'push' | 'unknown';

export interface SourceValidation {
  /** Playable as it is: every check passed or only warned. */
  ok: boolean;
  kind: SourceKind;
  /** The address that was finally read (a .pls / .m3u resolved, redirects followed). */
  url: string;
  verdict: string;
  checks: SourceCheck[];
  /** What the source is, as label/value pairs for the panel. */
  facts: { k: string; v: string }[];
  /** What the browser can try to play for a sample, or null when it cannot. */
  preview: { kind: 'audio' | 'hls' | 'dash'; url: string } | null;
  /** Icecast: the station's own metadata, for the adopt buttons. */
  icy?: IcyProbe;
  /** HLS: the playlist as read (master variants or media facts). */
  hls?: HlsInspection;
  elapsedMs: number;
}

const UA = 'Volt-Source-Check/1.0';
const MAX_DOC = 2 * 1024 * 1024;
const MAX_CONCURRENT = 6;
let inFlight = 0;

const kb = (n: number) => `${Math.round(n / 1000)} kbps`;

// ---------------------------------------------------------------------------
//  Container / codec sniffing (pure, exported for the check suite)
// ---------------------------------------------------------------------------
const MP3_BR: Record<string, number[]> = {
  // [version][layer] bitrate tables (kbps), index 1..14
  '1-3': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  '1-2': [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  '1-1': [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  '2-3': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  '2-2': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  '2-1': [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
};
const MP3_SR: Record<number, number[]> = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
const ADTS_SR = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
const AAC_PROFILE = ['AAC Main', 'AAC-LC', 'AAC SSR', 'AAC LTP'];

export interface AudioSniff { codec: string; sampleRate?: number; channels?: number; bitrateKbps?: number; frames: number }

function mp3FrameAt(b: Buffer, i: number): { len: number; br: number; sr: number; ch: number; layer: number } | null {
  if (i + 4 > b.length || b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) return null;
  const ver = (b[i + 1] >> 3) & 3; const layerBits = (b[i + 1] >> 1) & 3;
  const bri = (b[i + 2] >> 4) & 15; const sri = (b[i + 2] >> 2) & 3; const pad = (b[i + 2] >> 1) & 1;
  if (ver === 1 || layerBits === 0 || bri === 0 || bri === 15 || sri === 3) return null;
  const layer = 4 - layerBits;
  const table = MP3_BR[`${ver === 3 ? 1 : 2}-${layer}`];
  const br = table[bri] * 1000; const sr = MP3_SR[ver][sri];
  const ch = ((b[i + 3] >> 6) & 3) === 3 ? 1 : 2;
  let len: number;
  if (layer === 1) len = (Math.floor((12 * br) / sr) + pad) * 4;
  else len = Math.floor(((layer === 3 && ver !== 3 ? 72 : 144) * br) / sr) + pad;
  return len > 4 ? { len, br, sr, ch, layer } : null;
}

/** Offset of the first MP3 frame that is followed by another where its header says, or -1. */
export function mp3FrameOffset(b: Buffer, from = 0): number {
  for (let i = from; i + 4 <= b.length; i++) {
    if (b[i] !== 0xff) continue;
    const f = mp3FrameAt(b, i);
    if (!f) continue;
    if (i + f.len + 4 > b.length) return i;            // last frame in the buffer: accept
    const g = mp3FrameAt(b, i + f.len);
    if (g && g.sr === f.sr) return i;
  }
  return -1;
}

function adtsFrameAt(b: Buffer, i: number): { len: number; sr: number; ch: number; profile: number } | null {
  if (i + 7 > b.length || b[i] !== 0xff || (b[i + 1] & 0xf6) !== 0xf0) return null;
  const profile = (b[i + 2] >> 6) & 3; const sri = (b[i + 2] >> 2) & 15;
  const ch = ((b[i + 2] & 1) << 2) | ((b[i + 3] >> 6) & 3);
  const len = ((b[i + 3] & 3) << 11) | (b[i + 4] << 3) | ((b[i + 5] >> 5) & 7);
  if (sri >= ADTS_SR.length || len < 7) return null;
  return { len, sr: ADTS_SR[sri], ch, profile };
}

function skipId3(b: Buffer): number {
  let i = 0;
  while (i + 10 <= b.length && b.toString('latin1', i, i + 3) === 'ID3') {
    const size = ((b[i + 6] & 0x7f) << 21) | ((b[i + 7] & 0x7f) << 14) | ((b[i + 8] & 0x7f) << 7) | (b[i + 9] & 0x7f);
    i += 10 + size + ((b[i + 5] & 0x10) ? 10 : 0);
  }
  return i;
}

/** Find at least three consecutive MP3 or ADTS frames (or an Ogg page) in a raw audio sample. */
export function sniffAudio(buf: Buffer): AudioSniff | null {
  if (buf.length >= 4 && buf.toString('latin1', 0, 4) === 'OggS') {
    const head = buf.toString('latin1', 0, Math.min(buf.length, 512));
    return { codec: /OpusHead/.test(head) ? 'Opus (Ogg)' : /vorbis/.test(head) ? 'Vorbis (Ogg)' : /FLAC/.test(head) ? 'FLAC (Ogg)' : 'Ogg', frames: 1 };
  }
  const start = skipId3(buf);
  const limit = Math.min(buf.length, start + 16384);
  for (let i = start; i < limit; i++) {
    if (buf[i] !== 0xff) continue;
    // MP3: three frames in a row, each where the previous one said it ends.
    const f = mp3FrameAt(buf, i);
    if (f) {
      let j = i + f.len; let n = 1; const brs = [f.br];
      while (n < 8) { const g = mp3FrameAt(buf, j); if (!g || g.sr !== f.sr) break; brs.push(g.br); j += g.len; n++; }
      if (n >= 3) {
        const avg = brs.reduce((a, c) => a + c, 0) / brs.length;
        return { codec: f.layer === 3 ? 'MP3' : `MPEG audio layer ${f.layer}`, sampleRate: f.sr, channels: f.ch, bitrateKbps: Math.round(avg / 1000), frames: n };
      }
    }
    const a = adtsFrameAt(buf, i);
    if (a) {
      let j = i + a.len; let n = 1;
      while (n < 8) { const g = adtsFrameAt(buf, j); if (!g || g.sr !== a.sr) break; j += g.len; n++; }
      if (n >= 3) return { codec: AAC_PROFILE[a.profile] ?? 'AAC', sampleRate: a.sr, channels: a.ch || undefined, frames: n };
    }
  }
  return null;
}

/**
 * TIMED METADATA AT THE START OF A SEGMENT: the ID3v2 tags packed-audio HLS
 * carries (and some TS / fMP4 streams in their first bytes). Apple's
 * transportStreamTimestamp PRIV frame says where the segment sits on the
 * timeline; text frames carry now playing (TIT2 title, TPE1 artist, TALB album,
 * TXXX custom, WXXX a link, APIC artwork). Pure, bounded to the bytes given.
 */
export interface Id3Tags { title?: string; artist?: string; album?: string; text: Record<string, string>; frames: string[]; timestamp: boolean; artwork: boolean }
export function readId3(b: Buffer): Id3Tags | null {
  const out: Id3Tags = { text: {}, frames: [], timestamp: false, artwork: false };
  let i = 0, tags = 0;
  const dec = (enc: number, x: Buffer) => (enc === 1 || enc === 2 ? x.toString('utf16le') : x.toString(enc === 3 ? 'utf8' : 'latin1')).replace(/\u0000+$/g, '').replace(/^\ufeff/, '').trim();
  while (i + 10 <= b.length && b.toString('latin1', i, i + 3) === 'ID3' && tags < 8) {
    const ver = b[i + 3];
    const size = ((b[i + 6] & 0x7f) << 21) | ((b[i + 7] & 0x7f) << 14) | ((b[i + 8] & 0x7f) << 7) | (b[i + 9] & 0x7f);
    const body = b.subarray(i + 10, Math.min(b.length, i + 10 + size));
    let k = 0;
    while (k + 10 <= body.length && (ver === 3 || ver === 4)) {
      const id = body.toString('latin1', k, k + 4);
      if (!/^[A-Z0-9]{4}$/.test(id)) break;
      const fs = ver === 4 ? ((body[k + 4] & 0x7f) << 21) | ((body[k + 5] & 0x7f) << 14) | ((body[k + 6] & 0x7f) << 7) | (body[k + 7] & 0x7f) : body.readUInt32BE(k + 4);
      const f = body.subarray(k + 10, Math.min(body.length, k + 10 + fs));
      if (!out.frames.includes(id)) out.frames.push(id);
      if (id === 'PRIV' && f.toString('latin1', 0, 44) === 'com.apple.streaming.transportStreamTimestamp') out.timestamp = true;
      else if (id === 'APIC') out.artwork = true;
      else if (id === 'TXXX' && f.length > 1) { const parts = dec(f[0], f.subarray(1)).split('\u0000'); if (parts[0]) out.text[parts[0]] = parts.slice(1).join(' ').trim(); }
      else if (id[0] === 'T' && f.length > 1) {
        const v = dec(f[0], f.subarray(1)).replace(/\u0000/g, ' / ');
        if (id === 'TIT2') out.title = v; else if (id === 'TPE1') out.artist = v; else if (id === 'TALB') out.album = v; else out.text[id] = v;
      }
      k += 10 + fs;
    }
    i += 10 + size + ((b[i + 5] & 0x10) ? 10 : 0); tags++;
  }
  return tags ? out : null;
}

/** What container the first bytes of a segment are. */
export function sniffContainer(buf: Buffer): { container: string; ok: boolean } {
  if (buf.length >= 189 && buf[0] === 0x47 && buf[188] === 0x47) return { container: 'MPEG-TS', ok: true };
  if (buf.length >= 1 && buf[0] === 0x47 && buf.length < 189) return { container: 'MPEG-TS', ok: true };
  if (buf.length >= 8) {
    const box = buf.toString('latin1', 4, 8);
    if (['ftyp', 'styp', 'moof', 'sidx', 'moov', 'emsg', 'prft'].includes(box)) return { container: `fMP4 (${box})`, ok: true };
  }
  if (buf.length >= 4 && buf.toString('latin1', 0, 4) === 'WEBVTT') return { container: 'WebVTT', ok: true };
  const a = sniffAudio(buf);
  if (a) return { container: `packed audio (${a.codec})`, ok: true };
  if (buf.length >= 3 && buf.toString('latin1', 0, 3) === 'ID3') return { container: 'packed audio (ID3 tagged)', ok: true };
  const text = buf.toString('utf8', 0, Math.min(buf.length, 200)).trim().toLowerCase();
  if (text.startsWith('<!doctype') || text.startsWith('<html') || text.startsWith('{')) return { container: 'a web page or error, not media', ok: false };
  return { container: 'unrecognised bytes', ok: false };
}

// ---------------------------------------------------------------------------
//  Bounded HTTP
// ---------------------------------------------------------------------------
interface Got { status: number; url: string; headers: Headers; body: Buffer; error?: string }

/** GET at most `max` bytes (a stream is cut there), following redirects over http/https only. */
async function getBytes(url: string, max: number, timeoutMs: number, headers: Record<string, string> = {}): Promise<Got> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  let current = url;
  try {
    for (let hop = 0; hop <= 5; hop++) {
      const u = new URL(current);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return { status: 0, url: current, headers: new Headers(), body: Buffer.alloc(0), error: 'only http and https are read' };
      const r = await fetch(u, { redirect: 'manual', signal: ac.signal, headers: { 'user-agent': UA, accept: '*/*', ...headers } });
      const loc = r.headers.get('location');
      if (r.status >= 300 && r.status < 400 && loc) { current = new URL(loc, u).toString(); continue; }
      const chunks: Buffer[] = []; let size = 0;
      if (r.body) {
        const reader = r.body.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(Buffer.from(value)); size += value.length;
            if (size >= max) break;
          }
        } catch { /* aborted at the time limit: keep what arrived */ }
        try { await reader.cancel(); } catch { /* ignore */ }
      }
      return { status: r.status, url: current, headers: r.headers, body: Buffer.concat(chunks).subarray(0, max) };
    }
    return { status: 0, url: current, headers: new Headers(), body: Buffer.alloc(0), error: 'more than 5 redirects' };
  } catch (e: any) {
    const why = e?.name === 'AbortError' ? 'did not answer in time' : String(e?.cause?.code ?? e?.cause?.message ?? e?.message ?? e);
    return { status: 0, url: current, headers: new Headers(), body: Buffer.alloc(0), error: why };
  } finally { clearTimeout(t); }
}

const reachDetail = (g: Got) => g.error ? `Could not connect: ${g.error}` : `The server answered ${g.status}`;

// ---------------------------------------------------------------------------
//  Kind detection
// ---------------------------------------------------------------------------
export function kindFor(url: string, protocol?: string | null): SourceKind | null {
  const p = (protocol ?? '').toLowerCase();
  if (p === 'icecast' || p === 'shoutcast') return 'icecast';
  if (p === 'hls') return 'hls';
  if (p === 'dash') return 'dash';
  if (p === 'rtmp' || p === 'rtmps') return 'push';
  if (p === 'srt' && !/[?&]mode=caller\b/i.test(url)) return 'push';
  const u = url.trim();
  if (/\.m3u8(\?|#|$)/i.test(u)) return 'hls';
  if (/\.mpd(\?|#|$)/i.test(u)) return 'dash';
  if (/^https?:\/\//i.test(u) && p === '') return null;   // sniff it
  return p ? 'unknown' : null;
}

async function sniffKind(url: string): Promise<SourceKind> {
  const g = await getBytes(url, 2048, 6000, { 'Icy-MetaData': '0' });
  const ct = (g.headers.get('content-type') ?? '').toLowerCase();
  const head = g.body.toString('utf8', 0, Math.min(g.body.length, 400)).replace(/^﻿/, '').trimStart();
  if (head.startsWith('#EXTM3U') || /mpegurl/.test(ct) && head.includes('#EXT-X')) return 'hls';
  if (/<MPD[\s>]/.test(head) || /dash\+xml/.test(ct)) return 'dash';
  if (/^audio\//.test(ct) || g.headers.get('icy-name') != null || g.headers.get('icy-br') != null || sniffAudio(g.body)) return 'icecast';
  if (/\.(pls|m3u)(\?|$)/i.test(url)) return 'icecast';
  return 'unknown';
}

// ---------------------------------------------------------------------------
//  Per kind
// ---------------------------------------------------------------------------
async function validateIcecast(rawUrl: string, out: SourceValidation) {
  const icy = await probeIcySource(rawUrl, 8000);
  out.icy = icy; out.url = icy.url;
  if (icy.resolved) out.checks.push({ id: 'playlist', label: 'Playlist', state: 'pass', detail: `The address is a playlist. It points at ${icy.url}.` });
  if (!icy.ok) {
    out.checks.push({ id: 'connect', label: 'Connect', state: 'fail', detail: `${icy.error ?? 'No answer'}. The URL may be wrong, the station off air, or it may block this server.` });
    return;
  }
  const st = icy.station;
  out.checks.push({ id: 'connect', label: 'Connect', state: 'pass', detail: `Connected${st.contentType ? `, the server sends ${st.contentType}` : ''}.` });

  // The audio itself: read a few kilobytes WITHOUT interleaved metadata and
  // find real frames in it. A mount that answers 200 with a page fails here.
  const g = await getBytes(icy.url, 24 * 1024, 7000, { 'Icy-MetaData': '0' });
  const audio = g.status >= 200 && g.status < 300 ? sniffAudio(g.body) : null;
  if (audio) {
    out.checks.push({ id: 'audio', label: 'Audio', state: 'pass', detail: `${audio.frames} consecutive ${audio.codec} frames in the first ${Math.round(g.body.length / 1024)} KB.` });
    out.facts.push({ k: 'Codec', v: audio.codec });
    if (audio.sampleRate) out.facts.push({ k: 'Sample rate', v: `${(audio.sampleRate / 1000).toFixed(audio.sampleRate % 1000 ? 1 : 0)} kHz` });
    if (audio.channels) out.facts.push({ k: 'Channels', v: audio.channels === 1 ? 'mono' : audio.channels === 2 ? 'stereo' : String(audio.channels) });
    const br = audio.bitrateKbps ?? st.bitrateKbps;
    if (br) out.facts.push({ k: 'Bitrate', v: `${br} kbps${audio.bitrateKbps && st.bitrateKbps && Math.abs(audio.bitrateKbps - st.bitrateKbps) > 8 ? ` (the station announces ${st.bitrateKbps})` : ''}` });
  } else if (g.body.length) {
    const ct = (g.headers.get('content-type') ?? '').toLowerCase();
    const known = /^audio\/(mpeg|aac|aacp|mp4|ogg|opus|flac)/.test(ct);
    out.checks.push({ id: 'audio', label: 'Audio', state: known ? 'warn' : 'fail',
      detail: known ? `Bytes arrive as ${ct}, but no MP3 or AAC frames were recognised in them.` : `The server sent ${g.body.length} bytes of ${ct || 'an unknown type'}, which are not audio.` });
  } else {
    out.checks.push({ id: 'audio', label: 'Audio', state: 'fail', detail: `No audio arrived: ${reachDetail(g)}.` });
  }
  if (out.checks.some((c) => c.id === 'audio' && c.state === 'fail')) return;
  out.checks.push(icy.hasMetadata
    ? { id: 'metadata', label: 'Now playing', state: 'pass', detail: icy.nowPlaying ? `"${icy.nowPlaying}"` : 'The station sends ICY metadata (an empty title right now).' }
    : { id: 'metadata', label: 'Now playing', state: 'warn', detail: 'This mount does not interleave ICY metadata: no now-playing log or song / ad classification. Recording and packaging still work.' });
  if (st.name) out.facts.unshift({ k: 'Station', v: st.name });
  if (st.genre) out.facts.push({ k: 'Genre', v: st.genre });
  out.preview = { kind: 'audio', url: icy.url };
}

function pickVariant(vs: HlsVariant[]): HlsVariant | null {
  const own = vs.filter((v) => !v.externalAudio);
  const pool = own.length ? own : vs;
  return [...pool].sort((a, b) => (a.bandwidth ?? 0) - (b.bandwidth ?? 0))[0] ?? null;
}

async function validateHls(url: string, out: SourceValidation) {
  const top = await inspectHls(url, 8000);
  out.hls = top;
  if (top.redirectedTo) out.url = top.redirectedTo;
  if (!top.ok) { out.checks.push({ id: 'playlist', label: 'Playlist', state: 'fail', detail: top.error ?? 'Not an HLS playlist.' }); return; }
  let media = top; let mediaUrl = out.url;
  if (top.kind === 'master') {
    const vs = top.variants ?? [];
    const audioOnly = vs.length > 0 && vs.every((v) => v.audioOnly);
    out.checks.push({ id: 'playlist', label: 'Master playlist', state: vs.length ? 'pass' : 'fail',
      detail: vs.length ? `${vs.length} variant${vs.length === 1 ? '' : 's'}${audioOnly ? ', audio only' : ''}${top.renditions?.length ? `, ${top.renditions.length} alternative rendition${top.renditions.length === 1 ? '' : 's'}` : ''}.` : 'The master lists no variants.' });
    out.facts.push({ k: 'Variants', v: vs.map((v) => [v.resolution, v.bandwidth ? kb(v.bandwidth) : null, v.codecNames.join(' + ')].filter(Boolean).join(' ')).join(', ') || 'none' });
    const v = pickVariant(vs);
    if (!v) return;
    const sub = await inspectHls(v.uri, 8000);
    if (!sub.ok || sub.kind !== 'media') {
      out.checks.push({ id: 'media', label: 'Variant playlist', state: 'fail', detail: `The variant ${v.uri} could not be read: ${sub.error ?? 'not a media playlist'}.` });
      return;
    }
    media = sub; mediaUrl = sub.redirectedTo ?? v.uri;
    out.checks.push({ id: 'media', label: 'Variant playlist', state: 'pass', detail: `Read the ${v.bandwidth ? kb(v.bandwidth) : 'first'} variant.` });
  } else {
    out.checks.push({ id: 'playlist', label: 'Media playlist', state: 'pass', detail: 'A single rendition playlist.' });
  }
  const segs = media.recentSegments ?? [];
  out.facts.push({ k: 'Type', v: media.live ? 'live' : 'on demand (has an end)' });
  if (media.targetDuration) out.facts.push({ k: 'Segments', v: `${media.targetDuration} s target` });
  if (!segs.length) { out.checks.push({ id: 'segment', label: 'Segments', state: 'fail', detail: 'The playlist lists no segments.' }); return; }
  const last = segs[segs.length - 1];
  const g = await getBytes(last.uri, 4096, 8000, { range: 'bytes=0-4095' });
  if (g.status < 200 || g.status >= 300) {
    out.checks.push({ id: 'segment', label: 'Newest segment', state: 'fail', detail: `${reachDetail(g)} for ${last.uri}.` });
    return;
  }
  const c = sniffContainer(g.body);
  out.checks.push({ id: 'segment', label: 'Newest segment', state: c.ok ? 'pass' : 'fail', detail: c.ok ? `Downloads, ${c.container}.` : `Downloads, but it is ${c.container}.` });
  if (c.ok) out.facts.push({ k: 'Container', v: c.container });

  // WHAT ELSE THE STREAM CARRIES: now playing in the playlist (#EXTINF title)
  // and in the segment's ID3 tags, timed markers, captions and subtitles. All
  // of it can feed the content log, the guide and the player's now playing.
  const id3 = c.ok ? readId3(g.body) : null;
  const inf = media.segmentTitle ?? null;
  const npTitle = id3?.title ?? inf?.title ?? null, npArtist = id3?.artist ?? inf?.artist ?? null;
  const where = [inf ? 'the playlist (#EXTINF)' : '', id3?.title || id3?.artist ? 'the segments (ID3)' : ''].filter(Boolean).join(' and ');
  out.checks.push(npTitle || npArtist
    ? { id: 'metadata', label: 'Now playing', state: 'pass', detail: `"${[npArtist, npTitle].filter(Boolean).join(' - ')}", from ${where}.` }
    : { id: 'metadata', label: 'Now playing', state: inf || id3 ? 'pass' : 'skip', detail: inf || id3 ? 'Metadata is present, with no title right now.' : 'No now-playing data in the playlist or the segments.' });
  if (id3) {
    const parts = [id3.title ? 'title' : '', id3.artist ? 'artist' : '', id3.album ? 'album' : '', id3.artwork ? 'artwork' : '',
      ...Object.keys(id3.text).map((k) => k.toLowerCase()), id3.timestamp ? 'Apple timestamp (PRIV)' : ''].filter(Boolean);
    out.facts.push({ k: 'ID3 in segments', v: parts.join(', ') || id3.frames.join(', ') });
  }
  if (inf && Object.keys(inf.fields).length) out.facts.push({ k: 'Playlist #EXTINF', v: Object.keys(inf.fields).join(', ') });
  const mk = media.markers;
  if (mk && (mk.dateRanges || mk.cues)) out.facts.push({ k: 'Markers', v: [mk.dateRanges ? `${mk.dateRanges} EXT-X-DATERANGE` : '', mk.cues ? `${mk.cues} SCTE-35 cue tag${mk.cues === 1 ? '' : 's'}` : ''].filter(Boolean).join(', ') });
  if (mk) out.facts.push({ k: 'Program date-time', v: mk.programDateTime ? 'yes' : 'no' });
  const subs = (top.renditions ?? []).filter((r) => r.type === 'SUBTITLES');
  const cc = top.closedCaptions || (top.renditions ?? []).some((r) => r.type === 'CLOSED-CAPTIONS');
  out.checks.push(subs.length || cc
    ? { id: 'captions', label: 'Subtitles and captions', state: 'pass', detail: [subs.length ? `${subs.length} subtitle track${subs.length === 1 ? '' : 's'} (${subs.map((r) => r.language || r.name).join(', ')})` : '', cc ? 'closed captions in the video (608/708)' : ''].filter(Boolean).join('; ') + '.' }
    : { id: 'captions', label: 'Subtitles and captions', state: 'skip', detail: 'None in the playlist.' });
  if (!media.live) out.checks.push({ id: 'live', label: 'Live', state: 'warn', detail: 'The playlist has #EXT-X-ENDLIST: it is a finished recording, so a channel would reach its end and stop.' });
  void mediaUrl;
  out.preview = { kind: 'hls', url: out.url };
}

interface DashAs { type: string; codecs: string[]; reps: { id: string; bw: number | null; h: number | null }[]; init: string | null; drm: boolean }
const attr = (tag: string, name: string) => { const m = new RegExp(`\\b${name}="([^"]*)"`).exec(tag); return m ? m[1] : null; };

/** Pure: the shape of an MPD, enough to judge it. */
export function parseMpd(xml: string, baseUrl: string) {
  const mpdTag = /<MPD\b[^>]*>/.exec(xml)?.[0];
  if (!mpdTag) return null;
  const base = (scope: string, fallback: string) => { const m = /<BaseURL[^>]*>([^<]+)<\/BaseURL>/.exec(scope); try { return m ? new URL(m[1].trim(), fallback).toString() : fallback; } catch { return fallback; } };
  const mpdBase = base(xml.split(/<Period\b/)[0], baseUrl);
  const periods = xml.split(/<Period\b/).slice(1);
  const p0 = periods[0] ?? '';
  const periodBase = base(p0.split(/<AdaptationSet\b/)[0], mpdBase);
  const sets: DashAs[] = [];
  for (const chunk of p0.split(/<AdaptationSet\b/).slice(1)) {
    const asTag = '<AdaptationSet' + chunk.slice(0, chunk.indexOf('>') + 1);
    const body = chunk.split('</AdaptationSet>')[0];
    const mime = attr(asTag, 'mimeType') ?? attr(body, 'mimeType') ?? '';
    const type = attr(asTag, 'contentType') ?? (mime.split('/')[0] || 'unknown');
    const reps = [...body.matchAll(/<Representation\b[^>]*>/g)].map((m) => ({ id: attr(m[0], 'id') ?? '', bw: Number(attr(m[0], 'bandwidth')) || null, h: Number(attr(m[0], 'height')) || null }));
    const codecs = [...new Set([attr(asTag, 'codecs'), ...[...body.matchAll(/\bcodecs="([^"]*)"/g)].map((m) => m[1])].filter(Boolean) as string[])];
    const asBase = base(body.split(/<Representation\b/)[0], periodBase);
    let init: string | null = null;
    const tmpl = /<SegmentTemplate\b[^>]*>/.exec(body)?.[0];
    const initT = tmpl ? attr(tmpl, 'initialization') : null;
    const rep0 = reps[0];
    if (initT && rep0) init = initT.replace(/\$RepresentationID\$/g, rep0.id).replace(/\$Bandwidth\$/g, String(rep0.bw ?? ''));
    else {
      const repBlock = body.split(/<Representation\b/)[1] ?? '';
      const repBase = /<BaseURL[^>]*>([^<]+)<\/BaseURL>/.exec(repBlock)?.[1];
      if (repBase) init = repBase.trim();
    }
    if (init) { try { init = new URL(init, asBase).toString(); } catch { /* keep */ } }
    sets.push({ type, codecs, reps, init, drm: /<ContentProtection\b/.test(chunk) });
  }
  return { live: attr(mpdTag, 'type') === 'dynamic', periods: periods.length, sets, profiles: attr(mpdTag, 'profiles') };
}

async function validateDash(url: string, out: SourceValidation) {
  const g = await getBytes(url, MAX_DOC, 8000, { accept: 'application/dash+xml, */*' });
  out.url = g.url;
  if (g.status < 200 || g.status >= 300) { out.checks.push({ id: 'manifest', label: 'Manifest', state: 'fail', detail: `${reachDetail(g)}.` }); return; }
  const mpd = parseMpd(g.body.toString('utf8'), g.url);
  if (!mpd) { out.checks.push({ id: 'manifest', label: 'Manifest', state: 'fail', detail: 'This address does not return a DASH manifest (no <MPD>).' }); return; }
  const media = mpd.sets.filter((s) => s.type === 'audio' || s.type === 'video');
  out.checks.push({ id: 'manifest', label: 'Manifest', state: media.length ? 'pass' : 'fail',
    detail: media.length ? `${mpd.live ? 'Live' : 'On demand'}, ${mpd.periods} period${mpd.periods === 1 ? '' : 's'}, ${media.map((s) => s.type).join(' + ')}.` : 'No audio or video adaptation set in the first period.' });
  out.facts.push({ k: 'Type', v: mpd.live ? 'live' : 'on demand' });
  for (const s of media) {
    const tops = [...s.reps].sort((a, b) => (a.bw ?? 0) - (b.bw ?? 0)).map((r) => [r.h ? `${r.h}p` : null, r.bw ? kb(r.bw) : null].filter(Boolean).join(' ')).filter(Boolean);
    out.facts.push({ k: s.type === 'audio' ? 'Audio' : 'Video', v: [s.codecs.join(', '), tops.join(', ')].filter(Boolean).join(' · ') || `${s.reps.length} representation(s)` });
  }
  if (media.some((s) => s.drm)) out.checks.push({ id: 'drm', label: 'Protection', state: 'warn', detail: 'The manifest declares DRM (ContentProtection). It needs a licence to play; the sample below may not.' });
  const first = media.find((s) => s.init);
  if (!first) { out.checks.push({ id: 'segment', label: 'Init segment', state: 'skip', detail: 'No initialisation segment address could be worked out from the manifest.' }); }
  else {
    const s = await getBytes(first.init!, 4096, 8000, { range: 'bytes=0-4095' });
    if (s.status < 200 || s.status >= 300) out.checks.push({ id: 'segment', label: 'Init segment', state: 'fail', detail: `${reachDetail(s)} for ${first.init}.` });
    else {
      const c = sniffContainer(s.body);
      out.checks.push({ id: 'segment', label: 'Init segment', state: c.ok ? 'pass' : 'fail', detail: c.ok ? `Downloads, ${c.container}.` : `Downloads, but it is ${c.container}.` });
    }
  }
  out.preview = { kind: 'dash', url: out.url };
}

// ---------------------------------------------------------------------------
export async function validateSource(rawUrl: string, protocol?: string | null): Promise<SourceValidation> {
  const t0 = Date.now();
  const url = rawUrl.trim();
  const out: SourceValidation = { ok: false, kind: 'unknown', url, verdict: '', checks: [], facts: [], preview: null, elapsedMs: 0 };
  const done = () => {
    const fails = out.checks.filter((c) => c.state === 'fail');
    const warns = out.checks.filter((c) => c.state === 'warn');
    out.ok = out.checks.length > 0 && fails.length === 0 && out.kind !== 'push' && out.kind !== 'unknown';
    if (!out.verdict) {
      out.verdict = out.ok
        ? (warns.length ? `The source works, with ${warns.length} thing${warns.length === 1 ? '' : 's'} to know.` : 'The source works and is playable as it is.')
        : fails.length ? `The source does not work: ${fails[0].label.toLowerCase()} failed.` : 'The source could not be validated.';
    }
    if (!out.ok && fails.length) out.preview = null;
    out.elapsedMs = Date.now() - t0;
    return out;
  };
  let kind = kindFor(url, protocol);
  if (kind === 'push') {
    out.kind = 'push';
    out.verdict = 'A push source: there is nothing to dial. It is checked when a feed arrives at the ingest endpoint.';
    out.checks.push({ id: 'push', label: 'Push', state: 'skip', detail: out.verdict });
    return done();
  }
  if (kind === 'unknown') {
    out.verdict = `${(protocol ?? '').toUpperCase()} sources cannot be validated from here without a probe.`;
    out.checks.push({ id: 'protocol', label: 'Protocol', state: 'skip', detail: out.verdict });
    return done();
  }
  const problem = probeUrlProblem(url);
  if (problem) { out.checks.push({ id: 'url', label: 'Address', state: 'fail', detail: problem }); out.verdict = problem; return done(); }
  if (!/^https?:\/\//i.test(url)) { out.checks.push({ id: 'url', label: 'Address', state: 'fail', detail: 'Icecast, HLS and DASH are read over http or https.' }); return done(); }
  if (inFlight >= MAX_CONCURRENT) { out.verdict = 'Several sources are being validated already. Try again in a moment.'; return done(); }
  inFlight++;
  try {
    if (!kind) {
      // A .pls / .m3u station playlist is Icecast; anything else is sniffed.
      const resolved = /\.(pls|m3u)(\?|$)/i.test(url) ? await resolveStreamUrl(url) : url;
      kind = resolved !== url ? 'icecast' : await sniffKind(url);
    }
    out.kind = kind;
    if (kind === 'icecast') await validateIcecast(url, out);
    else if (kind === 'hls') await validateHls(url, out);
    else if (kind === 'dash') await validateDash(url, out);
    else {
      const g = await getBytes(url, 512, 6000);
      out.checks.push({ id: 'connect', label: 'Connect', state: g.status >= 200 && g.status < 300 ? 'warn' : 'fail',
        detail: g.status >= 200 && g.status < 300 ? `The server answers (${g.headers.get('content-type') || 'no content type'}), but it is not Icecast audio, HLS or DASH.` : `${reachDetail(g)}.` });
    }
  } finally { inFlight--; }
  return done();
}
