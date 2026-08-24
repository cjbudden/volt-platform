// ============================================================================
//  WHO DID THIS.
//
//  Every audit trail in the system — review decisions, media transitions, holds,
//  retention actions — records an actor, and the whole value of those trails is
//  that the actor is a NAME. "unknown" on an approval is worse than no trail,
//  because it looks like a record.
//
//  The access claim carries a user id, not an email, so the label is resolved
//  from it once and cached for the process. The id is kept alongside as a
//  foreign key; the label is stored as text as well, because a user can be
//  deleted and "approved by someone who has since left" still needs a name.
// ============================================================================
import type { Request } from 'express';
import { one } from '../db';

const labels = new Map<string, string>();

export function actorId(req: Request): string | null {
  const sub = req.auth?.sub ?? null;
  if (!sub) return null;
  // An API key acts as `apikey:<id>`, which is not a users row.
  return sub.startsWith('apikey:') ? null : sub;
}

/**
 * A human-readable name for whoever made this request.
 *
 * Falls back through email, then name, then the raw subject. It never returns
 * "unknown" for an authenticated request: the id is a worse label than an email
 * but it is still an answer, and an answer is what an audit trail needs.
 */
export async function actorLabel(req: Request): Promise<string> {
  const sub = req.auth?.sub;
  if (!sub) return 'system';
  if (sub.startsWith('apikey:')) return sub;          // already self-describing

  const hit = labels.get(sub);
  if (hit) return hit;
  try {
    const u = await one<{ email: string | null; display_name: string | null }>(
      `SELECT email, display_name FROM users WHERE id = $1`, [sub]
    );
    const label = u?.email ?? u?.display_name ?? sub;
    labels.set(sub, label);
    return label;
  } catch {
    return sub;
  }
}
