// ============================================================================
//  XMLTV OUT: the guide in the format the guide world already reads.
//
//  Pure: no database, no request. modules/xmltv.ts loads the rows and streams
//  what this builds, so every rule about the FORMAT is pinned here and tested
//  without Postgres (test/xmltv-pure.check.ts validates the output against the
//  real xmltv.dtd).
//
//  RULES the output keeps, each because a real consumer breaks without it:
//   - ELEMENT ORDER follows the DTD exactly. XMLTV is order-sensitive and
//     tv_validate_file, Jellyfin, TVHeadend and most IPTV middleware either
//     reject or silently drop a programme whose children are out of order.
//   - TIMES carry an explicit offset ("20261010090000 +1000"), never a bare
//     local time. A consumer that has to guess the zone shifts the whole guide.
//     The offset is computed per instant, so a programme either side of a DST
//     change gets the right one.
//   - CHANNEL IDS are the operator's `xmltv_id` when set, else our UUID. The
//     UUID is stable but ugly; partners want "volt1.example.com" and that is
//     configurable per channel. Programmes reference the same id.
//   - TEXT is escaped and stripped of the control characters XML 1.0 forbids.
//     One stray \u0007 pasted from a provider's feed makes the whole document
//     unparseable, which is a guide outage for every consumer at once.
//   - TIME BASIS is explicit. `scheduled` (the forward guide) or `asrun` (the
//     observed airing, for a catch-up guide). Never a default nobody can see:
//     the caller states it, and the document says which in a comment.
// ============================================================================

export type TimeBasis = 'scheduled' | 'asrun';
export type TzMode = 'local' | 'utc';

export interface XmltvChannel {
  /** The id written into the document (xmltv_id or uuid). */
  xmltvId: string;
  displayNames: string[];
  /** Absolute icon URL, or null. */
  icon?: string | null;
  url?: string | null;
  /** IANA zone the channel's times are expressed in when tzMode = local. */
  tz?: string | null;
  medium: 'tv' | 'radio' | 'event';
  lang?: string | null;
}

export interface XmltvProgrammeRow {
  title: string;
  starts_at: string | Date;
  ends_at: string | Date;
  actual_start?: string | Date | null;
  actual_end?: string | Date | null;
  status?: string | null;
  metadata?: Record<string, any> | null;
}

export interface BuildOptions {
  timeBasis: TimeBasis;
  tzMode: TzMode;
  /** Default lang attribute for text elements when the programme names none. */
  lang?: string;
  /** Turns a programme icon reference (store key or URL) into an absolute URL. */
  resolveIcon?: (ref: string) => string | null;
  generatedAt?: Date;
  generatorUrl?: string;
  sourceName?: string;
}

// ---------------------------------------------------------------- escaping

// XML 1.0 allows #x9 | #xA | #xD | [#x20-#xD7FF] | [#xE000-#xFFFD] | [#x10000-#x10FFFF].
// eslint-disable-next-line no-control-regex
const INVALID_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export function xmlText(v: unknown): string {
  return String(v ?? '')
    .replace(INVALID_XML, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
export function xmlAttr(v: unknown): string {
  return xmlText(v).replace(/"/g, '&quot;').replace(/'/g, '&apos;').replace(/\r?\n/g, '&#10;');
}

// ---------------------------------------------------------------- time

const offsetFmt = new Map<string, Intl.DateTimeFormat>();

/** Minutes east of UTC for `zone` at instant `d`. Unknown zone -> 0 (UTC). */
export function zoneOffsetMinutes(d: Date, zone: string | null | undefined): number {
  if (!zone || zone === 'UTC' || zone === 'Etc/UTC') return 0;
  let f = offsetFmt.get(zone);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' });
    } catch {
      return 0;
    }
    offsetFmt.set(zone, f);
  }
  const part = f.formatToParts(d).find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
  const m = part.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/);
  if (!m) return 0;
  const mins = Number(m[2]) * 60 + Number(m[3] ?? 0);
  return m[1] === '-' ? -mins : mins;
}

const p2 = (n: number) => String(n).padStart(2, '0');

/** XMLTV timestamp: "YYYYMMDDhhmmss +hhmm" in the given zone. */
export function xmltvTime(at: Date | string, zone: string | null | undefined): string {
  const d = at instanceof Date ? at : new Date(at);
  const off = zoneOffsetMinutes(d, zone);
  const l = new Date(d.getTime() + off * 60_000);
  const sign = off < 0 ? '-' : '+';
  const a = Math.abs(off);
  return (
    `${l.getUTCFullYear()}${p2(l.getUTCMonth() + 1)}${p2(l.getUTCDate())}` +
    `${p2(l.getUTCHours())}${p2(l.getUTCMinutes())}${p2(l.getUTCSeconds())} ` +
    `${sign}${p2(Math.floor(a / 60))}${p2(a % 60)}`
  );
}

/** The interval a programme is listed at, by time basis. */
export function listedSpan(p: XmltvProgrammeRow, basis: TimeBasis): { start: Date; stop: Date } {
  const s = new Date(p.starts_at);
  const e = new Date(p.ends_at);
  if (basis === 'asrun') {
    const as = p.actual_start ? new Date(p.actual_start) : s;
    const ae = p.actual_end ? new Date(p.actual_end) : e;
    if (ae.getTime() > as.getTime()) return { start: as, stop: ae };
  }
  return { start: s, stop: e };
}

// ---------------------------------------------------------------- metadata

const list = (v: unknown): string[] =>
  (Array.isArray(v) ? v : v == null || v === '' ? [] : typeof v === 'string' ? v.split(/\s*[,;]\s*/) : [v])
    .map((x: any) => (x && typeof x === 'object' && 'name' in x ? String(x.name) : String(x)).trim())
    .filter(Boolean);
const first = (m: Record<string, any>, ...keys: string[]): string | null => {
  for (const k of keys) {
    const v = m[k];
    if (v != null && v !== '' && !(Array.isArray(v) && !v.length)) return Array.isArray(v) ? String(v[0]) : String(v);
  }
  return null;
};
/** An RFC 1766-style language code, or null for anything that is not one. */
export function langCode(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(t) ? t : null;
}
const truthyFlag = (v: unknown) => v === true || v === 'true' || v === 'yes' || v === 1;
const uniq = (a: string[]) => [...new Set(a)];

/** Roles the DTD knows, in its order. Anything else is carried as a guest. */
const CREDIT_ORDER = ['director', 'actor', 'writer', 'adapter', 'producer', 'composer', 'editor', 'presenter', 'commentator', 'guest'] as const;

export interface Credit { role: string; name: string; character?: string }

function creditsFrom(m: Record<string, any>): Credit[] {
  const out: Credit[] = [];
  const raw = m.credits;
  if (Array.isArray(raw)) {
    for (const c of raw) if (c && c.name) out.push({ role: String(c.role ?? 'guest').toLowerCase(), name: String(c.name), character: c.character ? String(c.character) : undefined });
  } else if (raw && typeof raw === 'object') {
    // { presenter: ['A','B'], director: 'C' }
    for (const [role, names] of Object.entries(raw)) for (const n of list(names)) out.push({ role: role.toLowerCase(), name: n });
  }
  // Content-type mapping writes `credits.<role>` slots flat on the metadata.
  for (const [k, v] of Object.entries(m)) {
    const mm = k.match(/^credits\.(\w+)$/);
    if (mm) for (const n of list(v)) out.push({ role: mm[1].toLowerCase(), name: n });
  }
  return out;
}

/**
 * Episode numbering. XMLTV's xmltv_ns is ZERO-based ("S2E5" is "1.4."), which
 * is the mistake every hand-written exporter makes once; onscreen is the
 * human form and is emitted alongside it.
 */
export function episodeNums(m: Record<string, any>): { system: string; value: string }[] {
  const out: { system: string; value: string }[] = [];
  const season = Number(m.season ?? m.seasonNumber ?? m.partOfSeason);
  const episode = Number(m.episodeNumber ?? m.episode_number ?? (typeof m.episode === 'number' ? m.episode : NaN));
  const totalEp = Number(m.episodeCount ?? m.numberOfEpisodes);
  if (Number.isFinite(season) || Number.isFinite(episode)) {
    const s = Number.isFinite(season) && season > 0 ? String(season - 1) : '';
    const e = Number.isFinite(episode) && episode > 0
      ? `${episode - 1}${Number.isFinite(totalEp) && totalEp > 0 ? `/${totalEp}` : ''}`
      : '';
    if (s || e) out.push({ system: 'xmltv_ns', value: `${s}.${e}.` });
    const on = `${Number.isFinite(season) && season > 0 ? `S${season}` : ''}${Number.isFinite(episode) && episode > 0 ? `E${episode}` : ''}`;
    if (on) out.push({ system: 'onscreen', value: on });
  } else if (typeof m.episode === 'string' && m.episode.trim()) {
    out.push({ system: 'onscreen', value: m.episode.trim() });
  }
  if (typeof m.dd_progid === 'string' && m.dd_progid) out.push({ system: 'dd_progid', value: m.dd_progid });
  return out;
}

// ---------------------------------------------------------------- elements

export function channelXml(c: XmltvChannel, lang?: string): string {
  const l = langCode(c.lang) ?? langCode(lang);
  const la = l ? ` lang="${xmlAttr(l)}"` : '';
  const names = uniq(c.displayNames.filter(Boolean));
  let x = `  <channel id="${xmlAttr(c.xmltvId)}">\n`;
  for (const n of names.length ? names : [c.xmltvId]) x += `    <display-name${la}>${xmlText(n)}</display-name>\n`;
  if (c.icon) x += `    <icon src="${xmlAttr(c.icon)}"/>\n`;
  if (c.url) x += `    <url>${xmlText(c.url)}</url>\n`;
  x += `  </channel>\n`;
  return x;
}

export function programmeXml(p: XmltvProgrammeRow, ch: XmltvChannel, o: BuildOptions): string {
  const m = (p.metadata ?? {}) as Record<string, any>;
  const zone = o.tzMode === 'utc' ? 'UTC' : ch.tz;
  const { start, stop } = listedSpan(p, o.timeBasis);
  // <language> carries whatever the operator wrote ("English" is fine there);
  // the lang ATTRIBUTE must be an RFC 1766 code or consumers mis-key the text.
  const lang = first(m, 'language', 'inLanguage') ?? ch.lang ?? null;
  const code = langCode(lang) ?? langCode(o.lang);
  const la = code ? ` lang="${xmlAttr(code)}"` : '';
  const el = (name: string, body: string, attrs = '') => `    <${name}${attrs}>${xmlText(body)}</${name}>\n`;

  let x = `  <programme start="${xmltvTime(start, zone)}" stop="${xmltvTime(stop, zone)}" channel="${xmlAttr(ch.xmltvId)}">\n`;
  x += el('title', p.title, la);
  const sub = first(m, 'subTitle', 'sub_title', 'subtitle', 'episodeTitle');
  if (sub) x += el('sub-title', sub, la);
  const desc = first(m, 'description', 'desc', 'synopsis');
  if (desc) x += el('desc', desc, la);

  const credits = creditsFrom(m);
  if (credits.length) {
    x += `    <credits>\n`;
    for (const role of CREDIT_ORDER) {
      for (const c of credits.filter((k) => (CREDIT_ORDER as readonly string[]).includes(k.role) ? k.role === role : role === 'guest')) {
        const r = role === 'actor' && c.character ? ` role="${xmlAttr(c.character)}"` : '';
        x += `      <${role}${r}>${xmlText(c.name)}</${role}>\n`;
      }
    }
    x += `    </credits>\n`;
  }

  const date = first(m, 'date', 'productionYear', 'year', 'dateCreated');
  if (date) {
    const d = String(date).replace(/[^0-9]/g, '').slice(0, 8);
    if (d.length >= 4) x += `    <date>${d}</date>\n`;
  }
  for (const c of uniq([...list(m.genre), ...list(m.category), ...list(m.categories)])) x += el('category', c, la);
  for (const k of uniq(list(m.tags ?? m.keywords))) x += el('keyword', k, la);
  if (lang) x += el('language', lang);
  const icon = first(m, 'icon', 'image', 'thumbnail');
  const iconUrl = icon ? (o.resolveIcon ? o.resolveIcon(icon) : /^https?:\/\//.test(icon) ? icon : null) : null;
  if (iconUrl) x += `    <icon src="${xmlAttr(iconUrl)}"/>\n`;
  const url = first(m, 'url', 'website');
  if (url && /^https?:\/\//.test(url)) x += el('url', url);
  for (const c of uniq(list(m.country ?? m.countryOfOrigin))) x += el('country', c);
  for (const e of episodeNums(m)) x += el('episode-num', e.value, ` system="${xmlAttr(e.system)}"`);
  if (ch.medium === 'radio') {
    x += `    <video>\n      <present>no</present>\n    </video>\n`;
  }
  if (truthyFlag(m.previouslyShown) || truthyFlag(m.repeat)) x += `    <previously-shown/>\n`;
  if (truthyFlag(m.premiere)) x += `    <premiere/>\n`;
  if (truthyFlag(m.lastChance)) x += `    <last-chance/>\n`;
  if (truthyFlag(m.isNew) || truthyFlag(m.new)) x += `    <new/>\n`;
  if (truthyFlag(m.subtitles) || truthyFlag(m.captions)) x += `    <subtitles type="teletext"/>\n`;
  const rating = first(m, 'rating', 'contentRating');
  if (rating) {
    const sys = first(m, 'ratingSystem', 'rating_system');
    x += `    <rating${sys ? ` system="${xmlAttr(sys)}"` : ''}>\n      <value>${xmlText(rating)}</value>\n    </rating>\n`;
  }
  const stars = first(m, 'starRating', 'star_rating');
  if (stars && /^\d+(\.\d+)?\/\d+$/.test(stars)) x += `    <star-rating>\n      <value>${xmlText(stars)}</value>\n    </star-rating>\n`;
  x += `  </programme>\n`;
  return x;
}

export function documentHead(o: BuildOptions, note?: string): string {
  const at = o.generatedAt ?? new Date();
  const attrs = [
    `date="${xmltvTime(at, 'UTC')}"`,
    `source-info-name="${xmlAttr(o.sourceName ?? 'Volt Stream')}"`,
    `generator-info-name="Volt Stream XMLTV export"`,
    o.generatorUrl ? `generator-info-url="${xmlAttr(o.generatorUrl)}"` : '',
  ].filter(Boolean).join(' ');
  const safeNote = note ? String(note).replace(INVALID_XML, '').replace(/-{2,}/g, '-').replace(/-$/, '') : '';
  const comment = `<!-- times: ${o.timeBasis === 'asrun' ? 'as-run (observed airing where recorded, scheduled otherwise)' : 'scheduled'}; zone: ${o.tzMode === 'utc' ? 'UTC' : 'channel local'}${safeNote ? `; ${safeNote}` : ''} -->`;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE tv SYSTEM "xmltv.dtd">\n${comment}\n<tv ${attrs}>\n`;
}
export const DOCUMENT_TAIL = `</tv>\n`;

/** Whole document in memory: for tests and small exports. The route streams. */
export function buildXmltv(
  channels: XmltvChannel[],
  programmes: { channel: XmltvChannel; row: XmltvProgrammeRow }[],
  o: BuildOptions,
): string {
  let x = documentHead(o);
  for (const c of channels) x += channelXml(c, o.lang);
  for (const p of programmes) x += programmeXml(p.row, p.channel, o);
  return x + DOCUMENT_TAIL;
}

/** Operator-chosen XMLTV channel ids: RFC2838-ish, safe in an attribute and a URL. */
export const XMLTV_ID_RX = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
