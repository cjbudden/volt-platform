// ============================================================================
//  XMLTV IN: a streaming reader and the mapping onto our programme shape.
//
//  Pure, no database. modules/xmltvImport.ts feeds it bytes from an upload or
//  a URL and writes what it yields.
//
//  WHY A HAND-WRITTEN STREAMING READER. A year of a 200-channel guide is
//  hundreds of megabytes; a DOM parse holds all of it at once. XMLTV is plain,
//  regular XML (elements, attributes, text, the five entities and numeric
//  references, CDATA, comments, a DOCTYPE), so a small push tokenizer handles
//  it in constant memory per element and needs no dependency. Anything it does
//  not understand (a processing instruction, an unknown element) is skipped,
//  never fatal: one odd element must not cost a customer their whole guide.
//
//  RULES THE MAPPING KEEPS
//   - TIMES. "20261010183000 +1000" is exact. A time with NO offset is resolved
//     in the channel's own zone (or the source's fallback zone), never assumed
//     UTC, or the whole guide silently shifts by the zone offset. Partial times
//     ("202610101830", "20261010") are accepted, as the format allows.
//   - EPISODE NUMBERS. xmltv_ns is ZERO-based: "1.4." is season 2, episode 5.
//   - STOP IS OPTIONAL. Where it is missing the end is the next programme's
//     start on the same channel, else start + <length>; the last entry of a
//     file with neither is reported, not invented.
// ============================================================================
import { zoneOffsetMinutes } from './xmltv';

// ---------------------------------------------------------------- tokenizer

export interface XmlNode { name: string; attrs: Record<string, string>; children: XmlNode[]; text: string }

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
export function decodeEntities(s: string): string {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return Number.isFinite(n) ? String.fromCodePoint(n) : m; } catch { return m; }
    }
    return ENT[e] ?? m;
  });
}

function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([^\s=/]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out[m[1]] = decodeEntities(m[3] ?? m[4] ?? '');
  return out;
}

/**
 * Push tokenizer. Feed it text chunks; it calls onElement for every complete
 * element whose name is in `emit` (with its whole subtree), and onRootAttrs
 * once for the root element's attributes. Elements outside `emit` that are
 * not inside an emitted one are discarded as they close, so memory is bounded
 * by the largest single <channel> or <programme>.
 */
export class XmlStream {
  private buf = '';
  private stack: XmlNode[] = [];
  private depthOfEmit = -1;
  private rootSeen = false;
  constructor(
    private emit: Set<string>,
    private onElement: (n: XmlNode) => void,
    private onRootAttrs?: (a: Record<string, string>) => void,
  ) {}

  write(chunk: string) {
    this.buf += chunk;
    this.drain(false);
  }
  end() {
    this.drain(true);
    if (this.depthOfEmit >= 0) throw new Error('The file ended in the middle of an element: it may be truncated.');
  }

  private text(t: string) {
    if (this.depthOfEmit < 0 || !t) return;
    const top = this.stack[this.stack.length - 1];
    if (top) top.text += t;
  }

  private drain(final: boolean) {
    let i = 0;
    const b = this.buf;
    for (;;) {
      const lt = b.indexOf('<', i);
      // No tag yet: keep the text until one arrives, so an entity split across
      // two chunks ("&am" + "p;") is decoded whole.
      if (lt < 0) { if (final) { this.text(decodeEntities(b.slice(i))); i = b.length; } break; }
      if (lt > i) this.text(decodeEntities(b.slice(i, lt)));
      i = lt;
      if (b.startsWith('<!--', i)) {
        const e = b.indexOf('-->', i + 4); if (e < 0) break; i = e + 3; continue;
      }
      if (b.startsWith('<![CDATA[', i)) {
        const e = b.indexOf(']]>', i + 9); if (e < 0) break; this.text(b.slice(i + 9, e)); i = e + 3; continue;
      }
      if (b.startsWith('<!', i)) {
        // DOCTYPE (possibly with an internal subset in [ ... ])
        let e = b.indexOf('>', i); const br = b.indexOf('[', i);
        if (br >= 0 && (e < 0 || br < e)) { const cl = b.indexOf(']>', br); if (cl < 0) break; e = cl + 1; }
        if (e < 0) break; i = e + 1; continue;
      }
      if (b.startsWith('<?', i)) {
        const e = b.indexOf('?>', i); if (e < 0) break; i = e + 2; continue;
      }
      // a tag: find its end, respecting quoted attribute values
      let j = i + 1, q = '';
      for (; j < b.length; j++) {
        const c = b[j];
        if (q) { if (c === q) q = ''; }
        else if (c === '"' || c === "'") q = c;
        else if (c === '>') break;
      }
      if (j >= b.length) break;
      const tag = b.slice(i + 1, j);
      i = j + 1;
      if (tag[0] === '/') { this.close(tag.slice(1).trim()); continue; }
      const self = tag.endsWith('/');
      const body = self ? tag.slice(0, -1) : tag;
      const sp = body.search(/[\s]/);
      const name = (sp < 0 ? body : body.slice(0, sp)).trim();
      const attrs = sp < 0 ? {} : parseAttrs(body.slice(sp));
      this.open(name, attrs);
      if (self) this.close(name);
    }
    this.buf = b.slice(i);
    if (final && this.buf.trim()) throw new Error('The file ended with an incomplete tag: it may be truncated.');
    if (this.buf.length > 64 * 1024 * 1024) throw new Error('An element is larger than 64 MB: this does not look like XMLTV.');
  }

  private open(name: string, attrs: Record<string, string>) {
    if (!this.rootSeen) { this.rootSeen = true; this.onRootAttrs?.(attrs); this.stack.push({ name, attrs, children: [], text: '' }); return; }
    const node: XmlNode = { name, attrs, children: [], text: '' };
    if (this.depthOfEmit >= 0) this.stack[this.stack.length - 1].children.push(node);
    else if (this.emit.has(name)) this.depthOfEmit = this.stack.length;
    this.stack.push(node);
  }

  private close(name: string) {
    const node = this.stack.pop();
    if (!node) return;
    if (node.name !== name) throw new Error(`Mismatched tags: <${node.name}> closed by </${name}>.`);
    if (this.depthOfEmit === this.stack.length) {
      this.depthOfEmit = -1;
      this.onElement(node);
    }
  }
}

// ---------------------------------------------------------------- time

/**
 * Parse an XMLTV time. `zone` resolves times with no offset. Returns null for
 * anything unparseable rather than guessing.
 */
export function parseXmltvTime(s: string | undefined, zone: string | null): Date | null {
  if (!s) return null;
  const m = /^\s*(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?\s*(?:([+-])(\d{2}):?(\d{2})|(Z|UTC|GMT))?\s*$/i.exec(s);
  if (!m) return null;
  const [, Y, Mo = '01', D = '01', h = '00', mi = '00', se = '00', sign, oh, om, z] = m;
  const naive = Date.UTC(+Y, +Mo - 1, +D, +h, +mi, +se);
  if (!Number.isFinite(naive)) return null;
  if (sign) {
    const off = (+oh * 60 + +om) * (sign === '-' ? -1 : 1);
    return new Date(naive - off * 60_000);
  }
  if (z || !zone) return new Date(naive);
  // Local wall time in `zone`: find the instant whose local rendering is `naive`.
  // Two passes settle DST edges (the offset at the guess can differ from the
  // offset at the answer by the DST step).
  let t = naive - zoneOffsetMinutes(new Date(naive), zone) * 60_000;
  t = naive - zoneOffsetMinutes(new Date(t), zone) * 60_000;
  return new Date(t);
}

// ---------------------------------------------------------------- mapping

export interface XmltvChannelIn { id: string; displayNames: string[]; icon: string | null; url: string | null; lcn: string | null }

export interface XmltvProgrammeIn {
  channel: string;
  startRaw: string;
  stopRaw: string | null;
  title: string;
  lengthSec: number | null;
  metadata: Record<string, any>;
}

const kids = (n: XmlNode, name: string) => n.children.filter((c) => c.name === name);
const txt = (n?: XmlNode) => (n ? n.text.trim() : '');
function pickLang(nodes: XmlNode[], lang?: string | null): XmlNode | undefined {
  if (!nodes.length) return undefined;
  if (lang) {
    const l = lang.toLowerCase();
    const hit = nodes.find((n) => (n.attrs.lang ?? '').toLowerCase() === l) ?? nodes.find((n) => (n.attrs.lang ?? '').toLowerCase().startsWith(l.split('-')[0]));
    if (hit) return hit;
  }
  return nodes[0];
}

export function mapChannel(n: XmlNode): XmltvChannelIn {
  return {
    id: n.attrs.id ?? '',
    displayNames: kids(n, 'display-name').map(txt).filter(Boolean),
    icon: kids(n, 'icon')[0]?.attrs.src ?? null,
    url: txt(kids(n, 'url')[0]) || null,
    // <lcn> is not in the DTD but common (xmltv.net, Australian and UK feeds):
    // the channel NUMBER, often the only thing telling same-named channels apart.
    lcn: txt(kids(n, 'lcn')[0]) || null,
  };
}

/** xmltv_ns "S.E/T.P/T" (zero based) -> human numbers. */
export function parseXmltvNs(v: string): { season?: number; episodeNumber?: number; episodeCount?: number; part?: number } {
  const [s = '', e = '', p = ''] = v.replace(/\s+/g, '').split('.');
  const out: any = {};
  const sn = parseInt(s.split('/')[0], 10); if (Number.isFinite(sn)) out.season = sn + 1;
  const [en, et] = e.split('/');
  const epn = parseInt(en, 10); if (Number.isFinite(epn)) out.episodeNumber = epn + 1;
  const ect = parseInt(et, 10); if (Number.isFinite(ect)) out.episodeCount = ect;
  const pn = parseInt(p.split('/')[0], 10); if (Number.isFinite(pn)) out.part = pn + 1;
  return out;
}

const LENGTH_UNIT: Record<string, number> = { seconds: 1, minutes: 60, hours: 3600 };

export function mapProgramme(n: XmlNode, lang?: string | null): XmltvProgrammeIn | null {
  const channel = n.attrs.channel;
  const start = n.attrs.start;
  const titleNode = pickLang(kids(n, 'title'), lang);
  const title = txt(titleNode);
  if (!channel || !start || !title) return null;
  const md: Record<string, any> = {};
  const sub = txt(pickLang(kids(n, 'sub-title'), lang)); if (sub) md.subTitle = sub;
  const desc = txt(pickLang(kids(n, 'desc'), lang)); if (desc) md.description = desc;
  const cats = [...new Set(kids(n, 'category').map(txt).filter(Boolean))];
  if (cats.length) { md.genre = cats[0]; if (cats.length > 1) md.categories = cats; }
  const kw = [...new Set(kids(n, 'keyword').map(txt).filter(Boolean))]; if (kw.length) md.tags = kw;
  const langNode = txt(kids(n, 'language')[0]); if (langNode) md.language = langNode;
  const date = txt(kids(n, 'date')[0]); if (date) md.date = date;
  const country = kids(n, 'country').map(txt).filter(Boolean); if (country.length) md.country = country.length === 1 ? country[0] : country;
  const icon = kids(n, 'icon')[0]?.attrs.src; if (icon) md.icon = icon;
  const url = txt(kids(n, 'url')[0]); if (url) md.url = url;
  const credits = kids(n, 'credits')[0];
  if (credits) {
    const list = credits.children.filter((c) => txt(c)).map((c) => ({
      role: c.name, name: txt(c), ...(c.name === 'actor' && c.attrs.role ? { character: c.attrs.role } : {}),
    }));
    if (list.length) md.credits = list;
  }
  for (const e of kids(n, 'episode-num')) {
    const sys = (e.attrs.system ?? 'onscreen').toLowerCase();
    const v = txt(e);
    if (!v) continue;
    if (sys === 'xmltv_ns') Object.assign(md, parseXmltvNs(v));
    else if (sys === 'onscreen' && !md.episode) md.episode = v;
    else if (sys === 'dd_progid') md.dd_progid = v;
  }
  const rating = kids(n, 'rating')[0];
  if (rating) { const v = txt(kids(rating, 'value')[0]); if (v) { md.rating = v; if (rating.attrs.system) md.ratingSystem = rating.attrs.system; } }
  const star = txt(kids(kids(n, 'star-rating')[0] ?? { name: '', attrs: {}, children: [], text: '' }, 'value')[0]); if (star) md.starRating = star;
  if (kids(n, 'previously-shown').length) md.repeat = true;
  if (kids(n, 'premiere').length) md.premiere = true;
  if (kids(n, 'last-chance').length) md.lastChance = true;
  if (kids(n, 'new').length) md.isNew = true;
  if (kids(n, 'subtitles').length) md.subtitles = true;
  const video = kids(n, 'video')[0];
  if (video && txt(kids(video, 'present')[0]).toLowerCase() === 'no') md.audioOnly = true;
  let lengthSec: number | null = null;
  const len = kids(n, 'length')[0];
  if (len) { const v = parseFloat(txt(len)); const u = LENGTH_UNIT[(len.attrs.units ?? 'minutes').toLowerCase()]; if (Number.isFinite(v) && u) lengthSec = Math.round(v * u); }
  return { channel, startRaw: start, stopRaw: n.attrs.stop ?? null, title, lengthSec, metadata: md };
}

export interface ResolvedProgramme { channel: string; startsAt: Date; endsAt: Date; title: string; metadata: Record<string, any> }

/**
 * Resolve one channel's programmes to concrete spans: times parsed in `zone`,
 * a missing stop taken from the next start or the length. Returns the
 * programmes and what could not be resolved, so the run can report it.
 */
export function resolveChannel(progs: XmltvProgrammeIn[], zone: string | null): { ok: ResolvedProgramme[]; badTime: number; noEnd: number } {
  const parsed = progs
    .map((p) => ({ p, start: parseXmltvTime(p.startRaw, zone), stop: p.stopRaw ? parseXmltvTime(p.stopRaw, zone) : null }))
    .filter((x) => x.start);
  const badTime = progs.length - parsed.length;
  parsed.sort((a, b) => a.start!.getTime() - b.start!.getTime());
  const ok: ResolvedProgramme[] = [];
  let noEnd = 0;
  for (let i = 0; i < parsed.length; i++) {
    const { p, start } = parsed[i];
    let end = parsed[i].stop;
    if (!end || end <= start!) {
      const next = parsed.slice(i + 1).find((x) => x.start!.getTime() > start!.getTime());
      if (next) end = next.start;
      else if (p.lengthSec) end = new Date(start!.getTime() + p.lengthSec * 1000);
      else { noEnd++; continue; }
    }
    ok.push({ channel: p.channel, startsAt: start!, endsAt: end!, title: p.title, metadata: p.metadata });
  }
  return { ok, badTime, noEnd };
}
