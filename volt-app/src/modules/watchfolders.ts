/**
 * WATCHFOLDERS — folders, ordered rules, and the review queue.
 *
 *   GET    /                      folders for the account
 *   POST   /                      create a folder
 *   GET    /:id                   folder + its rules, newest items first
 *   PATCH  /:id                   edit (versioned + audited, like every record)
 *   DELETE /:id                   remove the folder and its rules
 *   GET    /:id/rules             ordered rules
 *   POST   /:id/rules             add one (appended to the end)
 *   PATCH  /:id/rules/:ruleId     edit, including its ordinal
 *   DELETE /:id/rules/:ruleId     remove
 *   POST   /:id/dry-run           "what would happen to this filename?"
 *   POST   /:id/scan              scan now
 *   GET    /:id/items             the log, filterable to the review queue
 *   POST   /:id/items/:itemId/resolve   reprocess or remove a refused file,
 *                                  retry or remove one whose ingest failed
 *
 * THE DRY RUN IS THE MOST USEFUL ROUTE HERE and is deliberately not an
 * afterthought. Rule sets are ordered and first-match-wins, so `*.png` sitting
 * above `slate_*.png` silently swallows every slate, and the only way an
 * operator finds that out is by watching real files land in the wrong place.
 * Typing a filename and being told which rule catches it, before anything moves,
 * turns that from an incident into a question. It shares `classify()` with the
 * scanner, so it cannot drift from what will actually happen.
 *
 * ON-PREM FOLDERS (kind 'site', build queue H2): a folder on a customer's
 * storage, scanned by the site agent of a Hybrid Site with the same rules.
 * Needs the Hybrid Sites licence. Scan now does not apply (the agent scans
 * every pass), and Reprocess asks the agent to move the file back, since it
 * is not on this server. GET /site-options lists what the form may offer.
 *
 * RESOLVING A QUARANTINED ITEM IS TWO REAL ACTIONS, not a status change:
 *   REPROCESS moves the file back to where it came from and marks the row so the
 *             next scan considers it again. Used after correcting a rule.
 *   REMOVE    leaves the file in the review folder and closes the row. The file
 *             is NOT deleted: this API refuses to destroy media, and an operator
 *             who wants it gone can empty the review folder themselves.
 */
import { Router } from 'express';
import { z } from 'zod';
import { rename, mkdir, stat } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { query, one } from '../db';
import { requireAuth, accountId } from '../auth/middleware';
import { asyncHandler, notFound, badRequest } from '../util/http';
import { defineList, parseList, whereSql, pageSql, finishPage } from '../util/listQuery';
import { writeAudit, actor, patchEntity } from '../services/audit';
import { classify, type WatchRule, type FolderPolicy } from '../services/watchfolder/rules';
import { loadFolder, pgItemStore, ingestFolder, syncS3, mirrorQuarantines } from '../services/watchfolder/store';
import { scanFolder } from '../services/watchfolder/scanner';
import { ingestableTargetKinds, libraryKindFor } from '../services/watchfolder/ingest';
import { videoTargetKinds, videoTargetFor } from '../services/watchfolder/videoIngest';
import { companionTargetKinds, isCompanionTarget, bestMatch } from '../services/watchfolder/companionIngest';
import { slateTargetKinds, isSlateTarget } from '../services/watchfolder/slateIngest';
import { resolveImageType } from '../services/watchfolder/imageTypes';
import { pgCompanionStore, videoImageTypes } from '../services/watchfolder/store';
import { hasLicence, requireLicence } from '../services/sites/licences';
import { defaultRulesFor, typesOfPattern, customOrdinal, defaultOrdinals, type FileType } from '../services/watchfolder/defaults';
import { PLACEMENTS, PLACEMENTS_BUILT } from '../services/sites/siteWatchfolders';
import { ApiError } from '../util/http';

/**
 * THE TARGET KINDS A FILE CAN ACTUALLY BE TAKEN IN AS (build queue 1.14-G3a-3).
 * The rule form used to take any text, so a rule saying `document` or `pdf`
 * accepted files that then sat as Waiting for ever: no ingest pass asks for a
 * kind it does not know. The list is read from the two ingest paths
 * themselves, so a kind added there is offered here with no second list to
 * keep in step. A refusing rule takes no kind into anything, so it is not
 * checked.
 */
export function targetKinds(): { kind: string; goesTo: 'images' | 'media' | 'loops' | 'companions'; accepts: FileType[] }[] {
  return [
    ...ingestableTargetKinds().map((kind) => ({ kind, goesTo: 'images' as const, accepts: ['image'] as FileType[] })),
    // The Media Library takes sound-only files too, as audio assets (H2b-4);
    // Loops & Fillers does not: a loop is a picture that plays under a stream.
    ...videoTargetKinds().map((kind) => videoTargetFor(kind) === 'loop'
      ? { kind, goesTo: 'loops' as const, accepts: ['video'] as FileType[] }
      : { kind, goesTo: 'media' as const, accepts: ['video', 'audio'] as FileType[] }),
    // An image to Loops & Fillers as a slate (H2b-3): a stream's fallback still.
    ...slateTargetKinds().map((kind) => ({ kind, goesTo: 'loops' as const, accepts: ['image'] as FileType[] })),
    // Captions and metadata sidecars, attached by name to their video (H2b-2).
    ...companionTargetKinds().map((kind) => ({ kind, goesTo: 'companions' as const, accepts: ['caption', 'sidecar'] as FileType[] })),
  ];
}

const TYPE_WORDS: Record<FileType, string> = { image: 'an image', video: 'a video', audio: 'an audio file', caption: 'a caption file', sidecar: 'a metadata file' };
const GOES_TO_WORDS = { images: 'the Image Library', media: 'the Media Library', loops: 'Loops & Fillers', companions: 'their video in the Media Library' } as const;

/**
 * WHERE A RULE MAY SEND EACH FILE TYPE (build queue H2b (d)). A rule whose
 * pattern can only match one kind of file (`*.png`, `extension: mp4, mov`)
 * may only send it somewhere that takes that kind in: an image to the Image
 * Library, a video to the Media Library or Loops & Fillers. Before this an
 * `*.png -> vod` rule was accepted and every matching file failed at the
 * encode. A pattern that could match anything (`loop_*`) is not checked here;
 * the ingest step still refuses a file it cannot take, with the reason.
 */
function assertFitsType(kind: unknown, matchType: unknown, pattern: unknown) {
  const types = typesOfPattern(String(matchType ?? 'glob'), String(pattern ?? ''));
  if (!types) return;
  const k = targetKinds().find((t) => t.kind === String(kind ?? '').toLowerCase().trim());
  if (!k) return;
  const misfit = types.filter((t) => !k.accepts.includes(t));
  if (!misfit.length) return;
  const where = targetKinds().filter((t) => misfit.every((m) => t.accepts.includes(m)));
  const offer = where.length
    ? `Send it to ${[...new Set(where.map((t) => GOES_TO_WORDS[t.goesTo]))].join(' or ')} instead (${where.map((t) => t.kind).join(', ')}).`
    : 'Volt does not take that kind of file in through a rule yet, so leave it to go to review.';
  throw Object.assign(badRequest(`"${String(pattern)}" matches ${misfit.map((m) => TYPE_WORDS[m]).join(' and ')}, which ${GOES_TO_WORDS[k.goesTo]} does not take. ${offer}`),
    { code: 'target_does_not_fit_type' });
}

/** Insert the defaults a folder lacks, after everything it already has. */
async function addDefaults(folder: { id: string; kind: string }): Promise<any[]> {
  const have = await query<any>(`SELECT ordinal, builtin FROM watchfolder_rules WHERE watchfolder_id = $1`, [folder.id]);
  const missing = defaultRulesFor(folder.kind).filter((d) => !have.some((r) => r.builtin === d.builtin));
  const ords = defaultOrdinals(have, missing.length);
  const added: any[] = [];
  for (const [i, d] of missing.entries()) {
    added.push(await one<any>(
      `INSERT INTO watchfolder_rules(watchfolder_id, ordinal, name, match_type, pattern, target_kind, action, enabled, builtin)
       VALUES ($1,$2,$3,$4,$5,$6,'accept',true,$7) RETURNING *`,
      [folder.id, ords[i], d.name, d.matchType, d.pattern, d.targetKind, d.builtin]));
  }
  return added;
}

/** Defaults this folder does not have (deleted, or made before H2b). */
async function missingDefaults(folder: { id: string; kind: string }): Promise<string[]> {
  const have = await query<any>(`SELECT builtin FROM watchfolder_rules WHERE watchfolder_id = $1 AND builtin IS NOT NULL`, [folder.id]);
  return defaultRulesFor(folder.kind).filter((d) => !have.some((r) => r.builtin === d.builtin)).map((d) => d.builtin);
}

function takesIn(kind: unknown): boolean {
  return !!libraryKindFor(String(kind ?? '')) || !!videoTargetFor(String(kind ?? '')) || isCompanionTarget(String(kind ?? '')) || isSlateTarget(String(kind ?? ''));
}

/**
 * A rule's image type (H2b-3) must be one of the account's types for video,
 * and only a rule that takes images into the Image Library can carry one:
 * nothing else becomes an asset's image.
 */
async function assertImageType(acct: string, imageType: unknown, action: unknown, kind: unknown) {
  if (imageType == null || imageType === '') return;
  if (action === 'reject' || !libraryKindFor(String(kind ?? ''))) {
    throw Object.assign(badRequest('Only a rule that takes images into the Image Library can set an image type.'), { code: 'image_type_needs_image_rule' });
  }
  const types = await videoImageTypes(acct);
  if (!types.some((t) => t.key === imageType)) {
    throw Object.assign(badRequest(`"${String(imageType)}" is not an image type of this account that is switched on. Use one of: ${types.map((t) => t.key).join(', ')}.`),
      { code: 'unknown_image_type' });
  }
}

function assertTargetKind(kind: unknown, what: string) {
  if (takesIn(kind)) return;
  throw badRequest(`"${String(kind ?? '')}" is not a kind Volt takes in, so ${what} would wait for ever. ` +
    `Use one of: ${targetKinds().map((k) => k.kind).join(', ')}.`);
}

export const watchfoldersRouter = Router();
watchfoldersRouter.use(requireAuth);

const FOLDER_EDITABLE = ['name', 'kind', 'config', 'default_target_kind', 'quarantine_path',
  'enabled', 'ladder_group_id', 'placement', 'rights_profile_id'];

/** A rights profile named on a folder must be one of the account's (build queue R1). */
async function ownRightsProfile(acct: string, id: unknown): Promise<string | null> {
  if (id == null || id === '') return null;
  const p = await one<any>(`SELECT id FROM rights_profiles WHERE id::text = $1 AND account_id = $2`, [String(id), acct]);
  if (!p) throw badRequest('That rights profile is not one of this account\'s.');
  return p.id;
}

/** A placement this release can run; 'encode_site' is refused until site encoders (H4). */
function assertPlacement(v: unknown) {
  if (!(PLACEMENTS as readonly string[]).includes(String(v))) throw badRequest(`placement must be one of ${PLACEMENTS.join(', ')}`);
  if (!(PLACEMENTS_BUILT as readonly string[]).includes(String(v))) {
    throw Object.assign(new ApiError(422, 'Encode at site arrives with site encoders. Use Upload and encode in the cloud for now.'), { code: 'placement_not_available' });
  }
}

/** The account's site, for an on-prem folder, and the licence it needs. */
async function siteFor(acct: string, siteId: unknown) {
  await requireLicence(acct, 'hybrid_sites');
  if (!siteId || !/^[0-9a-f-]{36}$/i.test(String(siteId))) throw badRequest('An on-prem folder needs the site whose agent watches it (siteId)');
  const site = await one<any>(`SELECT id, name FROM sites WHERE id = $1 AND account_id = $2`, [siteId, acct]);
  if (!site) throw badRequest('That site is not one of this account\'s sites');
  return site;
}

/** Account-scoped fetch. Every route goes through this: a folder id is a UUID an
 *  operator could paste from anywhere, and the tenant boundary is not optional. */
async function ownedFolder(req: any) {
  const f = await one<any>(
    `SELECT * FROM watchfolders WHERE id = $1 AND account_id = $2`,
    [req.params.id, accountId(req)]
  );
  if (!f) throw notFound('watchfolder not found');
  return f;
}

const createSchema = z.object({
  name: z.string().min(1),
  kind: z.enum(['local', 's3', 'site']).default('local'),
  config: z.record(z.any()).default({}),
  /** kind 'site': the Hybrid Site whose agent watches the folder, and where the work runs. */
  siteId: z.string().nullable().optional(),
  placement: z.string().nullable().optional(),
  defaultTargetKind: z.string().nullable().optional(),
  quarantinePath: z.string().default('_review'),
  /** The ladder every video file this folder accepts is encoded to. Null falls
   *  back to the account default at encode time. */
  ladderGroupId: z.string().uuid().nullable().optional(),
  /** Start with the default rules by file type (H2b). On unless asked not to. */
  defaultRules: z.boolean().default(true),
});

watchfoldersRouter.get('/', asyncHandler(async (req, res) => {
  const rows = await query<any>(
    `SELECT w.*,
            (SELECT count(*) FROM watchfolder_rules r WHERE r.watchfolder_id = w.id)::int AS rule_count,
            (SELECT count(*) FROM watchfolder_items i
              WHERE i.watchfolder_id = w.id AND i.status = 'quarantined')::int AS review_count,
            s.name AS site_name
       FROM watchfolders w
       LEFT JOIN sites s ON s.id = w.site_id
      WHERE w.account_id = $1
      ORDER BY w.created_at DESC`,
    [accountId(req)]
  );
  res.json(rows);
}));

/**
 * What the New watchfolder form may offer for an on-prem folder: whether the
 * account holds Hybrid Sites, its sites, and the placements. Readable by
 * whoever manages watchfolders, who need not be an administrator (the Sites
 * API itself is for administrators).
 */
watchfoldersRouter.get('/site-options', asyncHandler(async (req, res) => {
  const licensed = await hasLicence(accountId(req), 'hybrid_sites');
  const sites = licensed
    ? await query<any>(`SELECT id, name, status FROM sites WHERE account_id = $1 ORDER BY name`, [accountId(req)])
    : [];
  res.json({
    licensed,
    sites: sites.map((x) => ({ id: x.id, name: x.name, status: x.status })),
    placements: PLACEMENTS.map((p) => ({ placement: p, available: (PLACEMENTS_BUILT as readonly string[]).includes(p) })),
  });
}));

watchfoldersRouter.post('/', asyncHandler(async (req, res) => {
  const b = createSchema.parse(req.body);
  if (b.defaultTargetKind) assertTargetKind(b.defaultTargetKind, 'files the rules do not catch');
  let site: { id: string; name: string } | null = null;
  let placement: string | null = null;
  if (b.kind === 'site') {
    site = await siteFor(accountId(req), b.siteId);
    placement = b.placement ?? 'upload_cloud';
    assertPlacement(placement);
    if (!String(b.config?.path ?? '').trim()) throw badRequest('An on-prem folder needs its path on the site host (config.path)');
  }
  const who = actor(req);
  const row = await one<any>(
    `INSERT INTO watchfolders(account_id, name, kind, config, default_target_kind, quarantine_path, created_by, updated_by, ladder_group_id, site_id, placement, rights_profile_id)
     VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$7,$8,$9,$10,$11) RETURNING *`,
    [accountId(req), b.name, b.kind, JSON.stringify(b.config), b.defaultTargetKind ?? null,
     b.quarantinePath, who.userId, b.ladderGroupId ?? null, site?.id ?? null, placement,
     await ownRightsProfile(accountId(req), (req.body ?? {}).rightsProfileId)]
  );
  const rules = b.defaultRules ? await addDefaults(row) : [];
  // The site's agents pick up a new folder on their next config pull.
  if (site) await query(`UPDATE sites SET config_version = config_version + 1 WHERE id = $1`, [site.id]);
  await writeAudit(null, { accountId: accountId(req), userId: who.userId, label: who.label,
    action: 'create', entityType: 'watchfolder', entityId: row.id,
    snapshot: { name: b.name, kind: b.kind, ...(site ? { site: site.name, placement } : {}) } });
  res.status(201).json({ ...row, site_name: site?.name ?? null, rules });
}));

watchfoldersRouter.get('/:id', asyncHandler(async (req, res) => {
  const f = await ownedFolder(req);
  const site = f.site_id ? await one<any>(`SELECT name FROM sites WHERE id = $1`, [f.site_id]) : null;
  const rules = await query<any>(
    `SELECT * FROM watchfolder_rules WHERE watchfolder_id = $1 ORDER BY ordinal`, [f.id]);
  const items = await query<any>(
    `SELECT * FROM watchfolder_items WHERE watchfolder_id = $1 ORDER BY seen_at DESC LIMIT 100`, [f.id]);
  const counts = await one<any>(
    `SELECT count(*) FILTER (WHERE status = 'quarantined')::int AS review,
            count(*) FILTER (WHERE status = 'ingested')::int   AS ingested,
            count(*) FILTER (WHERE status = 'seen')::int       AS pending,
            count(*)::int                                       AS total
       FROM watchfolder_items WHERE watchfolder_id = $1`, [f.id]);
  // The kinds the rule form offers come with the folder, so the console never
  // has its own copy of the list to fall out of step with the server's.
  res.json({ ...f, site_name: site?.name ?? null, rules, items, counts, targetKinds: targetKinds(),
    defaultsMissing: await missingDefaults(f),
    // What a rule's image type may be (H2b-3): the account's types for video.
    imageTypes: await videoImageTypes(accountId(req)) });
}));

watchfoldersRouter.patch('/:id', asyncHandler(async (req, res) => {
  const cur = await ownedFolder(req);
  const b = req.body ?? {};
  const patch: Record<string, any> = {};
  if ('name' in b) patch.name = b.name;
  if ('config' in b) patch.config = b.config;
  if ('defaultTargetKind' in b) {
    if (b.defaultTargetKind) assertTargetKind(b.defaultTargetKind, 'files the rules do not catch');
    patch.default_target_kind = b.defaultTargetKind;
  }
  if ('name' in b && !String(b.name ?? '').trim()) throw badRequest('A watchfolder needs a name.');
  if ('quarantinePath' in b) patch.quarantine_path = b.quarantinePath;
  if ('enabled' in b) patch.enabled = !!b.enabled;
  if ('ladderGroupId' in b) patch.ladder_group_id = b.ladderGroupId;
  if ('rightsProfileId' in b) patch.rights_profile_id = await ownRightsProfile(accountId(req), b.rightsProfileId);
  if ('placement' in b) {
    if (cur.kind !== 'site') throw badRequest('Only an on-prem folder has a placement');
    assertPlacement(b.placement);
    patch.placement = b.placement;
  }
  const who = actor(req);
  // patchEntity, not a bare UPDATE: it versions, audits, and publishes the live
  // `record` frame, so a second admin editing this folder is told.
  const { row, changed } = await patchEntity({
    table: 'watchfolders', id: cur.id, accountId: accountId(req),
    current: cur, patch, allowed: FOLDER_EDITABLE,
    entityType: 'watchfolder', userId: who.userId, label: who.label,
    expectedVersion: b.version ?? null,
  });
  res.json({ ...row, changed });
}));

watchfoldersRouter.delete('/:id', asyncHandler(async (req, res) => {
  const f = await ownedFolder(req);
  await query(`DELETE FROM watchfolders WHERE id = $1`, [f.id]);
  const who = actor(req);
  await writeAudit(null, { accountId: accountId(req), userId: who.userId, label: who.label,
    action: 'delete', entityType: 'watchfolder', entityId: f.id, snapshot: { name: f.name } });
  res.status(204).end();
}));

/* -------------------------------------------------------------- rules ---- */

const ruleSchema = z.object({
  name: z.string().min(1),
  matchType: z.enum(['glob', 'regex', 'extension', 'prefix', 'suffix']).default('glob'),
  pattern: z.string().min(1),
  targetKind: z.string().min(1),
  workflow: z.string().nullable().optional(),
  action: z.enum(['accept', 'reject']).default('accept'),
  rejectReason: z.string().nullable().optional(),
  ordinal: z.number().int().optional(),
  enabled: z.boolean().default(true),
  /** The asset image type an image this rule accepts is for (H2b-3). */
  imageType: z.string().nullable().optional(),
  /** A type word at the end of the name wins over imageType (on by default). */
  imageTypeFromName: z.boolean().default(true),
});

watchfoldersRouter.get('/:id/rules', asyncHandler(async (req, res) => {
  const f = await ownedFolder(req);
  res.json(await query(`SELECT * FROM watchfolder_rules WHERE watchfolder_id=$1 ORDER BY ordinal`, [f.id]));
}));

watchfoldersRouter.post('/:id/rules', asyncHandler(async (req, res) => {
  const f = await ownedFolder(req);
  const b = ruleSchema.parse(req.body);
  if (b.action === 'accept') {
    assertTargetKind(b.targetKind, 'every file this rule accepts');
    assertFitsType(b.targetKind, b.matchType, b.pattern);
  }
  await assertImageType(accountId(req), b.imageType, b.action, b.targetKind);
  // APPENDED, in tens, after the other custom rules. A new rule must never
  // silently outrank the existing ones, and the gaps leave room to insert
  // without renumbering the whole set. It goes ABOVE the default rules by
  // type, which are the catch-all: see services/watchfolder/defaults.ts.
  const have = await query<any>(`SELECT ordinal, builtin FROM watchfolder_rules WHERE watchfolder_id=$1`, [f.id]);
  const ordinal = b.ordinal ?? customOrdinal(have);
  const row = await one<any>(
    `INSERT INTO watchfolder_rules(watchfolder_id, ordinal, name, match_type, pattern,
                                   target_kind, workflow, action, reject_reason, enabled,
                                   image_type, image_type_from_name)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [f.id, ordinal, b.name, b.matchType, b.pattern, b.targetKind, b.workflow ?? null,
     b.action, b.rejectReason ?? null, b.enabled, b.imageType || null, b.imageTypeFromName]
  );
  const who = actor(req);
  await writeAudit(null, { accountId: accountId(req), userId: who.userId, label: who.label,
    action: 'create', entityType: 'watchfolder_rule', entityId: row.id,
    snapshot: { folder: f.id, pattern: b.pattern, targetKind: b.targetKind } });
  res.status(201).json(row);
}));

/**
 * Add the default rules by file type a folder lacks: a folder made before
 * H2b, or one whose default was deleted. Existing rules are not touched and
 * the defaults go after them, so nothing the folder does today changes for a
 * file an existing rule already catches.
 */
watchfoldersRouter.post('/:id/rules/defaults', asyncHandler(async (req, res) => {
  const f = await ownedFolder(req);
  const added = await addDefaults(f);
  if (added.length) {
    const who = actor(req);
    await writeAudit(null, { accountId: accountId(req), userId: who.userId, label: who.label,
      action: 'update', entityType: 'watchfolder', entityId: f.id,
      snapshot: { defaultRulesAdded: added.map((r) => r.builtin) } });
    }
  res.status(added.length ? 201 : 200).json({ added, rules: await query(`SELECT * FROM watchfolder_rules WHERE watchfolder_id=$1 ORDER BY ordinal`, [f.id]) });
}));

watchfoldersRouter.patch('/:id/rules/:ruleId', asyncHandler(async (req, res) => {
  const f = await ownedFolder(req);
  const b = req.body ?? {};
  const sets: string[] = [];
  const params: any[] = [];
  const put = (col: string, v: any) => { params.push(v); sets.push(`${col}=$${params.length}`); };
  if ('name' in b) put('name', b.name);
  if ('matchType' in b) put('match_type', b.matchType);
  if ('pattern' in b) put('pattern', b.pattern);
  if ('targetKind' in b) put('target_kind', b.targetKind);
  if ('workflow' in b) put('workflow', b.workflow);
  if ('action' in b) put('action', b.action);
  if ('rejectReason' in b) put('reject_reason', b.rejectReason);
  if ('ordinal' in b) put('ordinal', b.ordinal);
  if ('enabled' in b) put('enabled', !!b.enabled);
  if ('imageType' in b) put('image_type', b.imageType || null);
  if ('imageTypeFromName' in b) put('image_type_from_name', b.imageTypeFromName !== false);
  if (!sets.length) throw badRequest('nothing to change');
  // The kind is checked against what the rule will be after the change: a rule
  // switched from refusing to accepting needs a kind that is taken in too.
  if ('targetKind' in b || b.action === 'accept' || 'pattern' in b || 'matchType' in b || 'imageType' in b || 'action' in b) {
    const cur = await one<any>(`SELECT target_kind, action, match_type, pattern, image_type FROM watchfolder_rules WHERE id=$1 AND watchfolder_id=$2`,
      [req.params.ruleId, f.id]);
    if (!cur) throw notFound('rule not found');
    const action = 'action' in b ? b.action : cur.action;
    const kind = 'targetKind' in b ? b.targetKind : cur.target_kind;
    if (action === 'accept') {
      assertTargetKind(kind, 'every file this rule accepts');
      assertFitsType(kind, 'matchType' in b ? b.matchType : cur.match_type, 'pattern' in b ? b.pattern : cur.pattern);
    }
    // Checked against the rule as it will be: moving a typed rule off the
    // Image Library needs its type cleared too.
    await assertImageType(accountId(req), 'imageType' in b ? b.imageType : cur.image_type, action, kind);
  }
  params.push(req.params.ruleId, f.id);
  const row = await one<any>(
    `UPDATE watchfolder_rules SET ${sets.join(', ')}
      WHERE id=$${params.length - 1} AND watchfolder_id=$${params.length} RETURNING *`, params);
  if (!row) throw notFound('rule not found');
  res.json(row);
}));

watchfoldersRouter.delete('/:id/rules/:ruleId', asyncHandler(async (req, res) => {
  const f = await ownedFolder(req);
  const r = await one<any>(
    `DELETE FROM watchfolder_rules WHERE id=$1 AND watchfolder_id=$2 RETURNING id`,
    [req.params.ruleId, f.id]);
  if (!r) throw notFound('rule not found');
  res.status(204).end();
}));

/* ------------------------------------------------------------ dry run ---- */

/**
 * What WOULD happen to a file with this name.
 *
 * Shares `classify()` with the scanner, so the answer cannot drift from the
 * behaviour. Returns the whole ordered rule list alongside the decision, with
 * the winner marked, because "slate_open.png becomes a poster" is only half the
 * answer: the operator needs to see that `*.png` sits above `slate_*.png`.
 */
watchfoldersRouter.post('/:id/dry-run', asyncHandler(async (req, res) => {
  const f = await ownedFolder(req);
  const name = String(req.body?.filename ?? '').trim();
  if (!name) throw badRequest('filename is required');
  const sizeBytes = req.body?.sizeBytes == null ? null : Number(req.body.sizeBytes);

  const rules = await query<any>(
    `SELECT * FROM watchfolder_rules WHERE watchfolder_id=$1 ORDER BY ordinal`, [f.id]);
  const mapped: WatchRule[] = rules.map((r) => ({
    id: r.id, ordinal: r.ordinal, name: r.name, matchType: r.match_type, pattern: r.pattern,
    targetKind: r.target_kind, workflow: r.workflow, action: r.action,
    rejectReason: r.reject_reason, enabled: r.enabled,
    imageType: r.image_type ?? null, imageTypeFromName: r.image_type_from_name !== false,
  }));
  const policy: FolderPolicy = {
    defaultTargetKind: f.default_target_kind ?? null,
    defaultWorkflow: f.config?.default_workflow ?? null,
    minBytes: f.config?.min_bytes ?? null,
    maxBytes: f.config?.max_bytes ?? null,
  };
  const decision = classify(name, sizeBytes, mapped, policy);

  // THE TYPE AND THE ASSET (H2b-3): what an image would be for, and which
  // asset it, or a caption, would go with, asked of the same functions the
  // ingest pass runs. `asset` is null when nothing in the folder fits yet.
  let imageType: any = null, asset: any = null, libraryKind: string | null = null;
  if (decision.decision === 'accept') {
    const kind = libraryKindFor(decision.targetKind);
    const rule = mapped.find((r) => r.id === decision.ruleId);
    if (kind) {
      const t = resolveImageType(name, { imageType: rule?.imageType, imageTypeFromName: rule?.imageTypeFromName }, await videoImageTypes(accountId(req)));
      libraryKind = kind === 'other' && t ? t.libraryKind : kind;
      if (t?.typeKey) imageType = { key: t.typeKey, label: t.label, from: t.from, word: t.word };
    }
    if ((imageType && kind) || isCompanionTarget(decision.targetKind)) {
      const m = bestMatch(name, await pgCompanionStore.candidates(f.id));
      if (m) {
        const v = m.assetId ? await one<any>(`SELECT id, title FROM vod_assets WHERE id = $1`, [m.assetId]) : null;
        asset = { objectKey: m.objectKey, id: v?.id ?? null, title: v?.title ?? null, waiting: !m.assetId };
      }
    }
  }
  res.json({
    filename: name,
    decision,
    imageType,
    libraryKind,
    asset,
    quarantinePath: f.quarantine_path,
    rules: mapped.map((r) => ({
      id: r.id, ordinal: r.ordinal, name: r.name, pattern: r.pattern,
      targetKind: r.targetKind, action: r.action, enabled: r.enabled, imageType: r.imageType ?? null,
      winner: 'ruleId' in decision && decision.ruleId === r.id,
    })),
  });
}));

/* --------------------------------------------------------------- scan ---- */

watchfoldersRouter.post('/:id/scan', asyncHandler(async (req, res) => {
  const f = await ownedFolder(req);
  if (f.kind === 'site') {
    throw Object.assign(new ApiError(409, 'This folder is on a site: its agent scans it on every pass, so there is nothing to scan from here.'), { code: 'scanned_at_site' });
  }
  const loaded = await loadFolder(f.id);
  if (!loaded) throw badRequest('this folder is disabled or has no path');
  try {
    // An S3 folder is mirrored into staging first; the scan below then sees
    // it as a local folder and its quarantines are mirrored back.
    const sync = f.kind === 's3' ? await syncS3(f.id) : null;
    const result = await scanFolder(loaded, pgItemStore);
    if (f.kind === 's3') await mirrorQuarantines(f.id, result.quarantined);
    // AND THEN INGEST, because an operator who presses Scan and sees "3 accepted"
    // with nothing in the library has been told a fact about an internal state
    // machine rather than an answer. Accepting and ingesting are two steps in the
    // code; they are one action at the desk.
    const ingest = await ingestFolder(f.id);
    await query(`UPDATE watchfolders SET last_scan_at=now(), last_scan_error=NULL WHERE id=$1`, [f.id]);
    res.json({ ...result, ingest, ...(sync ? { s3: sync } : {}) });
  } catch (e: any) {
    const msg = String(e?.message ?? e).slice(0, 500);
    await query(`UPDATE watchfolders SET last_scan_at=now(), last_scan_error=$2 WHERE id=$1`, [f.id, msg]);
    throw badRequest(msg);
  }
}));

/* -------------------------------------------------------------- items ---- */

// The list standard (util/listQuery.ts). status keeps working as before
// (status=quarantined), and now also takes a comma list.
const itemList = defineList({
  path: '/api/watchfolders/:id/items',
  fields: {
    id: { sql: 'i.id', type: 'number' },
    object_key: { sql: 'i.object_key', type: 'string', doc: 'The file path in the folder' },
    status: { sql: 'i.status', type: 'string', doc: 'seen, ingested, quarantined, failed, reprocessed or removed' },
    size_bytes: { sql: 'i.size_bytes', type: 'number' },
    target_kind: { sql: 'i.target_kind', type: 'string' },
    workflow: { sql: 'i.workflow', type: 'string' },
    matched_rule_id: { sql: 'i.matched_rule_id', type: 'uuid' },
    rule_name: { sql: 'r.name', type: 'string' },
    media_file_id: { sql: 'i.media_file_id', type: 'uuid' },
    reason: { sql: 'i.reason', type: 'string', sort: false },
    seen_at: { sql: 'i.seen_at', type: 'timestamp', notNull: true },
    resolved_at: { sql: 'i.resolved_at', type: 'timestamp' },
  },
  search: ['object_key', 'reason', 'rule_name'],
  defaultSort: '-seen_at',
  defaultLimit: 200,
  maxLimit: 500,
});

watchfoldersRouter.get('/:id/items', asyncHandler(async (req, res) => {
  const f = await ownedFolder(req);
  const base: unknown[] = [f.id];
  const params = [...base];
  const pl = parseList(itemList, req.query, params);
  const from = `FROM watchfolder_items i
       LEFT JOIN watchfolder_rules r ON r.id = i.matched_rule_id
      WHERE i.watchfolder_id = $1${whereSql(pl)}`;
  const rows = await query<any>(`SELECT i.*, r.name AS rule_name ${from} ${pageSql(pl)}`, params);
  const cParams = [...base];
  const cWhere = pl.count ? whereSql(parseList(itemList, { ...req.query, cursor: undefined, offset: undefined }, cParams)) : '';
  const total = pl.count ? (await one<any>(`SELECT count(*)::int AS n FROM watchfolder_items i LEFT JOIN watchfolder_rules r ON r.id = i.matched_rule_id WHERE i.watchfolder_id = $1${cWhere}`, cParams))?.n : undefined;
  res.json({ items: finishPage(req, res, pl, rows, total) });
}));

const resolveSchema = z.object({
  resolution: z.enum(['reprocess', 'remove']),
  note: z.string().max(500).optional(),
});

watchfoldersRouter.post('/:id/items/:itemId/resolve', asyncHandler(async (req, res) => {
  const f = await ownedFolder(req);
  const b = resolveSchema.parse(req.body);
  const item = await one<any>(
    `SELECT * FROM watchfolder_items WHERE id=$1 AND watchfolder_id=$2`,
    [req.params.itemId, f.id]);
  if (!item) throw notFound('item not found');
  // FAILED IS RESOLVABLE TOO (build queue 1.14-G3a-3). The console offered both
  // buttons on Failed rows and this refused them, so a failed file could only
  // be read about. A failed file matched a rule and was never moved: it is
  // still in the drop folder, so it needs no move, only another ingest pass.
  if (item.status !== 'quarantined' && item.status !== 'failed') {
    throw badRequest(`this item is ${item.status}, so there is nothing to resolve`);
  }

  const who = actor(req);

  if (item.status === 'failed' && b.resolution === 'reprocess') {
    // RETRY: back to Waiting with the claim cleared, so the next ingest pass
    // (every minute, or Scan now) takes it again. If it fails again the new
    // reason is recorded and the row is Failed again; nothing loops.
    await query(
      `UPDATE watchfolder_items
          SET status='seen', resolved_at=NULL, resolved_by=$2, resolution_note=$3,
              reason=$4
        WHERE id=$1 AND status='failed'`,
      [item.id, who.userId, b.note ?? null, `retrying after: ${String(item.reason ?? 'the ingest failed')}`.slice(0, 500)]);
  } else if (b.resolution === 'reprocess' && f.kind === 'site') {
    // THE FILE IS ON THE CUSTOMER'S STORAGE, not here. The row asks the site
    // agent to move it back (site_action 'return'); it does so on its next
    // pass and the scan after that decides it again. If it cannot, the row
    // returns to Needs review with the reason.
    await query(
      `UPDATE watchfolder_items
          SET status='reprocessed', site_action='return', resolved_at=now(), resolved_by=$2, resolution_note=$3
        WHERE id=$1`, [item.id, who.userId, b.note ?? null]);
  } else if (b.resolution === 'reprocess') {
    // PUT IT BACK WHERE IT CAME FROM, then mark the row. The file has to exist in
    // the drop folder again before the row says it will be reconsidered, or a
    // failed move leaves a queue entry claiming a scan will pick up a file that
    // is not there.
    const root = String(f.config?.path ?? '');
    if (!root) throw badRequest('this folder has no path, so nothing can be moved back');
    const from = join(root, String(item.quarantine_key).split('/').join(sep));
    const to = join(root, String(item.object_key).split('/').join(sep));
    try {
      await stat(from);
    } catch {
      throw badRequest('the file is no longer in the review folder; somebody has already moved or deleted it');
    }
    await mkdir(join(to, '..'), { recursive: true });
    await rename(from, to);
    await query(
      `UPDATE watchfolder_items
          SET status='reprocessed', resolved_at=now(), resolved_by=$2, resolution_note=$3
        WHERE id=$1`, [item.id, who.userId, b.note ?? null]);
  } else {
    // REMOVE CLOSES THE ROW AND LEAVES THE FILE. This API does not delete media:
    // the review folder is a person's to empty, and a queue action that silently
    // destroys the only copy of something is exactly what quarantine exists to
    // prevent.
    await query(
      `UPDATE watchfolder_items
          SET status='removed', resolved_at=now(), resolved_by=$2, resolution_note=$3
        WHERE id=$1`, [item.id, who.userId, b.note ?? null]);
  }

  // FILED AGAINST THE FOLDER. audit_log.entity_id is a UUID and an item's id
  // is a number, so filing it under the item failed the insert AFTER the row
  // had changed: every Reprocess and Dismiss from the console answered 400
  // while the queue had in fact moved on (found by build queue 1.14-G3a-3).
  await writeAudit(null, { accountId: accountId(req), userId: who.userId, label: who.label,
    action: 'update', entityType: 'watchfolder', entityId: f.id,
    snapshot: { item: String(item.id), was: item.status, resolution: b.resolution, objectKey: item.object_key, note: b.note ?? null } });

  const updated = await one<any>(`SELECT * FROM watchfolder_items WHERE id=$1`, [item.id]);
  res.json(updated);
}));
