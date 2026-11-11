// ============================================================================
//  RECORDINGS WAIT FOR THEIR ARCHIVE FILE (build queue H3-5c;
//  services/archive/recordingWait.ts, services/media/retention.ts sweep).
//
//  Against Postgres, real fMP4 runs on disk and the HTTP app:
//    - a channel whose copy rule archives recordings: the rule's delete rung
//      waits while no file covers the recording, while its file is being
//      made, when making it failed, while the stretch has not been handed on,
//      while its copy is being copied, and when the copy failed or went
//      missing, each with its reason on the recording; once the copy is
//      verified the recording goes and the reason is cleared;
//    - an expiry set by hand waits the same way;
//    - a recording from before the rule first handed recordings on goes as
//      before, and so does one of an account without Mirror and Archive;
//    - a dry run counts the wait without writing it;
//    - the Storage retention list carries the reason;
//    - the recordings pass marks where archiving began.
//
//  Usage: DATABASE_URL=... npx tsx test/retention-recordings-archive.check.ts
// ============================================================================
import { spawnSync } from 'node:child_process';
import { mkdirSync, utimesSync, cpSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

const ROOT = join(tmpdir(), `volt-rra-${Date.now().toString(36)}`);
process.env.ORIGIN_DIR = join(ROOT, 'origin');
process.env.CLIPS_DIR = join(ROOT, 'clips');
process.env.IMAGE_STORE_DIR = join(ROOT, 'image-store');
process.env.VOLT_TRASH_DIR = join(ROOT, 'trash');

let pass = 0, fail = 0;
const ok = (c: unknown, m: string, d?: unknown) => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log('FAIL ' + m + (d !== undefined ? ` -- ${typeof d === 'string' ? d : JSON.stringify(d)}` : '')); } };

(async () => {
  const src = join(ROOT, 'src'); mkdirSync(src, { recursive: true });
  const ff = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25', '-t', '20',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '50', '-keyint_min', '50', '-sc_threshold', '0',
    '-f', 'hls', '-hls_time', '2', '-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4',
    '-hls_segment_filename', join(src, 'seg_%d.m4s'), join(src, 'index.m3u8')], { encoding: 'utf8' });
  if (ff.status !== 0) { console.log('SKIP: ffmpeg could not make the test run', ff.stderr); process.exit(0); }

  const { createServer } = await import('../src/server');
  const { pool, one, query } = await import('../src/db');
  const { signAccess } = await import('../src/auth/jwt');
  const { reconcileStream } = await import('../src/services/media/reconcile');
  const { sweep, saveRule } = await import('../src/services/media/retention');
  const W = await import('../src/services/archive/recordingWait');
  const R = await import('../src/services/archive/recordings');

  const tag = Date.now().toString(36);
  const mkAccount = async (n: string, lic: string[]) => {
    const acct = (await one<any>(`INSERT INTO accounts(name, licences) VALUES ($1,$2) RETURNING id`, [`${n}-${tag}`, lic]))!.id as string;
    const user = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [acct, `${n}-${tag}@volt.test`]))!.id;
    const prof = (await one<any>(`INSERT INTO output_profiles(account_id, name, rungs, workflow_type) VALUES ($1,'T','[]','transcode') RETURNING id`, [acct]))!.id;
    const grp = (await one<any>(`INSERT INTO groups(account_id, name, output_profile_id) VALUES ($1,'G',$2) RETURNING id`, [acct, prof]))!.id as string;
    return { acct, grp, tok: signAccess({ sub: user, account_id: acct, role: 'owner' } as any) };
  };
  const A = await mkAccount('rra', ['mirror_archive']);
  const B = await mkAccount('rra-plain', []);
  const app: any = createServer(); const srv = app.listen(0); const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const api = async (method: string, path: string, body?: any, tok = A.tok) => {
    const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${tok}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const t = await r.text(); let j: any = t; try { j = JSON.parse(t); } catch { /* */ } return { status: r.status, body: j };
  };
  const mkChannel = async (grp: string, name: string) => (await one<any>(`INSERT INTO channels(group_id, name, tz) VALUES ($1,$2,'UTC') RETURNING id`, [grp, name]))!.id as string;

  // A run laid down `daysAgo` days ago (one rendition, 10 segments on a 2 s grid) and its recording row.
  let n = 0;
  async function layRecording(ch: string, daysAgo: number, title: string) {
    const t0 = Date.now() - daysAgo * 86_400_000 - (n++) * 600_000;
    const runId = new Date(t0).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const runDir = join(process.env.ORIGIN_DIR!, ch, 'runs', runId);
    cpSync(src, join(runDir, '720'), { recursive: true });
    for (let i = 0; i < 10; i++) { const t = new Date(t0 + (i + 1) * 2000); utimesSync(join(runDir, '720', `seg_${i}.m4s`), t, t); }
    writeFileSync(join(runDir, 'master.m3u8'), '#EXTM3U\n');
    const rec = (await one<any>(`INSERT INTO recordings(kind, channel_id, title, day_utc, status, start_epoch_ms, end_epoch_ms)
       VALUES ('channel_day', $1, $2, $3, 'complete', $4, $5) RETURNING id`, [ch, title, new Date(t0).toISOString().slice(0, 10), t0, t0 + 20_000]))!.id as string;
    await reconcileStream(ch);
    await query(`UPDATE media_objects SET recording_id = $2, state = 'available' WHERE logical_key LIKE $1`, [`run/${runId}/%`, rec]);
    return { rec, t0, t1: t0 + 20_000 };
  }
  const live = async (rec: string) => (await one<any>(`SELECT count(*)::int AS n FROM media_objects WHERE recording_id = $1 AND state <> 'deleted'`, [rec]))!.n as number;
  const recRow = (rec: string) => one<any>(`SELECT archive_wait_code, archive_wait, archive_checked_at, storage_state FROM recordings WHERE id = $1`, [rec]);

  try {
    console.log('== a channel that archives its recordings ==');
    const site = (await one<any>(`INSERT INTO sites (account_id, name) VALUES ($1,'Broadcast centre') RETURNING id`, [A.acct]))!.id;
    const target = (await one<any>(`INSERT INTO archive_targets (account_id, site_id, name, path) VALUES ($1,$2,'Recordings NAS','/mnt/rec') RETURNING id`, [A.acct, site]))!.id as string;
    let r = await api('PUT', '/api/publishing-rules/account', { settings: { archive: { copies: [{ targetId: target, on: ['recording'] }] } } });
    ok(r.status === 200, 'the account copy rule archives recordings', r.body);
    const ch = await mkChannel(A.grp, 'Archive TV');
    const chHand = await mkChannel(A.grp, 'Hand TV');
    await saveRule({ actingAccountId: A.acct, channelId: ch, name: 'Two days', appliesTo: 'recording', stages: [{ afterDays: 2, action: 'delete' }] });
    const rec = await layRecording(ch, 5, 'Five days old');
    const before = await layRecording(ch, 9, 'From before the rule');
    ok((await live(rec.rec)) >= 1 && (await live(before.rec)) >= 1, 'retention tracks both runs');
    // The rule first handed recordings on 7 days ago; the pass has looked up to 10 minutes ago.
    await query(`INSERT INTO archive_recording_cursors (stream_id, account_id, done_until, archived_from) VALUES ($1,$2, now() - interval '10 minutes', now() - interval '7 days')`, [ch, A.acct]);

    console.log('== no file covers it yet ==');
    const dry = await sweep({ dryRun: true, accountId: A.acct });
    ok(dry.waitingArchive >= 1 && !(await recRow(rec.rec)).archive_checked_at, 'a dry run counts the wait and writes nothing', dry);
    let s = await sweep({ accountId: A.acct, actor: 'test' });
    let row = await recRow(rec.rec);
    ok(s.waitingArchive >= 1 && (await live(rec.rec)) >= 1, 'the delete rung waits: its media stays', s);
    ok(row.archive_wait_code === 'no_file' && /only copy/.test(row.archive_wait), 'the recording says why: no archive file covers it', row);
    ok((await live(before.rec)) === 0, 'a recording from before the rule handed recordings on goes as before');

    console.log('== the file is being made, then making it failed ==');
    const job = (await one<any>(`INSERT INTO jobs (type, payload, state) VALUES ('archive.recording', $1::jsonb, 'queued') RETURNING id`,
      [JSON.stringify({ streamId: ch, startMs: rec.t0 - 1000, endMs: rec.t1 + 1000, fileName: 'Archive TV-x.mp4' })]))!.id;
    await sweep({ accountId: A.acct, actor: 'test' });
    row = await recRow(rec.rec);
    ok(row.archive_wait_code === 'making' && (await live(rec.rec)) >= 1, 'its file is being made: it waits and says so', row);
    await query(`UPDATE jobs SET state = 'failed', last_error = 'no segments could be read' WHERE id = $1`, [job]);
    await sweep({ accountId: A.acct, actor: 'test' });
    row = await recRow(rec.rec);
    ok(row.archive_wait_code === 'make_failed' && /no segments could be read/.test(row.archive_wait) && (await live(rec.rec)) >= 1, 'making it failed: it waits, with the reason', row);

    console.log('== its copy at the target ==');
    await query(`UPDATE jobs SET state = 'succeeded' WHERE id = $1`, [job]);
    const copy = (await one<any>(`INSERT INTO archive_copies (account_id, target_id, stream_id, range_start, range_end, title, what, source_uri, file_name, state)
       VALUES ($1,$2,$3,$4,$5,'x','recording','/build/x.mp4','Archive TV-20261106-1000.mp4','copying') RETURNING id`,
      [A.acct, target, ch, new Date(rec.t0 - 1000), new Date(rec.t1 + 1000)]))!.id;
    await sweep({ accountId: A.acct, actor: 'test' });
    row = await recRow(rec.rec);
    ok(row.archive_wait_code === 'copying' && /being copied at Recordings NAS/.test(row.archive_wait) && (await live(rec.rec)) >= 1, 'while it is copied: it waits, naming the file and the target', row);
    for (const st of ['failed', 'missing', 'corrupt']) {
      await query(`UPDATE archive_copies SET state = $2 WHERE id = $1`, [copy, st]);
      await sweep({ accountId: A.acct, actor: 'test' });
      row = await recRow(rec.rec);
      ok(row.archive_wait_code === 'copy_bad' && row.archive_wait.includes(`is ${st}`) && (await live(rec.rec)) >= 1, `a copy that is ${st}: it waits, and says to copy it again`, row);
    }
    r = await api('GET', '/api/storage/expiring');
    const item = (r.body?.items ?? []).find((x: any) => x.id === rec.rec);
    ok(item?.archiveWait?.code === 'copy_bad' && /Copy it again/.test(item.archiveWait.message), 'the Storage retention list carries the reason', item);
    r = await api('GET', `/api/recordings/${rec.rec}`);
    ok(r.body?.archive_wait_code === 'copy_bad', 'and so does the recording', r.body?.archive_wait_code);

    console.log('== not handed on yet ==');
    await query(`UPDATE archive_copies SET state = 'verified' WHERE id = $1`, [copy]);
    await query(`UPDATE archive_recording_cursors SET done_until = $2 WHERE stream_id = $1`, [ch, new Date(rec.t1 - 5000)]);
    await sweep({ accountId: A.acct, actor: 'test' });
    row = await recRow(rec.rec);
    ok(row.archive_wait_code === 'not_made' && (await live(rec.rec)) >= 1, 'the pass has not reached its end: it waits', row);

    console.log('== verified: it goes ==');
    await query(`UPDATE archive_recording_cursors SET done_until = now() - interval '10 minutes' WHERE stream_id = $1`, [ch]);
    s = await sweep({ accountId: A.acct, actor: 'test' });
    row = await recRow(rec.rec);
    ok((await live(rec.rec)) === 0 && s.deleted >= 1, 'its archive file is verified: the recording is deleted', s);
    ok(row.archive_wait_code === null && row.archive_wait === null, 'and the reason is cleared', row);

    console.log('== an expiry set by hand waits too ==');
    const hand = await layRecording(chHand, 1, 'Set by hand');
    await query(`UPDATE recordings SET delete_after = now() - interval '1 hour' WHERE id = $1`, [hand.rec]);
    await query(`INSERT INTO archive_recording_cursors (stream_id, account_id, done_until, archived_from) VALUES ($1,$2, now() - interval '10 minutes', now() - interval '7 days')`, [chHand, A.acct]);
    await sweep({ accountId: A.acct, actor: 'test' });
    row = await recRow(hand.rec);
    ok(row.archive_wait_code === 'no_file' && (await live(hand.rec)) >= 1, 'the manual expiry waits for the archive file', row);
    await query(`INSERT INTO archive_copies (account_id, target_id, stream_id, range_start, range_end, title, what, source_uri, file_name, state)
       VALUES ($1,$2,$3,$4,$5,'x','recording','/build/h.mp4','Hand TV.mp4','verified')`, [A.acct, target, chHand, new Date(hand.t0), new Date(hand.t1)]);
    await sweep({ accountId: A.acct, actor: 'test' });
    ok((await live(hand.rec)) === 0, 'and goes once it is verified');

    console.log('== outside a copy rule, unchanged ==');
    const chB = await mkChannel(B.grp, 'Plain TV');
    await saveRule({ actingAccountId: B.acct, channelId: chB, name: 'Two days', appliesTo: 'recording', stages: [{ afterDays: 2, action: 'delete' }] });
    const plain = await layRecording(chB, 5, 'Plain');
    s = await sweep({ accountId: B.acct, actor: 'test' });
    ok((await live(plain.rec)) === 0 && s.waitingArchive === 0 && (await recRow(plain.rec)).archive_wait_code === null, 'an account without Mirror and Archive: deleted as before', s);
    // A copy rule that archives originals only does not hold recordings.
    r = await api('PUT', '/api/publishing-rules/account', { settings: { archive: { copies: [{ targetId: target, on: ['ingest'] }] } } });
    const other = await layRecording(ch, 6, 'Originals only');
    ok(await W.recordingArchiveWait(other.rec) === null, 'a copy rule that does not archive recordings: no wait');

    console.log('== the pass marks where archiving began ==');
    r = await api('PUT', '/api/publishing-rules/account', { settings: { archive: { copies: [{ targetId: target, on: ['recording'] }] } } });
    const chNew = await mkChannel(A.grp, 'New TV');
    await query(`UPDATE channels SET recording_enabled = true WHERE id = $1`, [chNew]);
    await query(`INSERT INTO archive_recording_cursors (stream_id, account_id, done_until) VALUES ($1,$2, now() - interval '1 hour')`, [chNew, A.acct]);
    await R.recordingPass({ accountId: A.acct, streamId: chNew });
    const cur = await one<any>(`SELECT archived_from, done_until FROM archive_recording_cursors WHERE stream_id = $1`, [chNew]);
    ok(cur?.archived_from && Math.abs(new Date(cur.archived_from).getTime() - (Date.now() - 3600_000)) < 120_000, 'the first pass with the rule on records where it began', cur);
  } finally {
    srv.close();
    await pool.end();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
