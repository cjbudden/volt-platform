// ============================================================================
//  XMLTV IMPORT RUNS: bytes in (an upload or a URL), programmes out.
//
//  The reading and mapping rules live in services/xmltvParse.ts. This file is
//  the run: open the input (gzip or not, UTF-8 or Latin-1), stream it through
//  the parser, record the channels it names, map them to ours, resolve each
//  mapped channel's programmes in that channel's own time zone, write them as
//  an idempotent upsert, remove what the file no longer contains inside the
//  window it covers, and say exactly what happened.
//
//  WHAT A RUN NEVER DOES
//   - guess a channel. A channel id nobody has mapped is recorded (so it can be
//     mapped in the console) and its programmes are skipped and counted. Auto
//     mapping only takes a match that is unambiguous: our XMLTV id equal to
//     theirs, or exactly one channel with the same name.
//   - delete history it did not write, or anything with a clip cut from it.
//   - reject a file for overlaps. Their guide, their overlaps: they are counted
//     and shown, and the EPG conflict view is where they get fixed.
// ============================================================================
import { Readable } from 'node:stream';
import { TextDecoder } from 'node:util';
import { createGunzip } from 'node:zlib';
import { query, one } from '../db';
import { open as openSealed } from './social/crypto';
import { planRequests, retryDelayMinutes, daysAheadOf, type PlannedRequest } from './xmltvRequests';
import { XmlStream, mapChannel, mapProgramme, resolveChannel, parseXmltvTime, type XmltvChannelIn, type XmltvProgrammeIn } from './xmltvParse';

const DAY = 86_400_000;
const MAX_BYTES = 2 * 1024 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 180_000;
const MAX_FUTURE_DAYS = 400;

export interface ImportCounts {
  bytes: number;
  channelsInFile: number;
  programmesInFile: number;
  mappedChannels: number;
  unmappedChannels: number;
  skippedUnmapped: number;
  droppedOld: number;
  droppedFar: number;
  badTime: number;
  noEnd: number;
  inserted: number;
  updated: number;
  unchanged: number;
  removed: number;
  overlaps: number;
  /** 1 when a scheduled run was answered 304: the guide had not changed. */
  notModified?: number;
}

export class ImportError extends Error {}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => '\\' + c);
export const sourceRefPrefix = (sourceId: string, external: string) => `xmltv:${sourceId}:${external}:`;

/** Headers the API needs (an API key, say), stored sealed. */
export function sourceHeaders(src: any): Record<string, string> {
  if (!src.request_headers) return {};
  try { return JSON.parse(openSealed(src.request_headers) ?? '{}'); } catch { return {}; }
}

interface Fetched { body: Readable | null; notModified: boolean; etag: string | null; lastModified: string | null }

/** Fetch one guide request. A 304 comes back as notModified with no body. */
async function fetchGuide(url: string, headers: Record<string, string>, conditional: { etag?: string | null; lastModified?: string | null } | null): Promise<Fetched> {
  let u: URL;
  try { u = new URL(url); } catch { throw new ImportError('The source URL is not a valid URL.'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new ImportError('The source URL must be http or https.');
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  const h: Record<string, string> = { 'user-agent': 'Volt-XMLTV-Import/1.0', accept: 'application/xml, text/xml, application/gzip, */*', ...headers };
  if (conditional?.etag) h['if-none-match'] = conditional.etag;
  if (conditional?.lastModified) h['if-modified-since'] = conditional.lastModified;
  let r: Response;
  try {
    r = await fetch(u, { signal: ac.signal, headers: h });
  } catch (e: any) {
    clearTimeout(t);
    throw new ImportError(`Could not fetch the guide: ${e?.name === 'AbortError' ? 'timed out' : e?.cause?.code ?? e?.message ?? e}`);
  }
  if (r.status === 304) { clearTimeout(t); return { body: null, notModified: true, etag: r.headers.get('etag'), lastModified: r.headers.get('last-modified') }; }
  if (!r.ok || !r.body) {
    clearTimeout(t);
    // APIs explain themselves in the body ("invalid api key"): keep a little of it.
    let said = '';
    try { said = (await r.text()).replace(/\s+/g, ' ').trim().slice(0, 200); } catch { /* no body */ }
    throw new ImportError(`The guide URL answered ${r.status} ${r.statusText}`.trim() + (said ? `: ${said}` : ''));
  }
  const body = Readable.fromWeb(r.body as any);
  body.once('end', () => clearTimeout(t));
  body.once('error', () => clearTimeout(t));
  return { body, notModified: false, etag: r.headers.get('etag'), lastModified: r.headers.get('last-modified') };
}

/** Bytes -> text chunks, un-gzipping and picking the declared encoding. */
async function* textChunks(input: Readable, onBytes: (n: number) => void): AsyncGenerator<string> {
  const it = input[Symbol.asyncIterator]();
  const first = await it.next();
  if (first.done) return;
  const head: Buffer = Buffer.from(first.value);
  async function* raw() { yield head; for (;;) { const n = await it.next(); if (n.done) return; yield Buffer.from(n.value); } }
  let src: AsyncIterable<Buffer> = raw();
  if (head[0] === 0x1f && head[1] === 0x8b) src = Readable.from(raw()).pipe(createGunzip());
  let total = 0;
  let decoder: TextDecoder | null = null;
  for await (const chunk of src) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += b.length; onBytes(total);
    if (total > MAX_BYTES) throw new ImportError('The guide is larger than 2 GB: split it, or import a shorter window.');
    if (!decoder) {
      const decl = /<\?xml[^>]*encoding\s*=\s*["']([^"']+)["']/i.exec(b.subarray(0, 200).toString('latin1'))?.[1]?.toLowerCase() ?? 'utf-8';
      const enc = /^(iso-8859-1|latin1|latin-1|windows-1252|cp1252|us-ascii|ascii)$/.test(decl) ? 'windows-1252' : decl === 'utf-8' || decl === 'utf8' ? 'utf-8' : decl;
      try { decoder = new TextDecoder(enc); } catch { throw new ImportError(`The file declares an encoding we cannot read: ${decl}`); }
    }
    yield decoder.decode(b, { stream: true });
  }
  if (decoder) { const tail = decoder.decode(); if (tail) yield tail; }
}

/** Claim a source for a run, so two ticks (or a tick and a click) cannot run it at once. */
export async function claimSource(sourceId: string): Promise<boolean> {
  const r = await one(
    `UPDATE epg_import_sources SET running_since = now()
      WHERE id = $1 AND (running_since IS NULL OR running_since < now() - interval '1 hour') RETURNING id`, [sourceId]);
  return !!r;
}

export interface RunResult { runId: string; status: string; counts: ImportCounts; warnings: string[]; error?: string; coverage?: Coverage | null }

export async function runImport(sourceId: string, trigger: 'schedule' | 'manual' | 'upload', upload: Readable | null = null): Promise<RunResult> {
  const src = await one<any>(`SELECT * FROM epg_import_sources WHERE id = $1`, [sourceId]);
  if (!src) throw new ImportError('Import source not found');
  const run = await one<any>(`INSERT INTO epg_import_runs(source_id, trigger) VALUES ($1, $2) RETURNING id`, [sourceId, trigger]);
  const counts: ImportCounts = { bytes: 0, channelsInFile: 0, programmesInFile: 0, mappedChannels: 0, unmappedChannels: 0, skippedUnmapped: 0,
    droppedOld: 0, droppedFar: 0, badTime: 0, noEnd: 0, inserted: 0, updated: 0, unchanged: 0, removed: 0, overlaps: 0 };
  const warnings: string[] = [];
  let validators: { etag: string | null; lastModified: string | null; url: string } | null = null;
  try {
    const now = Date.now();
    const oldest = now - (src.keep_past_days + 1) * DAY;   // +1 day margin before zones are known

    // ---- what to read: the uploaded body, or the requests the source's URL makes today
    let plan: PlannedRequest[];
    let windowEnd: number;
    if (upload) {
      plan = [{ url: '', day: null, from: new Date(oldest), to: new Date(now + MAX_FUTURE_DAYS * DAY) }];
      windowEnd = now + MAX_FUTURE_DAYS * DAY;
    } else {
      if (src.kind !== 'url' || !src.url) throw new ImportError('This source takes uploaded files: upload one to run it.');
      const p = planRequests({ template: src.url, mode: src.request_mode, daysAhead: src.days_ahead, dateFormat: src.date_format, zone: src.fallback_tz, now: new Date(now) });
      plan = p.requests; windowEnd = p.windowEnd.getTime();
    }
    const headers = upload ? {} : sourceHeaders(src);
    // An unchanged single-request guide answers 304 to a scheduled run. Manual
    // runs always read the whole thing (a mapping may have changed since).
    const conditional = !upload && trigger === 'schedule' && src.request_mode === 'single' && src.conditional_url === plan[0].url
      ? { etag: src.etag, lastModified: src.last_modified } : null;

    const channels = new Map<string, XmltvChannelIn>();
    const progs = new Map<string, XmltvProgrammeIn[]>();
    const spans: { from: number; to: number }[] = [];   // the parts of the window this run actually read
    const failedDays: string[] = [];
    let firstError: string | null = null;
    let notModified = false;
    for (const req of plan) {
      let input: Readable;
      try {
        if (upload) input = upload;
        else {
          const f = await fetchGuide(req.url, headers, conditional);
          if (src.request_mode === 'single') validators = { etag: f.etag, lastModified: f.lastModified, url: req.url };
          if (f.notModified) { notModified = true; break; }
          input = f.body!;
        }
        let rootOk = false;
        const xml = new XmlStream(new Set(['channel', 'programme']), (n) => {
          if (n.name === 'channel') {
            const c = mapChannel(n);
            if (c.id) channels.set(c.id, c);
            return;
          }
          counts.programmesInFile++;
          const p = mapProgramme(n, src.lang);
          if (!p) { counts.badTime++; return; }
          const rough = parseXmltvTime(p.startRaw, 'UTC');
          if (!rough) { counts.badTime++; return; }
          if (rough.getTime() < oldest && (!p.stopRaw || (parseXmltvTime(p.stopRaw, 'UTC')?.getTime() ?? 0) < oldest)) { counts.droppedOld++; return; }
          if (rough.getTime() >= windowEnd + DAY) { counts.droppedFar++; return; }   // exact cut after zones are known
          let list = progs.get(p.channel);
          if (!list) { list = []; progs.set(p.channel, list); }
          list.push(p);
        }, () => { rootOk = true; });
        const before = counts.bytes;
        for await (const t of textChunks(input, (n) => { counts.bytes = before + n; })) xml.write(t);
        xml.end();
        if (!rootOk) throw new ImportError('The file is empty or is not XML.');
        // One request (or an upload) covers everything it lists; a day request covers its day.
        spans.push(req.day ? { from: req.from.getTime(), to: req.to.getTime() } : { from: -Infinity, to: Infinity });
      } catch (e: any) {
        // One request per day: a day that fails is reported and its part of the
        // guide left alone. Anything else (one request, an upload) fails the run.
        if (!req.day) throw e;
        const msg = e instanceof ImportError ? e.message : String(e?.message ?? e);
        firstError ??= msg;
        failedDays.push(req.day);
        warnings.push(`${req.day}: ${msg}`);
      }
    }
    if (failedDays.length && failedDays.length === plan.length) throw new ImportError(`Every day failed. ${firstError}`);
    if (failedDays.length) warnings.unshift(`${failedDays.length} of ${plan.length} day(s) could not be fetched; the guide for those days was left as it was.`);

    if (notModified) {
      // Nothing to read: the guide is as it was. Coverage is still checked below.
      warnings.length = 0;
      counts.notModified = 1;
    } else {
      counts.channelsInFile = channels.size;
      if (!channels.size && !progs.size) throw new ImportError('No <channel> or <programme> elements: this does not look like an XMLTV file.');
      await writeProgrammes(src, channels, progs, spans, upload ? null : windowEnd, now, counts, warnings);
    }

    const coverage = await checkCoverage(src, warnings);
    const status = warnings.length ? 'warnings' : 'ok';
    await finish(src, run.id, status, counts, warnings, null, validators, trigger);
    return { runId: run.id, status, counts, warnings, coverage };
  } catch (e: any) {
    const msg = e instanceof ImportError ? e.message : `Import failed: ${e?.message ?? e}`;
    const coverage = await checkCoverage(src, warnings).catch(() => null);
    await finish(src, run.id, 'failed', counts, warnings, msg, null, trigger);
    // Alert on the first failure of a run of them, not on every retry.
    if (!src.consecutive_failures) {
      const { notifyAccountAdmins } = await import('./notifications');
      await notifyAccountAdmins(src.account_id, 'epg.import_failed', `EPG import "${src.name}" failed`,
        `${msg}\n\nThe programmes already in the guide were left as they were.${src.kind === 'url' && src.refresh_hours ? ' Volt will keep retrying, sooner than the normal refresh, and will not alert again until it has worked.' : ''} Open EPG > XMLTV import to see the run.`,
        { sourceId: src.id, runId: run.id });
    }
    return { runId: run.id, status: 'failed', counts, warnings, error: msg, coverage };
  }
}

/** Channels recorded, mapped, and their programmes written as a diff inside the spans this run read. */
async function writeProgrammes(src: any, channels: Map<string, XmltvChannelIn>, progs: Map<string, XmltvProgrammeIn[]>,
  spans: { from: number; to: number }[], windowEnd: number | null, now: number, counts: ImportCounts, warnings: string[]) {
  // ---- record every channel the file names (declared or only referenced)
  const ids = new Set([...channels.keys(), ...progs.keys()]);
  for (const id of ids) {
    const c = channels.get(id);
    await query(
      `INSERT INTO epg_channel_aliases(account_id, source_id, external_id, display_name, icon, last_seen_at)
       VALUES ($1,$2,$3,$4,$5, now())
       ON CONFLICT (source_id, external_id) DO UPDATE SET display_name = COALESCE(EXCLUDED.display_name, epg_channel_aliases.display_name),
             icon = COALESCE(EXCLUDED.icon, epg_channel_aliases.icon), last_seen_at = now()`,
      [src.account_id, src.id, id, c?.displayNames[0] ?? null, c?.icon ?? null]);
  }

  // ---- unambiguous auto-mapping for the ones nobody has mapped yet
  if (src.auto_map) {
    const unmapped = await query<any>(`SELECT id, external_id FROM epg_channel_aliases WHERE source_id = $1 AND channel_id IS NULL`, [src.id]);
    for (const a of unmapped) {
      const names = (channels.get(a.external_id)?.displayNames ?? []).map((n) => n.toLowerCase());
      const byId = await query<any>(
        `SELECT c.id FROM channels c JOIN groups g ON g.id = c.group_id WHERE g.account_id = $1 AND lower(c.xmltv_id) = lower($2)`,
        [src.account_id, a.external_id]);
      let target: string | null = null, how = '';
      if (byId.length === 1) { target = byId[0].id; how = 'auto:xmltv_id'; }
      else if (names.length) {
        const byName = await query<any>(
          `SELECT c.id FROM channels c JOIN groups g ON g.id = c.group_id WHERE g.account_id = $1 AND lower(c.name) = ANY($2::text[])`,
          [src.account_id, names]);
        if (byName.length === 1) { target = byName[0].id; how = 'auto:name'; }
      }
      if (target) await query(`UPDATE epg_channel_aliases SET channel_id = $2, mapped_by = $3 WHERE id = $1`, [a.id, target, how]);
    }
  }

  // ---- write each mapped channel
  const aliases = await query<any>(
    `SELECT a.external_id, a.channel_id, c.tz FROM epg_channel_aliases a LEFT JOIN channels c ON c.id = a.channel_id
      WHERE a.source_id = $1 AND a.external_id = ANY($2::text[])`, [src.id, [...ids]]);
  const unmappedIds: string[] = [];
  for (const a of aliases) {
    const list = progs.get(a.external_id) ?? [];
    if (!a.channel_id) { unmappedIds.push(a.external_id); counts.skippedUnmapped += list.length; continue; }
    counts.mappedChannels++;
    const zone = a.tz || src.fallback_tz || null;
    const res = resolveChannel(list, zone);
    counts.badTime += res.badTime; counts.noEnd += res.noEnd;
    let keep = res.ok.filter((p) => p.endsAt.getTime() > now - src.keep_past_days * DAY);
    counts.droppedOld += res.ok.length - keep.length;
    if (windowEnd != null) {
      const inWindow = keep.filter((p) => p.startsAt.getTime() < windowEnd);
      counts.droppedFar += keep.length - inWindow.length;
      keep = inWindow;
    }
    const prefix = sourceRefPrefix(src.id, a.external_id);
    const byRef = new Map<string, typeof keep[number]>();
    for (const p of keep) byRef.set(prefix + p.startsAt.toISOString(), p);
    const refs = [...byRef.keys()];
    for (let i = 0; i < refs.length; i += 1000) {
      const slice = refs.slice(i, i + 1000);
      const rows = slice.map((r) => byRef.get(r)!);
      const out = await query<any>(
        `WITH x AS (
           SELECT * FROM unnest($2::text[], $3::timestamptz[], $4::timestamptz[], $5::text[], $6::text[]) AS t(title, s, e, md, ref)
         )
         INSERT INTO programmes(channel_id, title, starts_at, ends_at, metadata, source_ref)
         SELECT $1, title, s, e, md::jsonb, ref FROM x
         ON CONFLICT (channel_id, source_ref) WHERE source_ref IS NOT NULL
         DO UPDATE SET title = EXCLUDED.title, starts_at = EXCLUDED.starts_at, ends_at = EXCLUDED.ends_at,
                       metadata = EXCLUDED.metadata, updated_at = now()
           WHERE (programmes.title, programmes.starts_at, programmes.ends_at, programmes.metadata)
                 IS DISTINCT FROM (EXCLUDED.title, EXCLUDED.starts_at, EXCLUDED.ends_at, EXCLUDED.metadata)
         RETURNING (xmax = 0) AS inserted`,
        [a.channel_id, rows.map((r) => r.title), rows.map((r) => r.startsAt.toISOString()), rows.map((r) => r.endsAt.toISOString()),
         rows.map((r) => JSON.stringify(r.metadata)), slice]);
      const ins = out.filter((r) => r.inserted).length;
      counts.inserted += ins; counts.updated += out.length - ins; counts.unchanged += slice.length - out.length;
    }
    // The diff: inside each part of the window this run read, what the guide no
    // longer lists goes. With one request per day, a day that failed is not a
    // part that was read, so nothing in it is removed.
    for (const sp of spans) {
      const inSpan = keep.filter((p) => p.startsAt.getTime() >= sp.from && p.startsAt.getTime() < sp.to);
      if (!inSpan.length) continue;
      const from = new Date(Math.min(...inSpan.map((p) => p.startsAt.getTime())));
      const to = new Date(Math.max(...inSpan.map((p) => p.endsAt.getTime())));
      const gone = await query<any>(
        `DELETE FROM programmes WHERE channel_id = $1 AND source_ref LIKE $2 ESCAPE '\\'
            AND starts_at >= $3 AND starts_at < $4 AND NOT (source_ref = ANY($5::text[]))
            AND clip_status = 'none' AND clip_asset_id IS NULL
          RETURNING id`, [a.channel_id, escapeLike(prefix) + '%', from.toISOString(), to.toISOString(), refs]);
      counts.removed += gone.length;
    }
    if (keep.length) {
      const from = new Date(Math.min(...keep.map((p) => p.startsAt.getTime())));
      const to = new Date(Math.max(...keep.map((p) => p.endsAt.getTime())));
      const ov = await one<any>(
        `SELECT count(*)::int AS n FROM programmes x JOIN programmes y
            ON x.channel_id = y.channel_id AND x.id < y.id AND x.span && y.span
          WHERE x.channel_id = $1 AND x.span && tstzrange($2, $3, '[)')`, [a.channel_id, from.toISOString(), to.toISOString()]);
      counts.overlaps += ov?.n ?? 0;
    }
    await query(`UPDATE epg_channel_aliases SET last_programmes = $3 WHERE source_id = $1 AND external_id = $2`, [src.id, a.external_id, keep.length]);
  }
  counts.unmappedChannels = unmappedIds.length;
  if (unmappedIds.length) warnings.push(`${unmappedIds.length} channel(s) in the file are not mapped to a Volt channel, so their ${counts.skippedUnmapped} programme(s) were skipped: ${unmappedIds.slice(0, 8).join(', ')}${unmappedIds.length > 8 ? '…' : ''}`);
  if (counts.badTime) warnings.push(`${counts.badTime} programme(s) had a start time, title or channel we could not read and were skipped.`);
  if (counts.noEnd) warnings.push(`${counts.noEnd} programme(s) had no stop, no length and nothing after them, so their end is unknown and they were skipped.`);
  if (counts.overlaps) warnings.push(`${counts.overlaps} overlapping pair(s) in the imported window. They are kept: see the conflicts view in the EPG builder.`);
  if (!counts.mappedChannels && ids.size) warnings.push('No channel in the file is mapped yet. Map them under Channels in this source, then run it again.');
}

export interface Coverage {
  /** The earliest point any mapped channel's imported guide ends. */
  until: string | null;
  daysAhead: number | null;
  minDaysAhead: number;
  short: { externalId: string; channel: string; until: string | null; daysAhead: number | null }[];
}

/** A hole longer than this ends the guide's coverage: an overnight close-down is not a hole, a missing day is. */
export const COVERAGE_GAP_HOURS = 12;

/**
 * Per mapped channel, how far ahead this source's guide reaches CONTINUOUSLY:
 * from now, programme after programme, up to the first hole longer than
 * COVERAGE_GAP_HOURS (or the last programme). A guide with day 7 but not days
 * 5 and 6 reaches day 5, not day 8. Null when nothing is imported from now on.
 */
export async function coverageOf(src: any): Promise<{ externalId: string; channelId: string; channel: string; until: Date | null }[]> {
  return (await query<any>(
    `SELECT a.external_id, a.channel_id, c.name, cov.until
       FROM epg_channel_aliases a JOIN channels c ON c.id = a.channel_id
       LEFT JOIN LATERAL (
         WITH p AS (
           SELECT starts_at, ends_at,
                  COALESCE(max(ends_at) OVER (ORDER BY starts_at, ends_at ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), now()) AS reached
             FROM programmes
            WHERE channel_id = a.channel_id AND ends_at > now()
              AND left(source_ref, length('xmltv:' || a.source_id || ':' || a.external_id || ':')) = 'xmltv:' || a.source_id || ':' || a.external_id || ':'
         )
         SELECT CASE WHEN count(*) = 0 THEN NULL
                     ELSE COALESCE(min(reached) FILTER (WHERE starts_at - reached > make_interval(hours => $2)), max(ends_at)) END AS until
           FROM p
       ) cov ON true
      WHERE a.source_id = $1 ORDER BY c.name`, [src.id, COVERAGE_GAP_HOURS]))
    .map((r) => ({ externalId: r.external_id, channelId: r.channel_id, channel: r.name, until: r.until ? new Date(r.until) : null }));
}

/**
 * After every run of a URL source: is the guide still at least min_days_ahead
 * ahead on every mapped channel? Short is a warning on the run, and owners and
 * admins are alerted once when it first drops short (again only after it has
 * recovered).
 */
async function checkCoverage(src: any, warnings: string[]): Promise<Coverage | null> {
  const rows = await coverageOf(src);
  if (!rows.length) { await query(`UPDATE epg_import_sources SET coverage_until = NULL WHERE id = $1`, [src.id]); return null; }
  const now = new Date();
  const until = rows.reduce<Date | null>((m, r) => { const u = r.until ?? now; return !m || u < m ? u : m; }, null);
  const floor = now.getTime() + src.min_days_ahead * DAY;
  const watched = src.kind === 'url' && src.min_days_ahead > 0;
  const short = watched ? rows.filter((r) => !r.until || r.until.getTime() < floor) : [];
  const cov: Coverage = {
    until: until?.toISOString() ?? null, daysAhead: daysAheadOf(until, now), minDaysAhead: src.min_days_ahead,
    short: short.map((r) => ({ externalId: r.externalId, channel: r.channel, until: r.until?.toISOString() ?? null, daysAhead: daysAheadOf(r.until, now) })),
  };
  if (short.length) {
    const names = short.slice(0, 6).map((r) => `${r.channel} (${r.until ? `${daysAheadOf(r.until, now)} days` : 'nothing'})`).join(', ');
    warnings.push(`The guide is short of the ${src.min_days_ahead} days ahead this source should keep on ${short.length} channel(s): ${names}${short.length > 6 ? '…' : ''}.`);
  }
  const wasLow = !!src.coverage_low_since;
  await query(`UPDATE epg_import_sources SET coverage_until = $2,
                      coverage_low_since = CASE WHEN $3::boolean THEN COALESCE(coverage_low_since, now()) ELSE NULL END WHERE id = $1`,
    [src.id, cov.until, short.length > 0]);
  if (short.length && !wasLow) {
    const { notifyAccountAdmins } = await import('./notifications');
    await notifyAccountAdmins(src.account_id, 'epg.coverage_low', `EPG "${src.name}" is running short`,
      `The guide from "${src.name}" no longer reaches ${src.min_days_ahead} days ahead on ${short.length} channel(s): ` +
      `${short.map((r) => `${r.channel} (${r.until ? `ends ${r.until.toISOString().slice(0, 16).replace('T', ' ')} UTC` : 'no programmes'})`).join(', ')}.\n\n` +
      `Check that the provider is still publishing, and the source's URL and days ahead under EPG > XMLTV import.`,
      { sourceId: src.id, coverageUntil: cov.until });
  }
  return cov;
}

async function finish(src: any, runId: string, status: string, counts: ImportCounts, warnings: string[], error: string | null,
  validators: { etag: string | null; lastModified: string | null; url: string } | null, trigger: string) {
  await query(`UPDATE epg_import_runs SET finished_at = now(), status = $2, counts = $3::jsonb, warnings = $4::jsonb, error = $5 WHERE id = $1`,
    [runId, status, JSON.stringify(counts), JSON.stringify(warnings), error]);
  const failed = status === 'failed';
  const failures = failed ? (src.consecutive_failures ?? 0) + 1 : 0;
  // A failed run of a scheduled source tries again sooner than its refresh
  // (15 min, 30, 60 ...), so a provider's blip does not cost a whole day.
  const nextMinutes = src.kind === 'url' && src.refresh_hours
    ? (failed ? retryDelayMinutes(failures, src.refresh_hours) : src.refresh_hours * 60) : null;
  await query(
    `UPDATE epg_import_sources SET running_since = NULL, last_run_at = now(), last_status = $2, last_error = $3,
            next_run_at = CASE WHEN $4::int IS NULL OR NOT enabled THEN NULL ELSE now() + make_interval(mins => $4::int) END,
            consecutive_failures = $5,
            etag = CASE WHEN $6::boolean THEN $7 ELSE etag END,
            last_modified = CASE WHEN $6::boolean THEN $8 ELSE last_modified END,
            conditional_url = CASE WHEN $6::boolean THEN $9 ELSE conditional_url END,
            updated_at = now()
      WHERE id = $1`,
    [src.id, status, error, nextMinutes, failures, !!validators && !failed, validators?.etag ?? null, validators?.lastModified ?? null, validators?.url ?? null]);
  void trigger;
}

/** Orchestrator tick: run URL sources whose refresh (or retry) is due, one at a time. */
export async function runDueImports(limit = 2): Promise<number> {
  const due = await query<any>(
    `SELECT id FROM epg_import_sources WHERE enabled AND kind = 'url' AND next_run_at IS NOT NULL AND next_run_at <= now()
       AND (running_since IS NULL OR running_since < now() - interval '1 hour')
     ORDER BY next_run_at LIMIT $1`, [limit]);
  let n = 0;
  for (const s of due) {
    if (!(await claimSource(s.id))) continue;
    await runImport(s.id, 'schedule');
    n++;
  }
  return n;
}

/**
 * Try a source without writing anything: fetch its first request (today's,
 * with one request per day), read it, and say what is in it and how far
 * ahead it reaches. For setting up a guide API before switching it on.
 */
export async function testSource(src: any): Promise<{
  requests: { url: string; day: string | null }[]; tried: string; status: 'ok' | 'failed'; error?: string;
  bytes?: number; channels?: number; programmes?: number; firstStart?: string | null; lastEnd?: string | null; daysAhead?: number | null;
  sampleChannels?: { id: string; name: string | null }[];
}> {
  if (src.kind !== 'url' || !src.url) throw new ImportError('Only a URL source can be tried.');
  const now = new Date();
  const p = planRequests({ template: src.url, mode: src.request_mode, daysAhead: src.days_ahead, dateFormat: src.date_format, zone: src.fallback_tz, now });
  const requests = p.requests.map((r) => ({ url: r.url, day: r.day }));
  const req = p.requests[0];
  try {
    const f = await fetchGuide(req.url, sourceHeaders(src), null);
    const chans: { id: string; name: string | null }[] = [];
    let programmes = 0, first: number | null = null, last: number | null = null, bytes = 0, rootOk = false;
    const xml = new XmlStream(new Set(['channel', 'programme']), (n) => {
      if (n.name === 'channel') { const c = mapChannel(n); if (c.id) chans.push({ id: c.id, name: c.displayNames[0] ?? null }); return; }
      programmes++;
      const m = mapProgramme(n, src.lang);
      const s = m && parseXmltvTime(m.startRaw, src.fallback_tz || 'UTC');
      const e = m?.stopRaw ? parseXmltvTime(m.stopRaw, src.fallback_tz || 'UTC') : s;
      if (s) first = Math.min(first ?? s.getTime(), s.getTime());
      if (e) last = Math.max(last ?? e.getTime(), e.getTime());
    }, () => { rootOk = true; });
    for await (const t of textChunks(f.body!, (n) => { bytes = n; })) xml.write(t);
    xml.end();
    if (!rootOk) throw new ImportError('The response is empty or is not XML.');
    if (!chans.length && !programmes) throw new ImportError('No <channel> or <programme> elements: the response does not look like XMLTV.');
    return { requests, tried: req.url, status: 'ok', bytes, channels: chans.length, programmes,
      firstStart: first != null ? new Date(first).toISOString() : null, lastEnd: last != null ? new Date(last).toISOString() : null,
      daysAhead: last != null ? daysAheadOf(new Date(last), now) : null, sampleChannels: chans.slice(0, 12) };
  } catch (e: any) {
    return { requests, tried: req.url, status: 'failed', error: e instanceof ImportError ? e.message : String(e?.message ?? e) };
  }
}
