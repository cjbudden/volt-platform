// ============================================================================
//  NOTIFICATION DELIVERY: real email over SMTP, real FCM push, and the retry
//  policy, against local fakes of both (test/lib/fake-smtp.mjs and an FCM
//  look-alike below). No network.
//
//  Pins: a 5xx address is given up at once with its reason; a 4xx is retried
//  on the backoff and given up at the cap; retryDue only touches what is due;
//  a dead device token is given up and removed; a user's email fans out to
//  their devices; admins are told, other users are not; the message on the
//  wire is well formed (encoded subject, base64 body that decodes back).
//
//  Usage: DATABASE_URL=... npx tsx test/notifications-delivery.check.ts
// ============================================================================
import { createServer } from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-ignore: plain ESM helper shared with the shell suite
import { startFakeSmtp } from './lib/fake-smtp.mjs';

let pass = 0, fail = 0;
const ok = (m: string) => { console.log('PASS ' + m); pass++; };
const bad = (m: string, d: string) => { console.log(`FAIL ${m} -- ${d}`); fail++; };
const truthy = (m: string, v: unknown, d = '') => (v ? ok(m) : bad(m, d || `got [${JSON.stringify(v)}]`));

const ACC = '0000000a-0000-0000-0000-0000000000e1';
const OWNER = '0000000b-0000-0000-0000-0000000000e1';
const VIEWER = '0000000b-0000-0000-0000-0000000000e2';

(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'notif-'));
  const smtpOut = join(dir, 'smtp.jsonl');
  const smtp = await startFakeSmtp(0, smtpOut);
  const smtpPort = (smtp.address() as any).port;

  // ---- FCM look-alike: token endpoint + messages:send
  const sent: any[] = [];
  const fcm = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/token') { res.end(JSON.stringify({ access_token: 'at-123', expires_in: 3600 })); return; }
      if (/\/v1\/projects\/volt-test\/messages:send$/.test(req.url ?? '')) {
        if (req.headers.authorization !== 'Bearer at-123') { res.statusCode = 401; res.end('{}'); return; }
        const m = JSON.parse(body).message;
        if (m.token.startsWith('dead')) { res.statusCode = 404; res.end(JSON.stringify({ error: { status: 'UNREGISTERED', message: 'gone' } })); return; }
        if (m.token.startsWith('flaky')) { res.statusCode = 503; res.end(JSON.stringify({ error: { status: 'UNAVAILABLE', message: 'busy' } })); return; }
        sent.push(m); res.end(JSON.stringify({ name: `projects/volt-test/messages/${sent.length}` })); return;
      }
      res.statusCode = 404; res.end('{}');
    });
  });
  await new Promise<void>((r) => fcm.listen(0, '127.0.0.1', r));
  const fcmPort = (fcm.address() as any).port;
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });

  // configure BEFORE importing the service (it reads env at call time anyway)
  process.env.SMTP_URL = `smtp://volt:secret@127.0.0.1:${smtpPort}`;
  process.env.NOTIFY_FROM = 'Volt Alerts <alerts@volt.example>';
  process.env.FCM_SERVICE_ACCOUNT = JSON.stringify({ project_id: 'volt-test', client_email: 'push@volt-test.iam.gserviceaccount.com', private_key: privateKey });
  process.env.FCM_BASE_URL = `http://127.0.0.1:${fcmPort}`;
  process.env.FCM_TOKEN_URL = `http://127.0.0.1:${fcmPort}/token`;

  const { query, one, pool } = await import('../src/db');
  const N = await import('../src/services/notifications');

  await query(`INSERT INTO accounts(id,name) VALUES ($1,'NotifyCo') ON CONFLICT (id) DO NOTHING`, [ACC]);
  await query(`INSERT INTO users(id,account_id,email,password_hash,role,status) VALUES
                ($1,$3,'owner@notify.example','x','owner','active'),($2,$3,'viewer@notify.example','x','viewer','active')
               ON CONFLICT (id) DO NOTHING`, [OWNER, VIEWER, ACC]);
  await query(`DELETE FROM user_devices WHERE account_id=$1`, [ACC]);
  await query(`INSERT INTO user_devices(account_id,user_id,platform,token) VALUES ($1,$2,'ios','tok-owner-iphone-0001'),($1,$2,'android','dead-owner-old-phone-01')`, [ACC, OWNER]);

  const deliv = async (id: string) => query<any>(`SELECT * FROM notification_deliveries WHERE notification_id=$1 ORDER BY recipient, channel`, [id]);

  console.log('== configuration ==');
  const cfg = N.channelConfig();
  truthy('email configured from SMTP_URL + NOTIFY_FROM', cfg.email.configured && /127\.0\.0\.1/.test(cfg.email.detail));
  truthy('push configured from the service account', cfg.push.configured && /volt-test/.test(cfg.push.detail));

  console.log('\n== email ==');
  const a = await N.sendNotification({ accountId: ACC, topic: 't', recipients: ['ops@notify.example', 'permanent@notify.example', 'fail@notify.example'],
    channels: ['email'], subject: 'Stream “Grand Final” is down', body: 'Line one\nLine two' });
  const [failRow, okRow, permRow] = await deliv(a.id);
  truthy('good address sent', okRow.status === 'sent' && okRow.attempts === 1, JSON.stringify(okRow));
  truthy('550 is given up at once with the reason', permRow.status === 'failed' && permRow.gave_up_at && /550/.test(permRow.last_error), JSON.stringify(permRow));
  truthy('450 stays retryable with a next attempt about a minute out',
    failRow.status === 'failed' && !failRow.gave_up_at && failRow.next_attempt_at && Math.abs(new Date(failRow.next_attempt_at).getTime() - Date.now() - 60_000) < 15_000, JSON.stringify(failRow));
  const lines = readFileSync(smtpOut, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const msg = lines.find((m) => m.to.includes('ops@notify.example'));
  truthy('the server saw an authenticated session from the configured sender', msg && msg.authed && msg.from === 'alerts@volt.example', JSON.stringify(msg));
  truthy('non-ASCII subject is RFC 2047 encoded', msg && /Subject: =\?UTF-8\?B\?/.test(msg.data));
  const b64 = msg ? msg.data.split('\n\n').slice(1).join('').replace(/\s+/g, '') : '';
  truthy('body decodes back to the text', Buffer.from(b64, 'base64').toString('utf8').replace(/\r\n/g, '\n') === 'Line one\nLine two', b64);

  console.log('\n== retry policy ==');
  truthy('retryDue does nothing before the backoff elapses', (await N.retryDue()) === 0);
  await query(`UPDATE notification_deliveries SET next_attempt_at = now() - interval '1 second' WHERE id=$1`, [failRow.id]);
  truthy('retryDue picks up the due one', (await N.retryDue()) === 1);
  const r2 = await one<any>(`SELECT * FROM notification_deliveries WHERE id=$1`, [failRow.id]);
  truthy('second failure backs off to about five minutes', r2.attempts === 2 && Math.abs(new Date(r2.next_attempt_at).getTime() - Date.now() - 300_000) < 15_000, JSON.stringify(r2));
  for (let i = 0; i < 5; i++) await N.retryFailed(ACC, failRow.id);
  const r3 = await one<any>(`SELECT * FROM notification_deliveries WHERE id=$1`, [failRow.id]);
  truthy(`given up at the cap of ${N.MAX_ATTEMPTS} attempts, and says so`, r3.attempts === N.MAX_ATTEMPTS && r3.gave_up_at && /gave up after 5 attempts/.test(r3.last_error), JSON.stringify(r3));
  truthy('a given-up delivery is not retried again', (await N.retryFailed(ACC, failRow.id)) === 0);

  console.log('\n== push ==');
  const p = await N.sendNotification({ accountId: ACC, topic: 't', recipients: ['owner@notify.example', 'tok-direct-device-000001', 'dead-direct-0000000001', 'flaky-device-00000000001', 'viewer@notify.example'],
    channels: ['push'], subject: 'Hello', body: 'World' });
  const rows = Object.fromEntries((await deliv(p.id)).map((r) => [r.recipient, r]));
  truthy('a user email fans out to their devices; one live device is enough', rows['owner@notify.example'].status === 'sent' && /1\/2 device/.test(rows['owner@notify.example'].provider_ref), JSON.stringify(rows['owner@notify.example']));
  truthy('the dead device token was removed from the user', !(await one(`SELECT 1 FROM user_devices WHERE token='dead-owner-old-phone-01'`)));
  truthy('a direct token is sent', rows['tok-direct-device-000001'].status === 'sent');
  truthy('an unregistered token is given up at once', rows['dead-direct-0000000001'].gave_up_at && /UNREGISTERED/.test(rows['dead-direct-0000000001'].last_error));
  truthy('a 503 is retryable', !rows['flaky-device-00000000001'].gave_up_at && rows['flaky-device-00000000001'].next_attempt_at);
  truthy('a user with no devices is given up with the reason', rows['viewer@notify.example'].gave_up_at && /no registered devices/.test(rows['viewer@notify.example'].last_error));
  truthy('FCM got the title and body', sent.some((m) => m.notification?.title === 'Hello' && m.notification?.body === 'World'));

  console.log('\n== telling the admins ==');
  const before = (await query(`SELECT id FROM notifications WHERE account_id=$1`, [ACC])).length;
  await N.notifyAccountAdmins(ACC, 'auto_connect.gave_up', 'Ch: auto connect has stopped trying', 'details');
  const after = await query<any>(`SELECT d.recipient, d.channel, d.status FROM notifications n JOIN notification_deliveries d ON d.notification_id=n.id
                                    WHERE n.account_id=$1 AND n.topic='auto_connect.gave_up'`, [ACC]);
  truthy('one alert was raised', (await query(`SELECT id FROM notifications WHERE account_id=$1`, [ACC])).length > before);
  truthy('the owner gets it in the inbox, by email and on their device', ['in_app', 'email', 'push'].every((c) => after.some((d) => d.recipient === 'owner@notify.example' && d.channel === c && d.status === 'sent')), JSON.stringify(after));
  truthy('a viewer is not told', !after.some((d) => d.recipient === 'viewer@notify.example'));

  console.log('\n== unconfigured ==');
  delete process.env.SMTP_URL;
  const u = await N.sendNotification({ accountId: ACC, topic: 't', recipients: ['ops@notify.example'], channels: ['email'], subject: 's', body: 'b' });
  const [ur] = await deliv(u.id);
  truthy('email with no SMTP_URL is given up with a plain reason, not retried for ever', ur.gave_up_at && /not set up/.test(ur.last_error) && !/SMTP_URL/.test(ur.last_error), JSON.stringify(ur));

  smtp.close(); fcm.close(); await pool.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
