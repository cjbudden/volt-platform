// ============================================================================
//  MIRROR AND ARCHIVE: RECORDINGS (build queue H3-7, HYBRID_SITES.md "Format
//  for recordings").
//
//  Through the real API on a real database, with real fMP4 segments on disk
//  (made here with ffmpeg and stamped onto the wall clock the way the encoder
//  lands them) and the REAL site agent code (volt-agent/src/siteArchive.ts)
//  writing into a folder that stands in for the customer's NAS:
//    - the stretches (pure): hours in UTC, in a half-hour zone, on a day the
//      clocks change; programmes that closed in the window, and only those;
//    - copy rules take `recording` (and refuse anything else);
//    - the pass: a rule switched on does not reach back; then one job per
//      closed stretch with media (an hour without a guide, a programme with
//      one), none for stretches with no media, none twice, none without the
//      licence, none for a rule that does not ask for recordings;
//    - the job joins the top rendition and the sound without re-encoding,
//      cut at segment boundaries (a segment belongs to the stretch its middle
//      is in), named Title-Channel-YYYYMMDD-HHMM in the channel's zone, with
//      a JSON sidecar, and hands both to each active target as archive.copy
//      jobs in the site's pool with the file's own checksum;
//    - the agent copies both, they are verified, and the cloud's file goes;
//    - the off-peak window holds the copies; a disabled target is skipped;
//    - the copies list filters by stream and shows the stream and stretch.
//
//  Usage: DATABASE_URL=... npx tsx test/mirror-archive-recordings.check.ts
// ============================================================================
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';

let pass = 0, fail = 0;
const ok = (c: unknown, m: string, d?: unknown) => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log('FAIL ' + m + (d !== undefined ? ` -- ${typeof d === 'string' ? d : JSON.stringify(d)}` : '')); } };
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const H = 3600_000;

/** 40 s of picture and tone as the recorder writes it: 4 s fMP4 segments, a 360p and an audio rendition. */
function makeFixture(): string | null {
  const out = mkdtempSync(join(tmpdir(), 'mrr-fix-'));
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=40', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=40',
    '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '100', '-keyint_min', '100', '-sc_threshold', '0',
    '-c:a', 'aac', '-b:a', '96k', '-ac', '2',
    '-f', 'hls', '-hls_time', '4', '-hls_list_size', '0', '-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4',
    '-var_stream_map', 'v:0,agroup:aud,name:360p a:0,agroup:aud,name:audio',
    '-hls_segment_filename', `${out}/%v/seg_%d.m4s`, `${out}/%v/index.m3u8`], { encoding: 'utf8' });
  if (r.status !== 0) { console.error(r.stderr); return null; }
  for (const d of readdirSync(out)) for (const f of readdirSync(join(out, d))) if (/^init_\d+\.mp4$/.test(f)) cpSync(join(out, d, f), join(out, d, 'init.mp4'));
  return out;
}

/** Put the fixture under a stream as one run whose first segment starts at `startMs`. */
function placeRun(originDir: string, streamId: string, fix: string, startMs: number) {
  const run = join(originDir, streamId, 'runs', '20261107T000000Z');
  for (const rend of ['360p', 'audio']) {
    const dir = join(run, rend);
    mkdirSync(dir, { recursive: true });
    cpSync(join(fix, rend, 'init.mp4'), join(dir, 'init.mp4'));
    const segs = readdirSync(join(fix, rend)).filter((f) => /^seg_\d+\.m4s$/.test(f)).sort((a, b) => parseInt(a.slice(4)) - parseInt(b.slice(4)));
    segs.forEach((f, i) => {
      cpSync(join(fix, rend, f), join(dir, f));
      const t = (startMs + (i + 1) * 4000) / 1000;   // a segment lands when its content has been written
      utimesSync(join(dir, f), t, t);
    });
  }
}

const probe = (path: string) => {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type:format=duration', '-of', 'json', path], { encoding: 'utf8' });
  try { const j = JSON.parse(r.stdout); return { types: j.streams.map((s: any) => s.codec_type).sort(), ms: Math.round(parseFloat(j.format.duration) * 1000) }; } catch { return null; }
};

(async () => {
  process.env.ORIGIN_DIR ||= mkdtempSync(join(tmpdir(), 'mrr-origin-'));
  process.env.ARCHIVE_BUILD_DIR ||= mkdtempSync(join(tmpdir(), 'mrr-build-'));
  process.env.CLIPS_DIR ||= mkdtempSync(join(tmpdir(), 'mrr-clips-'));
  const R = await import('../src/services/archive/recordings');
  const N = await import('../src/services/archive/naming');
  const AG = await import('../../volt-agent/src/siteArchive');

  console.log('== the stretches (pure) ==');
  const T = (iso: string) => Date.parse(iso);
  let ps = R.planPieces({ afterMs: T('2026-11-07T09:10:00Z'), untilMs: T('2026-11-07T12:05:00Z'), timeZone: 'UTC', guide: null });
  ok(ps.length === 3 && ps[0].startMs === T('2026-11-07T09:00:00Z') && ps[2].endMs === T('2026-11-07T12:00:00Z'), 'without a guide: each clock hour that ended in the window, the first one whole although it began before', ps.map((p) => new Date(p.startMs).toISOString()));
  ps = R.planPieces({ afterMs: T('2026-11-07T09:10:00Z'), untilMs: T('2026-11-07T11:40:00Z'), timeZone: 'Asia/Kolkata', guide: null });
  ok(ps.length === 3 && new Date(ps[0].startMs).toISOString() === '2026-11-07T08:30:00.000Z' && new Date(ps[2].endMs).toISOString() === '2026-11-07T11:30:00.000Z', 'in a half-hour zone the hours are its own (India: on the half hour UTC)', ps.map((p) => new Date(p.startMs).toISOString()));
  // London's local day of 25 Oct 2026 runs from 23:00 UTC (midnight BST) to midnight UTC (midnight GMT).
  ps = R.planPieces({ afterMs: T('2026-10-24T23:00:00Z'), untilMs: T('2026-10-26T00:00:00Z'), timeZone: 'Europe/London', guide: null });
  ok(ps.length === 25 && ps.every((p) => p.endMs - p.startMs === H), 'the day the clocks go back has 25 hours of an hour each', ps.length);
  ok(ps.filter((p) => N.stampIn(p.startMs, 'Europe/London') === '20261025-0100').length === 2, 'and 01:00 comes twice (the agent adds -2 to the second name)');
  ok(R.planPieces({ afterMs: 5, untilMs: 5, guide: null }).length === 0, 'an empty window has none');
  const guide = [
    { id: 'a', title: 'News', startMs: T('2026-11-07T09:00:00Z'), endMs: T('2026-11-07T09:30:00Z') },
    { id: 'b', title: 'Film', startMs: T('2026-11-07T09:30:00Z'), endMs: T('2026-11-07T11:30:00Z') },
    { id: 'c', title: 'Later', startMs: T('2026-11-07T11:30:00Z'), endMs: T('2026-11-07T12:30:00Z') },
  ];
  ps = R.planPieces({ afterMs: T('2026-11-07T09:20:00Z'), untilMs: T('2026-11-07T12:00:00Z'), timeZone: 'UTC', guide });
  ok(ps.length === 2 && ps[0].title === 'News' && ps[1].title === 'Film' && ps[1].startMs === T('2026-11-07T09:30:00Z'), 'with a guide: each programme that ended in the window, whole, with its title; one still running waits', ps);

  console.log('== real segments ==');
  const fix = makeFixture();
  if (!fix) { ok(false, 'ffmpeg made the fixture'); process.exit(1); }
  const now = new Date();
  const T0 = Math.floor(now.getTime() / H) * H - 3 * H;            // an hour boundary three hours ago

  const { createServer } = await import('../src/server');
  const { pool, one, query } = await import('../src/db');
  const { signAccess } = await import('../src/auth/jwt');
  const tag = Date.now().toString(36);
  const acct = (await one<any>(`INSERT INTO accounts(name, licences) VALUES ($1, '{mirror_archive}') RETURNING id`, [`mrr-${tag}`]))!.id;
  const user = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [acct, `mrr-${tag}@example.com`]))!.id;
  const tok = signAccess({ sub: user, account_id: acct, role: 'owner' } as any);
  const prof = (await one<any>(`INSERT INTO output_profiles(account_id, name, rungs, workflow_type) VALUES ($1,'T','[]','transcode') RETURNING id`, [acct]))!.id;
  const grp = (await one<any>(`INSERT INTO groups(account_id, name, output_profile_id) VALUES ($1,'G',$2) RETURNING id`, [acct, prof]))!.id;
  const chHour = (await one<any>(`INSERT INTO channels(group_id, name, status, tz) VALUES ($1,'Channel 1','live','UTC') RETURNING id`, [grp]))!.id;
  const chEpg = (await one<any>(`INSERT INTO channels(group_id, name, status, tz) VALUES ($1,'Sky Arts','live','Europe/Berlin') RETURNING id`, [grp]))!.id;
  const origin = process.env.ORIGIN_DIR!;
  placeRun(origin, chHour, fix, T0 - 20_000);   // 40 s across the hour: 20 s each side
  placeRun(origin, chEpg, fix, T0 - 20_000);
  const segsBefore = R.segmentsForPiece(chHour, T0 - H, T0), segsAfter = R.segmentsForPiece(chHour, T0, T0 + H);
  ok(segsBefore[0]?.main.length === 5 && segsAfter[0]?.main.length === 5 && segsBefore[0].audio.length === 5, 'a segment belongs to the stretch its middle is in: 5 and 5 either side of the hour, sound alongside', [segsBefore[0]?.main.length, segsAfter[0]?.main.length]);
  await query(`INSERT INTO programmes (channel_id, title, starts_at, ends_at) VALUES ($1,'Morning News',$2,$3), ($1,'Late Show',$4,$5)`,
    [chEpg, new Date(T0 - 12_000), new Date(T0 + 12_000), new Date(T0 + H), new Date(T0 + 2 * H)]);

  const srv = createServer().listen(0);
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const api = async (method: string, path: string, body?: unknown, t: string | null = tok) => {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text(); let b: any = null; try { b = text ? JSON.parse(text) : null; } catch { b = text; }
    return { status: r.status, body: b };
  };
  const facts = (hostname: string) => ({ hostname, cpuCores: 4, memoryBytes: 8 * 2 ** 30, diskFreeBytes: 1e12, diskTotalBytes: 2e12, os: 'Linux', arch: 'x64', agentVersion: '0.5.0' });
  const site = (await api('POST', '/api/sites', { name: 'Archive room' })).body.id;
  const tk = await api('POST', `/api/sites/${site}/enrolment-tokens`, {});
  const e = await api('POST', '/api/site-agent/enrol', { token: tk.body.token, host: facts('arc-01') }, null);
  await api('POST', `/api/sites/${site}/hosts/${e.body.hostId}/approve`, {});
  const actx = { server: base, credential: () => e.body.credential, log: (_s: string) => {}, progressEveryMs: 50 };
  const nas = mkdtempSync(join(tmpdir(), 'mrr-nas-'));
  const nas2 = mkdtempSync(join(tmpdir(), 'mrr-nas2-'));
  const target = (await api('POST', '/api/archive/targets', { name: 'Recordings NAS', siteId: site, path: nas })).body.id;
  const target2 = (await api('POST', '/api/archive/targets', { name: 'Spare NAS', siteId: site, path: nas2 })).body.id;

  console.log('== copy rules take recordings ==');
  let r = await api('PUT', '/api/publishing-rules/account', { settings: { archive: { copies: [{ targetId: target, on: ['recordings'] }] } } });
  ok(r.status === 422, 'an unknown moment is refused', r.status);
  r = await api('PUT', '/api/publishing-rules/account', { settings: { archive: { copies: [{ targetId: target, on: ['ingest'] }] } } });
  ok(r.status === 200, 'a rule for originals only', r.status);

  console.log('== the pass ==');
  let p = await R.recordingPass({ now, accountId: acct });
  ok(p.queued === 0 && (await one<any>(`SELECT count(*)::int AS n FROM archive_recording_cursors WHERE stream_id = ANY($1)`, [[chHour, chEpg]])).n === 2, 'a rule that does not ask for recordings queues nothing (and the streams start from now)', p);
  r = await api('PUT', '/api/publishing-rules/account', { settings: { archive: { copies: [{ targetId: target, on: ['ingest', 'recording'] }, { targetId: target2, on: ['recording'] }] } } });
  ok(r.status === 200 && r.body.settings.archive.copies[0].on.join() === 'ingest,recording', 'a rule that archives recordings to two targets is saved', r.body?.settings?.archive);
  p = await R.recordingPass({ now, accountId: acct });
  ok(p.queued === 0, 'switching it on does not reach back over what is already recorded', p);

  // Wind the cursors back to just before the recorded hour, as if the rule had been on all along.
  await query(`UPDATE archive_recording_cursors SET done_until = $2 WHERE stream_id = ANY($1)`, [[chHour, chEpg], new Date(T0 - H - 60_000)]);
  await query(`UPDATE accounts SET licences = '{}' WHERE id = $1`, [acct]);
  p = await R.recordingPass({ now, accountId: acct });
  ok(p.queued === 0, 'without the licence nothing is queued', p);
  await query(`UPDATE accounts SET licences = '{mirror_archive}' WHERE id = $1`, [acct]);
  p = await R.recordingPass({ now, accountId: acct });
  const jobs = await query<any>(`SELECT * FROM jobs WHERE id = ANY($1) ORDER BY (payload->>'startMs')::bigint, payload->>'fileName'`, [p.jobs]);
  const hourJobs = jobs.filter((j) => j.channel_id === chHour), epgJobs = jobs.filter((j) => j.channel_id === chEpg);
  ok(p.queued === 3 && hourJobs.length === 2 && epgJobs.length === 1, 'one job per closed stretch with media: two hours on the channel with no guide, one programme on the other (the later programme and hours have no media)', jobs.map((j) => j.payload.fileName));
  ok(jobs.every((j) => j.type === 'archive.recording' && j.pool === null), 'as cloud jobs');
  ok(hourJobs[0].payload.fileName === `Channel1-${N.stampIn(T0 - H, 'UTC')}.mp4` && hourJobs[1].payload.fileName === `Channel1-${N.stampIn(T0, 'UTC')}.mp4`, 'an hour is named Channel-YYYYMMDD-HHMM', hourJobs.map((j) => j.payload.fileName));
  ok(epgJobs[0].payload.fileName === `MorningNews-SkyArts-${N.stampIn(T0 - 12_000, 'Europe/Berlin')}.mp4` && epgJobs[0].payload.title === 'Morning News', 'a programme is named Title-Channel-YYYYMMDD-HHMM in the channel\'s zone', epgJobs[0].payload.fileName);
  p = await R.recordingPass({ now, accountId: acct });
  ok(p.queued === 0, 'the next pass queues none of them again', p);

  console.log('== the job ==');
  const ctx = (job: any) => ({ job, progress: async () => {}, isCancelled: () => false });
  const res1 = await R.runRecordingJob(ctx(hourJobs[1]) as any) as any;
  const built = join(process.env.ARCHIVE_BUILD_DIR!, `${chHour}-${T0}`, hourJobs[1].payload.fileName);
  const pr = probe(built);
  ok(pr && pr.types.join() === 'audio,video' && Math.abs(pr.ms - 20_000) <= 500, 'the hour is one file of picture and sound, 20 s (its five segments), joined without re-encoding', pr);
  const vIn = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height', '-of', 'csv=p=0', built], { encoding: 'utf8' }).stdout.trim();
  ok(vIn === 'h264,640,360', 'the top rendition as it was recorded (h264 640x360)', vIn);
  const side = JSON.parse(readFileSync(built.replace(/\.mp4$/, '.json'), 'utf8'));
  ok(side.kind === 'volt.recording' && side.channel?.name === 'Channel 1' && side.file.sha256 === sha(readFileSync(built)) && side.stretch.cut === 'hour'
    && side.stretch.start === new Date(T0).toISOString() && side.media.segments === 5 && side.programme === null, 'the sidecar says what, which channel, when, and the file\'s checksum', side);
  const copies = await query<any>(`SELECT c.*, j.pool, j.type, j.payload FROM archive_copies c JOIN jobs j ON j.id = c.job_id WHERE c.stream_id = $1 ORDER BY c.target_id, c.what`, [chHour]);
  ok(res1.queued.length === 4 && copies.length === 4 && copies.every((c) => c.pool === `site:${site}` && c.type === 'archive.copy' && c.state === 'queued'), 'the file and its sidecar are handed to both targets as copy jobs in the site\'s pool', { res1, n: copies.length });
  const fileCopy = copies.find((c) => c.what === 'recording' && c.target_id === target);
  ok(fileCopy.expected_sha256 === side.file.sha256 && fileCopy.payload.transfers[0].bytes === side.file.bytes && fileCopy.range_start.getTime() === T0, 'each copy expects the file\'s own checksum and size, and names its stretch', fileCopy);

  const res2 = await R.runRecordingJob(ctx(epgJobs[0]) as any) as any;
  const epgBuilt = join(process.env.ARCHIVE_BUILD_DIR!, `${chEpg}-${T0 - 12_000}`, epgJobs[0].payload.fileName);
  const pe = probe(epgBuilt);
  const eside = JSON.parse(readFileSync(epgBuilt.replace(/\.mp4$/, '.json'), 'utf8'));
  ok(pe && Math.abs(pe.ms - 24_000) <= 500 && eside.programme?.title === 'Morning News' && eside.stretch.cut === 'programme' && eside.stretch.timeZone === 'Europe/Berlin',
    'the programme is cut at its start and end to the segment (24 s of a 24 s programme), with the programme in the sidecar', { pe, prog: eside.programme, res2: res2.queued.length });

  // A stretch with nothing recorded is refused for good, not retried.
  let perm: any = null;
  try { await R.joinPiece(chHour, T0 + 5 * H, T0 + 6 * H, join(process.env.ARCHIVE_BUILD_DIR!, 'none.mp4')); } catch (x) { perm = x; }
  ok(perm?.name === 'PermanentError' && perm.code === 'no_media', 'a stretch with no media is refused for good', perm?.message);

  console.log('== the agent copies them ==');
  let ran = 0, n: number;
  while ((n = await AG.archivePass(actx)) > 0) ran += n;
  const done = await query<any>(`SELECT * FROM archive_copies WHERE stream_id = ANY($1) ORDER BY what`, [[chHour, chEpg]]);
  ok(ran === 8 && done.length === 8 && done.every((c) => c.state === 'verified'), 'the agent makes all eight copies (two files and two sidecars, two targets) and each is verified', { ran, states: done.map((c) => c.state) });
  ok(existsSync(join(nas, hourJobs[1].payload.fileName)) && readFileSync(join(nas, hourJobs[1].payload.fileName)).equals(readFileSync(join(nas2, hourJobs[1].payload.fileName)))
    && existsSync(join(nas, epgJobs[0].payload.fileName.replace(/\.mp4$/, '.json'))), 'on the NAS under their names, the same bytes on both targets', readdirSync(nas));
  ok(!existsSync(built) && !existsSync(epgBuilt) && !existsSync(join(process.env.ARCHIVE_BUILD_DIR!, `${chHour}-${T0}`)), 'and the cloud\'s files are gone once every copy is verified', readdirSync(process.env.ARCHIVE_BUILD_DIR!));
  ok(await R.releaseBuilt(join(nas, hourJobs[1].payload.fileName)) === false && existsSync(join(nas, hourJobs[1].payload.fileName)), 'a file outside the build folder is never removed');

  console.log('== off-peak and a disabled target ==');
  await api('PATCH', `/api/archive/targets/${target2}`, { status: 'disabled' });
  const wnd = { from: '00:00', to: '00:01', timeZone: 'UTC' };
  await api('PUT', '/api/publishing-rules/account', { settings: { archive: { copies: [{ targetId: target, on: ['recording'] }, { targetId: target2, on: ['recording'] }], offPeak: wnd } } });
  // The first hour again, as if made under the new rule.
  const job0 = { ...hourJobs[0], payload: { ...hourJobs[0].payload, offPeak: wnd } };
  const res0 = await R.runRecordingJob(ctx(job0) as any) as any;
  const held = await query<any>(`SELECT j.run_after FROM archive_copies c JOIN jobs j ON j.id = c.job_id WHERE c.id = ANY($1)`, [res0.queued]);
  const opens = (await import('../src/services/archive/archive')).offPeakStart(new Date(), wnd);
  ok(res0.queued.length === 2 && res0.skipped.some((s: any) => s.targetId === target2 && s.why === 'target_disabled'), 'a disabled target is skipped and says why', res0);
  ok(opens === null ? true : held.every((h) => Math.abs(new Date(h.run_after).getTime() - opens.getTime()) < 120_000), 'the copies wait for the off-peak window', { held, opens });

  console.log('== the copies list ==');
  r = await api('GET', `/api/archive/copies?stream_id=${chEpg}&what=recording`);
  ok(r.status === 200 && r.body.items.length === 2 && r.body.items.every((c: any) => c.streamName === 'Sky Arts' && c.title === 'Morning News' && Date.parse(c.rangeStart) === T0 - 12_000 && Date.parse(c.rangeEnd) === T0 + 12_000 && c.vodAssetId === null),
    'filters by stream and kind, and shows the stream, programme and stretch', r.body);

  console.log('== hooks are wired ==');
  const src = (f: string) => readFileSync(join(__dirname, '..', f), 'utf8');
  ok(/recordingPass\(\)/.test(src('src/services/orchestrator/index.ts')), 'the scheduler runs the recording pass');
  ok(/registerArchiveRecordingHandlers\(\)/.test(src('src/index.ts')), 'the worker runs archive.recording jobs');

  srv.close();
  await pool.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
