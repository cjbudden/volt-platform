/**
 * Reusable notification service. One logical notification fans out to
 * per-recipient × per-channel DELIVERIES, each attempted independently.
 * Templated with {{var}}.
 *
 * CHANNELS
 *   in_app  the delivery row IS the message: it shows in the recipient's inbox.
 *   email   real SMTP (services/mail/smtp.ts), configured by SMTP_URL + NOTIFY_FROM.
 *   push    Firebase Cloud Messaging (services/push/fcm.ts), configured by
 *           FCM_SERVICE_ACCOUNT. The recipient is a device token, or a user's
 *           email, which fans out to that user's registered devices.
 *
 * RETRY POLICY
 *   A failure that retrying might fix (a 4xx from the mail server, a network
 *   error, a 5xx from FCM) is tried again on a backoff: 1, 5, 15 and 60
 *   minutes. After MAX_ATTEMPTS it is given up. A failure retrying cannot fix
 *   (a rejected address, a dead device token, the channel not configured) is
 *   given up at once, with the reason, instead of being re-sent for ever.
 *   retryDue() runs on the orchestrator tick; the Retry button runs it for one
 *   account, now, ignoring the backoff but not the cap.
 *
 * CALLERS: auto-connect giving up (orchestrator/resume.ts), XMLTV import
 * failures, social publishing failures, and the API.
 */
import { query, one } from '../db';
import { sendMail, parseSmtpUrl, SmtpError } from './mail/smtp';
import { sendPush, serviceAccount, PushError } from './push/fcm';

export type Channel = 'email' | 'in_app' | 'push';
export const MAX_ATTEMPTS = 5;
const BACKOFF_MIN = [1, 5, 15, 60];

export function render(tpl: string, payload: Record<string, any> = {}): string {
  return tpl.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => (payload[k] != null ? String(payload[k]) : ''));
}

/** Which channels can actually deliver on this deployment. */
export function channelConfig(): Record<Channel, { configured: boolean; detail: string }> {
  let email = { configured: false, detail: 'Set SMTP_URL and NOTIFY_FROM to send email.' };
  if (process.env.SMTP_URL) {
    try {
      const t = parseSmtpUrl(process.env.SMTP_URL);
      email = { configured: !!process.env.NOTIFY_FROM, detail: process.env.NOTIFY_FROM ? `SMTP via ${t.host}:${t.port} from ${process.env.NOTIFY_FROM}` : 'SMTP_URL is set but NOTIFY_FROM is not.' };
    } catch (e: any) { email = { configured: false, detail: e.message }; }
  }
  let push = { configured: false, detail: 'Set FCM_SERVICE_ACCOUNT to send device push.' };
  try { const sa = serviceAccount(); if (sa) push = { configured: true, detail: `Firebase project ${sa.project_id}` }; }
  catch { push = { configured: false, detail: 'FCM_SERVICE_ACCOUNT is not valid service account JSON.' }; }
  return { in_app: { configured: true, detail: 'Shown in each recipient\'s inbox in the console.' }, email, push };
}

class Permanent extends Error {}

type Adapter = (recipient: string, subject: string, body: string, accountId: string) => Promise<string | void>;
const adapters: Record<Channel, Adapter> = {
  in_app: async () => {},
  email: async (recipient, subject, body) => {
    const url = process.env.SMTP_URL;
    const from = process.env.NOTIFY_FROM;
    if (!url || !from) throw new Permanent('Email is not configured on this deployment (SMTP_URL, NOTIFY_FROM).');
    try {
      const r = await sendMail(parseSmtpUrl(url), { from, to: recipient, subject, text: body });
      return r.response.slice(0, 200);
    } catch (e: any) {
      if (e instanceof SmtpError && e.permanent) throw new Permanent(e.message);
      throw e;
    }
  },
  push: async (recipient, subject, body, accountId) => {
    // A user's email fans out to every device they registered; anything else is a token.
    const tokens = recipient.includes('@')
      ? (await query<any>(
          `SELECT d.token FROM user_devices d JOIN users u ON u.id = d.user_id
            WHERE d.account_id = $1 AND lower(u.email) = lower($2)`, [accountId, recipient])).map((r) => r.token)
      : [recipient];
    if (!tokens.length) throw new Permanent(`${recipient} has no registered devices.`);
    const errors: string[] = []; let sent = 0; let allPermanent = true;
    for (const t of tokens) {
      try { await sendPush(t, subject, body); sent++; }
      catch (e: any) {
        errors.push(e.message);
        if (!(e instanceof PushError && e.permanent)) allPermanent = false;
        if (e instanceof PushError && e.permanent && /UNREGISTERED|404/.test(e.message)) {
          await query(`DELETE FROM user_devices WHERE token = $1`, [t]).catch(() => {});
        }
      }
    }
    if (sent) return `${sent}/${tokens.length} device(s)`;
    if (allPermanent) throw new Permanent(errors[0] ?? 'push refused');
    throw new Error(errors[0] ?? 'push failed');
  },
};

/** One attempt. Records the outcome and, on failure, when to try next or that it is finished. */
async function attempt(deliveryId: string, recipient: string, channel: Channel, subject: string, body: string, accountId: string, attemptsSoFar: number) {
  try {
    const ref = await adapters[channel](recipient, subject, body, accountId);
    await query(
      `UPDATE notification_deliveries SET status='sent', attempts=attempts+1, sent_at=now(), last_error=NULL,
              next_attempt_at=NULL, provider_ref=$2 WHERE id=$1`, [deliveryId, ref ? String(ref) : null]);
  } catch (e: any) {
    const n = attemptsSoFar + 1;
    const giveUp = e instanceof Permanent || n >= MAX_ATTEMPTS;
    const wait = BACKOFF_MIN[Math.min(n - 1, BACKOFF_MIN.length - 1)];
    const reason = giveUp && !(e instanceof Permanent) ? `${String(e?.message ?? e)} (gave up after ${n} attempts)` : String(e?.message ?? e);
    await query(
      `UPDATE notification_deliveries SET status='failed', attempts=attempts+1, last_error=$2,
              next_attempt_at = CASE WHEN $3 THEN NULL ELSE now() + make_interval(mins => $4) END,
              gave_up_at = CASE WHEN $3 THEN now() ELSE NULL END
        WHERE id=$1`, [deliveryId, reason.slice(0, 500), giveUp, wait]);
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
  for (const recipient of [...new Set(o.recipients.map((r) => r.trim()).filter(Boolean))]) {
    for (const channel of [...new Set(o.channels)]) {
      const d = await one<any>(
        `INSERT INTO notification_deliveries(notification_id, account_id, recipient, channel) VALUES ($1,$2,$3,$4::notification_channel) RETURNING id`,
        [notif.id, o.accountId, recipient, channel]
      );
      await attempt(d.id, recipient, channel, subject, body, o.accountId, 0);
      n++;
    }
  }
  return { id: notif.id, deliveries: n };
}

async function retryRows(rows: any[]): Promise<number> {
  for (const r of rows) await attempt(r.id, r.recipient, r.channel, r.subject ?? '', r.body ?? '', r.account_id, r.attempts);
  return rows.length;
}

/** Retry this account's failed deliveries now (ignores the backoff, keeps the cap). */
export async function retryFailed(accountId: string, deliveryId?: string): Promise<number> {
  const rows = await query<any>(
    `SELECT d.id, d.recipient, d.channel, d.attempts, d.account_id, n.subject, n.body
       FROM notification_deliveries d JOIN notifications n ON n.id=d.notification_id
      WHERE d.account_id=$1 AND d.status='failed' AND d.gave_up_at IS NULL
        AND ($2::uuid IS NULL OR d.id = $2::uuid)`,
    [accountId, deliveryId ?? null]
  );
  return retryRows(rows);
}

/** Orchestrator tick: retry whatever is due, across accounts, a bounded batch. */
export async function retryDue(limit = 50): Promise<number> {
  const rows = await query<any>(
    `SELECT d.id, d.recipient, d.channel, d.attempts, d.account_id, n.subject, n.body
       FROM notification_deliveries d JOIN notifications n ON n.id=d.notification_id
      WHERE d.status='failed' AND d.gave_up_at IS NULL AND d.next_attempt_at <= now()
      ORDER BY d.next_attempt_at LIMIT $1`, [limit]);
  return retryRows(rows);
}

/**
 * Tell the people who run this account. Owners and admins, in the console
 * inbox always, and by email and push when those are configured. Never throws:
 * a notification failing must not fail the thing it is reporting on.
 */
export async function notifyAccountAdmins(accountId: string, topic: string, subject: string, body: string, payload: Record<string, any> = {}): Promise<void> {
  try {
    const admins = await query<any>(
      `SELECT u.email, EXISTS (SELECT 1 FROM user_devices d WHERE d.user_id = u.id) AS has_device
         FROM users u WHERE u.account_id = $1 AND u.role IN ('owner', 'admin') AND COALESCE(u.status, 'active') = 'active'`, [accountId]);
    if (!admins.length) return;
    const cfg = channelConfig();
    const base: Channel[] = ['in_app', ...(cfg.email.configured ? ['email' as const] : [])];
    // Push only to admins who have a device registered: everyone else would
    // collect a "no registered devices" failure on every alert.
    const withDevice = cfg.push.configured ? admins.filter((a) => a.has_device).map((a) => a.email) : [];
    const without = admins.map((a) => a.email).filter((e) => !withDevice.includes(e));
    if (withDevice.length) await sendNotification({ accountId, topic, recipients: withDevice, channels: [...base, 'push'], subject, body, payload });
    if (without.length) await sendNotification({ accountId, topic, recipients: without, channels: base, subject, body, payload });
  } catch (e) {
    console.error('[notifications] notifyAccountAdmins failed', topic, e);
  }
}
