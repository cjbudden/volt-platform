// ============================================================================
//  THE HOOK BUS.
//
//  The base workflow calls fireHook() at real stage boundaries. Each call:
//    1. appends to workflow_events (always, attached or not, so the dashboard
//       can trace where any subject has got to), and
//    2. starts a run for every enabled trigger on that hook whose filter
//       matches.
//
//  fireHook NEVER throws and never blocks the media path: a broken add-on or a
//  database hiccup here must not fail a recording close or a clip job. The
//  caller does not await anything it would mind losing.
// ============================================================================
import { query } from '../../db';
import { HOOK_IDS, type SubjectType } from './map';
import { resolveSubject, type Subject } from './subjects';
import { createRun } from './runs';

export interface TriggerFilter {
  channelIds?: string[];
  eventIds?: string[];
  groupIds?: string[];
}

/** Pure: does a trigger's filter accept this subject? Empty filter = everything. */
export function matchesFilter(f: TriggerFilter | null | undefined, s: { channelId: string | null; eventId: string | null; groupId?: string | null }): boolean {
  if (!f) return true;
  const lists = [f.channelIds, f.eventIds, f.groupIds].filter((l) => Array.isArray(l) && l.length);
  if (!lists.length) return true;
  // ANY listed scope matching is enough: "these two channels and that event".
  if (f.channelIds?.length && s.channelId && f.channelIds.includes(s.channelId)) return true;
  if (f.eventIds?.length && s.eventId && f.eventIds.includes(s.eventId)) return true;
  if (f.groupIds?.length && s.groupId && f.groupIds.includes(s.groupId)) return true;
  return false;
}

async function groupOf(s: Subject): Promise<string | null> {
  if (s.channelId) return (await query<any>(`SELECT group_id FROM channels WHERE id = $1`, [s.channelId]))[0]?.group_id ?? null;
  if (s.eventId) return (await query<any>(`SELECT group_id FROM events WHERE id = $1`, [s.eventId]))[0]?.group_id ?? null;
  return null;
}

export async function emitHook(hook: string, subjectType: SubjectType, subjectId: string, data: Record<string, unknown> = {}): Promise<{ eventId: string | null; runs: string[] }> {
  if (!HOOK_IDS.has(hook)) throw new Error(`[workflows] undeclared hook ${hook}; add it to services/workflows/map.ts`);
  const s = await resolveSubject(subjectType, subjectId);
  if (!s) return { eventId: null, runs: [] };

  const ev = await query<{ id: string }>(
    `INSERT INTO workflow_events (account_id, hook, subject_type, subject_id, channel_id, event_id, title, data)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb) RETURNING id`,
    [s.accountId, hook, s.type, s.id, s.channelId, s.eventId, s.title, JSON.stringify(data)]
  );

  const triggers = await query<any>(
    `SELECT t.*, a.accepts, a.enabled AS addon_enabled
       FROM addon_triggers t JOIN addon_services a ON a.id = t.addon_id
      WHERE t.account_id = $1 AND t.hook = $2 AND t.enabled`,
    [s.accountId, hook]
  );
  const runs: string[] = [];
  if (triggers.length) {
    const groupId = await groupOf(s);
    for (const t of triggers) {
      if (!t.addon_enabled) continue;
      if (!(t.accepts as string[]).includes(s.type)) continue;
      if (!matchesFilter(t.filter, { channelId: s.channelId, eventId: s.eventId, groupId })) continue;
      const run = await createRun({
        accountId: s.accountId, addonId: t.addon_id, triggerId: t.id, hook, subject: s,
        options: t.options ?? {}, createdBy: `trigger:${t.id}`, hookData: data,
      });
      runs.push(run.id);
    }
  }
  return { eventId: ev[0]?.id ?? null, runs };
}

/** Fire-and-forget wrapper for call sites in the media path. */
export function fireHook(hook: string, subjectType: SubjectType, subjectId: string | null | undefined, data: Record<string, unknown> = {}): void {
  if (!subjectId) return;
  emitHook(hook, subjectType, subjectId, data).catch((e) => console.error(`[workflows] hook ${hook} for ${subjectType} ${subjectId} failed`, e));
}
