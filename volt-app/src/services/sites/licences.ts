// ============================================================================
//  LICENSED ADD-ONS (build queue H1).
//
//  accounts.licences lists the add-ons an account is licensed for. Only the
//  system admin sets it (PATCH /api/platform/accounts/:id). An add-on that is
//  not licensed is not there: its routes refuse, its pages are not offered and
//  nothing it would add runs. Every add-on is off by default.
// ============================================================================
import { one } from '../../db';
import { ApiError } from '../../util/http';

/** Every licence the platform knows. A value not in this list is refused. */
export const LICENCES = ['hybrid_sites', 'mirror_archive'] as const;
export type Licence = typeof LICENCES[number];

export async function licencesOf(accountId: string): Promise<string[]> {
  const r = await one<{ licences: string[] | null }>(`SELECT licences FROM accounts WHERE id = $1`, [accountId]);
  return r?.licences ?? [];
}

export async function hasLicence(accountId: string, licence: Licence): Promise<boolean> {
  return (await licencesOf(accountId)).includes(licence);
}

/** 403 with a code a client can act on, when the account is not licensed. */
export function licenceRequired(licence: Licence): ApiError {
  return Object.assign(new ApiError(403, `This account is not licensed for ${licence === 'hybrid_sites' ? 'Hybrid Sites' : 'Mirror and Archive'}`),
    { code: 'licence_required', licence });
}

export async function requireLicence(accountId: string, licence: Licence): Promise<void> {
  if (!(await hasLicence(accountId, licence))) throw licenceRequired(licence);
}

/**
 * The add-ons that run on a site's agent. Mirror and Archive is sold on its
 * own (HYBRID_SITES.md), so an account with only `mirror_archive` still has
 * sites, hosts and the job lease; only the Hybrid Sites parts (on-prem
 * watchfolders and their uploads) stay behind `hybrid_sites`.
 */
export const SITE_LICENCES: Licence[] = ['hybrid_sites', 'mirror_archive'];

/** Either site add-on opens sites and their agents; neither: 403 naming Hybrid Sites, as before. */
export function hasSiteLicence(licences: string[] | null | undefined): boolean {
  return SITE_LICENCES.some((l) => (licences ?? []).includes(l));
}

export async function requireSiteLicence(accountId: string): Promise<void> {
  if (!hasSiteLicence(await licencesOf(accountId))) throw licenceRequired('hybrid_sites');
}
