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
}

export class ImportError extends Error {}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => '\\' + c);
export const sourceRefPrefix = (sourceId: string, external: string) => `xmltv:${sourceId}:${external}:`;

/** The input as a stream of bytes: an uploaded body, or the source's URL. */
async function openInput(src: any, upload: Readable | null): Promise<Readable> {
  if (upload) return upload;
  if (src.kind !== 'url' || !src.url) throw new ImportError('This source takes uploaded files: upload one to run it.');
  let u: URL;
  try { u = new URL(src.url); } catch { throw new ImportError('The source URL is not a valid URL.'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new ImportError('The source URL must be http or https.');
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  let r: Response;
  try {
    r = await fetch(u, { signal: ac.signal, headers: { 'user-agent': 'Volt-XMLTV-Import/1.0', accept: 'application/xml, text/xml, application/gzip, */*' } });
  } catch (e: any) {
    clearTimeout(t);
    throw new ImportError(`Could not fetch the guide: ${e?.name === 'AbortError' ? 'timed out' : e?.message ?? e}`);
  }
  if (!r.ok || !r.body) { clearTimeout(t); throw new ImportError(`The guide URL answered ${r.status} ${r.statusText}`.trim()); }
  const body = Readable.fromWeb(r.body as any);
  body.once('end', () => clearTimeout(t));
  body.once('error', () => clearTimeout(t));
  return body;
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

export async function runImport(sourceId: string, trigger: 'schedule' | 'manual' | 'upload', upload: Readable | null = null): Promise<{ runId: string; status: string; counts: ImportCounts; warnings: string[]; error?: string }> {
  const src = await one<any>(`SELECT * FROM epg_import_sources WHERE id = $1`, [sourceId]);
  if (!src) throw new ImportError('Import source not found');
  const run = await one<any>(`INSERT INTO epg_import_runs(source_id, trigger) VALUES ($1, $2) RETURNING id`, [sourceId, trigger]);
  const counts: ImportCounts = { bytes: 0, channelsInFile: 0, programmesInFile: 0, mappedChannels: 0, unmappedChannels: 0, skippedUnmapped: 0,
    droppedOld: 0, droppedFar: 0, badTime: 0, noEnd: 0, inserted: 0, updated: 0, unchanged: 0, removed: 0, overlaps: 0 };
  const warnings: string[] = [];
  try {
    const input = await openInput(src, upload);
    const now = Date.now();
    const oldest = now - (src.keep_past_days + 1) * DAY;   // +1 day margin before zones are known
    const newest = now + MAX_FUTURE_DAYS * DAY;
    const channels = new Map<string, XmltvChannelIn>();
    const progs = new Map<string, XmltvProgrammeIn[]>();
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
      if (rough.getTime() > newest) { counts.droppedFar++; return; }
      let list = progs.get(p.channel);
      if (!list) { list = []; progs.set(p.channel, list); }
      list.push(p);
    }, () => { rootOk = true; });
    for await (const t of textChunks(input, (n) => { counts.bytes = n; })) xml.write(t);
    xml.end();
    if (!rootOk) throw new ImportError('The file is empty or is not XML.');
    counts.channelsInFile = channels.size;
    if (!channels.size && !progs.size) throw new ImportError('No <channel> or <programme> elements: this does not look like an XMLTV file.');

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
      const keep = res.ok.filter((p) => p.endsAt.getTime() > now - src.keep_past_days * DAY);
      counts.droppedOld += res.ok.length - keep.length;
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
      // the diff: inside the span this file covers for this channel, what it no longer lists goes
      if (keep.length) {
        const from = new Date(Math.min(...keep.map((p) => p.startsAt.getTime())));
        const to = new Date(Math.max(...keep.map((p) => p.endsAt.getTime())));
        const gone = await query<any>(
          `DELETE FROM programmes WHERE channel_id = $1 AND source_ref LIKE $2 ESCAPE '\\'
              AND starts_at >= $3 AND starts_at < $4 AND NOT (source_ref = ANY($5::text[]))
              AND clip_status = 'none' AND clip_asset_id IS NULL
            RETURNING id`, [a.channel_id, escapeLike(prefix) + '%', from.toISOString(), to.toISOString(), refs]);
        counts.removed += gone.length;
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

    const status = warnings.length ? 'warnings' : 'ok';
    await finish(src, run.id, status, counts, warnings, null);
    return { runId: run.id, status, counts, warnings };
  } catch (e: any) {
    const msg = e instanceof ImportError ? e.message : `Import failed: ${e?.message ?? e}`;
    await finish(src, run.id, 'failed', counts, warnings, msg);
    const { notifyAccountAdmins } = await import('./notifications');
    await notifyAccountAdmins(src.account_id, 'epg.import_failed', `EPG import "${src.name}" failed`,
      `${msg}\n\nThe programmes already in the guide were left as they were. Open EPG > XMLTV import to see the run.`,
      { sourceId: src.id, runId: run.id });
    return { runId: run.id, status: 'failed', counts, warnings, error: msg };
  }
}

async function finish(src: any, runId: string, status: string, counts: ImportCounts, warnings: string[], error: string | null) {
  await query(`UPDATE epg_import_runs SET finished_at = now(), status = $2, counts = $3::jsonb, warnings = $4::jsonb, error = $5 WHERE id = $1`,
    [runId, status, JSON.stringify(counts), JSON.stringify(warnings), error]);
  await query(
    `UPDATE epg_import_sources SET running_since = NULL, last_run_at = now(), last_status = $2, last_error = $3,
            next_run_at = CASE WHEN kind = 'url' AND refresh_hours IS NOT NULL THEN now() + make_interval(hours => refresh_hours) ELSE NULL END,
            updated_at = now()
      WHERE id = $1`, [src.id, status, error]);
}

/** Orchestrator tick: run URL sources whose refresh is due, one at a time. */
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
