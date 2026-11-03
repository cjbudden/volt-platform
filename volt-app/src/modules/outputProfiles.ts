import { Router } from 'express';
import { z } from 'zod';
import { query, one } from '../db';
import { requireAuth, accountId } from '../auth/middleware';
import { asyncHandler, notFound } from '../util/http';
import { requireMinRole } from '../auth/roles';
import { actor, writeAudit } from '../services/audit';

export const profilesRouter = Router();
profilesRouter.use(requireAuth);

profilesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const rows = await query('SELECT * FROM output_profiles WHERE account_id = $1 ORDER BY created_at DESC', [accountId(req)]);
    res.json(rows);
  })
);

const rung = z.object({
  height: z.number(),
  bitrate_kbps: z.number(),
  fps: z.number().default(30),
  codec: z.string().default('h264'),
});

const createSchema = z.object({
  name: z.string().min(1),
  rungs: z.array(rung).min(1),
  packaging: z.enum(['hls', 'dash', 'both']).default('both'),
  workflowType: z.enum(['transcode', 'package_only']).default('transcode'),
  codecBackend: z.enum(['x264', 'nvenc']).default('nvenc'),
  segmentDur: z.number().default(4),
  dvrWindowSec: z.number().default(300),
  retentionDays: z.number().default(30),
  captionOffsetSec: z.number().default(0),
  drmEnabled: z.boolean().default(false),
  overlays: z.array(z.any()).default([]),
  /** Trick-play for Apple and smart-TV players (I-frame playlists, build queue
   *  3.2b). Left out: the account's default for new profiles. */
  trickPlay: z.boolean().optional(),
});

profilesRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const b = createSchema.parse(req.body);
    const row = await one(
      `INSERT INTO output_profiles
         (account_id, name, rungs, packaging, workflow_type, codec_backend,
          segment_dur, dvr_window_sec, retention_days, caption_offset_sec, drm_enabled, overlays, trick_play)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
               COALESCE($13::boolean, (SELECT trick_play_default FROM accounts WHERE id = $1), false)) RETURNING *`,
      [
        accountId(req), b.name, JSON.stringify(b.rungs), b.packaging, b.workflowType, b.codecBackend,
        b.segmentDur, b.dvrWindowSec, b.retentionDays, b.captionOffsetSec, b.drmEnabled, JSON.stringify(b.overlays),
        b.trickPlay ?? null,
      ]
    );
    res.status(201).json(row);
  })
);

// PATCH /api/output-profiles/{id}: the trick-play switch (build queue 3.2b).
// Account administrators. Media made with the profile picks the change up
// within a minute: turned on, the I-frame playlists are made from the
// existing segments (no re-encode) and listed; turned off, they are no longer
// listed or served. Live streams pick it up on their next start.
const patchSchema = z.object({ trickPlay: z.boolean() });
profilesRouter.patch(
  '/:id',
  requireMinRole('admin'),
  asyncHandler(async (req, res) => {
    const b = patchSchema.parse(req.body ?? {});
    const acc = accountId(req);
    const before = await one<any>('SELECT trick_play FROM output_profiles WHERE id = $1 AND account_id = $2', [req.params.id, acc]);
    if (!before) throw notFound('Profile not found');
    const row = await one('UPDATE output_profiles SET trick_play = $3 WHERE id = $1 AND account_id = $2 RETURNING *', [req.params.id, acc, b.trickPlay]);
    if (before.trick_play !== b.trickPlay) {
      const who = actor(req);
      await writeAudit(null, { accountId: acc, userId: who.userId, label: who.label, action: 'update', entityType: 'output_profile', entityId: String(req.params.id),
        changes: { trick_play: { from: before.trick_play, to: b.trickPlay } } });
    }
    res.json(row);
  })
);

profilesRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const row = await one('DELETE FROM output_profiles WHERE id = $1 AND account_id = $2 RETURNING id', [
      req.params.id,
      accountId(req),
    ]);
    if (!row) throw notFound('Profile not found');
    res.status(204).end();
  })
);
