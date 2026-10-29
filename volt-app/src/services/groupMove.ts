// ============================================================================
//  MOVING A STREAM TO ANOTHER GROUP (build queue 1.14-G3a-5).
//
//    POST /api/channels/:id/group   {groupId}   a TV channel, station or FAST channel
//    POST /api/events/:id/group     {groupId}   an event
//
//  Channel Groups told people to "move them to another group" before removing
//  a group, and nothing could. A move is checked the way creating the stream
//  in the target group is checked, because that is what it amounts to:
//
//    - the target is one of the account's own groups, and not the one the
//      stream is already in
//    - THE SAME WORKFLOW. A group's output profile decides transcode or
//      packaging, and a stream never changes workflow (the group drawer says
//      so too): its sources, ladder and encoder all follow from it. A move to
//      a group of the other type is refused; make a new stream there instead.
//    - THE TARGET'S SHARE OF THE PLAN for a channel or station (groups.
//      max_channels counts TV and radio together, as on create). The
//      account's own plan does not change: the stream was already counted.
//    - THE TARGET'S RUNNING AT ONCE for an event that has not ended, the same
//      overlap count as creating an event in that group.
//
//  Access is the stream's own: the routes sit under /api/channels/:id and
//  /api/events/:id, so requirementFor makes it Manage on TV channels, Radio,
//  FAST or Events by what the stream is. Moving uses a slot in a group the way
//  creating a stream there does, and creating is that same level; shares of
//  the plan themselves stay with administrators.
//
//  A running stream keeps running as it is. The target group's output
//  profile (its ladder and captions) applies from its next start, and the
//  answer says so when the two groups' profiles differ.
//
//  The target group's row is locked for the check and the write, so two moves
//  into the last free place cannot both succeed.
// ============================================================================
import type { Request } from 'express';
import { z } from 'zod';
import { tx } from '../db';
import { accountId } from '../auth/middleware';
import { badRequest, conflict, notFound } from '../util/http';
import { actor, writeAudit } from './audit';

export const moveSchema = z.object({ groupId: z.string().uuid() });

const typeLabel = (t: string | null) => t === 'package_only' ? 'Packaging' : t === 'transcode' ? 'Transcode' : 'unknown';

export interface MoveResult {
  id: string; kind: 'channel' | 'event'; name: string
  from: { id: string; name: string }; to: { id: string; name: string }
  /** the target group uses another output profile: it applies from the next start */
  profileChanges: boolean
  /** the stream is running now, so the move shows in its output after its next start */
  running: boolean
}

export async function moveToGroup(req: Request, kind: 'channel' | 'event', id: string): Promise<MoveResult> {
  const { groupId } = moveSchema.parse(req.body ?? {});
  const acc = accountId(req);
  return tx(async (c) => {
    const table = kind === 'channel' ? 'channels' : 'events';
    const cur = (await c.query(
      `SELECT s.id, s.name, s.status, s.group_id, g.name AS group_name, g.output_profile_id, p.workflow_type,
              ${kind === 'channel' ? `s.kind, NULL::timestamptz AS scheduled_start, NULL::timestamptz AS scheduled_end`
                                   : `NULL::text AS kind, s.scheduled_start, s.scheduled_end`}
         FROM ${table} s JOIN groups g ON g.id = s.group_id
         LEFT JOIN output_profiles p ON p.id = g.output_profile_id
        WHERE s.id = $1 AND g.account_id = $2
        FOR UPDATE OF s`, [id, acc])).rows[0];
    if (!cur) throw notFound(kind === 'channel' ? 'Channel not found' : 'Event not found');
    const tgt = (await c.query(
      `SELECT g.id, g.name, g.max_channels, g.max_concurrent, g.output_profile_id, p.workflow_type
         FROM groups g LEFT JOIN output_profiles p ON p.id = g.output_profile_id
        WHERE g.id = $1 AND g.account_id = $2
        FOR UPDATE OF g`, [groupId, acc])).rows[0];
    if (!tgt) throw notFound('Group not found');
    if (tgt.id === cur.group_id) throw badRequest(`${cur.name} is already in ${tgt.name}.`);

    if (cur.workflow_type && tgt.workflow_type && cur.workflow_type !== tgt.workflow_type) {
      throw conflict(`${tgt.name} is a ${typeLabel(tgt.workflow_type)} group and ${cur.name} is ${typeLabel(cur.workflow_type)}. ` +
        'A stream keeps its workflow, so it can only move to a group of the same type.');
    }

    if (kind === 'channel') {
      const n = (await c.query(
        `SELECT count(*)::int AS n, count(*) FILTER (WHERE kind = 'radio')::int AS radio FROM channels WHERE group_id = $1`, [tgt.id])).rows[0];
      if (n.n >= tgt.max_channels) {
        const tv = n.n - n.radio;
        const parts = [`${tv} TV channel${tv === 1 ? '' : 's'}`];
        if (n.radio) parts.push(`${n.radio} radio station${n.radio === 1 ? '' : 's'}`);
        throw conflict(`${tgt.name} is full: it is given ${tgt.max_channels} channels and stations of the plan and has ${parts.join(' and ')}. ` +
          'Give it a bigger share of the plan, or choose another group.');
      }
    } else if (cur.status !== 'ended') {
      const o = (await c.query(
        `SELECT count(*)::int AS n FROM events
          WHERE group_id = $1 AND status <> 'ended' AND scheduled_start < $3 AND scheduled_end > $2`,
        [tgt.id, cur.scheduled_start, cur.scheduled_end])).rows[0];
      if (o.n >= tgt.max_concurrent) {
        throw conflict(`${tgt.name} already has ${o.n} event${o.n === 1 ? '' : 's'} at the same time as ${cur.name}, ` +
          `and it may run ${tgt.max_concurrent} at once. Choose another group, or give it more running at once.`);
      }
    }

    await c.query(`UPDATE ${table} SET group_id = $2, updated_at = now() WHERE id = $1`, [cur.id, tgt.id]);
    const who = actor(req);
    await writeAudit(c, { accountId: acc, userId: who.userId, label: who.label, action: 'update',
      entityType: kind === 'channel' ? (cur.kind === 'radio' ? 'radio' : 'channel') : 'event', entityId: cur.id,
      changes: { group: { from: cur.group_name, to: tgt.name }, group_id: { from: cur.group_id, to: tgt.id } } });
    return {
      id: cur.id, kind, name: cur.name,
      from: { id: cur.group_id, name: cur.group_name }, to: { id: tgt.id, name: tgt.name },
      profileChanges: (cur.output_profile_id ?? null) !== (tgt.output_profile_id ?? null),
      running: cur.status === 'live' || cur.status === 'provisioning' || cur.status === 'testing',
    };
  });
}
