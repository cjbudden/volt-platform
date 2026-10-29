// ============================================================================
//  STREAM ALERTS: tell the account's admins when a stream needs a person.
//
//  The console shows every fault, but only to somebody looking at it. These
//  are the faults worth an inbox message and an email (and a push where a
//  device is registered), through notifyAccountAdmins:
//
//    stream.encoder_died    the encoder stopped without being asked to (auto
//                           connect will try again; it sends its own alert,
//                           auto_connect.gave_up, if it stops trying)
//    stream.input_error     the source could not be opened or read
//    stream.on_filler       every source lost and the slate or loop has been on
//                           air for FILLER_ALERT_MS (a few seconds' blip, which
//                           failover rides out, is not worth an email)
//    stream.output_timing   the delivered output went back in time, or audio and
//                           video drifted apart (output_check.py)
//
//  NOT NOISE: one alert per stream per topic per ALERT_QUIET_MIN, checked
//  against the notifications already sent (so it holds across restarts and
//  across instances). Never throws: an alert must not fail the report it rides on.
// ============================================================================
import { one } from '../db';

export const ALERT_QUIET_MIN = 30;
export const FILLER_ALERT_MS = 60_000;
/** Timing faults a viewer actually sees. Misaligned segment boundaries are shown in the console only. */
const SERIOUS_TIMING = new Set(['timeline_backwards', 'av_skew', 'rendition_skew', 'sequence_regressed']);

type Kind = 'channel' | 'event';

export interface Alert { topic: string; subject: string; body: string; delayMs?: number }

/** Pure: which alert, if any, an encoder event deserves. */
export function alertFor(name: string, kind: Kind, e: { type: string; detail?: any }, ctx: { wasLive?: boolean } = {}): Alert | null {
  const d = e.detail ?? {};
  const what = kind === 'event' ? 'event' : 'channel';
  switch (e.type) {
    case 'channel.stop': {
      const reason = String(d.reason ?? '');
      // A stop somebody asked for is not news: an operator or a schedule stop
      // marks the stream ended BEFORE the encoder reports, so only a stop that
      // arrives while the stream is still meant to be live is a fault.
      if (!ctx.wasLive) return null;
      return { topic: 'stream.encoder_died', subject: `${name}: the encoder stopped`,
        body: `The encoder for the ${what} "${name}" stopped without being asked to (${reason || 'no reason given'}). Auto connect will try to start it again if it is on for this ${what}.` };
    }
    case 'input.error':
      return { topic: 'stream.input_error', subject: `${name}: the source cannot be read`,
        body: `The ${what} "${name}" could not open or read its source: ${String(d.message ?? 'no detail').slice(0, 400)}` };
    case 'filler.engaged':
      return { topic: 'stream.on_filler', subject: `${name}: on the slate, every source lost`, delayMs: FILLER_ALERT_MS,
        body: `Every source of the ${what} "${name}" has been lost for over ${FILLER_ALERT_MS / 1000} seconds, and viewers are seeing the slate or loop. Check the contribution feed.` };
    case 'output.timeline': {
      if (d.state !== 'fault') return null;
      const serious = (d.faults ?? []).filter((f: any) => SERIOUS_TIMING.has(f.code));
      if (!serious.length) return null;
      return { topic: 'stream.output_timing', subject: `${name}: the output's timing is wrong`,
        body: `Viewers of the ${what} "${name}" may see the picture jump or sound out of sync: ${serious.map((f: any) => f.message).join('; ').slice(0, 600)}` };
    }
    default: return null;
  }
}

async function sentRecently(accountId: string, topic: string, id: string): Promise<boolean> {
  const r = await one<any>(
    `SELECT 1 FROM notifications WHERE account_id = $1 AND topic = $2 AND payload->>'id' = $3
        AND created_at > now() - ($4::int * interval '1 minute') LIMIT 1`, [accountId, topic, id, ALERT_QUIET_MIN]);
  return !!r;
}

/** Called for every encoder event the control plane records. */
export async function alertOnEvent(accountId: string, kind: Kind, id: string, e: { type: string; detail?: any }, ctx: { wasLive?: boolean } = {}): Promise<void> {
  try {
    if (!['channel.stop', 'input.error', 'filler.engaged', 'output.timeline'].includes(e.type)) return;
    const tbl = kind === 'channel' ? 'channels' : 'events';
    const row = await one<any>(`SELECT name FROM ${tbl} WHERE id = $1`, [id]);
    const a = alertFor(row?.name ?? 'A stream', kind, e, ctx);
    if (!a) return;
    const send = async () => {
      if (a.topic === 'stream.on_filler') {
        // still on the filler? a blip that failover rode out is not worth an email
        const col = kind === 'channel' ? 'channel_id' : 'event_id';
        const st = await one<any>(`SELECT filler_in_use FROM stream_status WHERE ${col} = $1`, [id]);
        if (!st?.filler_in_use) return;
      }
      if (await sentRecently(accountId, a.topic, id)) return;
      const { notifyAccountAdmins } = await import('./notifications');
      const path = kind === 'channel' ? `/channels/${id}` : `/events/${id}`;
      await notifyAccountAdmins(accountId, a.topic, a.subject, `${a.body}\n\nOpen it in the console: ${path}`, { kind, id, name: row?.name ?? null });
    };
    if (a.delayMs) setTimeout(() => { send().catch((err) => console.error('[alerts]', a.topic, err)); }, a.delayMs).unref?.();
    else await send();
  } catch (err) {
    console.error('[alerts] could not alert', e.type, id, err);
  }
}
