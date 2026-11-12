// ============================================================================
//  AFTER ENCODING, BY HAND: subtitles and an AI description for one asset
//  (services/media/postProcess.ts, Christian 12 Nov 2026).
//
//    GET  /api/vod/post-process/options   what this deployment and account
//                                          can do: Whisper here, add-ons that
//                                          take assets, AI descriptions. For
//                                          the Ingest Rules form and the asset.
//    GET  /api/vod/:id/post-process        the asset's plan and how each step
//                                          went, plus the options
//    POST /api/vod/:id/post-process        { subtitles: off|whisper|addon,
//                                            addonId?, spoken?, languages?,
//                                            model?, describe?, replace? }
//
//  The same steps an ingest rule asks for, started now for an asset from any
//  door (a recording's clip, an asset ingested before rules asked). Feature
//  `vod`: reading needs view, asking needs manage (auth/roles.ts, by method).
// ============================================================================
import { Router } from 'express';
import { z } from 'zod';
import { one, query } from '../db';
import { accountId } from '../auth/middleware';
import { asyncHandler, notFound, ApiError } from '../util/http';
import { actorLabel } from '../util/actor';
import { writeAudit, actor } from '../services/audit';
import { CAPTION_LANGUAGES } from '../services/captionLanguages';
import { MODEL_SIZES, requestPostProcess, whisperStatus, mediaInput, type Plan } from '../services/media/postProcess';
import { DESCRIBE_ADDON, descriptionField, hasValue } from '../services/media/aiDescribe';
import { aiConfigured } from '../services/media/aiDetails';
import { accountAddons } from '../services/invoicing/addons';
import { resolveEffectiveFields } from './metadataSchemas';

export const vodPostProcessRouter = Router();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function owned(id: string, acct: string) {
  if (!UUID.test(id)) return null;
  return one<any>(`
    SELECT v.*, COALESCE(g.account_id, v.account_id) AS owner_account
      FROM vod_assets v
      LEFT JOIN channels c ON c.id = v.channel_id
      LEFT JOIN events e ON e.id = v.event_id
      LEFT JOIN groups g ON g.id = COALESCE(c.group_id, e.group_id)
     WHERE v.id = $1 AND COALESCE(g.account_id, v.account_id) = $2`, [id, acct]);
}

/** AI descriptions for the account: offered at all (the model's key), on, and what is left this month. */
async function aiState(acct: string) {
  if (!aiConfigured()) return { offered: false as const, on: false };
  const a = (await accountAddons(acct)).find((x) => x.key === DESCRIBE_ADDON);
  if (!a || !(a.offered || a.on)) return { offered: false as const, on: false };
  return { offered: true as const, on: a.on, name: a.name, unit: a.unit, monthlyUsd: a.monthlyUsd, includedQuantity: a.includedQuantity, allowance: a.allowance, pack: a.pack };
}

async function options(acct: string) {
  const [w, addons, ai] = await Promise.all([
    whisperStatus(),
    query<any>(`SELECT id, name, kind, category FROM addon_services WHERE account_id = $1 AND enabled AND 'vod_asset' = ANY(accepts) ORDER BY name`, [acct]),
    aiState(acct),
  ]);
  return {
    whisper: { ready: w.whisper, translate: w.mt,
      reason: w.whisper ? null : 'Whisper (faster-whisper) is not installed for this server\'s Python. Install it, or make subtitles with an add-on.' },
    addons: addons.map((x: any) => ({ id: x.id, name: x.name, simulated: x.kind === 'demo', category: x.category })),
    ai,
    models: [...MODEL_SIZES],
    languages: CAPTION_LANGUAGES,
  };
}

vodPostProcessRouter.get('/post-process/options', asyncHandler(async (req, res) => {
  res.json(await options(accountId(req)));
}));

async function view(a: any, acct: string) {
  const fields = a.schema_id ? (await resolveEffectiveFields(a.schema_id, acct).catch(() => null))?.fields ?? [] : [];
  const key = descriptionField(fields as any);
  const caps = await query<any>(`SELECT language, source FROM vod_asset_files WHERE asset_id = $1 AND kind = 'captions' AND COALESCE((report->>'ok')::boolean, false)`, [a.id]);
  return {
    postProcess: a.post_process ?? null,
    hasMedia: !!(await mediaInput(a)),
    captions: caps.map((c: any) => ({ language: c.language, source: c.source })),
    description: { field: key, filled: key ? hasValue(a.metadata?.[key]) : false, contentType: !!a.schema_id },
    options: await options(acct),
  };
}

vodPostProcessRouter.get('/:id/post-process', asyncHandler(async (req, res) => {
  const acct = accountId(req);
  const a = await owned(String(req.params.id), acct);
  if (!a) throw notFound('VOD asset not found');
  res.json(await view(a, acct));
}));

const LANG = /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/;
const body = z.object({
  subtitles: z.enum(['off', 'whisper', 'addon']).default('off'),
  addonId: z.string().regex(UUID).nullish(),
  spoken: z.string().trim().refine((v) => v === 'auto' || LANG.test(v), 'auto or a language code such as en').default('auto'),
  languages: z.array(z.string().trim().regex(LANG)).max(10).default([]),
  model: z.enum(MODEL_SIZES).default('base'),
  describe: z.boolean().default(false),
  /** Write the description even though the asset has one. */
  replace: z.boolean().default(false),
});

vodPostProcessRouter.post('/:id/post-process', asyncHandler(async (req, res) => {
  const acct = accountId(req);
  const a = await owned(String(req.params.id), acct);
  if (!a) throw notFound('VOD asset not found');
  const b = body.parse(req.body ?? {});
  if (b.subtitles === 'off' && !b.describe) throw new ApiError(400, 'Ask for subtitles, a description, or both.');
  const opts = await options(acct);
  if (b.subtitles === 'whisper' && !opts.whisper.ready) throw Object.assign(new ApiError(409, opts.whisper.reason!), { code: 'whisper_missing' });
  if (b.subtitles === 'addon') {
    if (!b.addonId) throw new ApiError(422, 'addonId: choose the add-on that makes the subtitles');
    if (!opts.addons.some((x) => x.id === b.addonId)) throw new ApiError(422, 'That add-on is not switched on for this account, or does not take assets.');
  }
  if (b.describe) {
    if (!opts.ai.offered) throw Object.assign(new ApiError(409, 'AI descriptions is not available on this deployment.'), { code: 'ai_not_offered' });
    if (!opts.ai.on) throw Object.assign(new ApiError(403, 'AI descriptions is an add-on: an account administrator can turn it on in Admin, Billing.'), { code: 'addon_required' });
  }
  const by = (await actorLabel(req)) ?? 'someone';
  const plan: Plan = {
    subtitles: b.subtitles, addonId: b.subtitles === 'addon' ? b.addonId ?? null : null, spoken: b.spoken,
    languages: [...new Set(b.languages)], model: b.model, describe: b.describe ? 'ai' : 'off', replace: b.replace, by,
  };
  let pp;
  try { pp = await requestPostProcess(a.id, plan); }
  catch (e: any) { if (e?.status) throw new ApiError(e.status, e.message); throw e; }
  const who = actor(req);
  await writeAudit(null, { accountId: acct, userId: who.userId, label: who.label, action: 'update', entityType: 'vod_asset', entityId: a.id,
    changes: { post_process: { from: null, to: { subtitles: plan.subtitles, addonId: plan.addonId, languages: plan.languages, describe: plan.describe } } } });
  const after = await owned(a.id, acct);
  res.status(202).json({ ...(await view(after, acct)), postProcess: pp });
}));
