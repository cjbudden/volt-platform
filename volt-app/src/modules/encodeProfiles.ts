// ============================================================================
//  ENCODING PROFILES AND LADDER GROUPS
//
//    GET    /api/encode-profiles                 renditions
//    POST   /api/encode-profiles
//    PATCH  /api/encode-profiles/:id
//    DELETE /api/encode-profiles/:id
//    GET    /api/encode-profiles/ladders         ladder groups, with rungs RESOLVED
//    POST   /api/encode-profiles/ladders
//    PATCH  /api/encode-profiles/ladders/:id
//    DELETE /api/encode-profiles/ladders/:id
//    PUT    /api/encode-profiles/ladders/:id/members    set membership in order
//    GET    /api/encode-profiles/ladders/:id/preview?height=&fps=   what a source gets
//
//  THE LIST RESOLVES THE RUNGS RATHER THAN RETURNING THE ROW. A ladder group
//  that tracks a live output profile has no rungs of its own; returning the row
//  would show an operator an empty ladder and leave them to work out that the
//  numbers live somewhere else. Resolving costs one join and makes the screen
//  show what will actually be encoded.
//
//  THE PREVIEW IS THE DRY RUN, and it shares fitToSource() with the encode for
//  the same reason the watchfolder's dry run shares classify(): a preview with
//  its own copy of the rule would be confidently wrong exactly when it matters,
//  which here means telling an operator their 720p files will get a 1080p
//  rendition.
//
//  A TRACKING GROUP MAY NOT ALSO HAVE MEMBERS. Two answers to "what are the
//  rungs" means whichever the code reads is arbitrary, so the write refuses it
//  rather than the read picking one.
// ============================================================================
import { Router } from 'express';
import { z } from 'zod';
import { query, one } from '../db';
import { requireAuth, accountId } from '../auth/middleware';
import { asyncHandler, notFound, badRequest, conflict } from '../util/http';
import { writeAudit, actor, patchEntity } from '../services/audit';
import { fitToSource, describeFit } from '../services/encode/ladder';
import { loadLadder, listLadderGroups, ensureTrackingGroup } from '../services/encode/store';

export const encodeProfilesRouter = Router();
encodeProfilesRouter.use(requireAuth);

/* -------------------------------------------------------------- renditions */

const profileBody = z.object({
  name: z.string().min(1).max(120),
  height: z.number().int().min(90).max(4320),
  bitrateKbps: z.number().int().min(50).max(200_000),
  fps: z.number().positive().max(240).nullable().optional(),
  notes: z.string().max(500).nullable().optional(),
});

encodeProfilesRouter.get('/', asyncHandler(async (req, res) => {
  res.json(await query(
    `SELECT p.*,
            (SELECT count(*) FROM encode_ladder_members m WHERE m.profile_id = p.id)::int AS used_in
       FROM encode_profiles p WHERE p.account_id = $1
      ORDER BY p.height DESC, p.bitrate_kbps DESC`,
    [accountId(req)]
  ));
}));

encodeProfilesRouter.post('/', asyncHandler(async (req, res) => {
  const b = profileBody.parse(req.body);
  const who = actor(req);
  const row = await one<any>(
    `INSERT INTO encode_profiles (account_id, name, height, bitrate_kbps, fps, notes, created_by, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$7)
     ON CONFLICT (account_id, name) DO NOTHING
     RETURNING *`,
    [accountId(req), b.name, b.height, b.bitrateKbps, b.fps ?? null, b.notes ?? null, who.userId]
  );
  if (!row) throw conflict(`a rendition called "${b.name}" already exists`);
  await writeAudit(null, { accountId: accountId(req), userId: who.userId, label: who.label,
    action: 'create', entityType: 'encode_profile', entityId: row.id,
    snapshot: { name: b.name, height: b.height, bitrateKbps: b.bitrateKbps } });
  res.status(201).json(row);
}));

const PROFILE_EDITABLE = ['name', 'height', 'bitrate_kbps', 'fps', 'notes'];

encodeProfilesRouter.patch('/:id', asyncHandler(async (req, res) => {
  const cur = await one<any>(
    `SELECT * FROM encode_profiles WHERE id = $1 AND account_id = $2`,
    [req.params.id, accountId(req)]);
  if (!cur) throw notFound('rendition not found');
  const b = req.body ?? {};
  const patch: Record<string, any> = {};
  if ('name' in b) patch.name = b.name;
  if ('height' in b) patch.height = b.height;
  if ('bitrateKbps' in b) patch.bitrate_kbps = b.bitrateKbps;
  if ('fps' in b) patch.fps = b.fps;
  if ('notes' in b) patch.notes = b.notes;
  const who = actor(req);
  // EDITING A RENDITION CHANGES EVERY LADDER CONTAINING IT, which is the whole
  // point of profiles being separate — and is exactly why it is versioned and
  // audited rather than a bare UPDATE.
  const { row, changed } = await patchEntity({
    table: 'encode_profiles', id: cur.id, accountId: accountId(req),
    current: cur, patch, allowed: PROFILE_EDITABLE,
    entityType: 'encode_profile', userId: who.userId, label: who.label,
    expectedVersion: b.version ?? null,
  });
  res.json({ ...row, changed });
}));

encodeProfilesRouter.delete('/:id', asyncHandler(async (req, res) => {
  const used = await query<any>(
    `SELECT g.name FROM encode_ladder_members m
       JOIN encode_ladder_groups g ON g.id = m.group_id
      WHERE m.profile_id = $1`, [req.params.id]);
  // A CASCADE HERE SILENTLY SHRINKS A LADDER. The operator finds out when an
  // asset comes back with three renditions instead of four, months later.
  if (used.length) {
    throw conflict(
      `this rendition is used by ${used.length} ladder${used.length === 1 ? '' : 's'} ` +
      `(${used.map((u) => u.name).join(', ')}); remove it from them first`);
  }
  const row = await one<any>(
    `DELETE FROM encode_profiles WHERE id = $1 AND account_id = $2 RETURNING id, name`,
    [req.params.id, accountId(req)]);
  if (!row) throw notFound('rendition not found');
  const who = actor(req);
  await writeAudit(null, { accountId: accountId(req), userId: who.userId, label: who.label,
    action: 'delete', entityType: 'encode_profile', entityId: row.id, snapshot: { name: row.name } });
  res.status(204).end();
}));

/* ------------------------------------------------------------ ladder groups */

/** A group, with its rungs RESOLVED — see the header. */
async function withRungs(accId: string, g: any) {
  try {
    const l = await loadLadder(g.id, accId);
    return {
      ...g,
      rungs: l.rungs,
      segment_seconds: l.segmentSeconds,
      effective_fps: l.fps,
      origin: l.origin,
      problem: null as string | null,
    };
  } catch (e: any) {
    // A GROUP THAT CANNOT RESOLVE IS SHOWN AS BROKEN, not omitted and not shown
    // as empty. Its live profile may have been deleted, and the operator needs
    // to see that on the screen where they can fix it.
    return { ...g, rungs: [], segment_seconds: null, effective_fps: null,
             origin: null, problem: String(e?.message ?? e) };
  }
}

encodeProfilesRouter.get('/ladders', asyncHandler(async (req, res) => {
  const acc = accountId(req);
  const groups = await listLadderGroups(acc);
  res.json(await Promise.all(groups.map((g) => withRungs(acc, g))));
}));

const ladderBody = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).nullable().optional(),
  tracksOutputProfileId: z.string().uuid().nullable().optional(),
  segmentDur: z.number().positive().max(30).optional(),
  fps: z.number().positive().max(240).optional(),
  packaging: z.enum(['hls', 'dash', 'both']).optional(),
  codecBackend: z.enum(['x264', 'nvenc']).optional(),
  capToSource: z.boolean().optional(),
  isDefault: z.boolean().optional(),
});

/** Only one default per account; the partial unique index enforces it, and this
 *  stands the old one down first so the write is not simply rejected. */
async function clearDefault(accId: string, exceptId?: string) {
  await query(
    `UPDATE encode_ladder_groups SET is_default = false
      WHERE account_id = $1 AND is_default AND ($2::uuid IS NULL OR id <> $2)`,
    [accId, exceptId ?? null]);
}

encodeProfilesRouter.post('/ladders', asyncHandler(async (req, res) => {
  const acc = accountId(req);
  const b = ladderBody.parse(req.body);
  if (b.tracksOutputProfileId) {
    const p = await one<any>(
      `SELECT p.id FROM output_profiles p WHERE p.id = $1 AND p.account_id = $2`,
      [b.tracksOutputProfileId, acc]);
    if (!p) throw badRequest('that live output profile does not belong to this account');
  }
  if (b.isDefault) await clearDefault(acc);
  const who = actor(req);
  const row = await one<any>(
    `INSERT INTO encode_ladder_groups
       (account_id, name, description, tracks_output_profile_id, segment_dur, fps,
        packaging, codec_backend, cap_to_source, is_default, created_by, updated_by)
     VALUES ($1,$2,$3,$4,COALESCE($5,4.00),COALESCE($6,25.000),
             COALESCE($7,'both')::packaging_kind, COALESCE($8,'x264')::codec_backend,
             COALESCE($9,true), COALESCE($10,false), $11,$11)
     ON CONFLICT (account_id, name) DO NOTHING
     RETURNING *`,
    [acc, b.name, b.description ?? null, b.tracksOutputProfileId ?? null,
     b.segmentDur ?? null, b.fps ?? null, b.packaging ?? null, b.codecBackend ?? null,
     b.capToSource ?? null, b.isDefault ?? null, who.userId]
  );
  if (!row) throw conflict(`a ladder called "${b.name}" already exists`);
  await writeAudit(null, { accountId: acc, userId: who.userId, label: who.label,
    action: 'create', entityType: 'encode_ladder_group', entityId: row.id,
    snapshot: { name: b.name, tracks: b.tracksOutputProfileId ?? null } });
  res.status(201).json(await withRungs(acc, row));
}));

const LADDER_EDITABLE = ['name', 'description', 'tracks_output_profile_id', 'segment_dur',
  'fps', 'packaging', 'codec_backend', 'cap_to_source', 'is_default'];

encodeProfilesRouter.patch('/ladders/:id', asyncHandler(async (req, res) => {
  const acc = accountId(req);
  const cur = await one<any>(
    `SELECT * FROM encode_ladder_groups WHERE id = $1 AND account_id = $2`,
    [req.params.id, acc]);
  if (!cur) throw notFound('ladder not found');
  const b = req.body ?? {};
  const patch: Record<string, any> = {};
  if ('name' in b) patch.name = b.name;
  if ('description' in b) patch.description = b.description;
  if ('segmentDur' in b) patch.segment_dur = b.segmentDur;
  if ('fps' in b) patch.fps = b.fps;
  if ('packaging' in b) patch.packaging = b.packaging;
  if ('codecBackend' in b) patch.codec_backend = b.codecBackend;
  if ('capToSource' in b) patch.cap_to_source = !!b.capToSource;
  if ('isDefault' in b) patch.is_default = !!b.isDefault;

  if ('tracksOutputProfileId' in b) {
    if (b.tracksOutputProfileId) {
      const members = await one<{ n: number }>(
        `SELECT count(*)::int n FROM encode_ladder_members WHERE group_id = $1`, [cur.id]);
      // See the header: two answers to "what are the rungs" is not a state to
      // support, so the write refuses rather than the read guessing.
      if (Number(members?.n ?? 0) > 0) {
        throw conflict(
          'this ladder has its own renditions in it; remove them before pointing it at a ' +
          'live profile, or the ladder would have two different answers for what it contains');
      }
    }
    patch.tracks_output_profile_id = b.tracksOutputProfileId;
  }

  if (patch.is_default) await clearDefault(acc, cur.id);
  const who = actor(req);
  const { row, changed } = await patchEntity({
    table: 'encode_ladder_groups', id: cur.id, accountId: acc,
    current: cur, patch, allowed: LADDER_EDITABLE,
    entityType: 'encode_ladder_group', userId: who.userId, label: who.label,
    expectedVersion: b.version ?? null,
  });
  res.json({ ...(await withRungs(acc, row)), changed });
}));

encodeProfilesRouter.delete('/ladders/:id', asyncHandler(async (req, res) => {
  const acc = accountId(req);
  // A LADDER IN USE MUST NOT VANISH. The FK is ON DELETE SET NULL, so deleting
  // one silently re-points a watchfolder at the account default and the folder
  // starts producing a different ladder with nothing on screen having changed.
  const used = await query<any>(
    `SELECT 'watchfolder' AS kind, name FROM watchfolders WHERE ladder_group_id = $1
     UNION ALL
     SELECT 'asset', COALESCE(title, id::text) FROM vod_assets WHERE ladder_group_id = $1 LIMIT 20`,
    [req.params.id]);
  if (used.length) {
    throw conflict(
      `this ladder is in use by ${used.length} thing${used.length === 1 ? '' : 's'} ` +
      `(${used.slice(0, 5).map((u) => `${u.kind} "${u.name}"`).join(', ')}); ` +
      'point them at another ladder first');
  }
  const row = await one<any>(
    `DELETE FROM encode_ladder_groups WHERE id = $1 AND account_id = $2 RETURNING id, name`,
    [req.params.id, acc]);
  if (!row) throw notFound('ladder not found');
  const who = actor(req);
  await writeAudit(null, { accountId: acc, userId: who.userId, label: who.label,
    action: 'delete', entityType: 'encode_ladder_group', entityId: row.id, snapshot: { name: row.name } });
  res.status(204).end();
}));

/* --------------------------------------------------------------- membership */

const membersBody = z.object({ profileIds: z.array(z.string().uuid()).max(12) });

encodeProfilesRouter.put('/ladders/:id/members', asyncHandler(async (req, res) => {
  const acc = accountId(req);
  const g = await one<any>(
    `SELECT * FROM encode_ladder_groups WHERE id = $1 AND account_id = $2`,
    [req.params.id, acc]);
  if (!g) throw notFound('ladder not found');
  const b = membersBody.parse(req.body);
  if (g.tracks_output_profile_id && b.profileIds.length) {
    throw conflict(
      'this ladder tracks a live output profile, so its renditions come from there; ' +
      'stop tracking first if you want to set them by hand');
  }
  const seen = new Set(b.profileIds);
  if (seen.size !== b.profileIds.length) {
    // Two identical variants in a manifest, which players resolve by picking one
    // arbitrarily. The unique index would reject it; saying so is kinder.
    throw badRequest('the same rendition appears twice in that ladder');
  }
  if (b.profileIds.length) {
    const owned = await query<any>(
      `SELECT id FROM encode_profiles WHERE account_id = $1 AND id = ANY($2::uuid[])`,
      [acc, b.profileIds]);
    if (owned.length !== b.profileIds.length) {
      throw badRequest('one of those renditions does not belong to this account');
    }
  }
  await query(`DELETE FROM encode_ladder_members WHERE group_id = $1`, [g.id]);
  for (let i = 0; i < b.profileIds.length; i++) {
    await query(
      `INSERT INTO encode_ladder_members (group_id, profile_id, ordinal) VALUES ($1,$2,$3)`,
      [g.id, b.profileIds[i], (i + 1) * 10]);
  }
  const who = actor(req);
  await writeAudit(null, { accountId: acc, userId: who.userId, label: who.label,
    action: 'update', entityType: 'encode_ladder_group', entityId: g.id,
    snapshot: { members: b.profileIds.length } });
  res.json(await withRungs(acc, g));
}));

/* ------------------------------------------------------------------ preview */

/**
 * What a source of this shape would actually get.
 *
 * Shares fitToSource() with the encode. A preview with its own copy of the rule
 * would tell an operator their 720p files get a 1080p rendition, and they would
 * find out otherwise from an asset list months later.
 */
encodeProfilesRouter.get('/ladders/:id/preview', asyncHandler(async (req, res) => {
  const acc = accountId(req);
  const height = req.query.height == null || req.query.height === ''
    ? null : Number(req.query.height);
  const fps = req.query.fps == null || req.query.fps === '' ? null : Number(req.query.fps);
  const ladder = await loadLadder(req.params.id, acc);
  // null height is passed through as null, NOT coerced to 0: that is the whole
  // difference between "not measured" and "smaller than every rung".
  const fit = fitToSource(ladder, { height, fps });
  res.json({
    ladder: {
      id: ladder.groupId, name: ladder.groupName, origin: ladder.origin,
      rungs: ladder.rungs, segmentSeconds: ladder.segmentSeconds, fps: ladder.fps,
      capToSource: ladder.capToSource,
    },
    source: { height, fps },
    fit, summary: describeFit(fit),
  });
}));

/* --------------------------------------------- mirror a live profile in one go */

encodeProfilesRouter.post('/ladders/mirror', asyncHandler(async (req, res) => {
  const acc = accountId(req);
  const b = z.object({
    outputProfileId: z.string().uuid(),
    name: z.string().min(1).max(120).optional(),
    makeDefault: z.boolean().optional(),
  }).parse(req.body);
  const p = await one<any>(
    `SELECT id, name FROM output_profiles WHERE id = $1 AND account_id = $2`,
    [b.outputProfileId, acc]);
  if (!p) throw badRequest('that live output profile does not belong to this account');
  if (b.makeDefault) await clearDefault(acc);
  const who = actor(req);
  const id = await ensureTrackingGroup(acc, p.id, b.name ?? `Same as ${p.name}`,
    { makeDefault: b.makeDefault, userId: who.userId });
  const row = await one<any>(`SELECT * FROM encode_ladder_groups WHERE id = $1`, [id]);
  res.status(201).json(await withRungs(acc, row));
}));

/** The live profiles a ladder can track, for the picker. */
encodeProfilesRouter.get('/live-profiles', asyncHandler(async (req, res) => {
  res.json(await query(
    `SELECT id, name, rungs, segment_dur, workflow_type, codec_backend, packaging
       FROM output_profiles WHERE account_id = $1 ORDER BY name`,
    [accountId(req)]
  ));
}));
