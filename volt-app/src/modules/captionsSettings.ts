// ============================================================================
//  CAPTIONS SETTINGS (Admin > Captions, build queue 1.3).
//
//    GET   /api/account-settings/captions                 the account's engine,
//                                                          every output profile's
//                                                          captions, what may change
//    PATCH /api/account-settings/captions                 { provider } account
//                                                          administrators and owners
//    PATCH /api/account-settings/captions/profiles/:id    { enabled, sourceLang,
//                                                          targets, offsetSec,
//                                                          modelSize } settings: manage
//
//  WHY TWO LEVELS. The account's provider (none | whisper | gladia) is the
//  master switch and decides which engine runs (jobConfig.ts pins it); a
//  profile only opts in and says which languages, how far captions are held
//  back, and which whisper model. Before this screen the provider could only be
//  set in the database, and a profile's captions only through one channel's
//  settings drawer, which quietly changed every other stream in its group.
//
//  Both are read by the encoder when a stream starts and never again, so, as
//  for a channel's own settings (services/settingsLock.ts), a change is refused
//  with 409 locked_while_running while a stream it would affect is running,
//  naming those streams. Re-sending the stored value is not a change.
//
//  Every change is in the audit log.
// ============================================================================
import { Router } from 'express';
import { z } from 'zod';
import { query, one } from '../db';
import { requireAuth, accountId } from '../auth/middleware';
import { requireMinRole, rankOf, ROLE_RANK, can } from '../auth/roles';
import { asyncHandler, notFound } from '../util/http';
import { actor, writeAudit } from '../services/audit';
import { config } from '../config';
import { CAPTION_LANGUAGES, CAPTION_LANGUAGE_CODES } from '../services/captionLanguages';
import { CPU_WHISPER_SIZES } from '../services/captionsPlan';

export const PROVIDERS = ['none', 'whisper', 'gladia'] as const;
export const MODEL_SIZES = ['tiny', 'base', 'small', 'medium', 'large-v3'] as const;

export const captionsSettingsRouter = Router();
captionsSettingsRouter.use(requireAuth);

interface RunningStream { kind: 'channel' | 'event'; id: string; name: string; profileId: string; captions: boolean }

/** Streams of the account with an encoder running now (an instance row not terminated). */
async function runningStreams(acc: string): Promise<RunningStream[]> {
  const rows = await query<any>(
    `SELECT 'channel' AS kind, c.id, c.name, g.output_profile_id AS profile_id, COALESCE(p.captions_enabled, false) AS captions
       FROM channels c JOIN groups g ON g.id = c.group_id LEFT JOIN output_profiles p ON p.id = g.output_profile_id
      WHERE g.account_id = $1 AND EXISTS (SELECT 1 FROM instances i WHERE i.channel_id = c.id AND i.terminated_at IS NULL)
     UNION ALL
     SELECT 'event' AS kind, e.id, e.name, g.output_profile_id AS profile_id, COALESCE(p.captions_enabled, false) AS captions
       FROM events e JOIN groups g ON g.id = e.group_id LEFT JOIN output_profiles p ON p.id = g.output_profile_id
      WHERE g.account_id = $1 AND EXISTS (SELECT 1 FROM instances i WHERE i.event_id = e.id AND i.terminated_at IS NULL)`,
    [acc]);
  return rows.map((r) => ({ kind: r.kind, id: r.id, name: r.name, profileId: r.profile_id, captions: !!r.captions }));
}

function lockedReply(res: any, what: string, streams: RunningStream[]) {
  const names = streams.slice(0, 5).map((s) => s.name).join(', ') + (streams.length > 5 ? ` and ${streams.length - 5} more` : '');
  return res.status(409).json({
    error: `Stop ${names} to change ${what}. Captions settings are read by the encoder when a stream starts.`,
    code: 'locked_while_running', fields: [what],
    running: streams.map((s) => ({ kind: s.kind, id: s.id, name: s.name })),
  });
}

async function view(req: any) {
  const acc = accountId(req);
  const a = await one<any>(`SELECT captions_provider FROM accounts WHERE id = $1`, [acc]);
  if (!a) throw notFound('Account not found');
  const profiles = await query<any>(
    `SELECT p.id, p.name, p.workflow_type, p.captions_enabled, p.caption_source_lang, p.caption_targets,
            p.caption_offset_sec, p.caption_model_size,
            COALESCE((SELECT json_agg(json_build_object('id', g.id, 'name', g.name) ORDER BY g.name)
                        FROM groups g WHERE g.output_profile_id = p.id AND g.account_id = p.account_id), '[]') AS groups,
            (SELECT count(*)::int FROM channels c JOIN groups g ON g.id = c.group_id WHERE g.output_profile_id = p.id) AS channel_count,
            (SELECT count(*)::int FROM events e JOIN groups g ON g.id = e.group_id WHERE g.output_profile_id = p.id) AS event_count
       FROM output_profiles p WHERE p.account_id = $1 ORDER BY p.name`, [acc]);
  const running = await runningStreams(acc);
  const isAdmin = rankOf(String(req.auth?.role ?? 'viewer')) >= ROLE_RANK.admin;
  const canProfiles = can(req, 'settings', 'manage');
  return {
    provider: a.captions_provider as (typeof PROVIDERS)[number],
    canEditProvider: isAdmin,
    providerReason: isAdmin ? null : 'Account administrators and owners choose the captions engine.',
    canEditProfiles: canProfiles,
    profilesReason: canProfiles ? null : 'Changing a profile needs manage on Account settings.',
    // Whether whisper tiny and base run inside the encoder on CPU here, or
    // every whisper size needs the GPU add-on task (captionsPlan.ts).
    cpuInEncoder: config.orchestrator.captionsCpuInEncoder,
    cpuSizes: [...CPU_WHISPER_SIZES],
    modelSizes: [...MODEL_SIZES],
    languages: CAPTION_LANGUAGES,
    profiles: profiles.map((p) => ({
      id: p.id, name: p.name, workflowType: p.workflow_type,
      enabled: !!p.captions_enabled,
      sourceLang: p.caption_source_lang ?? 'auto',
      targets: Array.isArray(p.caption_targets) ? p.caption_targets : [],
      offsetSec: Number(p.caption_offset_sec ?? 0),
      modelSize: p.caption_model_size ?? 'small',
      groups: p.groups, channelCount: p.channel_count, eventCount: p.event_count,
      running: running.filter((s) => s.profileId === p.id).map((s) => ({ kind: s.kind, id: s.id, name: s.name })),
    })),
  };
}

captionsSettingsRouter.get('/', asyncHandler(async (req, res) => { res.json(await view(req)); }));

const providerSchema = z.object({ provider: z.enum(PROVIDERS) });

captionsSettingsRouter.patch('/', requireMinRole('admin'), asyncHandler(async (req, res) => {
  const { provider } = providerSchema.parse(req.body ?? {});
  const acc = accountId(req);
  const before = await one<any>(`SELECT captions_provider FROM accounts WHERE id = $1`, [acc]);
  if (!before) throw notFound('Account not found');
  if (before.captions_provider !== provider) {
    // Only running streams whose profile has captions on are affected: their
    // engine would change, they would stop captioning, or (from none) start
    // only at their next start. Any of those is the form saying one thing and
    // the output another, so all are locked.
    const affected = (await runningStreams(acc)).filter((s) => s.captions);
    if (affected.length) return lockedReply(res, 'the captions engine', affected);
    await one(`UPDATE accounts SET captions_provider = $2 WHERE id = $1 RETURNING id`, [acc, provider]);
    const who = actor(req);
    await writeAudit(null, { accountId: acc, userId: who.userId, label: who.label, action: 'update', entityType: 'account_captions', entityId: acc,
      changes: { captions_provider: { from: before.captions_provider, to: provider } } });
  }
  res.json(await view(req));
}));

const LANG = /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/;
const profileSchema = z.object({
  enabled: z.boolean().optional(),
  /** 'auto' to detect, or the language spoken (any whisper language). */
  sourceLang: z.string().trim().refine((v) => v === 'auto' || LANG.test(v), 'Use auto or a language code such as en').optional(),
  targets: z.array(z.string().refine((v) => CAPTION_LANGUAGE_CODES.has(v), 'Not a caption language Volt can deliver (see /api/caption-languages)'))
    .max(CAPTION_LANGUAGES.length).optional(),
  /** How far captions are held back to stay in step with the picture, in whole seconds (the column is an integer). */
  offsetSec: z.number().int('Whole seconds').min(0).max(60).optional(),
  modelSize: z.enum(MODEL_SIZES).optional(),
}).strict();

const COLS: Record<string, string> = {
  enabled: 'captions_enabled', sourceLang: 'caption_source_lang', targets: 'caption_targets',
  offsetSec: 'caption_offset_sec', modelSize: 'caption_model_size',
};

captionsSettingsRouter.patch('/profiles/:id', asyncHandler(async (req, res) => {
  const body = profileSchema.parse(req.body ?? {});
  const acc = accountId(req);
  if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) throw notFound('Profile not found');
  const p = await one<any>(
    `SELECT id, captions_enabled, caption_source_lang, caption_targets, caption_offset_sec, caption_model_size
       FROM output_profiles WHERE id = $1 AND account_id = $2`, [req.params.id, acc]);
  if (!p) throw notFound('Profile not found');
  const targets = body.targets ? [...new Set(body.targets)] : undefined;
  const next: Record<string, any> = { ...body, ...(targets ? { targets } : {}) };
  const changes: Record<string, { from: any; to: any }> = {};
  for (const [k, col] of Object.entries(COLS)) {
    if (!(k in next)) continue;
    const from = col === 'caption_targets' ? (p[col] ?? []) : col === 'caption_offset_sec' ? Number(p[col] ?? 0) : p[col];
    const to = next[k];
    if (JSON.stringify(from) !== JSON.stringify(to)) changes[col] = { from, to };
  }
  if (Object.keys(changes).length) {
    const running = (await runningStreams(acc)).filter((s) => s.profileId === p.id);
    if (running.length) return lockedReply(res, "this profile's captions", running);
    const sets: string[] = []; const vals: any[] = [p.id];
    for (const [col, c] of Object.entries(changes)) {
      vals.push(col === 'caption_targets' ? JSON.stringify(c.to) : c.to);
      sets.push(col === 'caption_targets' ? `${col} = $${vals.length}::jsonb` : `${col} = $${vals.length}`);
    }
    await one(`UPDATE output_profiles SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING id`, vals);
    const who = actor(req);
    await writeAudit(null, { accountId: acc, userId: who.userId, label: who.label, action: 'update', entityType: 'output_profile', entityId: p.id,
      changes });
  }
  res.json(await view(req));
}));
