import { Router } from 'express';
import { z } from 'zod';
import { query, one } from '../db';
import { requireAuth, accountId } from '../auth/middleware';
import { asyncHandler, notFound, conflict, ApiError } from '../util/http';
import { validateSchemaFields, validateMetadata, mergeFields, type SchemaField } from '../services/metadataValidator';
import { actor, patchEntity, writeAudit, entityHistory, VersionConflict } from '../services/audit';
import { ensureStandardTypes } from '../services/contentTypes';
import { applyAccountLists } from '../services/metadataLists';

const SCHEMA_EDITABLE = ['name', 'description', 'fields', 'target_kind', 'domain', 'extends_id', 'applies_to', 'schema_org_type'];

/**
 * Resolve a schema's EFFECTIVE fields by walking its extends chain (parent
 * fields first, child overrides by key). Guards against cycles. Returns null if
 * the schema isn't found / not owned. Shared by events/channels/vod validation.
 */
export async function resolveEffectiveFields(schemaId: string, account: string): Promise<{ targetKind: string; fields: SchemaField[] } | null> {
  const seen = new Set<string>();
  let current = await one<any>(`SELECT * FROM metadata_schemas WHERE id=$1 AND account_id=$2`, [schemaId, account]);
  if (!current) return null;
  const targetKind = current.target_kind ?? 'vod';
  const chain: any[] = [];
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    chain.push(current);
    current = current.extends_id ? await one<any>(`SELECT * FROM metadata_schemas WHERE id=$1 AND account_id=$2`, [current.extends_id, account]) : null;
  }
  // parent-most first → merge down so children override
  let fields: SchemaField[] = [];
  for (const s of chain.reverse()) fields = mergeFields(fields, s.fields as SchemaField[]);
  return { targetKind, fields };
}

/**
 * Validate an entity's (channel/event/vod) schema assignment + values. Enforces
 * the schema's target_kind and validates values against the effective (merged)
 * fields. Returns the cleaned pair to persist. schemaId null → clears metadata.
 */
export async function validateEntityMetadata(
  account: string,
  schemaId: string | null | undefined,
  metadata: Record<string, any> | undefined,
  kinds: string[],
  imageFolder?: string
): Promise<{ schemaId: string | null; metadata: Record<string, any> }> {
  if (!schemaId) return { schemaId: null, metadata: metadata ?? {} };
  const resolved = await resolveEffectiveFields(schemaId, account);
  if (!resolved) throw notFound('metadata schema not found');
  if (resolved.targetKind !== 'any' && !kinds.includes(resolved.targetKind))
    throw new ApiError(422, `schema targets '${resolved.targetKind}', cannot bind to ${kinds.join('/')}`);
  // Image fields given as a web address are downloaded into the Image Library
  // first (services/media/libraryImages.ts), under media/<owner name>/.
  const { internaliseImages, ownerFolder } = await import('../services/media/libraryImages');
  const withImages = await internaliseImages(account, resolved.fields, metadata ?? {}, imageFolder ?? ownerFolder(kinds[0] ?? 'owner', metadata?.name));
  // Owners keep keys the type does not define (see validateMetadata).
  return { schemaId, metadata: validateMetadata(resolved.fields, withImages, 'keep') };
}

/** Named, typed metadata field sets (Movie, Episode, Clip, …) per tenant. */
export const metadataSchemasRouter = Router();
metadataSchemasRouter.use(requireAuth);

metadataSchemasRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    // The standard types are part of every account: seed on first sight so a
    // new client never meets an empty list. ?appliesTo=radio|tv|event|vod
    // narrows to the types offered for that owner.
    await ensureStandardTypes(accountId(req));
    const applies = typeof req.query.appliesTo === 'string' ? req.query.appliesTo : null;
    const rows = await query(
      `SELECT * FROM metadata_schemas WHERE account_id = $1
         ${applies ? 'AND ($2 = ANY(applies_to) OR applies_to = \'{}\')' : ''}
        ORDER BY is_standard DESC, name`,
      applies ? [accountId(req), applies] : [accountId(req)]
    );
    res.json(rows);
  })
);

metadataSchemasRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const row = await one(`SELECT * FROM metadata_schemas WHERE id = $1 AND account_id = $2`, [
      req.params.id,
      accountId(req),
    ]);
    if (!row) throw notFound('Schema not found');
    res.json(row);
  })
);

const fieldSchema = z.object({
  key: z.string().min(1),
  label: z.string().optional(),
  type: z.enum(['string', 'text', 'number', 'boolean', 'date', 'enum', 'url', 'tags', 'reference', 'image', 'content']),
  required: z.boolean().optional(),
  options: z.array(z.string()).optional(),
  // An account list ('genres') the options come from; they are filled in here.
  optionsList: z.string().optional(),
  multiple: z.boolean().optional(),
  refDomain: z.string().optional(),
  relation: z.string().optional(),   // content: the relationship (services/contentLinks.ts)
  targetTypes: z.array(z.string()).optional(),
  epg: z.string().optional(),        // EPG slot, validated in validateSchemaFields
  schemaOrg: z.string().optional(),  // schema.org property
});
const upsertSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  fields: z.array(fieldSchema).default([]),
  targetKind: z.enum(['vod', 'event', 'channel', 'any']).default('vod'),
  domain: z.string().optional(),
  extendsId: z.string().uuid().optional(), // schema composition (inherit fields)
  appliesTo: z.array(z.enum(['radio', 'tv', 'event', 'vod'])).optional(),
  schemaOrgType: z.string().optional(),
});

metadataSchemasRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = upsertSchema.parse(req.body);
    // Fields linked to an account list (Genres) take their options from it.
    body.fields = await applyAccountLists(accountId(req), body.fields as SchemaField[]) as any;
    validateSchemaFields(body.fields); // dup keys / enum options etc.
    if (body.extendsId) {
      const parent = await one(`SELECT id FROM metadata_schemas WHERE id=$1 AND account_id=$2`, [body.extendsId, accountId(req)]);
      if (!parent) throw notFound('extendsId schema not found');
    }
    const exists = await one(`SELECT id FROM metadata_schemas WHERE account_id = $1 AND name = $2`, [
      accountId(req),
      body.name,
    ]);
    if (exists) throw conflict(`Schema "${body.name}" already exists`);
    const who = actor(req);
    const row = await one<any>(
      `INSERT INTO metadata_schemas(account_id, name, description, fields, target_kind, domain, extends_id, applies_to, schema_org_type, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10) RETURNING *`,
      [accountId(req), body.name, body.description ?? null, JSON.stringify(body.fields), body.targetKind, body.domain ?? null, body.extendsId ?? null,
       body.appliesTo ?? [], body.schemaOrgType ?? null, who.userId]
    );
    await writeAudit(null, { accountId: accountId(req), userId: who.userId, label: who.label,
      action: 'create', entityType: 'metadata_schema', entityId: row.id, snapshot: { name: row.name } });
    res.status(201).json(row);
  })
);

/** Edit a schema. PATCH = partial (null clears); PUT = alias. Versioned + audited;
 *  optimistic concurrency via If-Match (or a `version` field). */
const editSchema = asyncHandler(async (req, res) => {
  const body = upsertSchema.partial().extend({ version: z.number().int().optional() }).parse(req.body);
  const raw = (req.body ?? {}) as Record<string, unknown>;
  const has = (k: string) => Object.prototype.hasOwnProperty.call(raw, k);
  if (body.fields) {
    body.fields = await applyAccountLists(accountId(req), body.fields as SchemaField[]) as any;
    validateSchemaFields(body.fields);
  }
  const current = await one<any>(`SELECT * FROM metadata_schemas WHERE id = $1 AND account_id = $2`, [req.params.id, accountId(req)]);
  if (!current) throw notFound('Schema not found');

  const patch: Record<string, any> = {};
  if (has('name')) patch.name = body.name;
  if (has('description')) patch.description = body.description ?? null;
  if (has('fields')) patch.fields = body.fields;
  if (has('targetKind')) patch.target_kind = body.targetKind;
  if (has('domain')) patch.domain = body.domain ?? null;
  if (has('extendsId')) patch.extends_id = body.extendsId ?? null;
  if (has('appliesTo')) patch.applies_to = body.appliesTo ?? [];
  if (has('schemaOrgType')) patch.schema_org_type = body.schemaOrgType ?? null;

  const im = req.get('If-Match');
  const expectedVersion = im ? parseInt(im.replace(/"/g, ''), 10) : (has('version') ? Number(body.version) : null);
  const who = actor(req);
  try {
    const { row, changed } = await patchEntity({
      table: 'metadata_schemas', id: req.params.id, accountId: accountId(req),
      current, patch, allowed: SCHEMA_EDITABLE, entityType: 'metadata_schema',
      userId: who.userId, label: who.label, expectedVersion,
    });
    res.set('ETag', String(row.version));
    res.json({ ...row, _changed: changed });
  } catch (e) {
    if (e instanceof VersionConflict) return res.status(409).json({ error: e.message, currentVersion: e.currentVersion });
    throw e;
  }
});
metadataSchemasRouter.patch('/:id', editSchema);
metadataSchemasRouter.put('/:id', editSchema);

metadataSchemasRouter.get(
  '/:id/history',
  asyncHandler(async (req, res) => {
    const owned = await one(`SELECT id FROM metadata_schemas WHERE id=$1 AND account_id=$2`, [req.params.id, accountId(req)]);
    if (!owned) throw notFound('Schema not found');
    res.json(await entityHistory(accountId(req), 'metadata_schema', req.params.id));
  })
);

/** Effective (merged, extends-resolved) fields — what a form should render. */
metadataSchemasRouter.get(
  '/:id/effective-fields',
  asyncHandler(async (req, res) => {
    const resolved = await resolveEffectiveFields(req.params.id, accountId(req));
    if (!resolved) throw notFound('Schema not found');
    res.json({ id: req.params.id, targetKind: resolved.targetKind, fields: resolved.fields });
  })
);

metadataSchemasRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    // A type that something is assigned to cannot go: the station, event or
    // asset would be left with no type, which the rule above forbids. And a
    // standard type is never deleted, only edited or cloned, so a client can
    // always get back to the platform baseline.
    const cur = await one<any>(`SELECT id, is_standard FROM metadata_schemas WHERE id = $1 AND account_id = $2`, [req.params.id, accountId(req)]);
    if (!cur) throw notFound('Schema not found');
    if (cur.is_standard) throw conflict('Standard types cannot be deleted. Edit it, or clone it and assign the clone.');
    const use = await one<any>(
      `SELECT (SELECT count(*) FROM channels WHERE schema_id = $1)
            + (SELECT count(*) FROM events WHERE schema_id = $1)
            + (SELECT count(*) FROM vod_assets WHERE schema_id = $1) AS n`, [req.params.id]);
    if (Number(use?.n ?? 0) > 0) throw conflict(`This type is assigned to ${use.n} item(s). Reassign them first.`);
    const row = await one<any>(
      `DELETE FROM metadata_schemas WHERE id = $1 AND account_id = $2 RETURNING id, name`,
      [req.params.id, accountId(req)]
    );
    if (!row) throw notFound('Schema not found');
    const who = actor(req);
    await writeAudit(null, { accountId: accountId(req), userId: who.userId, label: who.label,
      action: 'delete', entityType: 'metadata_schema', entityId: row.id, snapshot: { name: row.name } });
    res.status(204).end();
  })
);
