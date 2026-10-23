// ============================================================================
//  VIEW AS A COUNTRY: the edge rights decision, made on this box.
//
//  In production the CloudFront Function (deploy/edge/rights-viewer-request.js)
//  decides per manifest request whether a viewer in a given country gets the
//  channel, the replacement or a 451. Multiview's "Viewer location" plays the
//  delivered output THROUGH the same decision, so an operator can watch what
//  a viewer in Australia gets while one in Malaysia gets the programme, on the
//  Mac, before any cloud is involved.
//
//  `decide` is a line-for-line port of the function's own `decide`, and the
//  parity test (test/edgeViewAs.check.ts) evaluates the deployed file's text
//  against this one, so the two cannot drift silently.
//
//  COST: the rules are cached per stream for a few seconds (cached() coalesces
//  concurrent loads), so a wall of tiles reloading playlists every few seconds
//  costs a couple of indexed reads per stream per window, not per request.
// ============================================================================
import { cached } from '../scale/cache';
import { loadEdgeRules, type EdgeRules } from './edgeRights';

export type EdgeDecision = 'allow' | 'block' | 'replace';

function listStops(rule: [string, string[]] | undefined, cc: string): boolean {
  if (!rule) return false;
  const mode = rule[0], list = rule[1] || [];
  if (mode === 'b') return !!cc && list.indexOf(cc) >= 0;
  if (mode === 'a') return !cc || list.indexOf(cc) < 0;
  return false;
}

/** Same answer as the CloudFront Function's decide(). */
export function decide(rules: EdgeRules | null, cc: string, nowSec: number): EdgeDecision {
  if (!rules || rules.v !== 1) return 'allow';
  if (listStops(rules.a as any, cc)) return 'block';
  if (listStops(rules.c as any, cc)) return 'block';
  const w = rules.w || [];
  for (const x of w) {
    if (nowSec >= x[0] && nowSec < x[1] && listStops([x[2], x[3]], cc)) return x[4] ? 'replace' : 'block';
  }
  return 'allow';
}

/** Why, in words, and until when the answer holds. */
export function explain(rules: EdgeRules | null, cc: string, nowSec: number): { decision: EdgeDecision; reason: string; until: number | null } {
  const decision = decide(rules, cc, nowSec);
  if (!rules) return { decision, reason: 'no geo rules on this stream', until: null };
  const who = cc || 'an unknown country';
  if (listStops(rules.a as any, cc)) return { decision, reason: `the account's geo setting excludes ${who}`, until: null };
  if (listStops(rules.c as any, cc)) return { decision, reason: `the channel's geo setting excludes ${who}`, until: null };
  for (const x of rules.w || []) {
    if (nowSec >= x[0] && nowSec < x[1] && listStops([x[2], x[3]], cc)) {
      return { decision, reason: `the current programme ${x[4] ? 'is replaced' : 'is blacked out'} for ${who}`, until: x[1] };
    }
  }
  const next = (rules.w || []).filter((x) => x[0] > nowSec && listStops([x[2], x[3]], cc)).sort((a, b) => a[0] - b[0])[0];
  return { decision, reason: `${who} can watch`, until: next ? next[0] : null };
}

/** Countries any rule on the stream names: the ones worth testing. */
export function ruleCountries(rules: EdgeRules | null): string[] {
  const s = new Set<string>();
  for (const r of [rules?.a, rules?.c]) for (const c of (r?.[1] ?? [])) s.add(c);
  for (const w of rules?.w ?? []) for (const c of w[3] ?? []) s.add(c);
  return [...s].sort();
}

export function rulesFor(id: string): Promise<EdgeRules | null> {
  return cached(`edge:viewas:${id}`, { ttlSec: 5, tags: [] }, async () => {
    // a stream id is a channel or an event; try the channel first
    const now = Math.floor(Date.now() / 1000);
    try {
      const ch = await loadEdgeRules('channel', id, now);
      if (ch) return ch;
    } catch { /* fall through */ }
    try { return await loadEdgeRules('event', id, now); } catch { return null; }
  });
}
