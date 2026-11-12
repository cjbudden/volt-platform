// ============================================================================
//  ENCODE-TIME POLICY FIELDS (build queue P4, PUBLISHING_POLICIES.md
//  "Encode-time vs delivery-time fields").
//
//  Most of a publishing policy is read at delivery and takes effect within a
//  minute. DRM is different: it changes the files, so it is decided when the
//  title is packaged. Two things follow:
//
//    - The policy a new title will get is shown before it uploads (the upload
//      panel reads GET /api/publishing-rules/resolve with the content type).
//    - When the encode finishes, the policy as it then stands is resolved and
//      kept on the title (`vod_assets.policy_snapshot`): what it asked for,
//      which rung and rule said so, and what the files were packaged with.
//
//  A title whose policy now asks for something its files do not carry is
//  "repackage pending". Saying so is the point: the Encode tab shows what
//  protects the files, not what a rule hoped for.
//
//  DRM PACKAGING OF FILE ENCODES (build queue P4-2). A cloud encode whose
//  policy asks for DRM is packaged with it: the account's DRM config gives
//  the SPEKE key service, as for live channels (services/jobConfig.ts), and
//  vod_encoder.py fetches a key through speke_client.py and has Shaka
//  encrypt (cbcs). The content id is the title, so its key belongs to it and
//  follows it wherever it is published (FAST_DRM.md recommends the same for
//  FAST). An account with no DRM config is refused the encode with the
//  reason rather than packaged in the clear under a policy that asks for
//  DRM. A site encode is still packaged in the clear (its keys need the
//  proxy of build queue H5-4), so its title shows Repackage pending.
// ============================================================================
import { one, query } from '../db';
import { resolveForAsset, type Resolved, type Rung } from './publishingRules';
import { rungLabel } from './publishingPolicies';

/** The encode-time fields a policy holds today. The ladder, captions and trick play join later. */
export const ENCODE_FIELDS = ['drm'] as const;
export type EncodeField = typeof ENCODE_FIELDS[number];

export interface EncodeSnapshot {
  /** When the policy was resolved for the encode. */
  at: string;
  /** What the policy asked for at that moment. */
  wanted: Record<EncodeField, boolean>;
  /** Which rung each field came from. */
  sources: Record<EncodeField, Rung>;
  /** The rule that decided DRM, by name, when it has one. */
  rule: string | null;
  /** What the files were actually packaged with. */
  packaged: Record<EncodeField, boolean>;
}

/** The rule row behind a field: the most specific rung that took part and set it. */
function ruleName(r: Resolved, rung: Rung): string | null {
  const row = [...r.rungs].reverse().find((x) => x.rung === rung);
  return row?.name ?? null;
}

/** PURE. The snapshot an encode leaves, from the policy as resolved and what the encode did. */
export function encodeSnapshot(r: Resolved, packaged: Record<EncodeField, boolean>, at = new Date()): EncodeSnapshot {
  const source = (r.fieldSources['protection.drm'] ?? 'baseline') as Rung;
  return {
    at: at.toISOString(),
    wanted: { drm: !!r.settings.protection?.drm },
    sources: { drm: source },
    rule: ruleName(r, source),
    packaged: { drm: !!packaged.drm },
  };
}

/** PURE. What the files carry: the snapshot when there is one, else the encode's own record. */
export function packagedOf(a: { policy_snapshot?: any; encode_result?: any }): { drm: boolean; recorded: boolean } {
  const s = a.policy_snapshot;
  if (s && s.packaged && typeof s.packaged.drm === 'boolean') return { drm: s.packaged.drm, recorded: true };
  // Every file encode and clip so far is packaged in the clear; an encode
  // that ever records a DRM system says so in encode_result.drm.
  const d = a.encode_result?.drm;
  return { drm: typeof d === 'string' ? d !== 'clear' : false, recorded: typeof d === 'string' };
}

/** PURE. The encode-time fields where the policy now asks for something the files do not carry. */
export function pendingFields(wanted: Record<EncodeField, boolean>, packaged: Record<EncodeField, boolean>): EncodeField[] {
  return ENCODE_FIELDS.filter((f) => !!wanted[f] !== !!packaged[f]);
}

export interface EncodePolicyView {
  /** What the policy asks for now, and where from. */
  now: { drm: boolean; source: Rung; sourceLabel: string; rule: string | null };
  /** What it asked for when the title was encoded (null: encoded before snapshots were kept). */
  atEncode: EncodeSnapshot | null;
  /** What the files carry. */
  packaged: { drm: boolean; recorded: boolean };
  /** Fields where the files and the policy disagree: the title waits for repackaging. */
  pending: EncodeField[];
  /** In words, for the Encode tab and the API reader. */
  note: string | null;
}

/** PURE. The view from a resolved policy and the title's row. */
export function encodePolicyView(r: Resolved, a: { policy_snapshot?: any; encode_result?: any }): EncodePolicyView {
  const source = (r.fieldSources['protection.drm'] ?? 'baseline') as Rung;
  const now = { drm: !!r.settings.protection?.drm, source, sourceLabel: rungLabel(source), rule: ruleName(r, source) };
  const packaged = packagedOf(a);
  const pending = pendingFields({ drm: now.drm }, { drm: packaged.drm });
  const from = source === 'asset' ? 'its own setting' : now.rule ? `the ${now.sourceLabel} "${now.rule}"` : `the ${now.sourceLabel}`;
  const note = !pending.length ? null
    : now.drm
      ? `Its publishing policy asks for DRM (${from}), but its files are packaged in the clear: repackage pending. It plays in the clear until it is packaged again: encode it again to package it with DRM.`
      : `Its publishing policy no longer asks for DRM (${from}), but its files are encrypted: repackage pending. It keeps its DRM until it is packaged again, never a weaker protection.`;
  return { now, atEncode: a.policy_snapshot ?? null, packaged, pending, note };
}

/** The account's DRM key service, the same row a live channel's output profile points at. */
export interface DrmConfig {
  id: string;
  scheme: string;
  systems: string[];
  tenant_id: string;
  key_service_url: string;
  management_key_ref: string;
}

/**
 * The account's DRM config: the first one it was given. Accounts have one
 * today (set up by Volt with the DRM vendor); the oldest is taken so the
 * choice is stable if a second is ever added.
 */
export async function accountDrmConfig(accountId: string): Promise<DrmConfig | null> {
  return (await one<DrmConfig>(
    `SELECT id, scheme::text AS scheme, systems, tenant_id, key_service_url, management_key_ref
       FROM drm_configs WHERE account_id = $1 ORDER BY created_at, id LIMIT 1`, [accountId])) ?? null;
}

/**
 * PURE. The encoder job's drm block, in the shape the live encoder takes
 * (services/jobConfig.ts): the key service and a reference to its
 * credential, never the credential. The content id is the title.
 */
export function encoderDrm(c: DrmConfig, assetId: string): Record<string, unknown> {
  return {
    mode: c.scheme || 'cbcs',
    speke_url: c.key_service_url,
    content_id: assetId,
    auth_ref: c.management_key_ref,
    tenant_id: c.tenant_id,
    systems: Array.isArray(c.systems) && c.systems.length ? c.systems : ['widevine', 'playready', 'fairplay'],
  };
}

/** What an encode must do about DRM for this title: whether its policy asks, from where, and the key service. */
export interface EncodeDrm {
  wanted: boolean;
  /** Where the ask comes from, in words ("the content type rule \"Protected films\""). */
  from: string;
  config: DrmConfig | null;
}

/** The title and the account its policy resolves under (null when the title is gone). */
async function policyTitle(assetId: string): Promise<any | null> {
  const a = await one<any>(
    `SELECT v.id, v.schema_id, v.channel_id, v.event_id, v.availability_override, COALESCE(g.account_id, v.account_id) AS account_id
       FROM vod_assets v
       LEFT JOIN channels c ON c.id = v.channel_id
       LEFT JOIN events   e ON e.id = v.event_id
       LEFT JOIN groups   g ON g.id = COALESCE(c.group_id, e.group_id)
      WHERE v.id = $1`, [assetId]);
  return a?.account_id ? a : null;
}

/** Resolve the title's policy now, for the encode that is about to package it. */
export async function encodeDrmFor(assetId: string): Promise<EncodeDrm | null> {
  const a = await policyTitle(assetId);
  if (!a) return null;
  const r = await resolveForAsset(a.account_id, a);
  const source = (r.fieldSources['protection.drm'] ?? 'baseline') as Rung;
  const rule = ruleName(r, source);
  const from = source === 'asset' ? 'its own setting' : rule ? `the ${rungLabel(source)} "${rule}"` : `the ${rungLabel(source)}`;
  const wanted = !!r.settings.protection?.drm;
  return { wanted, from, config: wanted ? await accountDrmConfig(a.account_id) : null };
}

/** PURE. The refusal an encode gives when its policy asks for DRM and the account has no key service. */
export function noDrmConfigMessage(from: string): string {
  return `its publishing policy asks for DRM (${from}), but this account has no DRM key service set up, so it is not packaged in the clear. Set up DRM for the account or turn DRM off in the policy, then encode it again.`;
}

/**
 * Resolve the title's policy as it stands and keep it with what the encode
 * did. Called by the encode when its files are written. Returns the snapshot,
 * or null when the title is gone.
 */
export async function snapshotEncodePolicy(assetId: string, packaged: Record<EncodeField, boolean>): Promise<EncodeSnapshot | null> {
  const a = await policyTitle(assetId);
  if (!a) return null;
  const r = await resolveForAsset(a.account_id, a);
  const snap = encodeSnapshot(r, packaged);
  await query(`UPDATE vod_assets SET policy_snapshot = $2::jsonb WHERE id = $1`, [assetId, JSON.stringify(snap)]);
  return snap;
}
