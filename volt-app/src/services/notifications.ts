/**
 * Reusable notification service. One logical notification fans out to
 * per-recipient × per-channel DELIVERIES, each attempted independently with
 * retry. Channels are pluggable adapters (in_app is the delivery row itself;
 * email/push are stubs until SES/FCM are wired). Templated with {{var}}.
 * Callers: event reminders (orchestrator), alerts, publishing, expiry.
 */
import { query, one } from '../db';

export type Channel = 'email' | 'in_app' | 'push';

export function render(tpl: string, payload: Record<string, any> = {}): string {
  return tpl.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => (payload[k] != null ? String(payload[k]) : ''));
}

// Adapters: resolve on success, throw on failure. in_app succeeds by virtue of
// the delivery row (the inbox). email/push are stubs; a 'fail@'/'bad-' recipient
// simulates a transient failure so retry can be exercised.
const adapters: Record<Channel, (recipient: string, subject: string, body: string) => Promise<void>> = {
  in_app: async () => {},
  email: async (recipient) => {
    if (recipient.startsWith('fail@')) throw new Error('smtp rejected recipient');
  },
  push: async (recipient) => {
    if (recipient.startsWith('bad-')) throw new Error('push token invalid');
  },
};

async function attempt(deliveryId: string, recipient: string, channel: Channel, subject: string, body: string) {
  try {
    await adapters[channel](recipient, subject, body);
    await query(`UPDATE notification_deliveries SET status='sent', attempts=attempts+1, sent_at=now(), last_error=NULL WHERE id=$1`, [deliveryId]);
  } catch (e: any) {
    await query(`UPDATE notification_deliveries SET status='failed', attempts=attempts+1, last_error=$2 WHERE id=$1`, [deliveryId, String(e?.message ?? e)]);
  }
}

export interface SendOpts {
  accountId: string;
  topic: string;
  recipients: string[];
  channels: Channel[];
  subject?: string;
  body?: string;
  payload?: Record<string, any>;
  templateKey?: string;
}

/** Create a notification + its deliveries and attempt each. Returns the notification id. */
export async function sendNotification(o: SendOpts): Promise<{ id: string; deliveries: number }> {
  let subject = o.subject ?? '';
  let body = o.body ?? '';
  if (o.templateKey) {
    const t = await one<any>(`SELECT subject, body FROM notification_templates WHERE account_id=$1 AND key=$2`, [o.accountId, o.templateKey]);
    if (t) {
      subject = render(t.subject, o.payload);
      body = render(t.body, o.payload);
    }
  } else {
    subject = render(subject, o.payload);
    body = render(body, o.payload);
  }
  const notif = await one<any>(
    `INSERT INTO notifications(account_id, topic, subject, body, payload) VALUES ($1,$2,$3,$4,$5::jsonb) RETURNING id`,
    [o.accountId, o.topic, subject, body, JSON.stringify(o.payload ?? {})]
  );
  let n = 0;
  for (const recipient of o.recipients) {
    for (const channel of o.channels) {
      const d = await one<any>(
        `INSERT INTO notification_deliveries(notification_id, account_id, recipient, channel) VALUES ($1,$2,$3,$4::notification_channel) RETURNING id`,
        [notif.id, o.accountId, recipient, channel]
      );
      await attempt(d.id, recipient, channel, subject, body);
      n++;
    }
  }
  return { id: notif.id, deliveries: n };
}

/** Re-attempt this account's failed deliveries. Returns how many were retried. */
export async function retryFailed(accountId: string): Promise<number> {
  const rows = await query<any>(
    `SELECT d.id, d.recipient, d.channel, n.subject, n.body
       FROM notification_deliveries d JOIN notifications n ON n.id=d.notification_id
      WHERE d.account_id=$1 AND d.status='failed'`,
    [accountId]
  );
  for (const r of rows) await attempt(r.id, r.recipient, r.channel, r.subject ?? '', r.body ?? '');
  return rows.length;
}
