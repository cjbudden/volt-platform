// ============================================================================
//  ENGINES API
//
//    GET  /api/engines                      installed + planned engines, with caps
//    GET  /api/engines/:id                  one engine
//    POST /api/engines/:id/validate         check a profile (or a raw job) against it
//    PUT  /api/engines/profiles/:profileId  choose the engine for an output profile (admin)
//
//    POST /api/engine-hooks/:engineId       PUBLIC vendor webhook. Verified by the
//                                           adapter, normalised to canonical Volt
//                                           events, applied through the same path
//                                           as an encoder's own status report.
// ============================================================================
import { Router } from 'express';
import express from 'express';
import { z } from 'zod';
import { one, query } from '../db';
import { requireAuth, accountId } from '../auth/middleware';
import { asyncHandler, badRequest, notFound, unauthorized } from '../util/http';
import { describeEngine, getEngine, listEngines, validateForEngine } from '../services/engines';
import { applyReport } from './status';

export const enginesRouter = Router();
enginesRouter.use(requireAuth);

enginesRouter.get('/', asyncHandler(async (_req, res) => {
  res.json({ engines: listEngines() });
}));

enginesRouter.get('/:id', asyncHandler(async (req, res) => {
  const d = describeEngine(req.params.id);
  if (!d) throw notFound('Unknown engine');
  res.json(d);
}));

/** A profile row reduced to the job fields the capability check reads. */
async function profileAsJob(acct: string, profileId: string) {
  const p = await one<any>(`SELECT * FROM output_profiles WHERE id = $1 AND account_id = $2`, [profileId, acct]);
  if (!p) return null;
  return {
    profile: p,
    job: {
      workflow: p.workflow_type,
      gpu: p.codec_backend === 'nvenc',
      ladder: Array.isArray(p.rungs) ? p.rungs : [],
      drm: p.drm_enabled ? {} : undefined,
      captions: { enabled: !!p.captions_enabled },
      watermark: Array.isArray(p.overlays) && p.overlays.length ? {} : undefined,
    },
  };
}

const validateBody = z.object({
  profileId: z.string().uuid().optional(),
  job: z.record(z.any()).optional(),
  mode: z.enum(['encode_only', 'full']).optional(),
});

enginesRouter.post('/:id/validate', asyncHandler(async (req, res) => {
  const b = validateBody.parse(req.body ?? {});
  let job = b.job;
  if (b.profileId) {
    const pj = await profileAsJob(accountId(req), b.profileId);
    if (!pj) throw notFound('Unknown profile');
    job = pj.job;
  }
  if (!job) throw badRequest('Send profileId or job');
  const issues = validateForEngine(req.params.id, job, b.mode);
  res.json({ ok: !issues.some((i) => i.severity === 'error'), issues });
}));

const assignBody = z.object({
  engine: z.string().min(1).max(32),
  mode: z.enum(['encode_only', 'full']).nullable().optional(),
});

enginesRouter.put('/profiles/:profileId', asyncHandler(async (req, res) => {
  const b = assignBody.parse(req.body ?? {});
  const pj = await profileAsJob(accountId(req), req.params.profileId);
  if (!pj) throw notFound('Unknown profile');
  if (b.engine !== 'builtin') {
    const issues = validateForEngine(b.engine, pj.job, b.mode ?? undefined);
    const errors = issues.filter((i) => i.severity === 'error');
    if (errors.length) return res.status(422).json({ error: 'This profile cannot run on that engine.', issues });
  }
  await query(
    `UPDATE output_profiles SET encode_engine = $3, encode_engine_mode = $4, updated_at = now() WHERE id = $1 AND account_id = $2`,
    [req.params.profileId, accountId(req), b.engine, b.engine === 'builtin' ? null : (b.mode ?? null)]
  );
  res.json({ ok: true, profileId: req.params.profileId, engine: b.engine, mode: b.mode ?? null });
}));

// ---------------------------------------------------------------------------
//  Vendor webhooks. Public by necessity (the vendor calls us), so the adapter's
//  verifyWebhook is the authentication, and an engine without one is refused.
// ---------------------------------------------------------------------------
export const engineHooksRouter = Router();
engineHooksRouter.post('/:engineId', express.text({ type: '*/*', limit: '1mb' }), asyncHandler(async (req, res) => {
  const engine = getEngine(req.params.engineId);
  if (!engine || req.params.engineId === 'builtin') throw notFound('Unknown engine');
  const raw = typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {});
  if (!engine.verifyWebhook || !engine.verifyWebhook(req.headers as any, raw)) throw unauthorized('Webhook signature not valid');
  let payload: unknown;
  try { payload = JSON.parse(raw); } catch { throw badRequest('Webhook body is not JSON'); }

  // Which stream is this about? Adapters put the vendor's id on the binding,
  // so we look it up by external_ref rather than trusting an id in the body.
  const ref = String((payload as any)?.__ref ?? req.query.ref ?? '');
  const rows = ref
    ? await query<any>(`SELECT * FROM engine_bindings WHERE engine_id = $1 AND external_ref = $2 ORDER BY created_at DESC LIMIT 1`, [engine.descriptor.id, ref])
    : [];
  const b = rows[0];
  if (!b) return res.status(202).json({ ok: true, applied: 0, note: 'no binding for this reference' });

  const events = engine.normalize(payload, {
    streamKind: b.stream_kind, streamId: b.stream_id,
    handle: { externalRef: b.external_ref, meta: b.meta ?? {} },
  });
  for (const e of events) {
    await applyReport({ kind: e.kind, id: e.id, event: { type: e.type, detail: { engine: engine.descriptor.id, ...(e.detail ?? {}) }, ts_ms: e.ts_ms } });
  }
  res.status(202).json({ ok: true, applied: events.length });
}));
