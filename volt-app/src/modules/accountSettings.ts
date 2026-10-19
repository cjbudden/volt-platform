// ============================================================================
//  ACCOUNT SETTINGS: the account's own branding (docs/ACCOUNT_SETTINGS.md).
//
//    GET   /api/account-settings   anyone signed in (forms and previews read it)
//    PATCH /api/account-settings   account administrators and owners
//
//  A logo (an image-library address or an https URL) and a primary and a
//  secondary colour. The share page uses them now; anything else the account
//  shows to outsiders can read the same three values. Every change is in the
//  audit log.
// ============================================================================
import { Router } from 'express';
import { z } from 'zod';
import { one } from '../db';
import { requireAuth, accountId } from '../auth/middleware';
import { requireMinRole, rankOf, ROLE_RANK } from '../auth/roles';
import { asyncHandler, notFound } from '../util/http';
import { actor, writeAudit } from '../services/audit';
import { normGeo, type GeoAccess } from '../services/geoAccess';

export const BRAND_DEFAULTS = { primary: '#2563eb', secondary: '#eef2ff' };
const HEX = /^#[0-9a-f]{6}$/i;
// An image-library path, or an http(s) address. Nothing that could run.
const LOGO = z.string().max(2048).refine((v) => /^\/library\/[^\s"'<>]+$/.test(v) || /^https?:\/\/[^\s"'<>]+$/i.test(v), 'Use an image from the library or an http(s) address');

export interface AccountBrand { logo: string | null; primary: string; secondary: string; custom: { primary: boolean; secondary: boolean } }
export interface AccountSettingsView extends AccountBrand { name: string; geoAccess: GeoAccess | null }

export async function accountBrand(id: string): Promise<AccountBrand & { name: string }> {
  const a = await one<any>(`SELECT name, brand_logo_ref, brand_primary, brand_secondary FROM accounts WHERE id = $1`, [id]);
  return {
    name: a?.name ?? 'Volt',
    logo: a?.brand_logo_ref ?? null,
    primary: a?.brand_primary ?? BRAND_DEFAULTS.primary,
    secondary: a?.brand_secondary ?? BRAND_DEFAULTS.secondary,
    custom: { primary: !!a?.brand_primary, secondary: !!a?.brand_secondary },
  };
}

export const accountSettingsRouter = Router();
accountSettingsRouter.use(requireAuth);

async function view(acc: string) {
  const b = await accountBrand(acc);
  const g = await one<any>(`SELECT geo_access FROM accounts WHERE id = $1`, [acc]);
  return { ...b, geoAccess: normGeo(g?.geo_access), defaults: BRAND_DEFAULTS };
}

accountSettingsRouter.get('/', asyncHandler(async (req, res) => {
  const b = await view(accountId(req));
  const canEdit = rankOf(String((req as any).auth?.role ?? 'viewer')) >= ROLE_RANK.admin;
  res.json({ ...b, canEdit, editReason: canEdit ? null : 'Account administrators and owners change these settings.' });
}));

const patchSchema = z.object({
  logo: LOGO.nullable().optional(),
  primary: z.string().regex(HEX, 'A colour is #RRGGBB').nullable().optional(),
  secondary: z.string().regex(HEX, 'A colour is #RRGGBB').nullable().optional(),
  /** Where anything of the account may be watched (services/geoAccess.ts); null = anywhere. */
  geoAccess: z.object({
    mode: z.enum(['block', 'allow']),
    countries: z.array(z.string().regex(/^[A-Za-z]{2}$/, 'A country is a two-letter code (IL, AU)')).max(250),
  }).nullable().optional(),
});

accountSettingsRouter.patch('/', requireMinRole('admin'), asyncHandler(async (req, res) => {
  const body = patchSchema.parse(req.body ?? {});
  const acc = accountId(req);
  const before = await one<any>(`SELECT brand_logo_ref, brand_primary, brand_secondary FROM accounts WHERE id = $1`, [acc]);
  if (!before) throw notFound('Account not found');
  const cols: Record<string, string> = { logo: 'brand_logo_ref', primary: 'brand_primary', secondary: 'brand_secondary' };
  const changes: Record<string, { from: any; to: any }> = {};
  const sets: string[] = []; const vals: any[] = [acc];
  for (const [k, col] of Object.entries(cols)) {
    if (!(k in body)) continue;
    const v = (body as any)[k] === null ? null : String((body as any)[k]).trim().toLowerCase() === '' ? null : (k === 'logo' ? (body as any)[k] : String((body as any)[k]).toLowerCase());
    if ((before[col] ?? null) === v) continue;
    vals.push(v); sets.push(`${col} = $${vals.length}`);
    changes[col] = { from: before[col] ?? null, to: v };
  }
  if (sets.length) {
    await one(`UPDATE accounts SET ${sets.join(', ')} WHERE id = $1 RETURNING id`, vals);
    const who = actor(req);
    await writeAudit(null, { accountId: acc, userId: who.userId, label: who.label, action: 'update', entityType: 'account_branding', entityId: acc, changes });
  }
  if ('geoAccess' in body) {
    const prev = await one<any>(`SELECT geo_access FROM accounts WHERE id = $1`, [acc]);
    const next = normGeo(body.geoAccess);
    if (body.geoAccess && body.geoAccess.mode === 'allow' && !next?.countries.length) {
      throw Object.assign(new Error('An allow list needs at least one country, or nothing could be watched anywhere'), { status: 422 });
    }
    if (JSON.stringify(normGeo(prev?.geo_access)) !== JSON.stringify(next)) {
      await one(`UPDATE accounts SET geo_access = $2::jsonb WHERE id = $1 RETURNING id`, [acc, next ? JSON.stringify(next) : null]);
      const who = actor(req);
      await writeAudit(null, { accountId: acc, userId: who.userId, label: who.label, action: 'update', entityType: 'account_geo_access', entityId: acc,
        changes: { geo_access: { from: normGeo(prev?.geo_access), to: next } } });
    }
  }
  res.json({ ...(await view(acc)), canEdit: true, editReason: null });
}));
