// ============================================================================
//  WHO CAN WATCH: the Availability tab's tester (build queue P1-2,
//  PUBLISHING_POLICIES.md "Lifecycle model").
//
//  A country, a kind of viewer, a moment and optionally an app go in; the play
//  gate's own answer comes out, with the step that decided it. It is the real
//  decision, not a second copy of the rules: the public status from the same
//  pure function the gate uses (services/publicStatus.ts), then the same
//  evaluateAccess() the gate calls, and the same reading of a refusal into
//  402, 403 or 451 (services/qoe/gateLog.ts classifyGate). The suite holds the
//  two together: for every status, the tester and the gate answer alike.
//
//  What it cannot know is left out and said so: a site's address (the title's
//  allowed referrer domains are checked against the page the player is on)
//  and a real viewer's purchases. "A viewer who has paid" stands for any
//  viewer whose purchase or subscription covers the title.
// ============================================================================
import { evaluateAccess } from './rights';
import { computePublicStatus, publiclyVisible, type StatusAnswer } from './publicStatus';
import { rightsForAsset, type RightsAppType } from './rightsProfiles';
import { classifyGate } from './qoe/gateLog';
import { vodAvailabilityRow } from './viewerPath';
import type { ViewerCtx } from './accessRules';

export const VIEWER_KINDS = ['anonymous', 'signed_in', 'entitled'] as const;
export type ViewerKind = typeof VIEWER_KINDS[number];

export interface WhoCanWatchAsk {
  accountId: string;
  assetId: string;
  country: string | null;
  viewer: ViewerKind;
  at: Date | null;
  appId?: string | null;
  appType?: RightsAppType | null;
}

export interface WhoCanWatchAnswer {
  at: string;
  /** The answer at that moment: play, teaser, not found, paywall, sign in, blocked. */
  outcome: 'play' | 'teaser' | 'not_found' | 'paywall' | 'sign_in' | 'blocked';
  /** The play gate's HTTP status for this viewer. */
  http: number;
  /** One line for people. */
  message: string;
  /** Which step decided: status, account, rights, on_demand, rules or none. */
  decidedBy: string;
  reason: string | null;
  ruleId: string | null;
  status: { publicStatus: string; editorial: string; reason: string; until: string | null; visible: boolean };
  /** What the tester leaves out. */
  notChecked: string[];
}

const iso = (x: Date | null) => (x ? x.toISOString() : null);
const statusOf = (s: StatusAnswer, at: Date) => ({ publicStatus: s.status, editorial: s.editorial, reason: s.reason, until: iso(s.until), visible: publiclyVisible(s, at) });

export async function whoCanWatch(ask: WhoCanWatchAsk): Promise<WhoCanWatchAnswer | null> {
  const row = await vodAvailabilityRow(ask.assetId);
  if (!row) return null;
  const now = new Date();
  const at = ask.at ?? now;
  // "Now" is the gate exactly; another moment reads the rights at that moment
  // and takes the public status, not the stored state, as what is published.
  const atNow = Math.abs(at.getTime() - now.getTime()) < 60_000;
  const country = ask.country ? ask.country.toUpperCase() : null;
  const ps = computePublicStatus(row, await rightsForAsset(row), at);
  const status = statusOf(ps, at);
  const notChecked = ['the page the player is on (allowed referrer domains)', 'a real viewer\'s purchases, groups and sign-in limits'];
  const base = { at: at.toISOString(), status, notChecked };

  // THE PUBLIC VISIBILITY RULE first, as the gate does: anything not public is
  // answered as an unknown id, and a Scheduled title past Listed from is a teaser.
  if (!publiclyVisible(ps, at)) {
    return { ...base, outcome: 'not_found', http: 404, decidedBy: 'status', reason: ps.reason, ruleId: null,
      message: `Not public (${ps.status.replace('_', ' ')}): the play gate answers as if the title did not exist.` };
  }
  if (ps.status === 'scheduled') {
    return { ...base, outcome: 'teaser', http: 403, decidedBy: 'status', reason: ps.reason, ruleId: null,
      message: `A teaser: the title and artwork are shown, with no way to play until ${ps.effectiveFrom?.toISOString().replace('T', ' ').slice(0, 16) ?? 'it opens'} UTC.` };
  }

  // WHO IS WATCHING, as the gate builds it. A signed-in viewer with no
  // purchases; a viewer who has paid stands for an entitlement that covers it.
  const viewerCtx: ViewerCtx | null = ask.viewer === 'anonymous' ? null
    : { country, viewerId: 'who-can-watch-tester', groups: [], entitlements: [] };
  const rights = await evaluateAccess(ask.assetId, country ?? undefined, {
    accountId: ask.accountId, appId: ask.appId ?? null, appType: ask.appType ?? null,
    entitled: ask.viewer === 'entitled', viewerCtx: viewerCtx ?? undefined, at: atNow ? undefined : at,
  });
  const layer = rights.layer ?? 'none';
  const ruleId = (rights as any).rule?.ruleId ?? null;
  if (rights.allowed) {
    return { ...base, outcome: 'play', http: 200, decidedBy: layer, reason: null, ruleId, message: 'Plays.' };
  }
  // The same reading of a refusal as the gate (modules/apps.ts decide()).
  const r: any = rights;
  const why = classifyGate(451, null, { rights }).reason;
  const paywall = why === 'payment' || r.rule?.reason === 'payment_required';
  const signIn = !paywall && (why === 'sign_in' || r.rule?.reason === 'members_only');
  const http = paywall ? 402 : signIn || why === 'group' || r.rule?.reason === 'group' ? 403 : 451;
  const outcome = paywall ? 'paywall' : signIn ? 'sign_in' : 'blocked';
  const message = paywall ? 'Asked to buy or subscribe.'
    : signIn ? 'Asked to sign in.'
    : http === 451 ? `Blocked here${country ? ` (${country})` : ''}: ${rights.reason ?? 'not available in this region or under these rights'}.`
    : `Not available to this viewer: ${rights.reason ?? 'a rule keeps them out'}.`;
  return { ...base, outcome, http, decidedBy: layer, reason: rights.reason ?? null, ruleId, message };
}
