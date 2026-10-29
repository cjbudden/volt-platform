// ============================================================================
//  COMPANION FILES: the pure part (docs/COMPANION_FILES.md).
//
//  Files that travel with a video or audio asset without being its media:
//    captions   SRT, WebVTT, TTML / DFXP / EBU-TT (subtitles, SDH, forced)
//    metadata   sidecars: JSON, XML (NFO, NewsML-ish, any flat XML), CSV / TSV
//    other      kept and downloadable, nothing read from them
//
//  Captions are parsed into cues, checked (timing, overlaps, length, reading
//  speed, past the end) and written out as one clean WebVTT, the format the
//  player and both manifests use. Cue times are ASSET MEDIA TIME (0 = the
//  asset's first frame); the playlist route maps that to the delivered
//  segments' own clock (delivery.ts), the one-clock rule in CAPTIONS.md.
//
//  Metadata sidecars are flattened to path -> value and matched to the
//  asset's content-type fields by key, label and common synonyms. Nothing is
//  written here: the caller proposes, a person (or an ingest rule) approves.
//
//  No imports, no I/O: pinned by test/companion-files.check.ts.
// ============================================================================

export type CompanionKind = 'captions' | 'metadata' | 'other';
export type CaptionFormat = 'srt' | 'vtt' | 'ttml';
export type SidecarFormat = 'json' | 'xml' | 'csv' | 'tsv';
export type FileFormat = CaptionFormat | SidecarFormat | 'unknown';

export interface Cue { startMs: number; endMs: number; text: string; settings?: string; id?: string }
export interface CaptionIssue { level: 'error' | 'warning'; code: string; message: string; cue?: number; count?: number }
export interface CaptionReport {
  format: CaptionFormat; cues: number; firstMs: number | null; lastMs: number | null; chars: number;
  issues: CaptionIssue[]; ok: boolean;
}

// ---------------------------------------------------------------- what is it

const EXT = (name: string) => (/\.([a-z0-9]+)$/i.exec(name)?.[1] ?? '').toLowerCase();

/** The file's format, from its contents first and its name second. */
export function detectFormat(name: string, text: string): FileFormat {
  const t = stripBom(text).trimStart();
  if (/^WEBVTT\b/.test(t)) return 'vtt';
  if (/^<\?xml[\s\S]{0,400}<tt[\s>:]/i.test(t) || /^<tt[\s>:]/i.test(t) || /<tt\s[^>]*xmlns="http:\/\/www\.w3\.org\/ns\/ttml/i.test(t.slice(0, 2000))) return 'ttml';
  if (/^\d+\s*\r?\n\s*\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}\s*-->/.test(t) || /^\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}\s*-->/.test(t)) return 'srt';
  if (/^[{[]/.test(t)) return 'json';
  if (/^</.test(t)) return 'xml';
  const e = EXT(name);
  if (e === 'srt') return 'srt';
  if (e === 'vtt' || e === 'webvtt') return 'vtt';
  if (['ttml', 'dfxp', 'xml'].includes(e) && /<(tt|p)\b/i.test(t)) return 'ttml';
  if (e === 'tsv' || e === 'tab') return 'tsv';
  if (e === 'csv') return 'csv';
  if (e === 'json') return 'json';
  if (['xml', 'nfo'].includes(e)) return 'xml';
  if (/\t/.test(t.split('\n')[0] ?? '')) return 'tsv';
  if (/,/.test(t.split('\n')[0] ?? '') && t.split('\n').length >= 2) return 'csv';
  return 'unknown';
}

export function kindOf(f: FileFormat): CompanionKind {
  return f === 'srt' || f === 'vtt' || f === 'ttml' ? 'captions' : f === 'unknown' ? 'other' : 'metadata';
}

const stripBom = (s: string) => s.replace(/^﻿/, '');

/**
 * Language and flags from a file name, the way people and playout systems
 * name them: movie.en.srt, Movie_FR.vtt, film.pt-BR.forced.srt, show.eng.sdh.srt,
 * episode-de-DE.ttml. Three-letter codes become two-letter ones where known.
 */
export function nameHints(name: string): { language: string | null; forced: boolean; sdh: boolean } {
  const base = name.replace(/\.[a-z0-9]+$/i, '');
  const parts = base.split(/[._\-\s]+/).filter(Boolean);
  const forced = parts.some((p) => /^forced$/i.test(p));
  const sdh = parts.some((p) => /^(sdh|cc|hi|hoh)$/i.test(p));
  let language: string | null = null;
  for (let i = parts.length - 1; i >= 0 && !language; i--) {
    const p = parts[i];
    // pt-BR / en-GB / zh-Hans arrive split on the hyphen: rejoin a region after a language.
    const nxt = parts[i + 1];
    const lang = toLang(p);
    if (!lang) continue;
    if (i === 0 && parts.length > 1) continue;             // the title itself ("de" in "de-bruges")
    const region = nxt && /^([A-Z]{2}|[A-Z][a-z]{3}|\d{3})$/.test(nxt) ? nxt : null;
    language = region ? `${lang}-${region}` : lang;
  }
  return { language, forced, sdh };
}
const ISO3: Record<string, string> = {
  eng: 'en', fre: 'fr', fra: 'fr', ger: 'de', deu: 'de', spa: 'es', ita: 'it', por: 'pt', dut: 'nl', nld: 'nl', jpn: 'ja', kor: 'ko',
  chi: 'zh', zho: 'zh', ara: 'ar', rus: 'ru', hin: 'hi', tha: 'th', vie: 'vi', ind: 'id', msa: 'ms', may: 'ms', tam: 'ta', fil: 'fil', tgl: 'tl',
  swe: 'sv', nor: 'no', dan: 'da', fin: 'fi', pol: 'pl', tur: 'tr', gre: 'el', ell: 'el', heb: 'he', mri: 'mi', mao: 'mi', ben: 'bn', urd: 'ur',
};
const ISO2 = new Set(['en', 'fr', 'de', 'es', 'it', 'pt', 'nl', 'ja', 'ko', 'zh', 'ar', 'ru', 'hi', 'th', 'vi', 'id', 'ms', 'ta', 'tl', 'sv', 'no', 'nb', 'nn', 'da', 'fi', 'pl', 'tr', 'el', 'he', 'mi', 'bn', 'ur', 'cs', 'hu', 'ro', 'uk', 'ca', 'eu', 'gl', 'cy', 'ga', 'is', 'hr', 'sr', 'sk', 'sl', 'bg', 'lt', 'lv', 'et', 'fa', 'sw', 'zu', 'af', 'km', 'lo', 'my', 'si', 'ne', 'pa', 'gu', 'te', 'kn', 'ml', 'mr']);
function toLang(p: string): string | null {
  const l = p.toLowerCase();
  if (p.length === 2 && ISO2.has(l)) return l;
  if (p.length === 3 && ISO3[l]) return ISO3[l];
  if (l === 'fil') return 'fil';
  return null;
}

/** "en" -> "English", in English, for a track name when nobody gave one. */
export function languageName(code: string | null | undefined): string {
  if (!code) return 'Subtitles';
  try { return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) ?? code; } catch { return code; }
}

// ---------------------------------------------------------------- reading captions

/** hh:mm:ss,mmm | hh:mm:ss.mmm | mm:ss.mmm -> ms. */
function clockMs(s: string): number | null {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})[,.](\d{1,3})$/.exec(s.trim());
  if (!m) return null;
  return ((Number(m[1] ?? 0) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + Number(m[4].padEnd(3, '0'));
}

export function parseSrt(text: string): Cue[] {
  const blocks = stripBom(text).replace(/\r\n?/g, '\n').split(/\n\s*\n/);
  const cues: Cue[] = [];
  for (const b of blocks) {
    const lines = b.split('\n').filter((l, i, a) => !(i === 0 && l.trim() === '' && a.length > 1));
    let i = 0;
    if (lines[i] !== undefined && /^\d+\s*$/.test(lines[i]) && lines[i + 1]?.includes('-->')) i++;
    const tl = lines[i];
    if (!tl || !tl.includes('-->')) continue;
    const [a, bRest] = tl.split('-->');
    const bTime = bRest.trim().split(/\s+/)[0];
    const s = clockMs(a), e = clockMs(bTime);
    if (s == null || e == null) continue;
    const body = lines.slice(i + 1).join('\n').trim();
    cues.push({ startMs: s, endMs: e, text: srtTextToVtt(body) });
  }
  return cues;
}

/** SRT styling to WebVTT: keep <i> <b> <u>, drop <font> and {\an8} position codes. */
function srtTextToVtt(t: string): string {
  return t
    .replace(/\{\\an?\d+\}/g, '')
    .replace(/\{\\[^}]*\}/g, '')
    .replace(/<\/?font[^>]*>/gi, '')
    .replace(/<(\/?)(i|b|u)\s*>/gi, '<$1$2>')
    .replace(/&(?!(amp|lt|gt|nbsp|lrm|rlm);)/g, '&amp;')
    .replace(/<(?!\/?(i|b|u|c|v|lang|ruby|rt)\b)/g, '&lt;');
}

export function parseVtt(text: string): Cue[] {
  const t = stripBom(text).replace(/\r\n?/g, '\n');
  const blocks = t.split(/\n\s*\n/);
  const cues: Cue[] = [];
  for (const b of blocks) {
    const lines = b.split('\n');
    let i = 0;
    if (/^(WEBVTT|NOTE|STYLE|REGION)\b/.test(lines[0] ?? '')) continue;
    let id: string | undefined;
    if (!lines[0]?.includes('-->')) { id = lines[0]?.trim(); i = 1; }
    const tl = lines[i];
    if (!tl || !tl.includes('-->')) continue;
    const m = /^\s*(\S+)\s+-->\s+(\S+)\s*(.*)$/.exec(tl);
    if (!m) continue;
    const s = clockMs(m[1]), e = clockMs(m[2]);
    if (s == null || e == null) continue;
    cues.push({ startMs: s, endMs: e, text: lines.slice(i + 1).join('\n').trim(), ...(m[3] ? { settings: m[3].trim() } : {}), ...(id ? { id } : {}) });
  }
  return cues;
}

/**
 * TTML / DFXP / EBU-TT-D: every <p begin end> (or begin+dur), inside <div>s
 * with their own begin offsets. Clock times (00:00:01.000), frames
 * (00:00:01:12 at ttp:frameRate, default 25), and offsets (1.5s, 1500ms,
 * 90000t at ttp:tickRate). <br/> becomes a line break; <span tts:fontStyle=
 * "italic"> becomes <i>. Styling and regions beyond that are dropped.
 */
export function parseTtml(text: string): Cue[] {
  const t = stripBom(text);
  const attr = (tag: string, name: string) => new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i').exec(tag)?.[1];
  const root = /<tt\b[^>]*>/i.exec(t)?.[0] ?? '';
  const frameRate = Number(attr(root, 'ttp:frameRate')) || 25;
  const mult = (attr(root, 'ttp:frameRateMultiplier') ?? '1 1').split(/\s+/).map(Number);
  const fps = frameRate * ((mult[0] || 1) / (mult[1] || 1));
  const tickRate = Number(attr(root, 'ttp:tickRate')) || (fps ? fps : 1);
  const timeMs = (v: string | undefined): number | null => {
    if (!v) return null;
    const s = v.trim();
    let m = /^(\d+):(\d{2}):(\d{2})(?:\.(\d+))?$/.exec(s);
    if (m) return ((Number(m[1]) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + (m[4] ? Math.round(Number(`0.${m[4]}`) * 1000) : 0);
    m = /^(\d+):(\d{2}):(\d{2}):(\d+)(?:\.\d+)?$/.exec(s);
    if (m) return ((Number(m[1]) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + Math.round((Number(m[4]) / fps) * 1000);
    m = /^(\d+(?:\.\d+)?)(h|m|s|ms|f|t)$/.exec(s);
    if (m) { const n = Number(m[1]); return Math.round(m[2] === 'h' ? n * 3600000 : m[2] === 'm' ? n * 60000 : m[2] === 's' ? n * 1000 : m[2] === 'ms' ? n : m[2] === 'f' ? (n / fps) * 1000 : (n / tickRate) * 1000); }
    return null;
  };
  const body = (/<body\b[\s\S]*<\/body>/i.exec(t)?.[0]) ?? t;
  // Offsets from enclosing <body>/<div begin>: walk the tags in order.
  const cues: Cue[] = [];
  const stack: number[] = [0];
  const re = /<(\/?)(body|div|p)\b([^>]*?)(\/?)>|<\/p>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const closing = m[1] === '/', name = (m[2] ?? 'p').toLowerCase(), attrs = m[3] ?? '';
    if (name === 'p' && !closing) {
      const end = body.indexOf('</p>', re.lastIndex);
      if (end < 0) break;
      const inner = body.slice(re.lastIndex, end);
      re.lastIndex = end + 4;
      const base = stack[stack.length - 1];
      const b = timeMs(attr(attrs, 'begin')), e = timeMs(attr(attrs, 'end')), d = timeMs(attr(attrs, 'dur'));
      if (b == null || (e == null && d == null)) continue;
      const text = inner
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<span\b[^>]*fontStyle\s*=\s*"italic"[^>]*>([\s\S]*?)<\/span>/gi, '<i>$1</i>')
        .replace(/<span\b[^>]*fontWeight\s*=\s*"bold"[^>]*>([\s\S]*?)<\/span>/gi, '<b>$1</b>')
        .replace(/<(?!\/?(i|b)>)[^>]+>/g, '')
        .replace(/&apos;/g, '\'').replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_x, n) => String.fromCodePoint(Number(n)))
        .split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
      if (text) cues.push({ startMs: base + b, endMs: base + (e ?? b + (d as number)), text });
      continue;
    }
    if (name === 'body' || name === 'div') {
      if (closing) { if (stack.length > 1) stack.pop(); }
      else if (m[4] !== '/') stack.push(stack[stack.length - 1] + (timeMs(attr(attrs, 'begin')) ?? 0));
    }
  }
  return cues;
}

export function parseCaptions(format: CaptionFormat, text: string): Cue[] {
  const cues = format === 'srt' ? parseSrt(text) : format === 'vtt' ? parseVtt(text) : parseTtml(text);
  return cues.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
}

// ---------------------------------------------------------------- checking captions

/**
 * What is wrong with a caption file, in plain words. Errors stop it being used
 * as a track (nothing to show, or every cue unusable); warnings are shown so a
 * person can decide (overlaps, long lines, fast reading, cues past the end).
 */
export function checkCaptions(format: CaptionFormat, cues: Cue[], durationMs?: number | null): CaptionReport {
  const issues: CaptionIssue[] = [];
  const add = (level: CaptionIssue['level'], code: string, message: string, count?: number, cue?: number) => issues.push({ level, code, message, ...(count != null ? { count } : {}), ...(cue != null ? { cue } : {}) });
  if (!cues.length) add('error', 'empty', `No cues could be read from this ${format.toUpperCase()} file.`);
  let bad = 0, firstBad = -1, overlaps = 0, firstOverlap = -1, longLines = 0, fast = 0, past = 0, blank = 0;
  cues.forEach((c, i) => {
    if (!(c.endMs > c.startMs)) { bad++; if (firstBad < 0) firstBad = i + 1; }
    if (!c.text.trim()) blank++;
    if (i > 0 && c.startMs < cues[i - 1].endMs - 40) { overlaps++; if (firstOverlap < 0) firstOverlap = i + 1; }
    const plain = c.text.replace(/<[^>]+>/g, '');
    if (plain.split('\n').some((l) => [...l].length > 42)) longLines++;
    const secs = (c.endMs - c.startMs) / 1000;
    if (secs > 0 && [...plain.replace(/\s+/g, ' ')].length / secs > 20) fast++;
    if (durationMs && c.startMs >= durationMs) past++;
  });
  if (bad) add(bad === cues.length ? 'error' : 'warning', 'timing', `${bad} cue${bad === 1 ? ' ends' : 's end'} before ${bad === 1 ? 'it starts' : 'they start'} (first: cue ${firstBad}); ${bad === 1 ? 'it is' : 'they are'} left out.`, bad, firstBad);
  if (blank) add('warning', 'blank', `${blank} cue${blank === 1 ? ' has' : 's have'} no text; left out.`, blank);
  if (overlaps) add('warning', 'overlap', `${overlaps} cue${overlaps === 1 ? ' overlaps' : 's overlap'} the one before (first: cue ${firstOverlap}). Players show both at once.`, overlaps, firstOverlap);
  if (longLines) add('warning', 'line-length', `${longLines} cue${longLines === 1 ? ' has a line' : 's have lines'} longer than 42 characters; may wrap on phones.`, longLines);
  if (fast) add('warning', 'reading-speed', `${fast} cue${fast === 1 ? ' is' : 's are'} faster than 20 characters a second to read.`, fast);
  if (past) add('warning', 'past-end', `${past} cue${past === 1 ? ' starts' : 's start'} after the asset ends (${clock(durationMs!)}). Is this the right file, or is it timed from a different start?`, past);
  if (cues.length && durationMs && cues[0].startMs > 3_600_000 && cues[0].startMs > durationMs) {
    add('warning', 'offset', `The first cue is at ${clock(cues[0].startMs)}: the file looks timed to a timecode (for example from 10:00:00:00). Set an offset when assigning it.`);
  }
  const good = cues.filter((c) => c.endMs > c.startMs && c.text.trim());
  return {
    format, cues: good.length, firstMs: good[0]?.startMs ?? null, lastMs: good.length ? Math.max(...good.map((c) => c.endMs)) : null,
    chars: good.reduce((n, c) => n + c.text.length, 0), issues, ok: !issues.some((x) => x.level === 'error'),
  };
}

const pad = (n: number, w = 2) => String(Math.floor(n)).padStart(w, '0');
/** 01:02:03.004 */
export function vttTime(ms: number): string {
  const v = Math.max(0, Math.round(ms));
  return `${pad(v / 3_600_000)}:${pad((v / 60_000) % 60)}:${pad((v / 1000) % 60)}.${pad(v % 1000, 3)}`;
}
const clock = (ms: number) => vttTime(ms).replace(/\.\d+$/, '');

/**
 * The clean WebVTT for a track: usable cues only, shifted by `offsetMs`
 * (negative to bring a file timed from 10:00:00 back to 0), with an optional
 * X-TIMESTAMP-MAP line for HLS (delivery.ts decides the value).
 */
export function toVtt(cues: Cue[], opts: { offsetMs?: number; timestampMap?: string | null } = {}): string {
  const off = opts.offsetMs ?? 0;
  const out = ['WEBVTT'];
  if (opts.timestampMap) out.push(opts.timestampMap);
  out.push('');
  let n = 0;
  for (const c of cues) {
    const s = c.startMs + off, e = c.endMs + off;
    if (!(e > s) || e <= 0 || !c.text.trim()) continue;
    n++;
    out.push(String(n), `${vttTime(Math.max(0, s))} --> ${vttTime(e)}${c.settings ? ` ${c.settings}` : ''}`, c.text.replace(/\n{2,}/g, '\n').replace(/-->/g, '→'), '');
  }
  return out.join('\n');
}

// ---------------------------------------------------------------- metadata sidecars

export type Flat = Record<string, string | string[]>;

/** A sidecar as path -> value. Nested JSON and XML keep their path ("episode.title"); repeated values become lists. */
export function parseSidecar(format: SidecarFormat, text: string): Flat {
  const t = stripBom(text);
  if (format === 'json') return flattenJson(JSON.parse(t));
  if (format === 'xml') return flattenXml(t);
  return flattenTable(t, format === 'tsv' ? '\t' : detectDelimiter(t));
}

function flattenJson(v: any, prefix = '', out: Flat = {}): Flat {
  if (v == null) return out;
  if (Array.isArray(v)) {
    if (v.every((x) => x == null || typeof x !== 'object')) { const vals = v.filter((x) => x != null && x !== '').map(String); if (vals.length) put(out, prefix || 'value', vals); return out; }
    v.forEach((x) => flattenJson(x, prefix, out));     // a list of objects: their fields, merged as lists
    return out;
  }
  if (typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) flattenJson(x, prefix ? `${prefix}.${k}` : k, out);
    return out;
  }
  if (String(v) !== '') put(out, prefix || 'value', String(v));
  return out;
}

function put(out: Flat, k: string, v: string | string[]) {
  const prev = out[k];
  if (prev == null) { out[k] = v; return; }
  out[k] = [...(Array.isArray(prev) ? prev : [prev]), ...(Array.isArray(v) ? v : [v])];
}

const unxml = (s: string) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, '\'')
  .replace(/&#x([0-9a-f]+);/gi, (_x, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_x, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, '&');

/**
 * XML to path -> value: element text leaves (namespace prefixes dropped, so
 * dc:title is "title"), and attributes as "element@attr". The root element is
 * not part of the path. Good for NFO, Dublin Core, simple NewsML, partner XML.
 */
function flattenXml(xml: string): Flat {
  const out: Flat = {};
  const s = xml.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_x, c: string) => c.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')).replace(/<\?[\s\S]*?\?>/g, '').replace(/<!--[\s\S]*?-->/g, '').replace(/<!DOCTYPE[^>]*>/gi, '');
  const path: string[] = [];
  const texts: string[] = [];
  const re = /<(\/?)([A-Za-z_][\w.:-]*)([^>]*?)(\/?)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    if (m[5] !== undefined) { if (path.length) texts[path.length - 1] = (texts[path.length - 1] ?? '') + m[5]; continue; }
    const local = m[2].replace(/^[\w-]+:/, '');
    if (m[1] === '/') {
      const t = unxml((texts[path.length - 1] ?? '').trim());
      const key = path.slice(1).join('.');
      if (t && key) put(out, key, t);
      texts.length = path.length - 1;
      path.pop();
      continue;
    }
    path.push(local);
    texts[path.length - 1] = '';
    for (const a of m[3].matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)) {
      if (/^xmlns/.test(a[1])) continue;
      const key = `${path.slice(1).join('.') || local}@${a[1].replace(/^[\w-]+:/, '')}`;
      if (a[2]) put(out, key, unxml(a[2]));
    }
    if (m[4] === '/') { path.pop(); texts.length = path.length; }
  }
  return out;
}

function detectDelimiter(t: string): string {
  const first = t.split(/\r?\n/)[0] ?? '';
  return (first.match(/;/g)?.length ?? 0) > (first.match(/,/g)?.length ?? 0) ? ';' : ',';
}

function splitRow(line: string, d: string): string[] {
  const out: string[] = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
    else if (ch === '"') q = true; else if (ch === d) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim());
}

/**
 * Two table shapes: "field,value" rows (a header of key/field/name + value is
 * optional), or a header row with ONE data row (a spreadsheet export).
 */
function flattenTable(t: string, d: string): Flat {
  const rows = t.split(/\r?\n/).filter((l) => l.trim()).map((l) => splitRow(l, d));
  const out: Flat = {};
  if (!rows.length) return out;
  const head = rows[0].map((h) => h.toLowerCase());
  const pairs = rows.every((r) => r.length <= 3) && (rows.length > 2 || /^(key|field|name|property)$/.test(head[0] ?? ''));
  if (pairs) {
    const body = /^(key|field|name|property)$/.test(head[0] ?? '') && /^(value|val)$/.test(head[1] ?? '') ? rows.slice(1) : rows;
    for (const r of body) if (r[0] && r[1]) put(out, r[0], r[1]);
    return out;
  }
  const data = rows[1] ?? [];
  rows[0].forEach((h, i) => { if (h && data[i]) put(out, h, data[i]); });
  return out;
}

// ---------------------------------------------------------------- matching fields

export interface FieldDef { key: string; label?: string; type?: string; options?: string[]; multiple?: boolean }
export interface Proposal { field: string; label: string; value: any; from: string; current: any; changes: boolean }

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Names a sidecar uses for a field, by field key (normalised). */
const SYNONYMS: Record<string, string[]> = {
  title: ['title', 'name', 'programmetitle', 'programtitle', 'episodetitle', 'headline', 'originaltitle'],
  description: ['description', 'synopsis', 'summary', 'plot', 'outline', 'longdescription', 'abstract', 'shortdescription', 'teaser'],
  keywords: ['keywords', 'tags', 'tag', 'subject', 'keyword'],
  tags: ['tags', 'keywords', 'tag', 'keyword'],
  genre: ['genre', 'genres', 'category', 'categories'],
  season: ['season', 'seasonnumber', 'seriesnumber'],
  episode: ['episode', 'episodenumber', 'episodeno'],
  series: ['series', 'show', 'showtitle', 'seriestitle', 'programme', 'program', 'brand'],
  released: ['released', 'releasedate', 'premiered', 'airdate', 'aired', 'broadcastdate', 'date', 'firstaired', 'year'],
  date: ['date', 'airdate', 'broadcastdate', 'released', 'created'],
  rating: ['rating', 'mpaa', 'certification', 'classification', 'contentrating', 'parentalrating'],
  language: ['language', 'lang', 'audiolanguage', 'originallanguage'],
  credits: ['credits', 'cast', 'actor', 'actors', 'director', 'directors'],
  director: ['director', 'directors'],
  cast: ['cast', 'actor', 'actors', 'actorname'],
  copyright: ['copyright', 'rights', 'licence', 'license'],
  artist: ['artist', 'performer', 'artistname'],
  album: ['album', 'release'],
  isrc: ['isrc'],
  label: ['label', 'recordlabel', 'publisher'],
  presenter: ['presenter', 'host', 'hosts', 'anchor'],
  location: ['location', 'place', 'city', 'venue'],
  externalid: ['id', 'externalid', 'houseid', 'materialid', 'assetid', 'guid', 'uid'],
};

/**
 * Which sidecar values fill which fields. A field matches a path whose last
 * part is its key, its label, or one of its synonyms; an exact key match wins
 * over a label, a label over a synonym, a short path over a deep one. Values
 * are shaped to the field: numbers, booleans, dates, an enum's own option
 * (any case), lists for multiple fields (split on ; | or ,).
 */
export function matchFields(flat: Flat, fields: FieldDef[], current: Record<string, any> = {}): { proposals: Proposal[]; unmatched: string[] } {
  const paths = Object.keys(flat);
  const used = new Set<string>();
  const proposals: Proposal[] = [];
  for (const f of fields) {
    if (f.type === 'image') continue;
    const keyN = norm(f.key), labelN = f.label ? norm(f.label) : '';
    // Synonyms both ways: the field's own list, and any list that names the field
    // (episodeNumber / "Episode number" is in episode's list, so <episode> fills it).
    const syn = new Set<string>();
    for (const [k, list] of Object.entries(SYNONYMS)) if (k === keyN || k === labelN || list.includes(keyN) || (labelN && list.includes(labelN))) { syn.add(k); list.forEach((x) => syn.add(x)); }
    let best: { path: string; score: number } | null = null;
    for (const p of paths) {
      const parts = p.split('.');
      const last = norm(parts[parts.length - 1].replace(/@/g, ''));
      const lastAttr = p.includes('@') ? norm(p.split('@').pop()!) : '';
      let score = 0;
      if (norm(p) === keyN) score = 100;
      else if (last === keyN || lastAttr === keyN) score = 90;
      else if (labelN && (last === labelN || norm(p) === labelN)) score = 80;
      else if (syn.has(last)) score = 60 - [...syn].indexOf(last);
      if (!score) continue;
      score -= parts.length;                                   // shallower paths first
      if (used.has(p)) score -= 30;
      if (!best || score > best.score) best = { path: p, score };
    }
    if (!best) continue;
    const value = shape(flat[best.path], f);
    if (value === undefined) continue;
    used.add(best.path);
    const cur = current[f.key];
    proposals.push({ field: f.key, label: f.label ?? f.key, value, from: best.path, current: cur ?? null, changes: JSON.stringify(cur ?? null) !== JSON.stringify(value) });
  }
  return { proposals, unmatched: paths.filter((p) => !used.has(p)) };
}

function shape(raw: string | string[], f: FieldDef): any {
  const list = (Array.isArray(raw) ? raw : [raw]).flatMap((v) => (f.multiple ? v.split(/\s*[;|]\s*|\s*,\s*(?=\S)/) : [v])).map((v) => v.trim()).filter(Boolean);
  if (!list.length) return undefined;
  const one = (v: string): any => {
    switch (f.type) {
      case 'number': case 'integer': { const n = Number(v.replace(/[^\d.-]/g, '')); return Number.isFinite(n) && /\d/.test(v) ? (f.type === 'integer' ? Math.round(n) : n) : undefined; }
      case 'boolean': return /^(1|true|yes|y|on)$/i.test(v) ? true : /^(0|false|no|n|off)$/i.test(v) ? false : undefined;
      case 'date': { const d = /^\d{4}$/.test(v) ? `${v}-01-01` : v; const t = Date.parse(d); return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : undefined; }
      case 'datetime': { const t = Date.parse(v); return Number.isFinite(t) ? new Date(t).toISOString() : undefined; }
      case 'enum': return f.options?.find((o) => o.toLowerCase() === v.toLowerCase());
      default: return v;
    }
  };
  if (f.multiple) { const vals = [...new Set(list.map(one).filter((x) => x !== undefined))]; return vals.length ? vals : undefined; }
  return one(f.type === 'string' || f.type === 'text' || !f.type ? (Array.isArray(raw) ? raw.join(f.type === 'text' ? '\n' : ', ') : raw) : list[0]);
}
