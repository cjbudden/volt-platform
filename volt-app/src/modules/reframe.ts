// ============================================================================
//  REFRAME API (volt/REFRAME.md): social formats made from a 16:9 asset.
//
//  Per asset (mounted under /api/vod, so the media library's access applies):
//    GET    /api/vod/:id/reframe                       analysis, formats, renders
//    GET    /api/vod/:id/reframe/tracks                the track store (every sample)
//    POST   /api/vod/:id/reframe/analyse               (re)analyse the picture
//    PUT    /api/vod/:id/reframe/formats/:format       move keyframes, or choose who a shot follows
//    POST   /api/vod/:id/reframe/formats/:format/reset back to Volt's framing
//    POST   /api/vod/:id/reframe/formats/:format/approve
//    POST   /api/vod/:id/reframe/render                encode formats ({formats?: [...]})
//  Per account (Admin > Formats and reframing):
//    GET    /api/account-settings/reframe
//    PATCH  /api/account-settings/reframe               admins
// ============================================================================
import { Router } from 'express';
import { z } from 'zod';
import { one, query } from '../db';
import { requireAuth, accountId } from '../auth/middleware';
import { requireMinRole, rankOf, ROLE_RANK } from '../auth/roles';
import { asyncHandler, notFound, badRequest } from '../util/http';
import { actor, writeAudit } from '../services/audit';
import { actorLabel } from '../util/actor';
import { FORMATS, FORMAT_KEYS, SOCIAL_PLATFORMS, applyPatch, isFormatKey, settingsPatch, type FormatKey } from '../services/reframe/formats';
import { cleanKeys, planPath, replanShots, withKeys, type FramingPath, type Overrides } from '../services/reframe/framing';
import {
  formatRow, formatRows, isAudioOnlyAsset, ownedAsset, readTrackStore, saveSettings, settingsFor, tracksRow, writePath,
} from '../services/reframe/store';
import { REFRAME_ANALYSE, queueReframeAnalysis, queueReframeRender, renderJobs } from '../services/jobs/handlers/reframe';

export const reframeRouter = Router();
reframeRouter.use(requireAuth);

const conflict = (message: string, code: string) => Object.assign(new Error(message), { status: 409, code });

async function owned(req: any) {
  const a = await ownedAsset(req.params.id, accountId(req));
  if (!a) throw notFound('VOD asset not found');
  return a;
}

function formatParam(v: string): FormatKey {
  if (!isFormatKey(v)) throw badRequest(`format must be one of ${FORMAT_KEYS.join(', ')}`);
  return v;
}

async function view(a: any) {
  const [tr, rows, settings, jobs] = await Promise.all([tracksRow(a.id), formatRows(a.id), settingsFor(a.owner_account), renderJobs(a.id)]);
  const aj = await one<any>(`SELECT state, progress_pct, progress_note FROM jobs WHERE type = $1 AND payload->>'vodAssetId' = $2
                              ORDER BY created_at DESC LIMIT 1`, [REFRAME_ANALYSE, a.id]).catch(() => null);
  const analysing = !!aj && ['queued', 'running'].includes(aj.state);
  return {
    assetId: a.id,
    title: a.title,
    durationMs: Number(a.duration_ms) || 0,
    media: { file: a.progressive_key ?? a.export_mp4_key ?? null, hls: a.master_key ?? null },
    audioOnly: isAudioOnlyAsset(a),
    analysis: {
      state: tr?.state ?? 'none',
      error: tr?.error ?? null,
      analysedAt: tr?.analysed_at ?? null,
      summary: tr?.summary ?? null,
      progress: analysing ? { state: aj.state, pct: Number(aj.progress_pct) || 0, note: aj.progress_note ?? null } : null,
    },
    settings: { movement: settings.movement, fallback: settings.fallback, priority: settings.priority,
      requireApproval: settings.requireApproval, safeArea: settings.safeArea, formats: settings.formats },
    formats: FORMAT_KEYS.map((f) => {
      const r = rows.find((x) => x.format === f);
      const j = jobs[f];
      return {
        format: f, label: FORMATS[f].label, ratio: FORMATS[f].ratio, width: FORMATS[f].width, height: FORMATS[f].height, for: FORMATS[f].for,
        enabled: settings.formats[f] || !!r,
        path: (r?.path && (r.path as FramingPath).keys) ? r.path : null,
        overrides: r?.overrides ?? {},
        edited: !!r?.edited,
        review: r?.review ?? 'pending', approvedAt: r?.approved_at ?? null, approvedBy: r?.approved_by ?? null,
        render: {
          state: r?.render_state ?? 'none', key: r?.output_key ?? null, width: r?.width ?? null, height: r?.height ?? null,
          bytes: r?.bytes != null ? Number(r.bytes) : null, seconds: r?.render_seconds != null ? Number(r.render_seconds) : null,
          renderedAt: r?.rendered_at ?? null, error: r?.render_error ?? null,
          progress: j && ['queued', 'running'].includes(j.state) ? { state: j.state, pct: j.pct, note: j.note } : null,
        },
      };
    }),
  };
}

async function audit(req: any, assetId: string, what: string, from: unknown, to: unknown) {
  const who = actor(req);
  await writeAudit(null, { accountId: accountId(req), userId: who.userId, label: who.label, action: 'update',
    entityType: 'vod_asset', entityId: assetId, changes: { [what]: { from, to } } }).catch(() => {});
}

reframeRouter.get('/:id/reframe', asyncHandler(async (req, res) => {
  res.json(await view(await owned(req)));
}));

reframeRouter.get('/:id/reframe/tracks', asyncHandler(async (req, res) => {
  const a = await owned(req);
  const store = readTrackStore(await tracksRow(a.id));
  if (!store) throw notFound('This asset has not been analysed yet.');
  res.setHeader('cache-control', 'private, max-age=60');
  res.json(store);
}));

reframeRouter.post('/:id/reframe/analyse', asyncHandler(async (req, res) => {
  const a = await owned(req);
  if (isAudioOnlyAsset(a)) throw conflict('This asset is sound only, so there is no picture to frame.', 'audio_only');
  const jobId = await queueReframeAnalysis(a.id, { force: true, createdBy: (req as any).auth?.sub ?? null });
  if (!jobId) throw conflict('The analysis could not be queued.', 'not_queued');
  await audit(req, a.id, 'reframe_analysis', null, 'queued');
  res.status(202).json({ queued: true, jobId });
}));

/** The store and path a change needs, or a 409 saying what is missing. */
async function editable(a: any, f: FormatKey) {
  const store = readTrackStore(await tracksRow(a.id));
  if (!store) throw conflict('Analyse this asset first: there is nothing to frame from yet.', 'not_analysed');
  const row = await formatRow(a.id, f);
  const settings = await settingsFor(a.owner_account);
  const path = (row?.path as FramingPath | undefined)?.keys ? row!.path as FramingPath : planPath({ store, format: f, settings });
  return { store, row, settings, path };
}

const putBody = z.object({
  keys: z.array(z.any()).max(5000).optional(),
  overrides: z.record(z.string().regex(/^\d+$/), z.object({ follow: z.string().min(1).max(40) }).nullable()).optional(),
}).strict();

reframeRouter.put('/:id/reframe/formats/:format', asyncHandler(async (req, res) => {
  const a = await owned(req);
  const f = formatParam(req.params.format);
  const b = putBody.parse(req.body ?? {});
  if (!b.keys && !b.overrides) throw badRequest('send keys, overrides, or both');
  const { store, row, settings, path: before } = await editable(a, f);
  let path = before;
  const overrides: Overrides = { ...(row?.overrides ?? {}) };
  if (b.overrides) {
    for (const [k, v] of Object.entries(b.overrides)) { if (v) overrides[k] = v; else delete overrides[k]; }
    const shots = Object.keys(b.overrides).map(Number).filter((n) => store.shots.some((s) => s.index === n));
    path = replanShots(path, { store, format: f, settings, overrides }, shots);
  }
  let edited = !!row?.edited;
  if (b.keys) {
    try {
      path = withKeys(path, cleanKeys(b.keys, path, store.shots, store.source.durationSec));
    } catch (e: any) { if (e?.status === 400) throw badRequest(e.message); throw e; }
    edited = true;
  }
  const by = await actorLabel(req);
  const saved = await writePath(a.id, f, path, { overrides, edited, approve: settings.requireApproval ? null : { by } });
  await audit(req, a.id, `reframe_${f}`, { keys: before.keys.length }, { keys: path.keys.length, overrides, edited });
  res.json({ format: f, path: saved.path, overrides: saved.overrides, edited: saved.edited, review: saved.review, renderState: saved.render_state });
}));

reframeRouter.post('/:id/reframe/formats/:format/reset', asyncHandler(async (req, res) => {
  const a = await owned(req);
  const f = formatParam(req.params.format);
  const { store, settings } = await editable(a, f);
  const path = planPath({ store, format: f, settings, overrides: {} });
  const saved = await writePath(a.id, f, path, { overrides: {}, edited: false, approve: settings.requireApproval ? null : { by: await actorLabel(req) } });
  await audit(req, a.id, `reframe_${f}`, 'edited', 'reset to Volt framing');
  res.json({ format: f, path: saved.path, overrides: saved.overrides, edited: saved.edited, review: saved.review, renderState: saved.render_state });
}));

reframeRouter.post('/:id/reframe/formats/:format/approve', asyncHandler(async (req, res) => {
  const a = await owned(req);
  const f = formatParam(req.params.format);
  const row = await formatRow(a.id, f);
  if (!row || !(row.path as FramingPath)?.keys) throw conflict('There is no framing to approve yet. Analyse the asset first.', 'no_path');
  const by = await actorLabel(req);
  const saved = await writePath(a.id, f, row.path as FramingPath, { approve: { by } });
  await audit(req, a.id, `reframe_${f}_review`, row.review, 'approved');
  res.json({ format: f, review: saved.review, approvedAt: saved.approved_at, approvedBy: saved.approved_by });
}));

reframeRouter.post('/:id/reframe/render', asyncHandler(async (req, res) => {
  const a = await owned(req);
  const b = z.object({ formats: z.array(z.string()).max(3).optional() }).strict().parse(req.body ?? {});
  const rows = await formatRows(a.id);
  const want = (b.formats ?? rows.map((r) => r.format)).map((x) => formatParam(x));
  if (!want.length) throw conflict('There is no framing to render yet. Analyse the asset first.', 'no_path');
  const queued: Record<string, string> = {};
  for (const f of want) {
    const r = rows.find((x) => x.format === f);
    if (!r || !(r.path as FramingPath)?.keys) throw conflict(`There is no ${FORMATS[f].ratio} framing to render yet.`, 'no_path');
    queued[f] = await queueReframeRender(a.id, f, (req as any).auth?.sub ?? null);
  }
  await audit(req, a.id, 'reframe_render', null, Object.keys(queued));
  res.status(202).json({ queued });
}));

// ---------------------------------------------------------------- settings
export const reframeSettingsRouter = Router();
reframeSettingsRouter.use(requireAuth);

const PLATFORM_LABEL: Record<string, string> = { youtube: 'YouTube', tiktok: 'TikTok', instagram: 'Instagram', facebook: 'Facebook', x: 'X', dailymotion: 'Dailymotion' };

async function settingsView(req: any) {
  const acct = accountId(req);
  const s = await settingsFor(acct);
  const linked = await query<any>(`SELECT platform::text AS platform, name, external_account, enabled FROM publish_targets
                                    WHERE account_id = $1 AND platform <> 'portal' ORDER BY platform, name`, [acct]).catch(() => []);
  const row = await one<any>(`SELECT updated_at, updated_by FROM reframe_settings WHERE account_id = $1`, [acct]).catch(() => null);
  return {
    settings: s,
    formats: FORMAT_KEYS.map((f) => ({ key: f, label: FORMATS[f].label, ratio: FORMATS[f].ratio, width: FORMATS[f].width, height: FORMATS[f].height, for: FORMATS[f].for })),
    platforms: SOCIAL_PLATFORMS.map((p) => ({ key: p, label: PLATFORM_LABEL[p], accounts: linked.filter((l: any) => l.platform === p) })),
    canEdit: rankOf(String(req.auth?.role ?? 'viewer')) >= ROLE_RANK.admin,
    updatedAt: row?.updated_at ?? null, updatedBy: row?.updated_by ?? null,
    engine: { tracking: 'This server (CPU)', faces: 'YuNet', shots: 'Colour and picture change' },
  };
}

reframeSettingsRouter.get('/', asyncHandler(async (req, res) => { res.json(await settingsView(req)); }));

reframeSettingsRouter.patch('/', requireMinRole('admin'), asyncHandler(async (req, res) => {
  const patch = settingsPatch.parse(req.body ?? {});
  const acct = accountId(req);
  const cur = await settingsFor(acct);
  const next = applyPatch(cur, patch);
  await saveSettings(acct, next, await actorLabel(req));
  const who = actor(req);
  await writeAudit(null, { accountId: acct, userId: who.userId, label: who.label, action: 'update', entityType: 'account_settings',
    entityId: acct, changes: { reframe: { from: cur, to: next } } }).catch(() => {});
  res.json(await settingsView(req));
}));
