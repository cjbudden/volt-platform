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
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { query, one, pool } from '../src/db';
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
import { demandPool } from '../src/services/availabilityDemand';

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
  // Two rules of the operator's own above the default rules by type a new
  // folder starts with (build queue H2b), as the guide's screenshot shows:
  // slates straight into Loops & Fillers, and key art as each episode's Hero
  // backdrop (H2b-3).
  await query(
    `INSERT INTO watchfolder_rules(watchfolder_id, ordinal, name, match_type, pattern, target_kind, workflow, image_type) VALUES
       ($1,10,'Slates','glob','slate_*.png','filler-slate','register',NULL),
       ($1,20,'Key art','glob','*_key_art.jpg','image','register','hero')`, [WATCH]);
  const { defaultRulesFor, defaultOrdinals } = await import('../src/services/watchfolder/defaults');
  const defs = defaultRulesFor('local');
  const ords = defaultOrdinals([{ ordinal: 20 }], defs.length);
  for (const [i, d] of defs.entries()) {
    await query(
      `INSERT INTO watchfolder_rules(watchfolder_id, ordinal, name, match_type, pattern, target_kind, builtin)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`, [WATCH, ords[i], d.name, d.matchType, d.pattern, d.targetKind, d.builtin]);
  }
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
  await seedFrames();
  await seedG8Sections();
  await seedRights();
  await seedRightsDemand();
  await seedRuleCollection();
  await seedCollectionAccess();
  await seedMetadataRules();
  await seedLifecycle();
  await seedBilling();
  await seedTitleRetention();

  console.log(`\ndocs demo ready. Sign in as ${DOCS_LOGIN.email} (password as in seed-demo.ts)`);
  await pool.end();
}

// EXACT FRAMES (build queue 3.2-3). The Recordings and Media Library guides
// show frame stepping, which needs real media: a minute of test card with the
// frame number burnt in (so a screenshot shows the frame it names), as a
// capture run of the first live channel two hours ago with its recording, and
// as a packaged library asset. Made with ffmpeg only when missing.
const DOCS_FRAMES = {
  recording: '5d0c6a1e-2f4b-4c1a-9e1d-3a7b2c9d0e40',
  asset: '5d0c6a1e-2f4b-4c1a-9e1d-3a7b2c9d0e41',
} as const;

async function seedFrames() {
  const ffmpeg = process.env.FFMPEG_BIN || 'ffmpeg';
  if (spawnSync(ffmpeg, ['-version'], { stdio: 'ignore' }).status !== 0) {
    console.warn('[seed-docs] ffmpeg not found: no frame stepping media (the exact frame screenshots need it)');
    return;
  }
  const ff = (args: string[]) => {
    const r = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error('ffmpeg failed: ' + args.join(' '));
  };
  const src = join(config.clips.dir, 'vod-src', `${DOCS_FRAMES.asset}.mp4`);
  if (!existsSync(src)) {
    mkdirSync(dirname(src), { recursive: true });
    // The frame number in the picture where drawtext exists (it needs a font
    // library some ffmpeg builds leave out); the plain test card otherwise.
    const hasText = /drawtext/.test(spawnSync(ffmpeg, ['-hide_banner', '-filters'], { encoding: 'utf8' }).stdout || '');
    const vf = hasText ? ",drawtext=text='frame %{n}':fontsize=96:fontcolor=white:box=1:boxcolor=black@0.7:x=(w-tw)/2:y=h-160" : '';
    ff(['-f', 'lavfi', '-i', `testsrc2=size=1280x720:rate=25:duration=60${vf}`,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '50', '-keyint_min', '50', '-sc_threshold', '0', '-bf', '2', '-b:v', '2500k', src]);
  }
  // The capture run, laid out as the origin writes it (segment i finished at T0 + 2(i+1) s).
  const ch = await query<{ id: string }>(
    `SELECT c.id FROM channels c JOIN groups g ON g.id = c.group_id
      WHERE g.account_id = $1 AND COALESCE(c.origin, '') <> 'playlist' ORDER BY c.name LIMIT 1`, [ACCOUNT]);
  if (!ch[0]) throw new Error('docs seed: no channel for the frame stepping recording');
  const T0 = Math.floor((Date.now() - 2 * 3600_000) / 1000) * 1000;
  const runId = new Date(T0).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const runDir = join(config.testStream.originDir, ch[0].id, 'runs', runId, '720p');
  mkdirSync(runDir, { recursive: true });
  ff(['-i', src, '-c', 'copy', '-f', 'hls', '-hls_time', '2', '-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4',
    '-hls_segment_filename', join(runDir, 'seg_%d.m4s'), join(runDir, 'index.m3u8')]);
  for (const f of readdirSync(runDir).filter((x) => /^seg_\d+\.m4s$/.test(x))) {
    const t = (T0 + (Number(/\d+/.exec(f)![0]) + 1) * 2000) / 1000;
    utimesSync(join(runDir, f), t, t);
  }
  await query(
    `INSERT INTO recordings(id, kind, channel_id, title, status, start_epoch_ms, end_epoch_ms, duration_ms, day_utc)
     VALUES ($1,'channel_day',$2,'Morning news',$3,$4,$5,60000,$6)
     ON CONFLICT (id) DO UPDATE SET channel_id=EXCLUDED.channel_id, start_epoch_ms=EXCLUDED.start_epoch_ms,
       end_epoch_ms=EXCLUDED.end_epoch_ms, day_utc=EXCLUDED.day_utc`,
    [DOCS_FRAMES.recording, ch[0].id, 'complete', T0, T0 + 60000, new Date(T0).toISOString().slice(0, 10)]);
  // The library asset, packaged as vod.encode leaves it (master -> v720/index.m3u8).
  const dir = join(config.clips.dir, 'vod', DOCS_FRAMES.asset);
  if (!existsSync(join(dir, 'master.m3u8'))) {
    mkdirSync(join(dir, 'v720'), { recursive: true });
    ff(['-i', src, '-c', 'copy', '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod', '-hls_segment_type', 'fmp4',
      '-hls_fmp4_init_filename', 'init.mp4', '-hls_segment_filename', join(dir, 'v720', 'seg_%03d.m4s'), join(dir, 'v720', 'index.m3u8')]);
    writeFileSync(join(dir, 'master.m3u8'), ['#EXTM3U', '#EXT-X-STREAM-INF:BANDWIDTH=2600000,RESOLUTION=1280x720,CODECS="avc1.64001f"', 'v720/index.m3u8', ''].join('\n'));
  }
  await query(
    `INSERT INTO vod_assets(id, account_id, source_kind, kind, title, master_key, start_epoch_ms, end_epoch_ms, duration_ms, created_at)
     VALUES ($1,$2,'upload','clip','Studio test card',$3,0,60000,60000, now() - interval '1 day')
     ON CONFLICT (id) DO UPDATE SET master_key=EXCLUDED.master_key, title=EXCLUDED.title`,
    [DOCS_FRAMES.asset, ACCOUNT, `/clips/vod/${DOCS_FRAMES.asset}/master.m3u8`]);
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

  // Find details (build queue F1): a film to look up on Wikidata, and a song
  // and its music video for the song service, so the Media Library guide can
  // show each finder. Titles only: the finders fill the rest.
  {
    const { standardTypeId } = await import('../src/services/contentTypes');
    const FIND = [
      { id: '6b1f0d2e-7a3c-4e5f-9a1b-2c3d4e5f6b01', title: 'Nosferatu', type: 'movie', metadata: { title: 'Nosferatu' } },
      { id: '6b1f0d2e-7a3c-4e5f-9a1b-2c3d4e5f6b02', title: 'Neon Coast - Night Drive', type: 'song', metadata: { artist: 'Neon Coast', title: 'Night Drive' } },
      { id: '6b1f0d2e-7a3c-4e5f-9a1b-2c3d4e5f6b03', title: 'Night Drive (official video)', type: 'music-video', metadata: { artist: 'Neon Coast', title: 'Night Drive' } },
    ];
    for (const f of FIND) {
      await query(
        `INSERT INTO vod_assets(id, account_id, source_kind, kind, title, start_epoch_ms, end_epoch_ms, duration_ms, metadata, schema_id, created_at)
         VALUES ($1,$2,'upload','clip',$3,0,240000,240000,$4::jsonb,$5, now() - interval '2 days')
         ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title, metadata=EXCLUDED.metadata, schema_id=EXCLUDED.schema_id`,
        [f.id, ACCOUNT, f.title, JSON.stringify(f.metadata), await standardTypeId(ACCOUNT, f.type)]);
    }
  }

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

  // Review (build queue 1.14-G3a): one clip waiting, sent from the Media
  // Library as the guide says, so the Review guide shows a queue with a clip
  // in it. Only from draft, so a rerun does not stack decisions.
  const { decide } = await import('../src/services/review');
  const goal = await query<any>(
    `SELECT v.id, v.review_state FROM vod_assets v JOIN channels c ON c.id = v.channel_id JOIN groups g ON g.id = c.group_id
      WHERE g.account_id = $1 AND v.title = 'Goal of the Month' LIMIT 1`, [ACCOUNT]);
  if (goal[0] && (goal[0].review_state ?? 'draft') === 'draft') {
    await decide({ assetId: goal[0].id, to: 'in_review', actorId: ADMIN, actorLabel: DOCS_LOGIN.email });
  }
}

// The four sections guided by build queue 1.14-G8. After seedFast: the
// collections hold the FAST titles, which seedFast makes on a fresh database.
async function seedG8Sections() {
  const PROMO = '6b1f0d2e-7a3c-4e5f-9a1b-2c3d4e5f6a01';
  // Collections (build queue 1.14-G8): the four food and travel titles in a
  // collection with a sub-collection for one week, and the promo on its own,
  // so the Collections guide shows a tree, a breadcrumb and an ordered list.
  // Fixed ids and ON CONFLICT so a rerun keeps one of each.
  const FOOD = '7c2e1a40-5b6d-4e8f-9a0b-1c2d3e4f5a01', WEEK = '7c2e1a40-5b6d-4e8f-9a0b-1c2d3e4f5a02', PROMOS = '7c2e1a40-5b6d-4e8f-9a0b-1c2d3e4f5a03';
  for (const [id, parent, name, description, color] of [
    [FOOD, null, 'Food & Travel', 'Everything the Food & Travel channel can air', '#ffb703'],
    [WEEK, FOOD, 'Week 44: Markets', 'This week\'s theme, in running order', '#2ec4b6'],
    [PROMOS, null, 'Promos', 'Station promos for breaks and fillers', null],
  ] as const) {
    await query(
      `INSERT INTO collections(id, account_id, parent_id, name, description, color, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (id) DO UPDATE SET parent_id=EXCLUDED.parent_id, name=EXCLUDED.name, description=EXCLUDED.description, color=EXCLUDED.color`,
      [id, ACCOUNT, parent, name, description, color, ADMIN]);
  }
  const inCol: [string, string[]][] = [
    [FOOD, ['5d0c6a1e-2f4b-4c1a-9e1d-3a7b2c9d0e34', '5d0c6a1e-2f4b-4c1a-9e1d-3a7b2c9d0e35']],
    [WEEK, ['5d0c6a1e-2f4b-4c1a-9e1d-3a7b2c9d0e32', '5d0c6a1e-2f4b-4c1a-9e1d-3a7b2c9d0e33']],
    [PROMOS, [PROMO]],
  ];
  for (const [col, ids] of inCol) {
    for (const [i, asset] of ids.entries()) {
      await query(
        `INSERT INTO collection_items(collection_id, vod_asset_id, position, added_by)
         SELECT $1, $2, $3, $4 WHERE EXISTS (SELECT 1 FROM vod_assets WHERE id=$2)
         ON CONFLICT (collection_id, vod_asset_id) DO UPDATE SET position=EXCLUDED.position`, [col, asset, i, ADMIN]);
    }
  }

  // Encoding Queue (build queue 1.14-G8): two finished encodes, one done and
  // one failed, so the guide shows Finished recently with a result and an
  // error to retry. Finished, never queued: a waiting job would be picked up
  // by the API's own worker and fail on a source that is not there.
  const ENC_OK = '7c2e1a40-5b6d-4e8f-9a0b-1c2d3e4f5a11', ENC_FAIL = '7c2e1a40-5b6d-4e8f-9a0b-1c2d3e4f5a12';
  for (const [id, asset, file, state, ago, took, summary, error] of [
    [ENC_OK, '5d0c6a1e-2f4b-4c1a-9e1d-3a7b2c9d0e32', 'harbour-market.mov', 'succeeded', 95, 312, '1080p, 720p, 480p and audio; HLS and DASH', null],
    [ENC_FAIL, '5d0c6a1e-2f4b-4c1a-9e1d-3a7b2c9d0e33', 'smoke-and-salt.mov', 'failed', 40, 6, null, 'The source file has no video or audio stream that can be read. Upload the file again, or check it plays on your computer.'],
  ] as const) {
    await query(
      `INSERT INTO jobs(id, type, state, payload, result, progress_pct, progress_note, attempts, max_attempts, last_error,
                        started_at, finished_at, created_at, run_after, created_by)
       VALUES ($1,'vod.encode',$2::job_state,$3::jsonb,$4::jsonb,$5,NULL,$6,3,$7,
               now() - make_interval(mins => $8) - make_interval(secs => $9), now() - make_interval(mins => $8),
               now() - make_interval(mins => $8) - make_interval(secs => $9 + 20), now() - make_interval(mins => $8) - make_interval(secs => $9 + 20), $10)
       ON CONFLICT (id) DO UPDATE SET state=EXCLUDED.state, started_at=EXCLUDED.started_at, finished_at=EXCLUDED.finished_at, created_at=EXCLUDED.created_at`,
      [id, state, JSON.stringify({ vodAssetId: asset, sourcePath: `uploads/${file}` }), summary ? JSON.stringify({ summary }) : null,
       state === 'succeeded' ? 100 : 0, state === 'failed' ? 3 : 1, error, ago, took, ADMIN]);
    // Its attempts, so the job page lists them (three for the failed one, as
    // the queue retries an error twice before it gives up).
    await query(`DELETE FROM job_attempts WHERE job_id=$1`, [id]);
    const tries = state === 'failed' ? 3 : 1;
    for (let n = 1; n <= tries; n++) {
      await query(
        `INSERT INTO job_attempts(job_id, attempt, started_at, finished_at, outcome, error)
         VALUES ($1,$2, now() - make_interval(mins => $3) - make_interval(secs => $4), now() - make_interval(mins => $3) - make_interval(secs => $4) + make_interval(secs => 2), $5, $6)`,
        [id, n, ago + (tries - n) * 2, took, state === 'failed' ? 'failed' : 'succeeded', error]);
    }
  }

  // Workflow report (build queue W1): a week of finished work across the
  // stages, so the Report tab shows runs, error rates, times and codes. Made
  // from fixed patterns, not random numbers, so the screenshot is the same
  // every time. Finished only, never queued: the API's worker would pick a
  // waiting job up. The file Encode stage is shown through vod.ladder jobs,
  // so the Encoding Queue guide keeps its two encodes. Re-running the seed
  // replaces it. The API's rollup turns
  // it into the report a minute or so after it starts.
  await query(`DELETE FROM jobs WHERE payload->>'seed' = 'docs-report'`);
  await query(`DELETE FROM workflow_events WHERE account_id = $1 AND data->>'seed' = 'docs-report'`, [ACCOUNT]);
  await query(`DELETE FROM addon_runs WHERE account_id = $1 AND created_by = 'seed:docs-report'`, [ACCOUNT]);
  const REPORT_ASSET = '5d0c6a1e-2f4b-4c1a-9e1d-3a7b2c9d0e32';
  for (const [type, perDay, failEvery, secs] of [
    ['vod.ladder', 6, 19, 260], ['qc.run', 14, 13, 7], ['clip.extract', 10, 29, 24], ['vod.image', 12, 61, 2], ['social.publish', 3, 9, 4], ['ingest.remote', 2, 11, 45],
  ] as const) {
    await query(
      `INSERT INTO jobs (type, state, payload, attempts, max_attempts, error_code, last_error, created_at, started_at, finished_at, run_after)
       SELECT $1, (CASE WHEN i % $3 = $3 - 1 THEN 'failed' WHEN i % 41 = 40 THEN 'cancelled' ELSE 'succeeded' END)::job_state,
              jsonb_build_object('vodAssetId', $5::text, 'seed', 'docs-report'),
              CASE WHEN i % 9 = 0 THEN 2 ELSE 1 END, 3,
              CASE WHEN i % $3 = $3 - 1 THEN (ARRAY['source_missing','timeout','tool_exit','http_503'])[1 + (i / $3) % 4] END,
              CASE WHEN i % $3 = $3 - 1 THEN 'Seeded failure for the workflow report' END,
              t - make_interval(secs => 4 + i % 11), t, t + make_interval(secs => $4 * (0.7 + (i % 7) * 0.1)), t
         FROM generate_series(0, $2 * 7 - 1) i,
              LATERAL (SELECT now() - interval '10 minutes' - make_interval(secs => i * (86400.0 / $2))) x(t)`,
      [type, perDay, failEvery, secs, REPORT_ASSET]);
  }
  const reportChannel = (await query<any>(`SELECT c.id FROM channels c JOIN groups g ON g.id = c.group_id WHERE g.account_id = $1 ORDER BY c.name LIMIT 1`, [ACCOUNT]))[0]?.id;
  if (reportChannel) {
    await query(
      `INSERT INTO workflow_events (account_id, hook, subject_type, subject_id, channel_id, title, data, created_at)
       SELECT $1, h.hook, h.subject, $2, $2, 'Docs seed',
              CASE h.hook WHEN 'stream.stopped' THEN jsonb_build_object('intent', CASE WHEN i % 17 = 16 THEN 'fault' ELSE 'schedule' END, 'seed', 'docs-report')
                          WHEN 'recording.completed' THEN jsonb_build_object('durationMs', (1800 + (i % 5) * 900) * 1000, 'seed', 'docs-report')
                          ELSE jsonb_build_object('to', 'approved', 'seed', 'docs-report') END,
              now() - interval '12 minutes' - make_interval(secs => i * (86400.0 / h.per_day))
         FROM (VALUES ('stream.stopped', 'channel', 4), ('recording.completed', 'recording', 4), ('review.decided', 'vod_asset', 5)) h(hook, subject, per_day),
              generate_series(0, h.per_day * 7 - 1) i`, [ACCOUNT, reportChannel]);
    await query(
      `INSERT INTO addon_runs (account_id, addon_id, hook, subject_type, subject_id, subject_title, state, error, created_by, callback_hash, created_at, dispatched_at, finished_at, deadline_at)
       SELECT $1, $2, 'recording.completed', 'recording', $3, 'Docs seed', CASE WHEN i % 12 = 11 THEN 'timed_out' ELSE 'succeeded' END,
              NULL, 'seed:docs-report', 'docs-seed', t, t + interval '1 second', t + make_interval(secs => 40 + (i % 6) * 15), t + interval '10 minutes'
         FROM generate_series(0, 27) i, LATERAL (SELECT now() - interval '14 minutes' - make_interval(secs => i * 21600)) x(t)`, [ACCOUNT, '5d0c6a1e-2f4b-4c1a-9e1d-3a7b2c9d0e20' /* the Summary agent above */, reportChannel]);
  }

  // Single sign-on (build queue 1.14-G8): an OpenID Connect provider with the
  // account's domain added but not yet verified, as it is just after Add a
  // provider, so the guide shows the DNS record to add. Not verified, so the
  // docs sign-in is never offered "Continue with" and keeps its password.
  const SSO = '7c2e1a40-5b6d-4e8f-9a0b-1c2d3e4f5a21';
  await query(
    `INSERT INTO sso_connections(id, account_id, protocol, name, enabled, oidc_issuer, oidc_client_id, jit, default_tier, group_map)
     VALUES ($1,$2,'oidc','Example Entra ID',true,'https://login.microsoftonline.com/example-tenant/v2.0','00000000-aaaa-bbbb-cccc-000000000001',true,'operator','[]'::jsonb)
     ON CONFLICT (id) DO NOTHING`, [SSO, ACCOUNT]);
  await query(
    `INSERT INTO sso_domains(domain, connection_id, account_id, verify_token) VALUES ('example.com',$1,$2,'docs-example-token')
     ON CONFLICT (domain) DO NOTHING`, [SSO, ACCOUNT]);

  // Hybrid Sites (build queue H1): the docs account holds the licence and has
  // one site with an approved GPU host reporting now and a second host
  // waiting for approval, so the guide shows both standings.
  await query(`UPDATE accounts SET licences = ARRAY(SELECT DISTINCT unnest(licences || '{hybrid_sites}'::text[])) WHERE id = $1`, [ACCOUNT]);
  const SITE = '8a1f2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c51';
  await query(
    `INSERT INTO sites(id, account_id, name, description, created_by, updated_by) VALUES ($1,$2,'Main broadcast centre','Machine room, rack 4',$3,$3)
     ON CONFLICT (id) DO NOTHING`, [SITE, ACCOUNT, ADMIN]);
  const hostRows: [string, string, string, number, number, string, any[], number, number, string | null][] = [
    ['8a1f2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c52', 'encoder-01', 'approved', 32, 128, 'x64', [{ name: 'NVIDIA L4', vendor: 'nvidia', memoryBytes: 24 * 2 ** 30, encodeSessions: 8 }], 1.6e12, 4e12, '12 seconds'],
    ['8a1f2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c53', 'encoder-02', 'pending', 16, 64, 'x64', [], 0.9e12, 2e12, '25 seconds'],
  ];
  for (const [id, hostname, status, cores, memGb, arch, gpus, free, total, ago] of hostRows) {
    await query(
      `INSERT INTO site_hosts(id, site_id, account_id, hostname, status, cpu_cores, memory_bytes, gpus, disk_free_bytes, disk_total_bytes, os, arch,
                              agent_version, encoder_version, last_heartbeat_at, decided_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,'Linux 6.8',$11,'0.2.0','1.4.0', now() - $12::interval, CASE WHEN $5 = 'approved' THEN now() - interval '2 days' END)
       ON CONFLICT (id) DO UPDATE SET last_heartbeat_at = EXCLUDED.last_heartbeat_at`,
      [id, SITE, ACCOUNT, hostname, status, cores, memGb * 2 ** 30, JSON.stringify(gpus), free, total, arch, ago]);
  }

  // Encode at site (build queue H4-8): a title from an Encode at site
  // watchfolder that a server of the site is encoding now, so the Hybrid
  // Sites guide can show "At site" beside Building on the asset page. Its
  // encode job is held running with a lease well past a docs run, so the
  // API's reaper leaves it alone while the screenshots are taken.
  const AT_SITE = '8a1f2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c71', AT_SITE_JOB = '8a1f2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c72';
  await query(
    `INSERT INTO jobs(id, type, state, progress_pct, pool, payload, claimed_by, claimed_at, started_at, lease_until, attempts)
     VALUES ($1,'site.vod-encode','running',42,$2,'{}'::jsonb,'encoder-01',now(),now(),now() + interval '7 days',1)
     ON CONFLICT (id) DO UPDATE SET state = 'running', lease_until = EXCLUDED.lease_until`, [AT_SITE_JOB, `site:${SITE}`]);
  await query(
    `INSERT INTO vod_assets(id, account_id, source_kind, kind, title, original_filename, start_epoch_ms, end_epoch_ms, duration_ms,
                            media_state, encode_job_id, ingest)
     VALUES ($1,$2,'watchfolder','clip','Harbour Lights','Harbour Lights.mp4',0,1500000,1500000,'processing',$3,$4::jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [AT_SITE, ACCOUNT, AT_SITE_JOB, JSON.stringify({ status: 'ingested', siteSource: { siteId: SITE, folderId: '', itemId: 0, sitePath: '/mnt/nas/drop/Harbour Lights.mp4', objectKey: 'Harbour Lights.mp4' } })]);

  // Mirror and Archive (build queue H3-6): the add-on, a NAS folder and an
  // S3-compatible store at the site, copies of the library's originals in
  // the states the guide explains (verified, queued for missing keys, failed
  // on a checksum mismatch, missing from the target), and a copy rule on the account default, so the
  // Storage page and the publishing rule editor show the real thing.
  await query(`UPDATE accounts SET licences = ARRAY(SELECT DISTINCT unnest(licences || '{mirror_archive}'::text[])) WHERE id = $1`, [ACCOUNT]);
  const NAS = '8a1f2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c61', OBJ = '8a1f2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c62';
  await query(
    `INSERT INTO archive_targets(id, account_id, site_id, name, kind, path, bandwidth_mbps, recheck_days, created_by)
     VALUES ($1,$2,$3,'Machine room NAS','path','/mnt/nas/volt-archive',200,30,$4)
     ON CONFLICT (id) DO NOTHING`, [NAS, ACCOUNT, SITE, ADMIN]);
  await query(
    `INSERT INTO archive_targets(id, account_id, site_id, name, kind, path, s3, bandwidth_mbps, recheck_days, created_by)
     VALUES ($1,$2,$3,'On-site object store','s3','s3://volt-archive/originals',
             '{"endpoint":"https://objects.example.com:9000","bucket":"volt-archive","prefix":"originals","region":"us-east-1","pathStyle":true,"credentialRef":"objects1"}'::jsonb,
             NULL,90,$4)
     ON CONFLICT (id) DO NOTHING`, [OBJ, ACCOUNT, SITE, ADMIN]);
  const originals = await query<{ id: string; title: string; source_key: string | null }>(
    `SELECT v.id, v.title, v.source_key FROM vod_assets v
       LEFT JOIN channels c ON c.id = v.channel_id LEFT JOIN events e ON e.id = v.event_id
       LEFT JOIN groups g ON g.id = COALESCE(c.group_id, e.group_id)
      WHERE COALESCE(g.account_id, v.account_id) = $1 ORDER BY v.title LIMIT 5`, [ACCOUNT]);
  const copyPlan: [string, string, string | null, string | null, string, string][] = [
    // target, state, error code, error, verified ago, checked ago
    [NAS, 'verified', null, null, '6 days', '2 hours'],
    [NAS, 'failed', 'checksum_mismatch', 'The copy read back from the target does not match what was downloaded', '0 seconds', '0 seconds'],
    [NAS, 'missing', 'missing', 'The copy is no longer at the target', '20 days', '1 hour'],
    [OBJ, 'verified', null, null, '3 days', '3 days'],
    [OBJ, 'queued', 'keys_missing', 'No keys named objects1 on this server', '0 seconds', '0 seconds'],
  ];
  for (let i = 0; i < Math.min(originals.length, copyPlan.length); i++) {
    const a = originals[i], [target, state, code, error, vAgo, cAgo] = copyPlan[i];
    const file = `${String(a.title).replace(/[^A-Za-z0-9]+/g, '')}.mp4`;
    const done = state === 'verified' || state === 'missing';
    await query(
      `INSERT INTO archive_copies(account_id, target_id, vod_asset_id, what, source_uri, file_name, stored_path, bytes, expected_sha256, sha256,
                                  state, error, error_code, copied_at, verified_at, checked_at, created_by, created_at)
       VALUES ($1,$2,$3,'source',$4,$5,$6,$7,$8,$8,$9,$10,$11,
               CASE WHEN $12 THEN now() - $13::interval END, CASE WHEN $12 THEN now() - $13::interval END,
               CASE WHEN $12 THEN now() - $14::interval END, $15, now() - $13::interval)
       ON CONFLICT (target_id, vod_asset_id, what) DO NOTHING`,
      [ACCOUNT, target, a.id, a.source_key ?? `s3://volt-media/originals/${a.id}.mp4`, file, done ? file : null,
       180_000_000 + i * 37_000_000, done ? 'a3f1'.repeat(16) : null, state, error, code, done, vAgo, cAgo, ADMIN]);
  }
  // Copy-before-delete (H3-5): the account's retention rule takes originals
  // out of the cloud 60 days after they land, once archived. The first
  // original (verified on the NAS) has gone; the second waits, its copy
  // having failed, so the guide shows both rows of Originals out of the cloud.
  const RET = '8a1f2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c71';
  await query(
    `INSERT INTO retention_rules(id, account_id, name, applies_to, enabled, original_after_days, include_uploads)
     VALUES ($1,$2,'Default retention','recording',true,60,true) ON CONFLICT (id) DO NOTHING`, [RET, ACCOUNT]);
  await query(`INSERT INTO retention_stages(rule_id, after_days, action) SELECT $1, 365, 'delete'::retention_action
                WHERE NOT EXISTS (SELECT 1 FROM retention_stages WHERE rule_id = $1)`, [RET]);
  if (originals[0]) {
    await query(
      `UPDATE vod_assets v SET original_removed_key = COALESCE(v.source_key, c.source_uri), source_key = NULL,
              original_removed_at = now() - interval '2 days', original_copy_id = c.id, original_checked_at = now() - interval '2 days'
         FROM archive_copies c WHERE v.id = $1 AND c.vod_asset_id = v.id AND c.target_id = $2 AND c.what = 'source' AND v.original_removed_at IS NULL`,
      [originals[0].id, NAS]);
  }
  if (originals[1]) {
    await query(
      // Landed 70 days ago, so its 60-day rung is due and the wait is real.
      `UPDATE vod_assets SET original_wait_code = 'copy_failed', original_checked_at = now() - interval '3 hours', created_at = now() - interval '70 days',
              original_wait = 'The archive copy to Machine room NAS failed: The copy read back from the target does not match what was downloaded. The original stays in the cloud until a copy is verified.'
        WHERE id = $1 AND original_removed_at IS NULL`, [originals[1].id]);
  }
  // A recording archived by the rule (H3-7): yesterday's evening news on the
  // NAS, the file and its metadata sidecar, both verified.
  const tv = await one<{ id: string; name: string }>(
    `SELECT c.id, c.name FROM channels c JOIN groups g ON g.id = c.group_id
      WHERE g.account_id = $1 AND c.kind IS DISTINCT FROM 'radio' AND c.origin = 'live' AND c.recording_enabled ORDER BY c.name LIMIT 1`, [ACCOUNT]);
  if (tv) {
    const day = new Date(Date.now() - 24 * 3600_000); day.setUTCHours(7, 0, 0, 0);   // 18:00 to 18:30 in Sydney (summer time, UTC+11)
    const end = new Date(day.getTime() + 30 * 60_000);
    const base = `EveningNews-${tv.name.replace(/[^A-Za-z0-9]+/g, '')}-${day.toISOString().slice(0, 10).replace(/-/g, '')}-1800`;
    for (const [what, file, bytes] of [['recording', `${base}.mp4`, 1_620_000_000], ['recording-sidecar', `${base}.json`, 1_400]] as const) {
      await query(
        `INSERT INTO archive_copies(account_id, target_id, stream_id, range_start, range_end, title, what, source_uri, file_name, stored_path, bytes,
                                    expected_sha256, sha256, state, copied_at, verified_at, checked_at, created_by, created_at)
         VALUES ($1,$2,$3,$4,$5,'Evening News',$6,$7,$8,$8,$9,$10,$10,'verified',now() - interval '20 hours',now() - interval '20 hours',now() - interval '20 hours',$11,now() - interval '20 hours')
         ON CONFLICT DO NOTHING`,
        [ACCOUNT, NAS, tv.id, day, end, what, `/srv/volt/archive-build/${file}`, file, bytes, 'b7e2'.repeat(16), ADMIN]);
    }
  }
  const rule = { copies: [{ targetId: NAS, on: ['ingest', 'recording'] }, { targetId: OBJ, on: ['publish'] }], offPeak: { from: '22:00', to: '06:00', timeZone: 'Australia/Sydney' } };
  const upd = await query(`UPDATE publishing_rules SET settings = settings || jsonb_build_object('archive', $2::jsonb) WHERE account_id = $1 AND scope_kind = 'account' RETURNING id`, [ACCOUNT, JSON.stringify(rule)]);
  if (!upd.length) await query(`INSERT INTO publishing_rules(account_id, scope_kind, scope_id, settings) VALUES ($1,'account',NULL,jsonb_build_object('archive', $2::jsonb))`, [ACCOUNT, JSON.stringify(rule)]);
  // The account default locks DRM (build queue P3-2), so the Publishing Rules
  // guide shows a padlock in use.
  await query(`UPDATE publishing_rules SET locked_fields = ARRAY['protection.drm'] WHERE account_id = $1 AND scope_kind = 'account'`, [ACCOUNT]);
}

/**
 * RIGHTS (build queue R1): three provider profiles beside the two built-ins,
 * one with its agreement and one without, one ending soon, and the account's
 * library spread across them, so the Rights guide shows a working list, a
 * profile with apps and territories, and an asset narrowed inside its profile.
 * Neutral provider names: a screenshot carries whatever the page shows.
 */
async function seedRights() {
  const P = { sport: '5b0c1d2e-3f40-4a51-8b62-7c83d94ea501', films: '5b0c1d2e-3f40-4a51-8b62-7c83d94ea502', archive: '5b0c1d2e-3f40-4a51-8b62-7c83d94ea503' };
  await query(`SELECT volt_rights_builtin($1, 'open'), volt_rights_builtin($1, 'closed')`, [ACCOUNT]);
  const until = new Date(Date.now() + 45 * 86400_000).toISOString();
  const rows: [string, string, string, string, string[], string, string[], string[], string[], string, any][] = [
    [P.sport, 'Example Sports League · Pacific', 'Example Sports League', 'allow', ['AU', 'NZ', 'FJ'], 'allow', ['web', 'mobile', 'smart_tv'],
      ['on_demand', 'fast', 'clips', 'ads'], ['subscription', 'ppv'], 'relative', { count: 12, unit: 'month', from: 'first_air' }],
    [P.films, 'Example Films catalogue', 'Example Films', 'block', ['US', 'CA'], 'block', ['partner'],
      ['on_demand', 'fast'], ['free', 'members'], 'fixed', { from: '2026-01-01T00:00:00Z', until: '2027-12-31T23:59:59Z' }],
    [P.archive, 'News archive', 'In-house archive', 'allow', ['AU'], 'allow', ['web'], ['on_demand', 'clips'], ['members'], 'fixed', { until }],
  ];
  for (const [id, name, provider, tm, terr, am, apps, uses, accessTypes, wk, w] of rows) {
    await query(
      `INSERT INTO rights_profiles(id, account_id, name, provider, takedown_contact, territory_mode, territories, app_mode, app_types, uses, access_types,
                                   window_kind, window_from, window_until, relative_count, relative_unit, relative_from)
       VALUES ($1,$2,$3,$4,'rights@example.com',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) ON CONFLICT (id) DO NOTHING`,
      [id, ACCOUNT, name, provider, tm, terr, am, apps, uses, accessTypes, wk, wk === 'fixed' ? w.from ?? null : null, w.until ?? null, w.count ?? null, w.unit ?? null, wk === 'relative' ? w.from : null]);
  }
  // The agreement of the first two, stored as the API stores it (private keys).
  for (const id of [P.sport, P.films]) {
    const key = `rights-agreements/${ACCOUNT}/${id}/docs-agreement.pdf`;
    await imageStore().put(key, Buffer.from('%PDF-1.4\n% Example agreement for the docs seed\n'), 'application/pdf');
    await query(`UPDATE rights_profiles SET agreement = $2::jsonb WHERE id = $1 AND agreement IS NULL`,
      [id, JSON.stringify({ name: id === P.sport ? 'League-agreement-2026.pdf' : 'Films-licence-v3.pdf', size: 248_310, type: 'application/pdf', key, uploadedBy: DOCS_LOGIN.email, uploadedAt: '2026-03-12T01:00:00Z' })]);
  }
  // The library, spread: the newest assets on the league, the next on films, two on the archive.
  const assets = await query<{ id: string }>(
    `SELECT v.id FROM vod_assets v LEFT JOIN channels c ON c.id = v.channel_id LEFT JOIN groups g ON g.id = c.group_id
      WHERE COALESCE(v.account_id, g.account_id) = $1 ORDER BY v.created_at DESC, v.id`, [ACCOUNT]);
  const plan = [P.sport, P.sport, P.sport, P.films, P.films, P.archive, P.archive];
  for (let i = 0; i < Math.min(plan.length, assets.length); i++) {
    await query(`UPDATE vod_assets SET rights_profile_id = $2, rights_set_by = $3, rights_set_at = now() - interval '2 days' WHERE id = $1`,
      [assets[i].id, plan[i], i < 2 ? 'watchfolder' : i < 5 ? 'chosen at upload' : `set by ${DOCS_LOGIN.email}`]);
  }
  if (assets[0]) await query(`UPDATE vod_assets SET rights_narrow = '{"territories":["AU","NZ"]}'::jsonb WHERE id = $1`, [assets[0].id]);
  // Where a title cannot play (build queue P2-2): the account's own words,
  // Notify me offered, and a few viewers waiting, so the Rights guide shows them.
  await query(`UPDATE accounts SET block_message = 'Not licensed in your country yet. We are working on it.', block_notify = true WHERE id = $1`, [ACCOUNT]);
  const waiting = [[0, 'NZ', 5], [1, 'US', 2], [2, 'GB', 1]];
  for (const [i, cc, n] of waiting as [number, string, number][]) {
    if (!assets[i]) continue;
    for (let k = 1; k <= n; k++) {
      await query(`INSERT INTO availability_notify (account_id, asset_id, who, email, country, reason, created_at)
                   VALUES ($1, $2, 'email:' || $3, $3, $4, 'region', now() - ($5 || ' hours')::interval) ON CONFLICT (asset_id, who) DO NOTHING`,
        [ACCOUNT, assets[i].id, `viewer${k}@example.com`, cc, String(k * 3)]);
    }
  }
}

/**
 * RIGHTS DEMAND (build queue P2-4): thirty days of refusals and plays in the
 * analytics database's daily rollups, written as the play gate's counter
 * writes them, so the Rights demand report has a map, a trend and titles to
 * show. The league title is licensed only in Australia and New Zealand and is
 * wanted most in Britain, the United States and India; the films title is
 * blocked in North America; the archive title plays only in Australia and is
 * asked for after one programme's window closed; the news channel blacks out
 * one programme in New Zealand. Hashed viewer keys are made up for the seed.
 */
async function seedRightsDemand() {
  const p = await demandPool();
  await p.query(`DELETE FROM availability_events WHERE account_id = $1`, [ACCOUNT]);
  await p.query(`DELETE FROM availability_viewers WHERE account_id = $1`, [ACCOUNT]);
  const assets = await query<{ id: string }>(
    `SELECT v.id FROM vod_assets v LEFT JOIN channels c ON c.id = v.channel_id LEFT JOIN groups g ON g.id = c.group_id
      WHERE COALESCE(v.account_id, g.account_id) = $1 ORDER BY v.created_at DESC, v.id`, [ACCOUNT]);
  if (assets.length < 6) return;
  // [asset, kind, country, reason, viewers a day at the peak]
  const plan: [string, string, string, string, number][] = [
    [assets[0].id, 'vod', 'AU', 'allowed', 160], [assets[0].id, 'vod', 'NZ', 'allowed', 48],
    [assets[0].id, 'vod', 'GB', 'geo', 42], [assets[0].id, 'vod', 'US', 'geo', 31], [assets[0].id, 'vod', 'IN', 'geo', 24],
    [assets[0].id, 'vod', 'JP', 'geo', 9], [assets[0].id, 'vod', 'DE', 'geo', 6], [assets[0].id, 'vod', 'ZA', 'geo', 5],
    [assets[0].id, 'vod', 'SG', 'geo', 4], [assets[0].id, 'vod', 'BR', 'geo', 2],
    [assets[3].id, 'vod', 'AU', 'allowed', 70], [assets[3].id, 'vod', 'GB', 'allowed', 22], [assets[3].id, 'vod', 'FR', 'allowed', 8],
    [assets[3].id, 'vod', 'US', 'rights', 27], [assets[3].id, 'vod', 'CA', 'rights', 11], [assets[3].id, 'vod', 'MX', 'geo', 3],
    [assets[5].id, 'vod', 'AU', 'allowed', 40], [assets[5].id, 'vod', 'NZ', 'geo', 8], [assets[5].id, 'vod', 'GB', 'geo', 3],
    [assets[5].id, 'vod', 'AU', 'expired', 4],
    [NEWS, 'channel', 'AU', 'allowed', 120], [NEWS, 'channel', 'NZ', 'geo', 14], [NEWS, 'channel', 'ID', 'geo', 4],
    [assets[1].id, 'vod', 'AU', 'payment', 6], [assets[2].id, 'vod', 'AU', 'sign_in', 3],
  ];
  const events: any[] = [], viewers: any[] = [];
  for (let d = 29; d >= 0; d--) {
    const day = new Date(Date.now() - d * 86400_000).toISOString().slice(0, 10);
    // Weekends higher, a rise over the month, and today only part done.
    const dow = new Date(day + 'T00:00:00Z').getUTCDay();
    const w = (0.55 + 0.45 * (29 - d) / 29) * (dow === 0 || dow === 6 ? 1.35 : 1) * (1 + 0.15 * Math.sin(d * 1.7)) * (d === 0 ? 0.4 : 1);
    plan.forEach(([asset, kind, cc, reason, peak], i) => {
      const n = Math.max(0, Math.round(peak * w * (0.85 + 0.3 * Math.abs(Math.sin(i * 7 + d)))));
      if (!n) return;
      // Someone refused tries again: requests run ahead of viewers.
      const requests = reason === 'allowed' ? n : Math.round(n * (1.6 + 0.4 * Math.abs(Math.sin(i + d))));
      events.push({ account_id: ACCOUNT, day, asset_id: asset, asset_kind: kind, country: cc, reason, source: 'gate', requests });
      if (reason === 'geo' || reason === 'rights') {
        // A pool of regulars per country, so the period's unique count is less than the days' sum.
        for (let k = 0; k < n; k++) viewers.push({ account_id: ACCOUNT, day, asset_id: asset, country: cc, reason, vh: `docs-${cc}-${i}-${(k * 7 + d * 3) % Math.max(n, Math.round(peak * 2.2))}` });
      }
    });
  }
  await p.query(
    `INSERT INTO availability_events (account_id, day, asset_id, asset_kind, country, reason, source, requests)
     SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(account_id uuid, day date, asset_id text, asset_kind text, country text, reason text, source text, requests float8)
     ON CONFLICT DO NOTHING`, [JSON.stringify(events)]);
  for (let i = 0; i < viewers.length; i += 5000) {
    await p.query(
      `INSERT INTO availability_viewers (account_id, day, asset_id, country, reason, vh)
       SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(account_id uuid, day date, asset_id text, country text, reason text, vh text)
       ON CONFLICT DO NOTHING`, [JSON.stringify(viewers.slice(i, i + 5000))]);
  }
}

/**
 * ACCESS ON A COLLECTION (build queue C2-2): Premium picks asks for a package
 * in Australia and New Zealand (its own price in the iOS app) and for signing
 * in everywhere else; Food & Travel asks for signing in everywhere, which its
 * sub-collection inherits. The Collections guide shows the access editor, the
 * inherited access, View as and the matrix of apps by regions, with one title
 * the rights keep out where the package is asked.
 */
async function seedCollectionAccess() {
  const FOOD = '7c2e1a40-5b6d-4e8f-9a0b-1c2d3e4f5a01', WEEK = '7c2e1a40-5b6d-4e8f-9a0b-1c2d3e4f5a02';
  const PICKS = '7c2e1a40-5b6d-4e8f-9a0b-1c2d3e4f5a05';
  await query(
    `INSERT INTO collections(id, account_id, name, description, color, created_by) VALUES ($1,$2,'Premium picks','Titles sold as a pass in Australia and New Zealand','#d4a64a',$3)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description`, [PICKS, ACCOUNT, ADMIN]);
  for (const [i, asset] of ['5d0c6a1e-2f4b-4c1a-9e1d-3a7b2c9d0e41', '6b1f0d2e-7a3c-4e5f-9a1b-2c3d4e5f6a01', '5d0c6a1e-2f4b-4c1a-9e1d-3a7b2c9d0e35'].entries()) {
    await query(
      `INSERT INTO collection_items(collection_id, vod_asset_id, position, added_by)
       SELECT $1, $2, $3, $4 WHERE EXISTS (SELECT 1 FROM vod_assets WHERE id=$2)
       ON CONFLICT (collection_id, vod_asset_id) DO UPDATE SET position=EXCLUDED.position`, [PICKS, asset, i, ADMIN]);
  }
  const term = (productKey: string, name: string, priceCents: number) => ({ productKey, name, kind: 'period', count: 1, unit: 'month', priceCents, currency: 'AUD' });
  const picks = { apps: 'all', territories: { mode: 'world', countries: [] }, rules: [
    { id: 'r1', countries: ['AU', 'NZ'], access: 'premium', terms: [term('picks.monthly', 'Premium picks pass', 499)],
      appTerms: { [IOSAPP]: [term('picks.ios.monthly', 'Premium picks pass (iOS)', 599)] } },
    { id: 'r2', countries: ['WORLD'], access: 'members' },
  ] };
  const food = { apps: 'all', territories: { mode: 'world', countries: [] }, rules: [{ id: 'r1', countries: ['WORLD'], access: 'members' }] };
  const CA = await import('../src/services/collectionAccess');
  for (const [id, access] of [[PICKS, picks], [FOOD, food]] as const) {
    await query(`UPDATE collections SET access = $2::jsonb WHERE id = $1`, [id, JSON.stringify(access)]);
    await CA.syncPackageProducts(ACCOUNT, id, access as any);
  }
  await CA.enqueueCollections([PICKS, FOOD, WEEK]);
  while (await CA.drainAccessRechecks());
}

/**
 * A RULE-BASED COLLECTION (build queue C1): short titles added this year,
 * plus one added by hand and one left out, so the Collections guide shows
 * rules, the live count, Rule and Added items and the left-out list.
 */
async function seedRuleCollection() {
  const ID = '7c2e1a40-5b6d-4e8f-9a0b-1c2d3e4f5a04';
  const rules = { match: 'all', conditions: [
    { field: 'created_at', op: 'within_last', value: { count: 12, unit: 'month' } },
    { field: 'duration_min', op: 'lt', value: 60 },
  ] };
  await query(
    `INSERT INTO collections(id, account_id, name, description, color, created_by, rules, order_by) VALUES ($1,$2,'Short and new','Everything under an hour added this year, kept up to date by rules','#3f7bff',$3,$4::jsonb,'-created_at')
     ON CONFLICT (id) DO UPDATE SET rules = EXCLUDED.rules, order_by = EXCLUDED.order_by, description = EXCLUDED.description`, [ID, ACCOUNT, ADMIN, JSON.stringify(rules)]);
  const { recompute } = await import('../src/services/collectionRules');
  await recompute(ID);
  // The station promo added by hand: it stays whatever the rules say.
  await query(`INSERT INTO collection_items(collection_id, vod_asset_id, position, added_by, source)
               SELECT $1, $2, 0, $3, 'manual' WHERE EXISTS (SELECT 1 FROM vod_assets WHERE id = $2)
               ON CONFLICT (collection_id, vod_asset_id) DO UPDATE SET source = 'manual'`, [ID, '6b1f0d2e-7a3c-4e5f-9a1b-2c3d4e5f6a01', ADMIN]);
  // One left out by a person, so the guide can show the left-out list.
  const first = await one<{ vod_asset_id: string }>(`SELECT vod_asset_id FROM collection_items WHERE collection_id = $1 AND source = 'rule' ORDER BY position LIMIT 1`, [ID])
    .then((r) => r).catch(() => null);
  // Once: a rerun of the seed leaves the same one out, not another.
  const already = await one(`SELECT 1 FROM collection_exclusions WHERE collection_id = $1 LIMIT 1`, [ID]);
  if (first && !already) {
    await query(`DELETE FROM collection_items WHERE collection_id = $1 AND vod_asset_id = $2`, [ID, first.vod_asset_id]);
    await query(`INSERT INTO collection_exclusions(collection_id, vod_asset_id, excluded_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [ID, first.vod_asset_id, ADMIN]);
  }
}

/**
 * METADATA RULES (build queue P3-3): two ordered rules on the Publishing
 * Rules page, so the guide shows the list, the order and an open rule with
 * its conditions and policy. Fixed ids: a rerun updates them in place.
 */
async function seedMetadataRules() {
  const rows: [string, number, string, any, any, string[]][] = [
    ['8d3f2b51-6c7e-4f90-8a1b-2c3d4e5f6b01', 0, 'Premier League matches',
      { match: 'all', conditions: [{ field: 'tags', op: 'has_any', value: ['premier-league'] }] },
      { geo: { mode: 'allow', countries: ['AU', 'NZ'] }, access: 'entitled', protection: { waf: 'standard' } }, ['geo']],
    ['8d3f2b51-6c7e-4f90-8a1b-2c3d4e5f6b02', 1, 'Embargoed until broadcast',
      { match: 'any', conditions: [{ field: 'tags', op: 'has_any', value: ['embargoed'] }, { field: 'genre', op: 'is', value: 'News' }] },
      { distribution: { shareLinks: false, mp4Download: false } }, []],
  ];
  for (const [id, position, name, conditions, settings, locked] of rows) {
    await query(
      `INSERT INTO publishing_metadata_rules(id, account_id, position, name, conditions, settings, locked_fields, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$8)
       ON CONFLICT (id) DO UPDATE SET position = EXCLUDED.position, name = EXCLUDED.name, conditions = EXCLUDED.conditions,
                                      settings = EXCLUDED.settings, locked_fields = EXCLUDED.locked_fields`,
      [id, ACCOUNT, position, name, JSON.stringify(conditions), JSON.stringify(settings), locked, ADMIN]);
  }
}

// TITLE RETENTION (build queue P5-2): three of the FAST titles keep their own
// Retention setting (the asset rung), so Storage's "Titles deleted by their
// publishing policy" shows each case the guide explains: one due in four days
// and listed, one due and kept by a legal hold, one due and waiting for the
// archive copy the account's copy rule asks for. The sweep runs with limit 0,
// so it stores dates, warnings and reasons but never removes a title here.
async function seedTitleRetention() {
  const [, smoke, bakery, valley] = DOCS_FAST.assets.map((a) => a.id);
  const has = await query<{ id: string }>(`SELECT id FROM vod_assets WHERE id = ANY($1::uuid[])`, [[smoke, bakery, valley]]);
  if (has.length < 3) { console.warn('[seed-docs] no FAST titles: the title retention list stays empty'); return; }
  const keep = (days: number) => JSON.stringify({ retention: { keep: 'days', days, anchor: 'ingest' } });
  // Made 3 days before the seed: 7 days is due in 4, 2 and 1 days are due now.
  for (const [id, days] of [[bakery, 7], [smoke, 2], [valley, 1]] as const) {
    await query(`UPDATE vod_assets SET availability_override = COALESCE(availability_override, '{}'::jsonb) || $2::jsonb,
                   created_at = now() - interval '3 days', retention_warned_at = NULL WHERE id = $1`, [id, keep(days)]);
  }
  await query(`UPDATE vod_assets SET legal_hold_at = now() - interval '1 day', legal_hold_by = $2, legal_hold_reason = 'Music rights dispute, case 2026-114'
                WHERE id = $1 AND legal_hold_at IS NULL`, [valley, 'admin@example.com']);
  const { sweepVodRetention } = await import('../src/services/media/vodRetention');
  await sweepVodRetention({ accountId: ACCOUNT, limit: 0, actor: 'seed-docs' });
}

// THE LIFECYCLE (build queue P1-2): one published title with a window, so the
// Media Library's Public status column and the Availability tab's timeline
// show Available with a start, an end and today between them. The house promo
// already has its media; it is published to the catalogue, open to everyone,
// from 12 days before the seed to 18 days after it.
async function seedLifecycle() {
  const PROMO = '6b1f0d2e-7a3c-4e5f-9a1b-2c3d4e5f6a01';
  await query(
    `UPDATE vod_assets SET availability_state = 'available', published = true, media_state = 'ready',
            availability = '{"targets":[{"kind":"portal"}],"access":"free"}'::jsonb,
            available_from = now() - interval '12 days', available_until = now() + interval '18 days', updated_at = now()
      WHERE id = $1 AND account_id = $2`, [PROMO, ACCOUNT]);
  const { refreshPublicStatus } = await import('../src/services/publicStatus');
  await refreshPublicStatus(PROMO);
}

// BILLING (build queue B1-3): two months already invoiced, one paid with a
// reference and one waiting, a price for server time and a charge on the open
// month, so the Billing guide shows a real history. The account pays under
// contract, which needs no Stripe. The ledger is append only, so a rerun adds
// nothing to a month already invoiced and the open month's charge is added once.
// The page itself shows billing only when the API runs with VOLT_BILLING set.
async function seedBilling() {
  const before = process.env.VOLT_BILLING;
  process.env.VOLT_BILLING = 'contract';
  try {
    const I = await import('../src/services/invoicing');
    await query(`UPDATE accounts SET billing_handling = 'contract', billing_tax_rate = 0.1 WHERE id = $1`, [ACCOUNT]);
    if (!(await one(`SELECT 1 FROM billing_prices WHERE unit_key = 'server_hour' AND instance_type IS NULL`))) {
      await query(`INSERT INTO billing_prices(unit_key, instance_type, name, unit, unit_usd, effective_from) VALUES ('server_hour', NULL, 'Streaming server', 'hour', 0.42, now() - interval '120 days')`);
    }
    const open = I.monthOf(), last = I.previousMonth(open), older = I.previousMonth(last);
    for (const [m, desc, amt] of [[older, 'Onboarding workshop', 450], [last, 'Extra storage, 2 TB', 80]] as [string, string, number][]) {
      if (await one(`SELECT 1 FROM billing_invoices WHERE account_id = $1 AND period_month = $2`, [ACCOUNT, m])) continue;
      await I.addManualCharge({ accountId: ACCOUNT, amountUsd: amt, description: desc, month: m, userId: null });
      await I.closeMonth(m, { accountId: ACCOUNT });
    }
    const paid = await one<any>(`SELECT id, status FROM billing_invoices WHERE account_id = $1 AND period_month = $2`, [ACCOUNT, older]);
    if (paid && paid.status === 'issued') await I.markPaid(paid.id, 'Bank transfer, ref. 40172', null);
    if (!(await one(`SELECT 1 FROM billing_charges WHERE account_id = $1 AND period_month = $2 AND source = 'manual'`, [ACCOUNT, open]))) {
      await I.addManualCharge({ accountId: ACCOUNT, amountUsd: -25, description: 'Credit: outage on the 3rd', month: open, userId: null });
    }
    // ADD-ONS (build queue B2-2): a catalogue with packs, and the docs account
    // with one on and part of its allowance used, for the Billing guide.
    if (!(await one(`SELECT 1 FROM billing_addons WHERE key = 'archive_storage'`))) {
      await query(`INSERT INTO billing_addons(key, name, description, monthly_usd, included_quantity, unit, licence) VALUES
        ('archive_storage', 'Archive storage', 'Verified copies of your originals and recordings in your own storage', 50, 100, 'GB', 'mirror_archive'),
        ('extra_transcode', 'Extra transcode hours', 'Encoding hours beyond your plan for on-demand titles', 30, 20, 'hours', NULL)`);
      await query(`INSERT INTO billing_addon_packs(addon_key, key, name, extra_quantity, monthly_usd) VALUES
        ('archive_storage', 'small', 'Small pack', 100, 20), ('archive_storage', 'large', 'Large pack', 500, 60),
        ('extra_transcode', 'plus', 'Plus pack', 40, 45)`);
    }
    const X = await import('../src/services/invoicing/addons');
    if (!(await one(`SELECT 1 FROM account_addons WHERE account_id = $1 AND addon_key = 'archive_storage'`, [ACCOUNT]))) {
      await X.setAddon(ACCOUNT, 'archive_storage', 'small', { userId: null, label: 'volt' });
    }
    await query(`INSERT INTO addon_usage(account_id, addon_key, period_month, used) VALUES ($1, 'archive_storage', $2, 128.5)
                 ON CONFLICT (account_id, addon_key, period_month) DO NOTHING`, [ACCOUNT, open]);
  } finally {
    if (before === undefined) delete process.env.VOLT_BILLING; else process.env.VOLT_BILLING = before;
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
