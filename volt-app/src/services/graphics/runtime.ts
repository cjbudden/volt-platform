// ============================================================================
//  GRAPHICS AT RUN TIME: live state, take on / off, rundowns, feeds, the tick.
//
//  ONE STATE PER ASSIGNMENT. Live control, the API and data feeds all write the
//  same gfx_state row; every change goes to gfx_state_log with who, when, the
//  old and the new value (FR-9, FR-10). Readers (live control, the player feed,
//  the burn-in sidecar) resolve values through values.ts and the on/off
//  decision through schedule.ts, so they cannot disagree.
//
//  THE TICK (leader only, every second): polls the data sources that are due,
//  fires feed cues on change, takes graphics off when their time is up, and
//  fires due time / offset / repeat cues in event rundowns.
// ============================================================================
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { PoolClient } from 'pg';
import { one, query, tx } from '../../db';
import { conflict, badRequest, notFound } from '../../util/http';
import { genresOf, isOn, plan, type AssignmentRun, type Programme } from './schedule';
import { resolveValues, coerce, pick, type FeedState, type FieldBinding, type GuideNowNext } from './values';
import { dueAutomatic, feedFired, type Cue } from './rundown';
import { publishGfx, publishForSource, watchLive } from './livePush';

export interface Target { kind: 'channel' | 'event'; id: string; name: string; workflow: 'transcode' | 'package_only' | null; live: boolean; start: Date | null; end: Date | null }

/** The channel or event an assignment hangs off, scoped to the account. Radio is refused. */
export async function loadTarget(acct: string, t: { channelId?: string | null; eventId?: string | null }): Promise<Target> {
  if (t.channelId) {
    const r = await one<any>(
      `SELECT c.id, c.name, c.kind, c.status, op.workflow_type
         FROM channels c JOIN groups g ON g.id = c.group_id
         LEFT JOIN output_profiles op ON op.id = g.output_profile_id
        WHERE c.id = $1 AND g.account_id = $2`, [t.channelId, acct]);
    if (!r) throw notFound('No channel with that id in this account');
    if (r.kind === 'radio') throw badRequest('Graphics are for video. Radio stations have no picture to draw on.');
    return { kind: 'channel', id: r.id, name: r.name, workflow: r.workflow_type ?? null, live: r.status === 'live', start: null, end: null };
  }
  if (t.eventId) {
    const r = await one<any>(
      `SELECT e.id, e.name, e.status, e.actual_start, e.scheduled_start, e.scheduled_end, op.workflow_type
         FROM events e JOIN groups g ON g.id = e.group_id
         LEFT JOIN output_profiles op ON op.id = g.output_profile_id
        WHERE e.id = $1 AND g.account_id = $2`, [t.eventId, acct]);
    if (!r) throw notFound('No event with that id in this account');
    return { kind: 'event', id: r.id, name: r.name, workflow: r.workflow_type ?? null, live: r.status === 'live',
      start: r.actual_start ?? r.scheduled_start ?? null, end: r.scheduled_end ?? null };
  }
  throw badRequest('Give a channel_id or an event_id');
}

/** Burned output needs our encoder: package-only streams carry the source encoder's picture. */
export function assertTargetsAllowed(target: Target, targets: string): void {
  if ((targets === 'burn' || targets === 'both') && target.workflow === 'package_only') {
    throw badRequest(`${target.name} is packaging only, so its graphics come from the source encoder. Choose Player overlay.`);
  }
}

export async function guideFor(kind: 'channel' | 'event', id: string, from: Date, to: Date): Promise<Programme[]> {
  const rows = await query<any>(
    `SELECT id, title, starts_at, ends_at, metadata FROM programmes
      WHERE ${kind === 'channel' ? 'channel_id' : 'event_id'} = $1 AND status <> 'cancelled'
        AND starts_at < $3 AND ends_at > $2 AND COALESCE(metadata->>'source','') <> 'icy'
      ORDER BY starts_at LIMIT 2000`, [id, from, to]);
  return rows.map((r) => ({ id: r.id, title: r.title, startsAt: new Date(r.starts_at), endsAt: new Date(r.ends_at),
    kind: r.metadata?.kind ?? r.metadata?.class ?? 'content', genres: genresOf(r.metadata), subtitle: r.metadata?.subtitle ?? r.metadata?.episodeTitle ?? null } as any));
}

function nowNext(progs: (Programme & { subtitle?: string | null })[], at: Date): GuideNowNext {
  const content = progs.filter((p) => !['ad', 'filler', 'slate'].includes(String(p.kind ?? 'content').toLowerCase()));
  const now = content.find((p) => p.startsAt <= at && at < p.endsAt) ?? null;
  const next = content.find((p) => p.startsAt > at) ?? null;
  const m = (p: any) => p ? { title: p.title, subtitle: p.subtitle ?? null, startsAt: p.startsAt } : null;
  return { now: m(now), next: m(next) };
}

export async function feedStates(acct: string, ids: string[]): Promise<Map<string, FeedState>> {
  const map = new Map<string, FeedState>();
  if (!ids.length) return map;
  const rows = await query<any>(`SELECT id, kind, payload, last_ok_at, stale_after_sec, on_stale FROM gfx_data_sources WHERE account_id = $1 AND id = ANY($2::uuid[])`, [acct, ids]);
  for (const r of rows) {
    const age = r.last_ok_at ? Date.now() - new Date(r.last_ok_at).getTime() : Infinity;
    map.set(r.id, { payload: r.payload, stale: r.kind !== 'push' && age > r.stale_after_sec * 1000, onStale: r.on_stale });
  }
  return map;
}

export async function imageUrls(acct: string, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const clean = ids.filter((x) => /^[0-9a-f-]{36}$/i.test(x));
  if (!clean.length) return out;
  // An alpha video (metadata.motion, services/motionGraphics.ts) binds as its WebM; its
  // store_key is the first-frame PNG that thumbnails use.
  for (const r of await query<any>(`SELECT id, store_key, kind, metadata FROM media_files WHERE account_id = $1 AND id = ANY($2::uuid[])`, [acct, clean])) {
    out.set(r.id, '/' + (r.metadata?.motion?.video ? r.metadata.motion.video : r.store_key));
  }
  return out;
}

const ASSIGNMENT_SQL = `
  SELECT a.*, s.name AS setup_name, s.fields AS bindings, s.placement, s.version_id, s.template_id,
         t.name AS template_name, t.kind AS template_kind, v.version, v.manifest,
         st.values AS state_values, st.overrides, st.on_air, st.rundown_item_id, st.off_at, st.updated_at AS state_updated_at, st.updated_by AS state_updated_by
    FROM gfx_assignments a
    JOIN gfx_setups s ON s.id = a.setup_id
    JOIN gfx_templates t ON t.id = s.template_id
    JOIN gfx_template_versions v ON v.id = s.version_id
    LEFT JOIN gfx_state st ON st.assignment_id = a.id`;

/** Every assignment on a channel or event, with its resolved values and whether it is on now. */
export async function liveFor(acct: string, target: Target, at = new Date()) {
  const rows = await query<any>(`${ASSIGNMENT_SQL} WHERE a.account_id = $1 AND a.${target.kind === 'channel' ? 'channel_id' : 'event_id'} = $2 ORDER BY a.created_at`, [acct, target.id]);
  return resolveRows(acct, target, rows, at);
}

export async function liveOne(acct: string, assignmentId: string, at = new Date()) {
  const r = await one<any>(`${ASSIGNMENT_SQL} WHERE a.account_id = $1 AND a.id = $2`, [acct, assignmentId]);
  if (!r) throw notFound('No graphic assignment with that id');
  const target = await loadTarget(acct, { channelId: r.channel_id, eventId: r.event_id });
  return (await resolveRows(acct, target, [r], at))[0];
}

async function resolveRows(acct: string, target: Target, rows: any[], at: Date) {
  const progs = await guideFor(target.kind, target.id, new Date(at.getTime() - 6 * 3600_000), new Date(at.getTime() + 12 * 3600_000));
  const guide = nowNext(progs as any, at);
  const feedIds = new Set<string>(); const imgIds = new Set<string>();
  for (const r of rows) for (const b of Object.values<FieldBinding>(r.bindings ?? {})) {
    if (b.source === 'feed' && b.sourceId) feedIds.add(b.sourceId);
    if (b.source === 'image' && b.imageId) imgIds.add(b.imageId);
  }
  const feeds = await feedStates(acct, [...feedIds]);
  const imgs = await imageUrls(acct, [...imgIds]);
  return rows.map((r) => {
    const manifest = r.manifest ?? {};
    const res = resolveValues({ fields: manifest.fields ?? [], bindings: r.bindings ?? {}, stateValues: r.state_values ?? {},
      overrides: r.overrides ?? [], feeds, guide, imageUrl: (id) => imgs.get(id) ?? null });
    const run: AssignmentRun = { run_mode: r.run_mode, rule: r.rule ?? {}, clear_in_ads: r.clear_in_ads, enabled: r.enabled };
    const decision = isOn(run, progs, at, !!r.on_air);
    const on = decision.on && !res.hidden;
    return {
      id: r.id, setupId: r.setup_id, setupName: r.setup_name, templateId: r.template_id, templateName: r.template_name, templateKind: r.template_kind,
      versionId: r.version_id, version: r.version, canvas: manifest.canvas ?? [1920, 1080], fields: manifest.fields ?? [],
      templateUrl: `/gfx/${r.version_id}/index.html`, placement: r.placement ?? {},
      channelId: r.channel_id, eventId: r.event_id, targets: r.targets, runMode: r.run_mode, rule: r.rule ?? {}, clearInAds: r.clear_in_ads, enabled: r.enabled,
      onAir: on, reason: res.hidden ? 'feed is stale and set to hide' : decision.reason, takenByHand: !!r.on_air,
      values: res.values, origin: res.origin, overrides: r.overrides ?? [], staleFeeds: res.staleFeeds,
      rundownItemId: r.rundown_item_id ?? null, offAt: r.off_at ?? null,
      updatedAt: r.state_updated_at ?? null, updatedBy: r.state_updated_by ?? null,
    };
  });
}

/** Day strip: when each assignment of a channel is on between from and to. */
export async function planFor(acct: string, target: Target, from: Date, to: Date) {
  const progs = await guideFor(target.kind, target.id, from, to);
  const rows = await query<any>(`SELECT a.*, s.name AS setup_name FROM gfx_assignments a JOIN gfx_setups s ON s.id = a.setup_id
    WHERE a.account_id = $1 AND a.${target.kind === 'channel' ? 'channel_id' : 'event_id'} = $2 ORDER BY a.created_at`, [acct, target.id]);
  return {
    programmes: progs.map((p) => ({ id: p.id, title: p.title, startsAt: p.startsAt, endsAt: p.endsAt, kind: p.kind, genres: p.genres })),
    assignments: rows.map((r) => ({ id: r.id, setupName: r.setup_name, runMode: r.run_mode,
      windows: plan({ run_mode: r.run_mode, rule: r.rule ?? {}, clear_in_ads: r.clear_in_ads, enabled: r.enabled }, progs, from, to)
        .map((w) => ({ start: w.start, end: w.end, reason: w.reason })) })),
  };
}

// ---- writing state ----------------------------------------------------------

async function logChange(c: PoolClient, acct: string, assignmentId: string | null, eventId: string | null, actor: string, action: string, field: string | null, oldV: unknown, newV: unknown) {
  await c.query(`INSERT INTO gfx_state_log(account_id, assignment_id, event_id, actor, action, field, old_value, new_value)
                 VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)`,
    [acct, assignmentId, eventId, actor, action, field, oldV === undefined ? null : JSON.stringify(oldV), newV === undefined ? null : JSON.stringify(newV)]);
}

async function lockState(c: PoolClient, acct: string, assignmentId: string) {
  const a = await c.query(`SELECT a.id, a.channel_id, a.event_id, v.manifest, s.fields AS bindings FROM gfx_assignments a
      JOIN gfx_setups s ON s.id = a.setup_id JOIN gfx_template_versions v ON v.id = s.version_id
     WHERE a.id = $1 AND a.account_id = $2`, [assignmentId, acct]);
  if (!a.rows[0]) throw notFound('No graphic assignment with that id');
  await c.query(`INSERT INTO gfx_state(assignment_id) VALUES ($1) ON CONFLICT DO NOTHING`, [assignmentId]);
  const s = (await c.query(`SELECT * FROM gfx_state WHERE assignment_id = $1 FOR UPDATE`, [assignmentId])).rows[0];
  return { a: a.rows[0], s };
}

/**
 * Set field values (the live driving call). Idempotent per field: a value
 * equal to the current one is not logged. Writing a feed-bound field takes it
 * over from the feed until `release` hands it back.
 */
export async function setValues(acct: string, assignmentId: string, values: Record<string, unknown>, actor: string, release: string[] = []) {
  let stream: { channelId: string | null; eventId: string | null } | null = null;
  const r = await tx(async (c) => {
    const { a, s } = await lockState(c, acct, assignmentId);
    stream = { channelId: a.channel_id, eventId: a.event_id };
    const fields: { id: string; type: string }[] = a.manifest?.fields ?? [];
    const byId = new Map(fields.map((f) => [f.id, f]));
    const cur: Record<string, unknown> = { ...(s.values ?? {}) };
    const overrides = new Set<string>(s.overrides ?? []);
    const errors: string[] = [];
    let changed = 0;
    for (const [k, raw] of Object.entries(values ?? {})) {
      const f = byId.get(k);
      if (!f) { errors.push(`${k}: the template has no such field`); continue; }
      const v = coerce(f.type, raw);
      if (!v.ok) { errors.push(`${k}: ${v.error}`); continue; }
      if (JSON.stringify(cur[k]) === JSON.stringify(v.value)) continue;
      await logChange(c, acct, assignmentId, a.event_id, actor, 'set', k, cur[k], v.value);
      cur[k] = v.value; changed++;
      if (a.bindings?.[k]?.source === 'feed') overrides.add(k);
    }
    if (errors.length) throw badRequest(errors.join('; '));
    for (const k of release) {
      if (overrides.delete(k)) { delete cur[k]; changed++; await logChange(c, acct, assignmentId, a.event_id, actor, 'release', k, null, null); }
    }
    if (changed) await c.query(`UPDATE gfx_state SET values = $2::jsonb, overrides = $3, updated_at = now(), updated_by = $4 WHERE assignment_id = $1`,
      [assignmentId, JSON.stringify(cur), [...overrides], actor]);
    return { changed };
  });
  // Announced after the commit, so a console that re-reads on the frame sees the new value.
  if (r.changed && stream) publishGfx(acct, stream, 'values', assignmentId);
  return r;
}

export async function setAir(acct: string, assignmentId: string, on: boolean, actor: string, opts: { forSec?: number | null } = {}) {
  let stream: { channelId: string | null; eventId: string | null } | null = null;
  const r = await tx(async (c) => {
    const { a, s } = await lockState(c, acct, assignmentId);
    stream = { channelId: a.channel_id, eventId: a.event_id };
    const offAt = on && opts.forSec ? new Date(Date.now() + opts.forSec * 1000) : null;
    if (s.on_air === on && !offAt) return { changed: 0 };
    await c.query(`UPDATE gfx_state SET on_air = $2, off_at = $3, rundown_item_id = CASE WHEN $2 THEN rundown_item_id ELSE NULL END,
                   updated_at = now(), updated_by = $4 WHERE assignment_id = $1`, [assignmentId, on, offAt, actor]);
    if (!on && s.rundown_item_id) await c.query(`UPDATE gfx_rundown_items SET status = 'done', updated_at = now() WHERE id = $1 AND status = 'on_air'`, [s.rundown_item_id]);
    await logChange(c, acct, assignmentId, a.event_id, actor, on ? 'on' : 'off', null, s.on_air, on);
    return { changed: 1 };
  });
  if (r.changed && stream) publishGfx(acct, stream, 'air', assignmentId);
  return r;
}

// ---- rundowns ---------------------------------------------------------------

/** The event's assignment for a setup, created on first use (manual, shown where the workflow allows). */
async function assignmentForItem(c: PoolClient, acct: string, target: Target, setupId: string): Promise<string> {
  const found = (await c.query(`SELECT id FROM gfx_assignments WHERE account_id = $1 AND event_id = $2 AND setup_id = $3 ORDER BY created_at LIMIT 1`, [acct, target.id, setupId])).rows[0];
  if (found) return found.id;
  const targets = target.workflow === 'package_only' ? 'player' : 'burn';
  const r = await c.query(`INSERT INTO gfx_assignments(account_id, setup_id, event_id, targets, run_mode) VALUES ($1,$2,$3,$4,'manual') RETURNING id`, [acct, setupId, target.id, targets]);
  return r.rows[0].id;
}

/** Put one rundown item on air. Another item on the same graphic is finished first. */
export async function takeItem(acct: string, eventId: string, itemId: string, actor: string) {
  const target = await loadTarget(acct, { eventId });
  const r = await tx(async (c) => {
    const it = (await c.query(`SELECT * FROM gfx_rundown_items WHERE id = $1 AND event_id = $2 AND account_id = $3 FOR UPDATE`, [itemId, eventId, acct])).rows[0];
    if (!it) throw notFound('No rundown item with that id on this event');
    if (it.status === 'skipped') throw conflict('This item is skipped. Restore it before taking it.');
    const assignmentId = await assignmentForItem(c, acct, target, it.setup_id);
    await c.query(`INSERT INTO gfx_state(assignment_id) VALUES ($1) ON CONFLICT DO NOTHING`, [assignmentId]);
    const s = (await c.query(`SELECT * FROM gfx_state WHERE assignment_id = $1 FOR UPDATE`, [assignmentId])).rows[0];
    if (s.rundown_item_id && s.rundown_item_id !== it.id) {
      await c.query(`UPDATE gfx_rundown_items SET status = 'done', updated_at = now() WHERE id = $1 AND status = 'on_air'`, [s.rundown_item_id]);
    }
    const offAt = it.stays_sec ? new Date(Date.now() + it.stays_sec * 1000) : null;
    await c.query(`UPDATE gfx_state SET values = $2::jsonb, overrides = '{}', on_air = true, rundown_item_id = $3, off_at = $4, updated_at = now(), updated_by = $5
                    WHERE assignment_id = $1`, [assignmentId, JSON.stringify(it.values ?? {}), it.id, offAt, actor]);
    await c.query(`UPDATE gfx_rundown_items SET status = 'on_air', taken_at = now(), updated_at = now() WHERE id = $1`, [it.id]);
    await logChange(c, acct, assignmentId, eventId, actor, 'take', null, null, { item: it.id, title: it.title });
    return { assignmentId, itemId: it.id, offAt };
  });
  publishGfx(acct, { eventId }, 'rundown', r.assignmentId);
  return r;
}

/** Take off whatever the rundown has on air (the persistent graphics, run_mode != manual, stay). */
export async function takeOffRundown(acct: string, eventId: string, actor: string, itemId?: string) {
  await loadTarget(acct, { eventId });
  const r = await tx(async (c) => {
    const items = (await c.query(`SELECT id, title FROM gfx_rundown_items WHERE event_id = $1 AND account_id = $2 AND status = 'on_air' ${itemId ? 'AND id = $3' : ''} FOR UPDATE`,
      itemId ? [eventId, acct, itemId] : [eventId, acct])).rows;
    for (const it of items) {
      await c.query(`UPDATE gfx_rundown_items SET status = 'done', updated_at = now() WHERE id = $1`, [it.id]);
      const st = (await c.query(`UPDATE gfx_state SET on_air = false, off_at = NULL, rundown_item_id = NULL, updated_at = now(), updated_by = $2
                                   WHERE rundown_item_id = $1 RETURNING assignment_id`, [it.id, actor])).rows;
      for (const r of st) await logChange(c, acct, r.assignment_id, eventId, actor, 'take_off', null, { item: it.id, title: it.title }, null);
    }
    return { takenOff: items.length };
  });
  if (r.takenOff) publishGfx(acct, { eventId }, 'rundown');
  return r;
}

// ---- data sources -----------------------------------------------------------

const PRIVATE = [/^10\./, /^127\./, /^169\.254\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^0\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, /^::1$/, /^f[cd][0-9a-f]{2}:/i, /^fe80:/i, /^::ffff:(10|127|192\.168|169\.254)\./i];

/** A feed URL must be public http(s). Private ranges are refused unless GRAPHICS_ALLOW_PRIVATE_FEEDS=1. */
export async function assertPublicUrl(raw: string): Promise<URL> {
  let u: URL;
  try { u = new URL(raw); } catch { throw badRequest('The feed URL is not a valid URL.'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw badRequest('The feed URL must be http or https.');
  if (process.env.GRAPHICS_ALLOW_PRIVATE_FEEDS === '1') return u;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (!addrs.length) throw badRequest(`${host} does not resolve.`);
  if (addrs.some((a) => PRIVATE.some((re) => re.test(a)))) throw badRequest('The feed URL points at a private network address.');
  return u;
}

/** Fetch a feed once. JSON as parsed; RSS / Atom as { items: [{ title, link, description }] }. */
export async function fetchFeed(kind: 'json' | 'rss', url: string): Promise<unknown> {
  const u = await assertPublicUrl(url);
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 8000);
  try {
    const r = await fetch(u, { signal: ac.signal, redirect: 'error', headers: { 'user-agent': 'Volt-Graphics/1.0', accept: kind === 'json' ? 'application/json' : 'application/rss+xml, application/atom+xml, text/xml, */*', 'cache-control': 'no-cache' } });
    if (!r.ok) throw new Error(`answered ${r.status} ${r.statusText}`.trim());
    const len = Number(r.headers.get('content-length') ?? 0);
    if (len > 2_000_000) throw new Error('the response is larger than 2 MB');
    const text = await r.text();
    if (text.length > 2_000_000) throw new Error('the response is larger than 2 MB');
    if (kind === 'json') { try { return JSON.parse(text); } catch { throw new Error('the response is not JSON'); } }
    return parseRss(text);
  } catch (e: any) {
    throw new Error(e?.name === 'AbortError' ? 'timed out after 8 s' : (e?.message ?? String(e)));
  } finally { clearTimeout(t); }
}

export function parseRss(xml: string): { title: string | null; items: { title: string; link: string | null; description: string | null }[] } {
  const un = (s: string | undefined) => s == null ? null : s.replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&').trim();
  const tag = (blk: string, n: string) => un(blk.match(new RegExp(`<${n}\\b[^>]*>([\\s\\S]*?)</${n}>`, 'i'))?.[1]);
  const blocks = [...xml.matchAll(/<(item|entry)\b[\s\S]*?<\/\1>/gi)].map((m) => m[0]).slice(0, 100);
  return {
    title: tag(xml.replace(/<(item|entry)\b[\s\S]*?<\/\1>/gi, ''), 'title'),
    items: blocks.map((b) => ({ title: tag(b, 'title') ?? '', link: tag(b, 'link') ?? (b.match(/<link[^>]*href="([^"]+)"/i)?.[1] ?? null), description: tag(b, 'description') ?? tag(b, 'summary') })),
  };
}

/** Store a new payload; fire feed cues whose value changed. Used by the poller and by push. */
export async function acceptPayload(acct: string, sourceId: string, payload: unknown, actor = 'feed') {
  const before = await one<any>(`SELECT payload FROM gfx_data_sources WHERE id = $1 AND account_id = $2`, [sourceId, acct]);
  if (!before) throw notFound('No data source with that id');
  await query(`UPDATE gfx_data_sources SET payload = $2::jsonb, last_ok_at = now(), last_error = NULL, last_polled_at = now() WHERE id = $1`, [sourceId, JSON.stringify(payload)]);
  if (JSON.stringify(before.payload) === JSON.stringify(payload)) return { changed: false, fired: 0 };
  const items = await query<any>(
    `SELECT i.id, i.event_id, i.cue FROM gfx_rundown_items i JOIN events e ON e.id = i.event_id
      WHERE i.account_id = $1 AND i.cue->>'kind' = 'feed' AND i.cue->>'sourceId' = $2 AND i.status = 'ready' AND e.status = 'live'`, [acct, sourceId]);
  // A new payload can change what every graphic bound to this source shows.
  await publishForSource(acct, sourceId);
  let fired = 0;
  for (const i of items) {
    if (feedFired(i.cue as Cue, before.payload, payload, (o, p) => pick(o, p))) {
      try { await takeItem(acct, i.event_id, i.id, actor); fired++; } catch (e) { console.error('[graphics] feed cue failed', e); }
    }
  }
  return { changed: true, fired };
}

export async function pollSource(src: { id: string; account_id: string; kind: 'json' | 'rss'; url: string }) {
  try {
    const payload = await fetchFeed(src.kind, src.url);
    return await acceptPayload(src.account_id, src.id, payload);
  } catch (e: any) {
    await query(`UPDATE gfx_data_sources SET last_error = $2, last_polled_at = now() WHERE id = $1`, [src.id, String(e?.message ?? e).slice(0, 300)]);
    return { changed: false, fired: 0, error: String(e?.message ?? e) };
  }
}

// ---- the tick -----------------------------------------------------------------

let ticking = false;
let lastPrune = 0;
export async function tick(now = new Date()): Promise<{ polled: number; offs: number; cues: number }> {
  if (ticking) return { polled: 0, offs: 0, cues: 0 };
  ticking = true;
  let polled = 0, offs = 0, cues = 0;
  try {
    // 1. Feeds that something live depends on, when due.
    const due = await query<any>(
      `SELECT DISTINCT d.id, d.account_id, d.kind, d.url FROM gfx_data_sources d
        WHERE d.kind <> 'push' AND (d.last_polled_at IS NULL OR d.last_polled_at < now() - make_interval(secs => d.every_sec))
          AND (EXISTS (SELECT 1 FROM gfx_assignments a JOIN gfx_setups s ON s.id = a.setup_id
                        LEFT JOIN channels c ON c.id = a.channel_id LEFT JOIN events e ON e.id = a.event_id
                       WHERE a.enabled AND s.account_id = d.account_id AND s.fields::text LIKE '%' || d.id::text || '%'
                         AND COALESCE(c.status::text, e.status::text) = 'live')
            OR EXISTS (SELECT 1 FROM gfx_rundown_items i JOIN events e ON e.id = i.event_id
                        WHERE i.cue->>'sourceId' = d.id::text AND i.status = 'ready' AND e.status = 'live'))
        LIMIT 50`);
    await Promise.all(due.map(async (d) => { await pollSource(d); polled++; }));

    // 2. Graphics whose time is up.
    const ending = await query<any>(`SELECT st.assignment_id, a.account_id FROM gfx_state st JOIN gfx_assignments a ON a.id = st.assignment_id
                                      WHERE st.on_air AND st.off_at IS NOT NULL AND st.off_at <= $1`, [now]);
    for (const e of ending) { await setAir(e.account_id, e.assignment_id, false, 'timer'); offs++; }

    // 3. Automatic rundown cues on live events.
    const evs = await query<any>(`SELECT DISTINCT i.event_id, i.account_id, e.actual_start, e.scheduled_start, e.status FROM gfx_rundown_items i
                                    JOIN events e ON e.id = i.event_id
                                   WHERE e.status = 'live' AND i.cue->>'kind' IN ('time','offset','repeat') AND i.status <> 'skipped'`);
    for (const ev of evs) {
      const items = (await query<any>(`SELECT id, position, status, cue, stays_sec, taken_at FROM gfx_rundown_items WHERE event_id = $1`, [ev.event_id]))
        .map((i) => ({ ...i, taken_at: i.taken_at ? new Date(i.taken_at) : null }));
      for (const i of dueAutomatic(items, now, ev.actual_start ?? ev.scheduled_start ?? null, true)) {
        try { await takeItem(ev.account_id, ev.event_id, i.id, 'cue'); cues++; } catch (e) { console.error('[graphics] cue failed', e); }
      }
    }
    // 4. Player graphics: a snapshot per live stream whose state changed (playerFeed.ts).
    const pf = await import('./playerFeed');
    await pf.recordSnapshots(now);
    // 5. Consoles: announce live streams whose graphics moved with no write
    //    (a rule at a programme boundary, a feed going stale), livePush.ts.
    await watchLive(now);
    if (now.getTime() - lastPrune > 3600_000) { lastPrune = now.getTime(); await pf.pruneSnapshots(); }
  } catch (e) {
    console.error('[graphics] tick failed', e);
  } finally { ticking = false; }
  return { polled, offs, cues };
}

export function startGraphicsRuntime(everyMs = 1000): () => void {
  const h = setInterval(() => { void tick(); }, everyMs);
  return () => clearInterval(h);
}
