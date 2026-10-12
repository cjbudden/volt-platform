import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { query, one } from '../db';
import { config } from '../config';
import { requireAuth, accountId } from '../auth/middleware';
import { verifyAccess } from '../auth/jwt';
import { asyncHandler, notFound, unauthorized, badRequest } from '../util/http';
import { subscribe, publish, subscriberCount } from '../services/statusHub';
import { orchestrator } from '../services/orchestrator';

// Guardrail: one SSE connection per admin VIEWER (fanned out by tenant), NOT per
// channel — so channel count never multiplies sockets. This hard cap protects the
// process from runaway/leaked connections regardless.
const MAX_SSE_CLIENTS = Number(process.env.MAX_SSE_CLIENTS ?? 2000);

/**
 * Live stream status + event log.
 *
 * The encoder container reports here; the admin reads it. Two transports, by
 * design (see the polling-vs-websocket note in the README):
 *   - POLLING REST is the base: GET /api/status (all), /:kind/:id (one),
 *     /:kind/:id/events (log). Always available, cacheable, integration-friendly.
 *   - SSE is the live layer: GET /api/status/stream pushes changes to the admin
 *     within ~1s. Server->client only, plain HTTP, auto-reconnect — no sticky
 *     sessions or socket infra. We did NOT use raw WebSocket: status is a
 *     low-frequency, read-only, server-push signal, so SSE fits and is simpler
 *     to operate; add WS later only if the admin needs a duplex control channel.
 */

// ---------------------------------------------------------------------------
// Ingest — the encoder POSTs events + status snapshots here. Authenticated by a
// shared ingest token (from Secrets Manager), NOT a user JWT.
// ---------------------------------------------------------------------------
export const ingestRouter = Router();

export function requireIngestToken(req: Request, _res: Response, next: NextFunction) {
  const tok = req.header('X-Volt-Ingest-Token');
  if (!tok || tok !== config.ingestToken) return next(unauthorized('Bad ingest token'));
  next();
}
ingestRouter.use(requireIngestToken);

const kindEnum = z.enum(['channel', 'event']);
const snapshotSchema = z.object({
  output_available: z.boolean(),
  active_source: z.string(),
  fallback_in_use: z.boolean(),
  filler_in_use: z.boolean(),
  packager_ok: z.boolean(),
  sources: z.record(z.any()).default({}),
  seq: z.number().int().nonnegative().default(0),
  // encoder boot time (ms). seq restarts at 1 on every encoder boot, so ordering
  // reports by seq alone rejected EVERYTHING a restarted encoder sent until it passed
  // the dead run's counter (the UI stuck on the old state). A newer boot always wins.
  boot_ms: z.number().nonnegative().default(0),
});
const reportSchema = z.object({
  kind: kindEnum,
  id: z.string().uuid(),
  status: snapshotSchema.optional(),
  event: z
    .object({
      ts_ms: z.number().optional(),
      seq: z.number().int().optional(),
      type: z.string(),
      detail: z.record(z.any()).optional(),
    })
    .optional(),
});

async function resolveAccount(kind: 'channel' | 'event', id: string): Promise<string | null> {
  const sql =
    kind === 'channel'
      ? `SELECT g.account_id FROM channels c JOIN groups g ON g.id = c.group_id WHERE c.id = $1`
      : `SELECT g.account_id FROM events e JOIN groups g ON g.id = e.group_id WHERE e.id = $1`;
  const row = await one<{ account_id: string }>(sql, [id]);
  return row?.account_id ?? null;
}

/**
 * Apply one status report (event and/or snapshot). The encoder's own POST lands
 * here, and so do vendor engine webhooks once normalised (modules/engines.ts),
 * so a MediaLive or Bitmovin alert drives the same event log, health gates and
 * teardown as our own encoder's report.
 */
export async function applyReport(raw: unknown): Promise<void> {
  const body = reportSchema.parse(raw);
  const acct = await resolveAccount(body.kind, body.id);
  if (!acct) throw notFound('Unknown stream');
  const col = body.kind === 'channel' ? 'channel_id' : 'event_id';

  if (body.event) {
    const e = body.event;
    await query(
      `INSERT INTO stream_events(${col}, seq, type, detail, ts)
       VALUES ($1,$2,$3,$4, COALESCE(to_timestamp($5::double precision / 1000.0), now()))`,
      [body.id, e.seq ?? null, e.type, e.detail ?? {}, e.ts_ms ?? null]
    );
    // push every event to live admins too (not just status snapshots), so the UI
    // refreshes on channel.start/stop, source.up/down, input.error, output.stalled…
    publish(acct, 'event', { kind: body.kind, id: body.id, type: e.type });
    // The encoder can DIE on its own (e.g. packager crash) without the control
    // plane knowing. When it reports channel.stop while we still think it's live,
    // run the real teardown so status stops lying (instances terminated, channel
    // ended, recordings closed). Guarded on status='live' so a normal operator
    // stop (which already set 'ended') is not double-processed.
    // ----------------------------------------------------------------------
    //  WHAT THE ENCODER ACTUALLY PRODUCED. Until this existed the event was
    //  emitted and nobody listened, so the API kept advertising an MP3 URL
    //  for an output the running station had dropped. Pressing Listen then
    //  attached to a URL with no audio behind it and said nothing.
    //
    //  channel.start CLEARS the map. A run decides its own outputs at launch
    //  (the relay probe runs per start), so inheriting the previous run's
    //  verdict would hide an MP3 output that came back when Icecast did.
    // ----------------------------------------------------------------------
    if (e.type === 'channel.start') {
      await query(
        `UPDATE stream_status SET degraded_outputs = '{}'::jsonb WHERE ${col} = $1`,
        [body.id]
      ).catch((err) => console.error('[ingest] could not clear degraded outputs', body.id, err));
    } else if (e.type === 'output.degraded') {
      const d = (e.detail ?? {}) as any;
      const output = String(d.output ?? '').trim();
      if (output) {
        await query(
          `INSERT INTO stream_status(${col}, degraded_outputs)
           VALUES ($1, jsonb_build_object($2::text, $3::text))
           ON CONFLICT (${col}) DO UPDATE
             SET degraded_outputs = stream_status.degraded_outputs
                                  || jsonb_build_object($2::text, $3::text)`,
          [body.id, output, String(d.reason ?? 'unavailable')]
        ).catch((err) => console.error('[ingest] could not record a degraded output', body.id, err));
      }
    }

    if (e.type === 'channel.stop') {
      const tbl = body.kind === 'channel' ? 'channels' : 'events';
      const owner = await one<{ status: string }>(`SELECT status FROM ${tbl} WHERE id = $1`, [body.id]);
      if (owner?.status === 'live') {
        const reason = String((e.detail as any)?.reason ?? 'stop');
        try {
          // A FAULT, NOT A STOP. The encoder died; nobody decided this stream should
          // be off. Marking it stopped here would switch auto-connect off for the
          // exact case it exists to handle.
          await orchestrator.stopStream(body.kind, body.id, `encoder-reported: ${reason}`, 'fault');
        } catch (err) {
          console.error('[ingest] encoder-reported stop teardown failed', body.id, err);
        }
      }
    }
  }

  if (body.status) {
    const s = body.status;
    // Upsert the single snapshot row; the WHERE guards against an older
    // (out-of-order) report clobbering a newer one.
    await query(
      `INSERT INTO stream_status(${col}, output_available, active_source, fallback_in_use,
                                 filler_in_use, packager_ok, sources, last_seq, boot_ms, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
       ON CONFLICT (${col}) DO UPDATE SET
         output_available = EXCLUDED.output_available,
         active_source    = EXCLUDED.active_source,
         fallback_in_use  = EXCLUDED.fallback_in_use,
         filler_in_use    = EXCLUDED.filler_in_use,
         packager_ok      = EXCLUDED.packager_ok,
         sources          = EXCLUDED.sources,
         last_seq         = EXCLUDED.last_seq,
         boot_ms          = EXCLUDED.boot_ms,
         updated_at       = now()
       WHERE EXCLUDED.boot_ms > COALESCE(stream_status.boot_ms, 0)
          OR (EXCLUDED.boot_ms = COALESCE(stream_status.boot_ms, 0)
              AND stream_status.last_seq <= EXCLUDED.last_seq)`,
      [
        body.id,
        s.output_available,
        s.active_source,
        s.fallback_in_use,
        s.filler_in_use,
        s.packager_ok,
        s.sources,
        s.seq,
        s.boot_ms,
      ]
    );
    // push the change to any live admin dashboards for this tenant
    publish(acct, 'status', { kind: body.kind, id: body.id, ...s });
  }
}

ingestRouter.post(
  '/:id/report',
  asyncHandler(async (req, res) => {
    await applyReport({ ...req.body, id: req.params.id ?? req.body.id });
    res.status(202).json({ ok: true });
  })
);

// ---------------------------------------------------------------------------
// Admin reads — user JWT, tenant-scoped.
// ---------------------------------------------------------------------------
export const statusRouter = Router();

/** Overview: every channel's latest status for the tenant (dashboard poll). */
statusRouter.get(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const rows = await query(
      `SELECT s.channel_id, s.event_id, s.output_available, s.active_source,
              s.fallback_in_use, s.filler_in_use, s.packager_ok, s.sources, s.updated_at,
              COALESCE(c.name, e.name) AS name
         FROM stream_status s
         LEFT JOIN channels c ON c.id = s.channel_id
         LEFT JOIN events   e ON e.id = s.event_id
         JOIN groups g ON g.id = COALESCE(c.group_id, e.group_id)
        WHERE g.account_id = $1
        ORDER BY s.updated_at DESC`,
      [accountId(req)]
    );
    res.json(rows);
  })
);

/**
 * Live push (SSE). EventSource can't set an Authorization header, so this
 * endpoint also accepts the access token as `?ticket=` — in production issue a
 * short-lived, single-purpose SSE ticket rather than the full access JWT.
 */
statusRouter.get(
  '/stream',
  asyncHandler(async (req, res) => {
    const header = req.headers.authorization ?? '';
    const bearer = header.startsWith('Bearer ') ? header.slice(7) : undefined;
    const token = bearer ?? (typeof req.query.ticket === 'string' ? req.query.ticket : undefined);
    if (!token) throw unauthorized('Missing token');
    let acct: string;
    try {
      acct = verifyAccess(token).account_id;
    } catch {
      throw unauthorized('Invalid token');
    }

    // refuse new streams past the cap rather than exhaust memory/FDs
    if (subscriberCount() >= MAX_SSE_CLIENTS) {
      res.status(503).json({ error: 'Too many live connections; retry shortly' });
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`event: ready\ndata: ${JSON.stringify({ ok: true })}\n\n`);
    const unsubscribe = subscribe(acct, res);
    req.on('close', () => {
      unsubscribe();
      res.end();
    });
  })
);

const kindParam = z.enum(['channel', 'event']);

/** One stream's current snapshot (polling). */
statusRouter.get(
  '/:kind/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const kind = kindParam.parse(req.params.kind);
    const col = kind === 'channel' ? 'channel_id' : 'event_id';
    const grpCol = kind === 'channel' ? 'c.group_id' : 'e.group_id';
    const join =
      kind === 'channel'
        ? 'JOIN channels c ON c.id = s.channel_id'
        : 'JOIN events e ON e.id = s.event_id';
    const row = await one(
      `SELECT s.* FROM stream_status s ${join}
         JOIN groups g ON g.id = ${grpCol}
        WHERE s.${col} = $1 AND g.account_id = $2`,
      [req.params.id, accountId(req)]
    );
    if (!row) throw notFound('No status for that stream yet');
    res.json(row);
  })
);

/** One stream's event log (polling), newest first, optional `since` seq. */
statusRouter.get(
  '/:kind/:id/events',
  requireAuth,
  asyncHandler(async (req, res) => {
    const kind = kindParam.parse(req.params.kind);
    const col = kind === 'channel' ? 'channel_id' : 'event_id';
    const grpCol = kind === 'channel' ? 'c.group_id' : 'e.group_id';
    const join =
      kind === 'channel'
        ? 'JOIN channels c ON c.id = ev.channel_id'
        : 'JOIN events e ON e.id = ev.event_id';
    const limit = Math.min(Number(req.query.limit ?? 100), 500);
    const since = req.query.since !== undefined ? Number(req.query.since) : null;
    if (since !== null && !Number.isFinite(since)) throw badRequest('since must be a number');
    const rows = await query(
      `SELECT ev.id, ev.seq, ev.type, ev.detail, ev.ts
         FROM stream_events ev ${join}
         JOIN groups g ON g.id = ${grpCol}
        WHERE ev.${col} = $1 AND g.account_id = $2
          AND ($3::bigint IS NULL OR ev.id > $3)
        ORDER BY ev.id DESC
        LIMIT $4`,
      [req.params.id, accountId(req), since, limit]
    );
    res.json(rows);
  })
);
