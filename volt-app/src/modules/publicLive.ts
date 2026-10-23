import { viewerGeo, noStore } from '../scale/edge';
/**
 * Public live delivery.
 *
 * This is the PUBLIC playback surface for a live channel: the URL a viewer app
 * (or the public API) hits to watch. In production this is served by CloudFront;
 * locally it redirects to the origin the control plane already serves.
 *
 * The contract Christian asked for: the public URL ONLY returns the stream when
 * the channel is ON AIR and the output has VALID CONTENT. So:
 *   - off air            -> 404 { available:false, reason:'not_on_air' }  (nothing public)
 *   - on air, no content -> 503 { available:false, reason:'no_valid_content' }
 *   - on air + valid     -> 302 to the CDN (prod) or /origin (local) manifest
 *
 * The On air gate in the console is computed from the SAME two facts (published +
 * valid content), so the gate is green only when this URL would actually serve.
 *
 * NO admin auth: viewers are the public. (Per-viewer account/client tokens hook in
 * here later; the shape is ready for it.)
 */
import { Router } from 'express';
import { one } from '../db';
import { config } from '../config';
import { liveDirFor, liveUrlBase } from '../services/liveOrigin';
import { asyncHandler } from '../util/http';
import { channelDelivery, reportedOutputLive } from '../services/viewerPath';
import { edgeCache } from '../scale/edge';
import { scaleConfig } from '../scale/config';
import { existsSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** GROUND TRUTH: is the channel's origin manifest advancing right now? Shaka rewrites
 *  master.m3u8 / manifest.mpd on every new segment, so a recent mtime = valid content. */
export function outputHasValidContent(channelId: string): boolean {
  try {
    const dir = liveDirFor(channelId);   // per-run namespace: probe the CURRENT run
    if (!existsSync(dir)) return false;
    let newest = 0;
    for (const f of readdirSync(dir)) {
      if (f.endsWith('.m3u8') || f.endsWith('.mpd')) {
        try { const m = statSync(join(dir, f)).mtimeMs; if (m > newest) newest = m; } catch { /* ignore */ }
      }
    }
    return newest > 0 && (Date.now() - newest) < 15000;
  } catch { return false; }
}

/** The public playback URL for a channel (what a viewer/app would open). Relative in
 *  local/dev (served by this box), absolute CDN in production. */
export function publicPlaybackUrl(channelId: string, file: 'master.m3u8' | 'manifest.mpd' = 'master.m3u8'): string {
  return `/live/${channelId}/${file}`;
}

export const publicLiveRouter = Router();

/** The account's and the channel's geo restriction for the public live URL. */
async function publicGeoGate(id: string, country: string | undefined): Promise<{ varies: boolean; blocked: string | null }> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return { varies: false, blocked: null };
  const { accountGeo, channelGeo, geoBlocks } = await import('../services/geoAccess');
  const row = await one<any>(`SELECT g.account_id, c.geo_mode, c.geo_countries FROM channels c JOIN groups g ON g.id = c.group_id WHERE c.id = $1`, [id]);
  if (!row) return { varies: false, blocked: null };
  const acct = await accountGeo(row.account_id); const ch = channelGeo(row);
  return { varies: !!(acct || ch), blocked: geoBlocks(acct, country, 'This content') ?? geoBlocks(ch, country, 'This channel') };
}

/**
 * THE EDGE RIGHTS DECISION, MADE HERE (EDGE_RIGHTS_VARIANTS.md, "On the Mac
 * first"). On the Mac there is no CloudFront, so the public route runs the
 * same decision the viewer-request function makes (services/edgeRights.ts
 * edgeDecision, proven equal to the function by test/edge-variants.check.ts):
 * allow, block, or replace:<variant>. Only where it runs differs.
 *
 * Outside production, a tester can pretend to be a viewer elsewhere and at
 * another time: `?as=AU&rc=standard&at=<ISO time>`, or the
 * X-Volt-Test-Country / X-Volt-Test-Rights headers ("XX" is a viewer whose
 * country the CDN cannot tell). Production ignores all of them and uses the
 * CDN's country header and the signed `vrc` claim, exactly as the edge does.
 */
/**
 * Who is asking, as the edge sees it: country, rights class and the time to
 * decide at, with the development-only stand-ins. `carry` is the part of
 * the query that must follow the viewer onto the variant's own playlists
 * (the stand-ins and a query-string claim), as `?a=b&c=d` or ''.
 */
export async function rightsViewer(req: any, id: string): Promise<{
  cc: string; rc: string; nowSec: number; atSet: boolean; perViewer: boolean; carry: string;
}> {
  const er = await import('../services/edgeRights');
  const dev = config.env !== 'production';
  const q = req.query ?? {};
  const pick = (v: unknown) => (Array.isArray(v) ? v[0] : v) as string | undefined;
  const testCc = dev ? (pick(q.as) ?? req.get?.('x-volt-test-country')) : undefined;
  const testRc = dev ? (pick(q.rc) ?? req.get?.('x-volt-test-rights')) : undefined;
  const testAt = dev ? pick(q.at) : undefined;
  const atMs = testAt ? Date.parse(testAt) : NaN;
  const nowSec = Math.floor((Number.isFinite(atMs) ? atMs : Date.now()) / 1000);
  const ccRaw = typeof testCc === 'string' && /^[A-Za-z]{2}$/.test(testCc) ? testCc.toUpperCase() : (viewerGeo(req) ?? '');
  const cc = ccRaw === 'XX' ? '' : ccRaw;
  const qClaim = pick(q.vrc);
  const claim = qClaim ?? (String(req.get?.('cookie') ?? '').match(/(?:^|;\s*)vrc=([^;]+)/)?.[1]);
  const rc = typeof testRc === 'string' && er.RC_RE.test(testRc.toLowerCase())
    ? testRc.toLowerCase()
    : claim ? er.verifyRightsClaim(decodeURIComponent(claim), id, Math.floor(Date.now() / 1000)) : '';
  const carryParts: string[] = [];
  for (const [k, v] of [['as', dev ? pick(q.as) : undefined], ['rc', dev ? pick(q.rc) : undefined], ['at', testAt], ['vrc', qClaim]] as const) {
    if (typeof v === 'string' && v) carryParts.push(`${k}=${encodeURIComponent(v)}`);
  }
  return {
    cc, rc, nowSec, atSet: Number.isFinite(atMs),
    perViewer: !!(testCc || testRc || testAt || claim),
    carry: carryParts.length ? '?' + carryParts.join('&') : '',
  };
}

export async function publicRightsDecision(req: any, id: string): Promise<{
  restricted: boolean; decision: string; variant: string | null; cc: string; rc: string; perViewer: boolean; carry: string;
}> {
  const er = await import('../services/edgeRights');
  const { cc, rc, nowSec, atSet, perViewer, carry } = await rightsViewer(req, id);
  let rules: import('../services/edgeRights').EdgeRules | null;
  if (atSet) {
    // another time: the rules as the sync would have published them then
    rules = await er.loadEdgeRules('channel', id, nowSec).catch(() => null)
      ?? await er.loadEdgeRules('event', id, nowSec).catch(() => null);
  } else {
    const { rulesFor } = await import('../services/edgeViewAs');
    rules = await rulesFor(id);
  }
  const d = er.decideFor(rules, cc, rc, nowSec);
  return {
    restricted: !!rules,
    decision: er.edgeDecision(rules, cc, rc, nowSec),
    // the variant the audience maps to, even before the variant service runs
    variant: d === 'replace' ? er.variantFor(rules?.vm, cc, rc) : null,
    cc, rc, perViewer, carry,
  };
}

/**
 * PUBLIC RADIO delivery. Same contract as the video surface: nothing is public
 * until the operator takes the station ON AIR, and then only while the output
 * is valid. /radio/:id/stream.mp3 remains the PRIVATE preview (the audio
 * equivalent of /origin), so monitoring never leaks to listeners.
 */
publicLiveRouter.get(
  '/live/:id/stream.mp3',
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    // the account's and the station's geo restriction, as for TV
    const gate = await publicGeoGate(id, viewerGeo(req));
    if (gate.varies) res.setHeader('Vary', 'CloudFront-Viewer-Country');
    if (gate.blocked) { noStore(res); res.status(451).json({ available: false, reason: 'geo', message: gate.blocked }); return; }
    const ch = await one<any>(`SELECT id, name, status, on_air, kind FROM channels WHERE id=$1 AND kind='radio'`, [id]);
    if (!ch || !ch.on_air) { res.status(404).json({ available: false, reason: 'not_on_air' }); return; }
    const { radioHasValidContent } = await import('../services/radio/detail');
    if (ch.status !== 'live' || !radioHasValidContent(id)) {
      res.status(503).json({ available: false, reason: 'no_valid_content' });
      return;
    }
    // MP3 IS DERIVED ON DEMAND FROM THE HLS THIS STATION IS ALREADY WRITING.
    //
    // Not pushed by the station to a relay, and not redirected to one. The
    // station writes HLS and DASH and knows nothing about MP3 at all; the first
    // listener here starts one ffmpeg that reads the origin and transcodes, and
    // it stops shortly after the last listener leaves. See
    // services/radio/mp3Gateway.ts for why that inversion fixes three separate
    // problems at once.
    //
    // TERMINATING THE CONNECTION IS THE POINT, not an accident. It is what
    // keeps the on-air gate, the rights check, the listener count and the byte
    // measurement per-listener — every one of which a relay or a CDN in front of
    // one would have collapsed into a single anonymous connection.
    //
    // A station that pushes to a relay is still supported (radio_config
    // outputs.mp3), and where one is configured its public URL still points at
    // the relay. This route is the on-demand path.
    // THREE TOPOLOGIES, and the discriminator is not "is mp3 enabled".
    //
    // `outputs.mp3` means different things in different modes, which is exactly
    // the confusion to avoid here:
    //
    //   legacy in-process   the control plane spawns the station's ffmpeg and
    //                       reads MP3 off its stdout. mp3 enabled means WE have
    //                       the bytes; serve them from the pipeline.
    //   container + relay   the station PUSHES to a relay. mp3 enabled means the
    //                       audio is somewhere else, so redirect: proxying would
    //                       put the control plane back in the audio path, which
    //                       is the thing containerising radio removed.
    //   container, no relay the station writes HLS and knows nothing of MP3.
    //                       Derive it on demand.
    //
    // Keying on `outputs.mp3` alone read the legacy case as the relay case and
    // sent a 302 to a mount nothing was pushing to.
    const rc = (await one<any>(`SELECT radio_config FROM channels WHERE id=$1`, [id]))?.radio_config ?? {};
    const { radioIsContainerised } = await import('../services/radio/state');
    if (!radioIsContainerised()) {
      const { attachMp3Listener } = await import('../services/radio/pipeline');
      if (!attachMp3Listener(id, req as any, res as any, ch.name)) {
        res.status(503).json({ available: false, reason: 'no_valid_content' });
      }
      return;
    }
    if (rc?.outputs?.mp3 === true) {
      const { publicMp3Url } = await import('../services/radio/jobConfig');
      res.redirect(302, publicMp3Url(id));
      return;
    }
    const acct = await one<any>(
      `SELECT g.account_id FROM channels c JOIN groups g ON g.id = c.group_id WHERE c.id = $1`, [id]);
    const { attachListener } = await import('../services/radio/mp3Gateway');
    const r = await attachListener(id, req as any, res as any, {
      bitrateKbps: rc?.bitrateKbps ?? 128,
      stationName: ch.name,
      accountId: acct?.account_id ?? null,
    });
    if (!r.ok) {
      res.status(503).json({ available: false, reason: r.reason ?? 'no_valid_content' });
    }
  })
);

/**
 * Where the public manifest for a channel is, or why there is none.
 *
 * One function so the /live redirect and the play gate's `delivery` URLs can
 * never disagree. Reads only cached state (services/viewerPath.ts): an on-air
 * change invalidates at once, the output check is at most 2 s old.
 */
export async function resolveLiveManifest(id: string, file: 'master.m3u8' | 'manifest.mpd'):
  Promise<{ ok: true; url: string } | { ok: false; status: 404 | 503; reason: string }> {
  const ch = await channelDelivery(id);
  // A FAST CHANNEL (origin = playlist): its playout's playlists, while the
  // playout's heartbeat is fresh; the per-viewer stitched URL when its ads are
  // stitched (HLS; DASH viewers get the channel's own breaks). services/fast/delivery.ts
  if (ch && ch.on_air) {
    const { fastManifest } = await import('../services/fast/delivery');
    const f = await fastManifest(id, file);
    if (f) return f;
  }
  // Off air: the public URL exposes nothing. This is the whole point of "On means
  // available to the public" — private previews never leak here.
  if (!ch || !ch.on_air) return { ok: false, status: 404, reason: 'not_on_air' };
  // On air but the encoder isn't producing valid content -> the public stream is
  // broken; say so honestly rather than 302 to a dead manifest.
  // Radio writes its master ONCE and advances audio/index.m3u8, so it has its own
  // freshness probe; TV rewrites the master every segment.
  //
  // WHEN THIS BOX CANNOT SEE THE ORIGIN (every cloud deployment: the encoder
  // writes to S3 from another machine) the directory probe would always say
  // "no content" and the public URL would always answer 503. The encoder's own
  // status reports are the ground truth there.
  const valid = ch.kind === 'radio'
    ? (await import('../services/radio/detail')).radioHasValidContent(id)
    : existsSync(liveDirFor(id)) ? outputHasValidContent(id) : await reportedOutputLive(id);
  if (ch.status !== 'live' || !valid) return { ok: false, status: 503, reason: 'no_valid_content' };
  // Production: the CloudFront distribution in front of S3. Local/dev: the origin
  // this control plane already serves at /origin.
  const cdn = config.aws?.cdnBaseUrl;
  if (cdn && config.env === 'production' && !/example\.com/.test(cdn)) {
    // the CDN path cannot be stat'ed from here, so decide from the channel: the
    // encoder writes master_cc whenever it splices (failover with a slate/loop) or
    // carries subtitles
    // ...and, since in-stream graphic triggers (services/graphicTriggers.ts), on
    // every video channel: the delivered copies are where the encoder writes the
    // wall clock and the triggers, and the packager's own files carry neither.
    // Radio: its master.m3u8 is rewritten by radio.py to lead to the delivered
    // copy (audio/index_cc.m3u8), and its DASH lives under dash/, where the
    // delivered copy is manifest_cc.mpd.
    const out = ch.kind === 'radio'
      ? (file === 'master.m3u8' ? 'master.m3u8' : 'dash/manifest_cc.mpd')
      : (file === 'master.m3u8' ? 'master_cc.m3u8' : 'manifest_cc.mpd');
    return { ok: true, url: `${cdn.replace(/\/$/, '')}/channel/${id}/${out}` };
  }
  // Radio packages DASH under the run's dash/ dir; HLS master sits at the run root.
  let path = ch.kind === 'radio' && file === 'manifest.mpd' ? 'dash/manifest.mpd' : file;
  // The radio DASH copy with the triggers in it, once radio.py has written one.
  if (ch.kind === 'radio' && file === 'manifest.mpd' && existsSync(join(liveDirFor(id), 'dash/manifest_cc.mpd'))) path = 'dash/manifest_cc.mpd';
  // THE DELIVERED MASTER. When the encoder writes master_cc.m3u8 (subtitles, and/or
  // the playout splice that covers a lost source with the channel's loop), that is
  // what a viewer must get: the packager's own master has neither, and a viewer
  // given it stalls when the source drops.
  if (ch.kind !== 'radio') {
    const delivered = file === 'master.m3u8' ? 'master_cc.m3u8' : 'manifest_cc.mpd';
    if (existsSync(join(liveDirFor(id), delivered))) path = delivered;
  }
  return { ok: true, url: `${liveUrlBase(id)}/${path}` };
}

/**
 * The public manifest for an EVENT, or why there is none.
 *
 * An event is public while it is live inside its public window (public_start
 * to public_end when set) and producing valid output. Same rules as a channel
 * otherwise: nothing leaks before it starts, a broken output says so.
 */
export async function resolveEventManifest(id: string, file: 'master.m3u8' | 'manifest.mpd'):
  Promise<{ ok: true; url: string } | { ok: false; status: 404 | 503; reason: string }> {
  const ev = await one<any>(`SELECT status, public_start, public_end FROM events WHERE id = $1`, [id]);
  if (!ev) return { ok: false, status: 404, reason: 'not_found' };
  const now = Date.now();
  const opened = !ev.public_start || new Date(ev.public_start).getTime() <= now;
  const closed = !!ev.public_end && new Date(ev.public_end).getTime() < now;
  if (ev.status !== 'live' || !opened || closed) return { ok: false, status: 404, reason: 'not_on_air' };
  const valid = existsSync(liveDirFor(id)) ? outputHasValidContent(id) : await reportedOutputLive(id);
  if (!valid) return { ok: false, status: 503, reason: 'no_valid_content' };
  const cdn = config.aws?.cdnBaseUrl;
  // Delivered copies, as for channels: the encoder writes them for every video stream.
  if (cdn && config.env === 'production' && !/example\.com/.test(cdn)) return { ok: true, url: `${cdn.replace(/\/$/, '')}/event/${id}/${file === 'master.m3u8' ? 'master_cc.m3u8' : 'manifest_cc.mpd'}` };
  const delivered = file === 'master.m3u8' ? 'master_cc.m3u8' : 'manifest_cc.mpd';
  return { ok: true, url: `${liveUrlBase(id)}/${existsSync(join(liveDirFor(id), delivered)) ? delivered : file}` };
}

publicLiveRouter.get(
  '/live/:id/:file(master.m3u8|manifest.mpd)',
  asyncHandler(async (req, res) => {
    const { id, file } = req.params;
    // GEO ABOVE THE RULES (services/geoAccess.ts): the account's restriction and
    // the channel's own. Only a channel with one varies by viewer country, so
    // everything else keeps its single shared edge entry.
    const gate = await publicGeoGate(id, viewerGeo(req));
    if (gate.varies) res.setHeader('Vary', 'CloudFront-Viewer-Country');
    if (gate.blocked) { noStore(res); res.status(451).json({ available: false, reason: 'geo', message: gate.blocked }); return; }
    // THE PROGRAMME RIGHTS (blackout and replace windows from the guide), the
    // same decision the edge makes. A stream with rules varies by country; a
    // tester's pretend country or a signed class is one viewer's answer.
    if (/^[0-9a-f-]{36}$/i.test(id)) {
      const rd = await publicRightsDecision(req, id);
      if (rd.restricted) {
        res.setHeader('Vary', 'CloudFront-Viewer-Country');
        res.setHeader('X-Volt-Rights', rd.decision);
      }
      if (rd.perViewer) noStore(res);
      if (rd.decision !== 'allow') {
        noStore(res);
        const k = rd.decision.startsWith('replace:') ? rd.decision.slice(8) : null;
        if (k) {
          // the variant manifest service (services/variantManifest.ts, below)
          // serves it; a tester's stand-ins travel with them
          res.redirect(302, `/live/${id}/v/${k}/${file}${rd.carry}`);
          return;
        }
        // Blocked, or replaced while no variant service runs yet: never
        // serve what the rights say this viewer may not see.
        res.status(451).json({
          available: false, reason: 'rights', decision: rd.variant ? 'replace' : 'block', variant: rd.variant,
          message: rd.variant ? 'This programme is replaced where you are' : 'This programme is not available where you are',
        });
        return;
      }
    }
    const r = await resolveLiveManifest(id, file as 'master.m3u8' | 'manifest.mpd');
    // The answer is the same for every viewer of the channel, so the edge may
    // hold it for a couple of seconds: a million viewers then cost the API a
    // request per edge location every 2 s, not a request each. Except a
    // per-viewer URL (a FAST channel with stitched ads), which must never be shared.
    if (r.ok && (r as any).perViewer) noStore(res);
    else if (!/no-store/.test(String(res.getHeader('Cache-Control') ?? ''))) edgeCache(res, scaleConfig.edge.liveRedirectMaxAgeSec);
    if (!r.ok) {
      res.status(r.status).json({ available: false, reason: r.reason });
      return;
    }
    res.redirect(302, r.url);
  })
);

/**
 * THE VARIANT MANIFEST SERVICE (EDGE_RIGHTS_VARIANTS.md, queue item 1.14b).
 *
 *   /live/<id>/v/<key>/<file>      the Mac and the public API (the route
 *                                  above redirects a replaced viewer here)
 *   /channel|event/<id>/v/<key>/<file>  behind the CDN: the edge function
 *                                  rewrote the viewer's own URL to it and
 *                                  sent it to this service (deploy/terraform,
 *                                  the variants origin)
 *
 * Answers with THE ASKING VIEWER'S OWN variant (their audience in the
 * published map), whatever key the path names: the key is the cache name,
 * not a permission. So a variant asked for by name is never a way round a
 * block, nobody gets another audience's version, and a viewer whose window
 * has closed while their player still holds a /v/ address is handed the
 * normal stream through the same path (an empty timeline) instead of an
 * error. Blocked: 451, as the edge answers. Off air: as the public route.
 * A variant that cannot be built safely: 503, never the normal stream.
 */
async function serveVariant(req: any, res: any, kindHint: 'channel' | 'event' | null, id: string, key: string, file: string) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (!/^[0-9a-f-]{36}$/i.test(id) || !/^v[0-9a-f]{8}$/.test(key) || !/^[A-Za-z0-9_.-]{1,80}\.(m3u8|mpd|vtt)$/.test(file)) {
    res.status(404).json({ available: false, reason: 'not_found' });
    return;
  }
  const vm = await import('../services/variantManifest');
  if (file.endsWith('.vtt')) {
    // the subtitle track inside a window: nothing to show, the same file for everyone
    if (file !== 'empty.vtt') { res.status(404).json({ available: false, reason: 'not_found' }); return; }
    edgeCache(res, 86400);
    res.type('text/vtt; charset=utf-8').send(vm.EMPTY_VTT);
    return;
  }
  const er = await import('../services/edgeRights');
  if (!er.variantServiceOn()) { noStore(res); res.status(404).json({ available: false, reason: 'variant_service_off' }); return; }
  const found = await one<any>(`SELECT 'channel' AS kind FROM channels WHERE id = $1 UNION ALL SELECT 'event' FROM events WHERE id = $1 LIMIT 1`, [id]);
  const kind: 'channel' | 'event' | null = found?.kind ?? null;
  if (!kind || (kindHint && kindHint !== kind)) { res.status(404).json({ available: false, reason: 'not_found' }); return; }
  const v = await rightsViewer(req, id);
  // the account's and the channel's own geo first, as on the normal route
  const gate = await publicGeoGate(id, v.cc || undefined);
  if (gate.blocked) { noStore(res); res.status(451).json({ available: false, reason: 'geo', message: gate.blocked }); return; }
  const st = await er.loadEdgeState(kind, id, v.nowSec);
  const decision = er.decideFor(st.rules, v.cc, v.rc, v.nowSec);
  res.setHeader('X-Volt-Rights', decision);
  if (decision === 'block') {
    noStore(res);
    res.status(451).json({ available: false, reason: 'rights', decision: 'block', message: 'This programme is not available where you are' });
    return;
  }
  // on air and producing, exactly as the normal route requires
  const manifest = file.endsWith('.mpd') ? 'manifest.mpd' : 'master.m3u8';
  const live = kind === 'channel' ? await resolveLiveManifest(id, manifest) : await resolveEventManifest(id, manifest);
  if (!live.ok) { noStore(res); res.status(live.status).json({ available: false, reason: live.reason }); return; }
  const mine = er.variantFor(st.rules?.vm, v.cc, v.rc);
  const variant = mine ? st.variants.find((x) => x.key === mine) ?? null : null;
  res.setHeader('X-Volt-Variant', variant?.key ?? 'none');
  try {
    const out = await vm.renderVariant({
      kind, id, key: variant?.key ?? key, file, timeline: variant?.timeline ?? [],
      shiftSec: v.atSet ? v.nowSec - Math.floor(Date.now() / 1000) : 0, carry: v.carry,
    });
    if (!out) { noStore(res); res.status(404).json({ available: false, reason: 'not_found' }); return; }
    // one answer per variant: the edge may share it for about a segment;
    // a tester's stand-ins are one viewer's answer
    if (v.perViewer && config.env !== 'production') noStore(res);
    else edgeCache(res, scaleConfig.edge.liveRedirectMaxAgeSec);
    res.type(out.type).send(out.body);
  } catch (e: any) {
    noStore(res);
    if (e instanceof vm.VariantError) {
      res.status(503).json({ available: false, reason: 'variant_unavailable', message: e.message });
      return;
    }
    throw e;
  }
}

publicLiveRouter.get('/live/:id/v/:key/:file', asyncHandler(async (req, res) => {
  await serveVariant(req, res, null, req.params.id, req.params.key, req.params.file);
}));
publicLiveRouter.get('/channel/:id/v/:key/:file', asyncHandler(async (req, res) => {
  await serveVariant(req, res, 'channel', req.params.id, req.params.key, req.params.file);
}));
publicLiveRouter.get('/event/:id/v/:key/:file', asyncHandler(async (req, res) => {
  await serveVariant(req, res, 'event', req.params.id, req.params.key, req.params.file);
}));
