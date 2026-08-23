// ============================================================================
//  CLIP PROVENANCE — the chain from a finished asset back to physical media.
//
//  Two halves, both against real media rather than fixtures.
//
//  1. CONTINUITY. A run with a hole in it must resolve to TWO blocks and report
//     the hole, not to one block that byte-joins over it. The hole is made for
//     real: a scratch stream is built from a genuine run's segments and some are
//     moved out of the middle, so what is tested is the same scan path
//     production uses, on the same kind of files.
//
//  2. THE CHAIN. A clip is cut through the API, the job is waited on, and the
//     provenance is checked against the resolution it was built from: sequence
//     ranges, offsets that tile the clip's duration, the recording and broadcast
//     day it belonged to. Then the recording row is deleted and the chain is
//     read again — it must SURVIVE, because retention outlives the sources and a
//     record that vanishes with the media answers nothing when it matters.
//
//  Usage: DATABASE_URL=... API=http://localhost:8080 npx tsx test/clip-provenance.check.ts
// ============================================================================
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pool, query, one } from '../src/db';
import { resolveRange, assessRange } from '../src/services/clips/resolve';
import { listRuns, pickRenditions, scanRun } from '../src/services/localRecordingIndex';
import { originBaseFor } from '../src/services/liveOrigin';
import { traceClip, clipsFromRecording } from '../src/services/clips/provenance';

const API = process.env.API ?? 'http://localhost:8080';
let pass = 0, fail = 0;
const ok = (m: string) => { console.log('PASS ' + m); pass++; };
const bad = (m: string, d: string) => { console.log(`FAIL ${m} -- ${d}`); fail++; };
const check = (m: string, got: unknown, want: unknown) =>
  got === want ? ok(m) : bad(m, `expected [${String(want)}] got [${String(got)}]`);
const truthy = (m: string, v: unknown) => (v ? ok(m) : bad(m, `expected truthy, got [${String(v)}]`));
const near = (m: string, got: number, want: number, tol: number) =>
  Math.abs(got - want) <= tol ? ok(`${m} (${got} vs ${want}, tol ${tol})`)
    : bad(m, `expected ~${want} +/-${tol}, got ${got}`);

async function token(): Promise<string> {
  const r = await fetch(`${API}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'root@adminco.example', password: 'volt1234' }),
  });
  return (await r.json() as any).access;
}

async function main() {
  const TOK = await token();
  if (!TOK) { console.log('FATAL: no token (is the API up?)'); process.exit(1); }
  const api = async (path: string, init?: RequestInit) => {
    const r = await fetch(`${API}/api${path}`, {
      ...init,
      headers: { authorization: `Bearer ${TOK}`, 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
    return { status: r.status, body: await r.json().catch(() => null) as any };
  };

  // ---------------------------------------------------------------- subject
  // The channel with the most segments actually on disk. Chosen by measurement
  // rather than by SQL, because a recording row can claim time a crash meant was
  // never written.
  const chans = await query<any>(
    `SELECT c.id, c.name FROM channels c
       JOIN groups g ON g.id = c.group_id JOIN accounts a ON a.id = g.account_id
      WHERE a.name = 'AdminCo'`
  );
  let subject: { id: string; runId: string; segs: number } | null = null;
  for (const c of chans) {
    for (const runId of listRuns(c.id)) {
      if (!pickRenditions(c.id, runId).audio) continue;
      const n = scanRun(c.id, runId, 'audio').length;
      if (n > (subject?.segs ?? 0)) subject = { id: c.id, runId, segs: n };
    }
  }
  if (!subject) { console.log('SKIP: no audio media on disk'); process.exit(0); }
  console.log(`subject: channel ${subject.id} run ${subject.runId} (${subject.segs} segments)`);

  // ================================================================ PART 1
  //  A hole inside a run must end the block.
  // ------------------------------------------------------------------------
  const SCRATCH = 'prov-scratch-0000-0000-000000000001';
  const srcDir = join(originBaseFor(subject.id), 'runs', subject.runId, 'audio');
  const dstBase = originBaseFor(SCRATCH);
  const dstDir = join(dstBase, 'runs', 'scratchrun', 'audio');
  rmSync(dstBase, { recursive: true, force: true });
  mkdirSync(dstDir, { recursive: true });
  // preserveTimestamps is load-bearing, not tidiness: a segment's wall-clock
  // placement is measured from its write time, so a plain copy would stamp every
  // segment with the same instant and the scan would see nothing but holes.
  cpSync(join(srcDir, 'init.mp4'), join(dstDir, 'init.mp4'), { preserveTimestamps: true });
  const files = readdirSync(srcDir).filter((f) => /^seg_\d+\.m4s$/.test(f)).sort();
  const take = files.slice(0, 60);
  for (const f of take) cpSync(join(srcDir, f), join(dstDir, f), { preserveTimestamps: true });
  // Resolve over the media's OWN span. Asking for [0..forever] would make the
  // empty eternity either side count as gaps, which says nothing about the run.
  const scratch = scanRun(SCRATCH, 'scratchrun', 'audio');
  const sFrom = scratch[0].startMs, sTo = scratch[scratch.length - 1].startMs + scratch[scratch.length - 1].durMs;

  const whole = resolveRange(SCRATCH, sFrom, sTo, 'audio');
  check('a healthy copied run resolves to one block', whole.blocks.length, 1);
  check('and reports one run', whole.runCount, 1);
  check('and has no gaps', whole.gaps.length, 0);

  // Punch a hole: move five segments out of the middle. The files are moved
  // rather than deleted so the scratch tree stays inspectable after a failure.
  const holeDir = join(dstBase, '_removed');
  mkdirSync(holeDir, { recursive: true });
  const removed = take.slice(30, 35);
  for (const f of removed) renameSync(join(dstDir, f), join(holeDir, f));

  const holed = resolveRange(SCRATCH, sFrom, sTo, 'audio');
  check('a hole inside a run splits it into two blocks', holed.blocks.length, 2);
  check('but it is still ONE run', holed.runCount, 1);
  check('the hole is reported as a gap', holed.gaps.length, 1);
  check('and named as missing media, not as a stopped recording',
    holed.gaps[0]?.reason, 'missing-media');
  near('the gap is as long as the segments removed', holed.gaps[0]?.ms ?? 0,
    removed.length * 4000, 1500);
  truthy('coverage falls below 100%', holed.coveragePct < 100);
  check('the two blocks belong to the same run',
    holed.blocks[0].runId === holed.blocks[1].runId, true);
  check('and are numbered in order', holed.blocks.map((b) => b.blockIndex).join(','), '0,1');
  check('no block spans the hole',
    holed.blocks.every((b) => b.segments.every((s) =>
      !removed.includes(s.file))), true);

  // The subtle half of the same fault. A segment's start is its write time MINUS
  // its duration, and the duration comes from the tfdt delta to the next entry
  // on disk. With the hole punched, the next entry for the segment before it is
  // five segments later, so an unguarded read gives that segment a 24s duration
  // and places it 20s EARLY, on top of its own predecessors — media that looks
  // present, in the wrong place, with no gap reported.
  const holedSegs = scanRun(SCRATCH, 'scratchrun', 'audio');
  const longest = Math.max(...holedSegs.map((s) => s.durMs));
  truthy('no segment takes its duration from across the hole', longest < 10_000);
  let monotonic = true;
  for (let i = 1; i < holedSegs.length; i++) {
    if (holedSegs[i].startMs < holedSegs[i - 1].startMs) monotonic = false;
  }
  check('segment placement stays in sequence order across a hole', monotonic, true);
  check('and the blocks come out in time order',
    holed.blocks.map((b) => b.segments[0].seq).join(',') ===
    [...holed.blocks].sort((a, b) => a.startMs - b.startMs).map((b) => b.segments[0].seq).join(','),
    true);

  const verdict = assessRange(holed);
  check('a range with a hole is refused', verdict.ok, false);
  check('with the coverage reason', verdict.ok ? '' : verdict.code, 'coverage_gap');

  // A range that stops before the hole is clean again.
  const beforeHole = resolveRange(SCRATCH, holed.blocks[0].startMs, holed.blocks[0].endMs, 'audio');
  check('a range inside the first block is one block', beforeHole.blocks.length, 1);
  check('and is accepted', assessRange(beforeHole).ok, true);
  rmSync(dstBase, { recursive: true, force: true });

  // ================================================================ PART 2
  //  The chain, end to end, through the API.
  // ------------------------------------------------------------------------
  const rec = await one<any>(
    `SELECT * FROM recordings WHERE channel_id = $1 ORDER BY start_epoch_ms DESC LIMIT 1`,
    [subject.id]
  );
  if (!rec) { console.log('SKIP: no recording row for the subject channel'); process.exit(0); }

  // Cut inside the real run, off the segment grid at both ends so the trim flags
  // mean something.
  const segs = scanRun(subject.id, subject.runId, 'audio');
  const from = Math.round(segs[3].startMs + 1_400);
  const to = Math.round(from + 20_000);

  const created = await api(`/recordings/${rec.id}/clip`, {
    method: 'POST',
    body: JSON.stringify({ title: 'provenance check', startMs: from, endMs: to, outputKind: 'both' }),
  });
  if (created.status !== 202) {
    console.log(`FATAL: clip request returned ${created.status}: ${JSON.stringify(created.body).slice(0, 300)}`);
    process.exit(1);
  }
  const assetId: string = created.body.id;
  ok('the clip request is accepted');

  // Wait for the job. A clip of twenty seconds is quick; the cap is generous so
  // a slow box reports a real failure instead of a flake.
  let state = '';
  for (let i = 0; i < 90; i++) {
    const j = await api(`/jobs/${created.body.jobId}`);
    state = j.body?.state ?? '';
    if (state === 'succeeded' || state === 'failed') break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  check('the extraction job succeeds', state, 'succeeded');

  const trace = await api(`/vod/${assetId}/provenance`);
  check('the provenance endpoint answers', trace.status, 200);
  const t = trace.body;
  truthy('the chain is recorded', t?.recorded);
  check('the clip is one contiguous block', t.counts.blocks, 1);
  check('from one run', t.counts.runs, 1);
  check('and one broadcast day', t.counts.containers, 1);
  truthy('the segment count is real', t.counts.segments >= 5);
  check('coverage was complete', t.coveragePct, 100);
  check('the gap total is zero', t.gapMs, 0);
  check('the build strategy is recorded', t.buildStrategy, 'full-render');
  truthy('the build time is recorded', !!t.builtAt);
  check('it does not span broadcast days', t.spansBroadcastDays, false);

  const b0 = t.blocks[0];
  check('the block records its run', b0.runId, subject.runId);
  check('the block records its rendition', b0.rendition, 'audio');
  truthy('the sequence range is ordered', b0.segments.last >= b0.segments.first);
  check('the sequence range matches the segment count',
    b0.segments.last - b0.segments.first + 1, b0.segments.count);
  truthy('the head was trimmed inside a segment', b0.trimmed.head);
  truthy('the tail was trimmed inside a segment', b0.trimmed.tail);
  check('the first block starts at offset zero', b0.clip.offsetMs, 0);
  near('the block duration matches what was asked for', b0.clip.durationMs, to - from, 200);
  near('the source window matches the request', b0.source.fromMs, from, 200);
  truthy('it is linked to a recording', !!b0.recording);
  truthy('and to a broadcast day', !!b0.container);
  truthy('the day is a label, not a timestamp', /^\d{4}-\d{2}-\d{2}$/.test(b0.container?.day ?? ''));
  truthy('the source media is still present', b0.sourceMediaPresent);

  // offsets must tile the clip with no overlap and no hole
  let tiled = true, cursor = 0;
  for (const b of t.blocks) {
    if (Math.abs(b.clip.offsetMs - cursor) > 2) tiled = false;
    cursor += b.clip.durationMs;
  }
  check('block offsets tile the finished clip', tiled, true);

  // ---- the reverse question ----------------------------------------------
  const derived = await api(`/recordings/${rec.id}/derived`);
  check('the recording reports what came out of it', derived.status, 200);
  truthy('and the new clip is in the list',
    derived.body.assets.some((a: any) => a.assetId === assetId));
  check('an unpublished clip does not block pruning', derived.body.safeToPrune, true);

  // ---- the chain outlives its sources -------------------------------------
  // The whole point of ON DELETE SET NULL. Retention will take the recording
  // away; the record of what was cut from it must not go with it.
  await query(`DELETE FROM recordings WHERE id = $1`, [rec.id]);
  const after = await traceClip(assetId, originBaseFor);
  truthy('the chain survives the recording being deleted', (after?.blocks.length ?? 0) > 0);
  check('the run id survives', after?.blocks[0].runId, subject.runId);
  check('the sequence range survives', after?.blocks[0].segments.count, b0.segments.count);
  check('the recording link is cleared, not dangling', after?.blocks[0].recording, null);
  check('and the loss is counted', after?.counts.recordingsGone, 1);
  const orphaned = await clipsFromRecording(rec.id);
  check('the deleted recording no longer claims the clip', orphaned.length, 0);

  // put the recording back so the suite is repeatable
  await query(
    `INSERT INTO recordings (id, channel_id, event_id, kind, recording_type, container_id,
                             title, status, start_epoch_ms, end_epoch_ms, duration_ms,
                             master_key, day_utc)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (id) DO NOTHING`,
    [rec.id, rec.channel_id, rec.event_id, rec.kind, rec.recording_type, rec.container_id,
     rec.title, rec.status, rec.start_epoch_ms, rec.end_epoch_ms, rec.duration_ms,
     rec.master_key, rec.day_utc]
  );
  const restored = await one<any>(`SELECT id FROM recordings WHERE id = $1`, [rec.id]);
  truthy('the subject recording is restored for the next run', !!restored);

  // clean up the asset this suite created
  await query(`DELETE FROM vod_assets WHERE id = $1`, [assetId]);
  const chainGone = await query(`SELECT id FROM clip_segments WHERE vod_asset_id = $1`, [assetId]);
  check('deleting the asset takes its chain with it', chainGone.length, 0);
  try { rmSync(join(process.env.CLIPS_DIR ?? '/tmp/clips', assetId), { recursive: true, force: true }); } catch { /* */ }

  console.log(`\nclip-provenance: ${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
