/**
 * Demo account for the customer guides' screenshots (build queue 1.14-G0).
 *
 * The everyday demo seed (seed-demo.ts) is named after a real prospect, and a
 * screenshot carries whatever the page shows: the docs site's banned-term
 * check reads text, not pictures. So this runs that seed and then gives the
 * account, its people and its streams neutral names, plus a little history
 * (audit rows) so pages that list past actions are not empty in a guide.
 * The screenshot script (docs-site/scripts/screenshots.mjs) still checks every
 * page's visible text against scrub.json before it saves a picture, as a net
 * for anything a future seed or page adds.
 *
 *   DATABASE_URL=... npx tsx scripts/seed-docs.ts
 * Sign-in afterwards: admin@example.com / volt1234
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { query, pool } from '../src/db';
import { writeAudit } from '../src/services/audit';
import { fillerPath } from '../src/services/uploads';
import { imageStore } from '../src/services/imageStore';
import { upsertMediaRow } from '../src/services/mediaLibrary';
import { ensureTrackingGroup } from '../src/services/encode/store';
import { hashPassword } from '../src/auth/password';
import { generateKey } from '../src/services/apiKeys';
import { addSandbox } from '../src/services/social/index';
import { ensureDefaultRoles } from '../src/auth/defaultRoles';
import { config } from '../src/config';

const ACCOUNT = '3de20755-af2b-46d0-8d24-f39afbf4b3a0';
const ADMIN = '8342a24d-751f-46ca-9636-f72a8a1110ef';
const NEWS = 'ae0e5ac4-9833-48b7-ab97-91df0d27467c';
const SPORT = '32cfef30-0d1d-44df-b2b8-0ed5a06bdf80';
export const DOCS_LOGIN = { email: 'admin@example.com', password: 'volt1234' };

async function main() {
  const r = spawnSync(join(__dirname, '../node_modules/.bin/tsx'), [join(__dirname, 'seed-demo.ts')], {
    cwd: join(__dirname, '..'), stdio: 'inherit', env: process.env,
  });
  if (r.status !== 0) throw new Error('seed-demo.ts failed');

  await query(`UPDATE accounts SET name='Example Broadcaster' WHERE id=$1`, [ACCOUNT]);
  await query(`UPDATE users SET email=$2 WHERE id=$1`, [ADMIN, DOCS_LOGIN.email]);
  await query(`UPDATE groups SET name='Main' WHERE account_id=$1 AND name='RTM Main'`, [ACCOUNT]);
  // The demo seed gives its one group a share of 10 on a plan of 5, which the
  // Channel Groups guide would show as more shared out than the plan holds.
  // Fit it to the plan and make it the default group, as an account starts.
  // Running at once too: a group allowed more than the plan made the plan
  // itself impossible to save on Plan & limits (found writing the G4 guides).
  await query(`UPDATE groups SET max_channels=LEAST(max_channels, (SELECT max_channels FROM accounts WHERE id=$1)), max_concurrent=LEAST(max_concurrent, (SELECT max_concurrent_sources FROM accounts WHERE id=$1)), is_default=true WHERE account_id=$1 AND name='Main'`, [ACCOUNT]);
  await query(`UPDATE channels SET name='News 24' WHERE id=$1`, [NEWS]);
  await query(`UPDATE channels SET name='Sport One' WHERE id=$1`, [SPORT]);

  // One radio station, so the Radio guide shows a station rather than the
  // empty state. Neutral name and an example source: a screenshot carries
  // whatever the page shows. Created stopped and off air; re-running the seed
  // keeps the one already there.
  const grp = await query<{ id: string }>(`SELECT id FROM groups WHERE account_id=$1 ORDER BY created_at LIMIT 1`, [ACCOUNT]);
  const have = await query(`SELECT 1 FROM channels c JOIN groups g ON g.id=c.group_id WHERE g.account_id=$1 AND c.kind='radio' AND c.name='Radio One'`, [ACCOUNT]);
  if (grp[0] && !have.length) {
    const ch = await query<{ id: string }>(
      `INSERT INTO channels(group_id, name, kind, radio_config, recording_enabled) VALUES ($1,'Radio One','radio',$2::jsonb,true) RETURNING id`,
      [grp[0].id, JSON.stringify({ outputs: { mp3: true, hls: true, dash: true }, bitrateKbps: 128, metadataCapture: true })]);
    await query(`INSERT INTO stream_inputs(channel_id, role, protocol, ingest_url) VALUES ($1,'primary','icecast'::ingest_protocol,$2)`,
      [ch[0].id, 'https://source.example/radio-one-128-mp3']);
  }

  // Loops & Fillers: one slate and one loop, so its guide shows the list rather
  // than the empty state, and News 24 falls back to the slate (Used by). The
  // files are small neutral pictures kept beside this script; the rows are laid
  // out exactly as an upload leaves them. Fixed ids keep re-runs to one each.
  const fillers: Array<[string, 'slate' | 'loop', string, string, string, number, number, number | null]> = [
    ['5d0c6a1e-2f4b-4c1a-9e1d-3a7b2c9d0e01', 'slate', 'Standby slate', 'standby-slate.png', 'image/png', 1280, 720, null],
    ['5d0c6a1e-2f4b-4c1a-9e1d-3a7b2c9d0e02', 'loop', 'Break loop', 'break-loop.mp4', 'video/mp4', 640, 360, 4000],
  ];
  for (const [id, kind, name, file, ct, w, h, ms] of fillers) {
    const src = join(__dirname, 'docs-media', file);
    const dest = fillerPath(ACCOUNT, id, file);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
    const key = `filler/${ACCOUNT}/${id}${file.slice(file.lastIndexOf('.'))}`;
    await query(
      `INSERT INTO filler_assets(id, account_id, kind, name, status, source_key, width, height, duration_ms, bytes, content_type, filename, uploaded_at, created_at)
       VALUES ($1,$2,$3,$4,'ready',$5,$6,$7,$8,$9,$10,$11, now() - interval '2 days', now() - interval '2 days')
       ON CONFLICT (id) DO UPDATE SET status='ready', source_key=EXCLUDED.source_key, bytes=EXCLUDED.bytes`,
      [id, ACCOUNT, kind, name, key, w, h, ms, statSync(src).size, ct, file]);
  }
  await query(`UPDATE channels SET input_loss_behavior='slate', filler_asset_id=$2, filler_slate_ref=NULL WHERE id=$1`, [NEWS, fillers[0][0]]);

  // The media sections (guides batch 1.14-G3) would otherwise all open on their
  // empty states. Two images in the Image Library (the slate picture again, so
  // no new file is needed), a ladder that mirrors the live HD profile and is the
  // account default, a watchfolder with two rules on a folder that exists, and
  // the built-in demo add-on attached to Recording completed. Each is keyed so
  // a re-run keeps one of each.
  const slatePng = readFileSync(join(__dirname, 'docs-media', 'standby-slate.png'));
  for (const [folder, name, kind] of [['slates', 'standby-slate.png', 'slate'], ['brands', 'station-brand.png', 'brand']] as const) {
    const path = `${folder}/${name}`;
    const storeKey = `library/${ACCOUNT}/${path}`;
    await imageStore().put(storeKey, slatePng, 'image/png');
    await query(`INSERT INTO media_folders(account_id, path) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [ACCOUNT, folder]);
    await upsertMediaRow({
      accountId: ACCOUNT, kind, path, folder, name, storeKey, sizeBytes: slatePng.length, contentType: 'image/png',
      tags: [], userId: ADMIN, source: 'upload', facts: { width: 1280, height: 720, contentType: 'image/png' },
    } as any);
  }
  const hd = await query<{ id: string; name: string }>(
    `SELECT id, name FROM output_profiles WHERE account_id=$1 ORDER BY name LIMIT 1`, [ACCOUNT]);
  if (hd[0]) {
    const hasDefault = await query(`SELECT 1 FROM encode_ladder_groups WHERE account_id=$1 AND is_default`, [ACCOUNT]);
    await ensureTrackingGroup(ACCOUNT, hd[0].id, `Same as ${hd[0].name}`, { makeDefault: !hasDefault.length, userId: ADMIN });
  }
  const WATCH = '5d0c6a1e-2f4b-4c1a-9e1d-3a7b2c9d0e10';
  // A neutral path that exists on any Mac or Linux box: the console shows it,
  // and a missing folder would read as scan failing in the screenshot.
  const watchDir = '/tmp/volt-docs/agency-drop';
  mkdirSync(watchDir, { recursive: true });
  await query(
    `INSERT INTO watchfolders(id, account_id, name, kind, config, created_by, updated_by)
     VALUES ($1,$2,'Agency drop','local',$3::jsonb,$4,$4)
     ON CONFLICT (id) DO UPDATE SET config=EXCLUDED.config`,
    [WATCH, ACCOUNT, JSON.stringify({ path: watchDir }), ADMIN]);
  await query(`DELETE FROM watchfolder_rules WHERE watchfolder_id=$1`, [WATCH]);
  await query(
    `INSERT INTO watchfolder_rules(watchfolder_id, ordinal, name, match_type, pattern, target_kind, workflow) VALUES
       ($1,1,'Slates','glob','slate_*.png','slate','register'),
       ($1,2,'Programmes','glob','*.mp4','programme','register')`, [WATCH]);
  const DEMO = '5d0c6a1e-2f4b-4c1a-9e1d-3a7b2c9d0e20';
  await query(
    `INSERT INTO addon_services(id, account_id, name, description, category, kind, signing_secret, accepts, steps, timeout_sec)
     VALUES ($1,$2,'Summary agent','Writes a summary and chapters for each recording','ai_agent','demo','docs-seed-not-a-secret',
             ARRAY['recording','vod_asset']::text[], '[]'::jsonb, 600)
     ON CONFLICT (id) DO NOTHING`, [DEMO, ACCOUNT]);
  await query(`DELETE FROM addon_triggers WHERE addon_id=$1`, [DEMO]);
  await query(`INSERT INTO addon_triggers(account_id, addon_id, hook) VALUES ($1,$2,'recording.completed')`, [ACCOUNT, DEMO]);

  // A short, believable history for the audit log. Re-running the seed
  // replaces it rather than piling up copies.
  await query(`DELETE FROM audit_log WHERE account_id=$1 AND detail->>'seed'='docs'`, [ACCOUNT]);
  const label = 'admin@example.com';
  // The snapshot carries the name, so the log says which channel, not an id.
  const rows: Array<[string, 'create' | 'update' | 'delete', string, string, string, Record<string, { from: any; to: any }> | undefined]> = [
    ['5 hours', 'create', 'channel', SPORT, 'Sport One', undefined],
    ['3 hours', 'update', 'channel', NEWS, 'News 24', { name: { from: 'News', to: 'News 24' } }],
    ['2 hours', 'update', 'channel', NEWS, 'News 24', { failover_enabled: { from: false, to: true } }],
    ['40 minutes', 'update', 'channel', SPORT, 'Sport One', { name: { from: 'Sport', to: 'Sport One' } }],
  ];
  for (const [ago, action, type, id, name, changes] of rows) {
    await writeAudit(null, { accountId: ACCOUNT, userId: ADMIN, label, action, entityType: type, entityId: id, changes, snapshot: { name } });
    await query(
      `UPDATE audit_log SET created_at = now() - $2::interval, detail = detail || '{"seed":"docs"}'::jsonb
        WHERE id = (SELECT id FROM audit_log WHERE account_id=$1 ORDER BY created_at DESC LIMIT 1)`,
      [ACCOUNT, ago],
    );
  }

  await seedAccountSections();
  await seedFast();

  console.log(`\ndocs demo ready. Sign in as ${DOCS_LOGIN.email} (password as in seed-demo.ts)`);
  await pool.end();
}

// FAST (build queue 1.14-G5c). The FAST library offers only titles that can
// air: packaged for splicing, or with their uploaded file still on this server
// so activating the run order can prepare them. The demo seed's assets have
// neither, so the FAST guides could show an empty library and no week. This
// adds four short titles with real source files, laid out exactly as a video
// upload leaves them (source under clips/vod-src, nothing packaged yet), and a
// FAST channel whose draft run order uses them: a three-episode series and a
// film, rounded up to the half hour so the week reads like a guide grid.
// The files are generated with ffmpeg (a test pattern and a tone, 2 to 3 MB
// each) rather than kept in the repo, and only when missing, so a re-run is
// quick. Activating the run order prepares them through the normal encode.
const DOCS_FAST = {
  channel: '5d0c6a1e-2f4b-4c1a-9e1d-3a7b2c9d0e30',
  lineup: '5d0c6a1e-2f4b-4c1a-9e1d-3a7b2c9d0e31',
  assets: [
    { id: '5d0c6a1e-2f4b-4c1a-9e1d-3a7b2c9d0e32', title: 'Harbour Market', series: 'Coastal Kitchens', season: 1, episode: 1, sec: 48, tone: 440 },
    { id: '5d0c6a1e-2f4b-4c1a-9e1d-3a7b2c9d0e33', title: 'Smoke and Salt', series: 'Coastal Kitchens', season: 1, episode: 2, sec: 52, tone: 523 },
    { id: '5d0c6a1e-2f4b-4c1a-9e1d-3a7b2c9d0e34', title: 'The Night Bakery', series: 'Coastal Kitchens', season: 1, episode: 3, sec: 50, tone: 587 },
    { id: '5d0c6a1e-2f4b-4c1a-9e1d-3a7b2c9d0e35', title: 'A Quiet Valley', series: null, season: null, episode: null, sec: 64, tone: 659 },
  ],
} as const;

async function seedFast() {
  const ffmpeg = process.env.FFMPEG_BIN || 'ffmpeg';
  if (spawnSync(ffmpeg, ['-version'], { stdio: 'ignore' }).status !== 0) {
    console.warn('[seed-docs] ffmpeg not found: no FAST titles or FAST channel (the FAST screenshots need them)');
    return;
  }
  const srcDir = join(config.clips.dir, 'vod-src');
  mkdirSync(srcDir, { recursive: true });
  for (const a of DOCS_FAST.assets) {
    const src = join(srcDir, `${a.id}.mp4`);
    if (!existsSync(src)) {
      const r = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25',
        '-f', 'lavfi', '-i', `sine=frequency=${a.tone}:sample_rate=48000`,
        '-t', String(a.sec), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '32', '-pix_fmt', 'yuv420p', '-g', '50',
        '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', src], { stdio: 'inherit' });
      if (r.status !== 0) throw new Error(`ffmpeg could not make ${src}`);
    }
    const metadata: Record<string, unknown> = { title: a.title };
    if (a.series) Object.assign(metadata, { series: a.series, season: a.season, episodeNumber: a.episode });
    await query(
      `INSERT INTO vod_assets(id, account_id, source_kind, kind, title, source_key, source_bytes, start_epoch_ms, end_epoch_ms, duration_ms, metadata, created_at)
       VALUES ($1,$2,'upload','clip',$3,$4,$5,0,$6,$6,$7::jsonb, now() - interval '3 days')
       ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title, source_key=EXCLUDED.source_key, source_bytes=EXCLUDED.source_bytes,
         duration_ms=EXCLUDED.duration_ms, end_epoch_ms=EXCLUDED.end_epoch_ms, metadata=EXCLUDED.metadata`,
      [a.id, ACCOUNT, a.title, src, statSync(src).size, a.sec * 1000, JSON.stringify(metadata)]);
  }

  // The channel, as POST /api/fast/channels makes it: a playlist channel with
  // no source, no recording and no encoder, its ads row, and one lineup.
  const grp = await query<{ id: string }>(`SELECT id FROM groups WHERE account_id=$1 AND name='Main' LIMIT 1`, [ACCOUNT]);
  if (!grp[0]) throw new Error('docs seed: no Main group for the FAST channel');
  const zone = 'Australia/Sydney';
  await query(
    `INSERT INTO channels(id, group_id, name, origin, fast_media, recording_enabled, tz, created_by, updated_by)
     VALUES ($1,$2,'Food & Travel','playlist','video',false,$3,$4,$4)
     ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name`,
    [DOCS_FAST.channel, grp[0].id, zone, ADMIN]);
  await query(`INSERT INTO channel_ads(channel_id) VALUES ($1) ON CONFLICT DO NOTHING`, [DOCS_FAST.channel]);
  const [e1, , , film] = DOCS_FAST.assets;
  const slots = [
    { id: 's1', kind: 'series', series: e1.series, count: 3, order: 'sequential', atEnd: 'loop' },
    { id: 's2', kind: 'title', pool: [{ assetId: film.id }] },
  ];
  // Left a draft: the guide shows building and checking a run order before it
  // airs, and activating needs the API (it prepares the titles and starts the
  // playout). The epoch is the seed's own midnight, so the week starts today.
  await query(
    `INSERT INTO fast_lineups(id, channel_id, name, epoch, zone, slots, settings, status, created_by)
     VALUES ($1,$2,'Main lineup', date_trunc('day', now() AT TIME ZONE $3) AT TIME ZONE $3, $3, $4::jsonb, $5::jsonb, 'draft', $6)
     ON CONFLICT (id) DO UPDATE SET slots=EXCLUDED.slots, settings=EXCLUDED.settings, epoch=EXCLUDED.epoch, status='draft'`,
    [DOCS_FAST.lineup, DOCS_FAST.channel, zone, JSON.stringify(slots), JSON.stringify({ gridMin: 30, horizonDays: 7 }), ADMIN]);
}

// The audience, account and access sections (guides batch 1.14-G4) would
// otherwise open on empty states, or on the demo seed's prospect-named rows:
// a fortnight of audience figures with neutral app names, two colleagues and a
// custom role, two public users, a registered web and iOS app, one alert with
// a delivered and a failed copy, a template, a sandbox social account, a
// product with a viewer who holds it, and the server the running channel is on
// with a week of metered time. Everything is keyed or cleared first, so a
// re-run keeps one of each.
const HOST = '6a7f3c1e-4b2d-4e8f-9a61-0d5c2b7e8f10';
const SAM = '0b6f1f7e-2a43-4c1e-9d55-3a8e6c4b2d11';
const ALEX = '1c7a2e8f-3b54-4d2f-8e66-4b9f7d5c3e22';
const NEWSDESK = '2d8b3f9a-4c65-4e3a-9f77-5ca08e6d4f33';
const JORDAN = '3e9c4a0b-5d76-4f4b-8a88-6db19f7e5a44';
const WEBAPP = '4fad5b1c-6e87-4a5c-9b99-7ec2a08f6b55';
const IOSAPP = '5abe6c2d-7f98-4b6d-8caa-8fd3b19a7c66';
const PRODUCT = '6bcf7d3e-8a09-4c7e-9dbb-90e4c2ab8d77';

async function seedAccountSections() {
  // Audience: daily figures for two weeks, the last day still open. The demo
  // seed's one row names its prospect's app, which a screenshot would carry.
  await query(`DELETE FROM analytics_rollups WHERE account_id=$1`, [ACCOUNT]);
  for (let d = 13; d >= 0; d--) {
    const w = 1 + 0.35 * Math.sin(d / 2.2) + (d % 7 === 1 || d % 7 === 2 ? 0.25 : 0);
    const views = Math.round(820 * w), uniques = Math.round(views * 0.71), peak = Math.round(96 * w);
    const sealed = d > 0;
    const json = (o: Record<string, number>) => JSON.stringify(o);
    const split = (n: number, parts: Array<[string, number]>) => Object.fromEntries(parts.map(([k, f]) => [k, Math.round(n * f)]));
    await query(
      `INSERT INTO analytics_rollups(account_id, scope, scope_id, bucket_date, total_views, unique_views, peak_concurrent, watch_seconds, blocked_count, by_app, by_device, by_geo, sealed, sealed_at)
       VALUES ($1,'account',NULL,current_date - $2::int,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11, CASE WHEN $11 THEN now() END)`,
      [ACCOUNT, d, views, uniques, peak, views * 410, Math.round(views * 0.012),
        json(split(views, [['Web player', 0.52], ['iOS app', 0.27], ['TV app', 0.21]])),
        json(split(views, [['Mobile', 0.46], ['Desktop', 0.31], ['TV', 0.23]])),
        json(split(views, [['AU', 0.68], ['NZ', 0.17], ['GB', 0.09], ['US', 0.06]])), sealed]);
    for (const [id, share] of [[NEWS, 0.62], [SPORT, 0.38]] as const) {
      const v = Math.round(views * share);
      await query(
        `INSERT INTO analytics_rollups(account_id, scope, scope_id, bucket_date, total_views, unique_views, peak_concurrent, watch_seconds, by_app, by_device, by_geo, sealed, sealed_at)
         VALUES ($1,'channel',$2,current_date - $3::int,$4,$5,$6,$7,'{}','{}','{}',$8, CASE WHEN $8 THEN now() END)`,
        [ACCOUNT, id, d, v, Math.round(v * 0.7), Math.round(peak * share), v * 410, sealed]);
    }
  }
  await query(`UPDATE stream_concurrency SET concurrent=64, updated_at=now() WHERE account_id=$1`, [ACCOUNT]);

  // People: a colleague on a default role, an invited one on a custom role.
  const pw = await hashPassword('volt1234');
  await query(
    `INSERT INTO user_groups(id, account_id, name, description, permissions, tier, is_system)
     VALUES ($1,$2,'News desk','Runs the news channel and its events, and watches monitoring. Cannot create or change them.',$3::jsonb,'operator',false)
     ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, description=EXCLUDED.description, permissions=EXCLUDED.permissions`,
    [NEWSDESK, ACCOUNT, JSON.stringify({ monitoring: 'view', channels: 'operate', events: 'operate', epg: 'view', recordings: 'view' })]);
  // The default roles are made when the API starts; a fresh database has none yet.
  await ensureDefaultRoles(ACCOUNT);
  const eventManager = await query<any>(`SELECT id FROM user_groups WHERE role_key='event_manager' AND is_system AND account_id=$1 LIMIT 1`, [ACCOUNT]);
  await query(
    `INSERT INTO users(id, account_id, email, password_hash, role, status, display_name, email_verified_at, created_at)
     VALUES ($1,$3,'sam.lee@example.com',$4,'operator','active','Sam Lee',now(),now() - interval '20 days'),
            ($2,$3,'alex.chen@example.com',$4,'operator','invited','Alex Chen',NULL,now() - interval '1 day')
     ON CONFLICT (id) DO NOTHING`, [SAM, ALEX, ACCOUNT, pw]);
  await query(`DELETE FROM user_group_members WHERE user_id = ANY($1::uuid[])`, [[SAM, ALEX]]);
  if (eventManager[0]) await query(`INSERT INTO user_group_members(user_id, group_id, granted_by) VALUES ($1,$2,$3)`, [SAM, eventManager[0].id, ADMIN]);
  await query(`INSERT INTO user_group_members(user_id, group_id, granted_by) VALUES ($1,$2,$3)`, [ALEX, NEWSDESK, ADMIN]);

  // Public users: one with a Volt account, one from the broadcaster's own sign-in.
  await query(
    `INSERT INTO viewers(id, account_id, external_id, email, display_name, groups, status, source, password_hash, email_verified_at, last_seen_at, created_at)
     VALUES ($1,$2,'jordan@example.net','jordan@example.net','Jordan Smith','{members}','active','hosted',$3,now(),now() - interval '2 hours',now() - interval '30 days')
     ON CONFLICT (id) DO NOTHING`, [JORDAN, ACCOUNT, pw]);
  await query(
    `INSERT INTO viewers(account_id, external_id, groups, status, source, last_seen_at, created_at)
     VALUES ($1,'member-1042','{members}','active','external',now() - interval '1 day',now() - interval '9 days')
     ON CONFLICT (account_id, external_id) DO NOTHING`, [ACCOUNT]);

  // Apps: a web player bound to its site, and an iOS app.
  for (const [id, name, type, restrictions] of [
    [WEBAPP, 'Web player', 'web', { referrers: ['https://watch.example.com'] }],
    [IOSAPP, 'iOS app', 'ios', {}],
  ] as const) {
    const made = await query<any>(
      `INSERT INTO apps(id, account_id, name, type, restrictions, enabled) VALUES ($1,$2,$3,$4,$5::jsonb,true)
       ON CONFLICT (id) DO NOTHING RETURNING id`, [id, ACCOUNT, name, type, JSON.stringify(restrictions)]);
    if (made.length) {
      const k = generateKey('publishable');
      await query(`INSERT INTO api_keys(account_id, app_id, kind, key_prefix, key_hash, scopes, request_count, last_used_at)
                   VALUES ($1,$2,'publishable',$3,$4,'{playback}',$5,now() - interval '3 minutes')`,
        [ACCOUNT, id, k.prefix, k.hash, type === 'web' ? 18240 : 5310]);
    }
  }

  // Notifications: one alert, delivered to the inbox, refused by email.
  await query(`DELETE FROM notifications WHERE account_id=$1 AND payload->>'seed'='docs'`, [ACCOUNT]);
  const n = await query<any>(
    `INSERT INTO notifications(account_id, topic, subject, body, payload, created_at)
     VALUES ($1,'auto_connect.gave_up','Auto connect gave up on Sport One','Sport One could not reach its source after 5 attempts. Check the source, then start the channel again.','{"seed":"docs"}'::jsonb, now() - interval '50 minutes')
     RETURNING id`, [ACCOUNT]);
  await query(
    `INSERT INTO notification_deliveries(notification_id, account_id, recipient, channel, status, attempts, sent_at, last_error, gave_up_at, created_at)
     VALUES ($1,$2,'admin@example.com','in_app','sent',1,now() - interval '50 minutes',NULL,NULL,now() - interval '50 minutes'),
            ($1,$2,'admin@example.com','email','failed',1,NULL,'Email is not set up on this deployment.',now() - interval '50 minutes',now() - interval '50 minutes')`,
    [n[0].id, ACCOUNT]);
  // Read already, so the bell in every other guide's screenshots stays quiet.
  await query(`UPDATE notification_deliveries SET read_at=now() WHERE notification_id=$1 AND channel='in_app'`, [n[0].id]);
  await query(
    `INSERT INTO notification_templates(account_id, key, subject, body)
     SELECT $1,'event.reminder','Reminder: {{name}} starts at {{time}}','{{name}} goes live at {{time}}. Open it in Volt to check its sources.'
      WHERE NOT EXISTS (SELECT 1 FROM notification_templates WHERE account_id=$1 AND key='event.reminder')`, [ACCOUNT]);

  // Social: a sandbox account, so the page shows a linked account.
  await query(`DELETE FROM publish_targets WHERE account_id=$1 AND mode='sandbox'`, [ACCOUNT]);
  await addSandbox(ACCOUNT, ADMIN, 'youtube', 'Example Broadcaster');

  // On-demand ads (build queue 1.14k): the account default on, an ad server and
  // a house promo, so the guide shows a set-up page rather than the empty one.
  const PROMO = '6b1f0d2e-7a3c-4e5f-9a1b-2c3d4e5f6a01', ADSRV = '6b1f0d2e-7a3c-4e5f-9a1b-2c3d4e5f6a02';
  await query(
    `INSERT INTO vod_assets(id, account_id, source_kind, kind, title, master_key, start_epoch_ms, end_epoch_ms, duration_ms, metadata, created_at)
     VALUES ($1,$2,'upload','clip','Station promo',$3,0,20000,20000,'{"title":"Station promo"}'::jsonb, now() - interval '5 days')
     ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title`, [PROMO, ACCOUNT, `/clips/vod/${PROMO}/master.m3u8`]);
  await query(
    `INSERT INTO ad_servers(id, account_id, name, vendor, tag_template) VALUES ($1,$2,'Example ad server','vast','https://ads.example.com/vast?pod=[BREAK_POSITION]&dur=[BREAK_DURATION]&cb=[CACHEBUSTING]')
     ON CONFLICT (id) DO NOTHING`, [ADSRV, ACCOUNT]);
  await query(
    `INSERT INTO vod_ad_rules(account_id, schema_id, mode, policy, ad_server_id, house_ads) VALUES ($1, NULL, 'on', '{}'::jsonb, $2, $3::jsonb)
     ON CONFLICT (account_id) WHERE schema_id IS NULL DO UPDATE SET mode='on', ad_server_id=EXCLUDED.ad_server_id, house_ads=EXCLUDED.house_ads`,
    [ACCOUNT, ADSRV, JSON.stringify([{ assetId: PROMO }])]);

  // Payments: a month pass on Sport One, and a viewer who bought it elsewhere.
  const term = { kind: 'period', count: 1, unit: 'month', priceCents: 999, currency: 'AUD', productKey: 'sport-month', name: 'Sport One monthly pass' };
  await query(
    `INSERT INTO products(id, account_id, key, name, term, grants, source_rule, enabled)
     VALUES ($1,$2,'sport-month','Sport One monthly pass',$3::jsonb,$4::jsonb,'channel',true)
     ON CONFLICT (account_id, key) DO UPDATE SET name=EXCLUDED.name, term=EXCLUDED.term`,
    [PRODUCT, ACCOUNT, JSON.stringify(term), JSON.stringify({ channels: [SPORT] })]);

  // The server News 24 runs on, with readings, and a week of metered time.
  await query(
    `INSERT INTO compute_hosts(id, kind, external_id, instance_type, lifecycle, vcpus, memory_mib, state, first_seen_at, last_seen_at, last_metric_at)
     VALUES ($1,'local','studio-1','Studio server',NULL,8,16384,'up',now() - interval '8 days',now(),now())
     ON CONFLICT (id) DO UPDATE SET state='up', last_seen_at=now(), last_metric_at=now()`, [HOST]);
  await query(`DELETE FROM host_samples WHERE host_id=$1`, [HOST]);
  await query(`INSERT INTO host_samples(host_id, at, source, cpu_pct, mem_pct, net_in_bps, net_out_bps, tasks_on_host) VALUES ($1, now() - interval '1 minute', 'onbox', 38, 46, 9200000, 31500000, 1)`, [HOST]);
  await query(`UPDATE instances SET host_id=$1, lifecycle='on_demand', task_kind='transcode', launched_at=now() - interval '2 hours', metered_through=now() - interval '6 minutes' WHERE channel_id=$2 AND terminated_at IS NULL`, [HOST, NEWS]);
  await query(`DELETE FROM usage_accruals WHERE account_id=$1`, [ACCOUNT]);
  const radio = await query<any>(`SELECT c.id FROM channels c JOIN groups g ON g.id=c.group_id WHERE g.account_id=$1 AND c.kind='radio' AND c.name='Radio One' LIMIT 1`, [ACCOUNT]);
  const RADIO = radio[0]?.id ?? null;
  for (let d = 6; d >= 0; d--) {
    for (const [id, name, kind, hours] of [[NEWS, 'News 24', 'transcode', d ? 18 : 1.9], [SPORT, 'Sport One', 'transcode', d % 3 === 0 ? 4 : 0], [RADIO, 'Radio One', 'radio', d ? 24 : 2]] as const) {
      if (!hours || !id) continue;
      await query(
        `INSERT INTO usage_accruals(account_id, channel_id, host_id, stream_id, stream_name, task_kind, instance_type, from_at, to_at, seconds, indicative)
         VALUES ($1,$2,$3,$2,$4,$5,'Studio server', date_trunc('day', now()) - make_interval(days => $6), date_trunc('day', now()) - make_interval(days => $6) + make_interval(secs => $7), $7, true)`,
        [ACCOUNT, id, HOST, name, kind, d, Math.round(hours * 3600)]);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
