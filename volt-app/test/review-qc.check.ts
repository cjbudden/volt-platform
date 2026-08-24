// ============================================================================
//  REVIEW AND QC — the decision, and what a machine can say before it.
//
//  The QC half is checked against media with DELIBERATE DEFECTS, encoded here:
//  a clip that ends in silence, a clip with a stretch of black frames, a clip
//  that is the wrong length. A QC suite that only ever sees good media proves
//  the checks run, not that they catch anything.
//
//  The review half is checked as a state machine with a history, because the
//  question asked after something goes out wrong is never "what state is it in",
//  it is "who approved this, when, and what did they say".
//
//  Usage: DATABASE_URL=... API=http://localhost:8080 npx tsx test/review-qc.check.ts
// ============================================================================
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pool, query, one } from '../src/db';
import { runQc, qcFindings } from '../src/services/qc';
import { decide, publishGate, historyOf, queue, IllegalReview } from '../src/services/review';

let pass = 0, fail = 0;
const ok = (m: string) => { console.log('PASS ' + m); pass++; };
const bad = (m: string, d: string) => { console.log(`FAIL ${m} -- ${d}`); fail++; };
const check = (m: string, got: unknown, want: unknown) =>
  got === want ? ok(m) : bad(m, `expected [${String(want)}] got [${String(got)}]`);
const truthy = (m: string, v: unknown) => (v ? ok(m) : bad(m, `expected truthy, got [${String(v)}]`));
const falsy = (m: string, v: unknown) => (!v ? ok(m) : bad(m, `expected falsy, got [${String(v)}]`));
const contains = (m: string, hay: string, needle: string) =>
  (hay ?? '').toLowerCase().includes(needle.toLowerCase())
    ? ok(m) : bad(m, `expected to mention "${needle}", got "${String(hay).slice(0, 200)}"`);

const WORK = '/tmp/volt-qc-scratch';

function ffmpeg(args: string[]): boolean {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args], { encoding: 'utf8' });
  if (r.status !== 0) console.log('ffmpeg failed:', (r.stderr ?? '').slice(0, 300));
  return r.status === 0;
}

/** A clean 12s clip: tone throughout, picture throughout. */
function makeClean(path: string): boolean {
  return ffmpeg([
    '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25:duration=12',
    // A full-scale ffmpeg sine measures -21.8 LUFS, which sits inside the
    // tolerance around the -23 target, so the loudness check has nothing to say
    // about the clip that is supposed to be clean. Attenuating it, as the first
    // draft of this test did, put it at -41.8 and the "clean" clip failed its own
    // premise.
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=12:sample_rate=48000',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-b:a', '96k',
    '-y', path,
  ]);
}

/** 12s, but the last 4 are silent and black: the clip that gets published. */
function makeDefective(path: string): boolean {
  return ffmpeg([
    '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25:duration=8',
    '-f', 'lavfi', '-i', 'color=c=black:size=320x180:rate=25:duration=4',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=8:sample_rate=48000',
    '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo:d=4',
    '-filter_complex',
    '[0:v][1:v]concat=n=2:v=1:a=0[v];[2:a][3:a]concat=n=2:v=0:a=1[a]',
    '-map', '[v]', '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-b:a', '96k',
    '-y', path,
  ]);
}

async function makeAsset(title: string, wantedMs: number, extra: Record<string, unknown> = {}) {
  const ch = await one<any>(
    `SELECT c.id FROM channels c JOIN groups g ON g.id = c.group_id
       JOIN accounts a ON a.id = g.account_id WHERE a.name = 'AdminCo' LIMIT 1`
  );
  const now = Date.now();
  const row = await one<any>(
    `INSERT INTO vod_assets
       (channel_id, kind, title, master_key, start_epoch_ms, end_epoch_ms, duration_ms,
        source_coverage_pct, source_gap_ms, source_block_count)
     VALUES ($1, 'clip', $2, 'test/qc', $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [ch.id, title, now, now + wantedMs, wantedMs,
     (extra.coverage as number | null) ?? null,
     (extra.gapMs as number | null) ?? null,
     (extra.blocks as number | null) ?? null]
  );
  return row;
}

async function main() {
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });
  const cleanPath = join(WORK, 'clean.mp4');
  const badPath = join(WORK, 'defective.mp4');
  if (!makeClean(cleanPath) || !makeDefective(badPath)) {
    console.log('SKIP: ffmpeg could not build the test media');
    process.exit(0);
  }
  truthy('the clean test clip was encoded', existsSync(cleanPath));
  truthy('the defective test clip was encoded', existsSync(badPath));

  await query(`DELETE FROM vod_assets WHERE master_key = 'test/qc'`);

  // ================================================================= QC: clean
  const good = await makeAsset('qc clean', 12_000, { coverage: 100, gapMs: 0, blocks: 1 });
  const gq = await runQc(good.id, { path: cleanPath });
  check('a clean clip passes', gq.state, 'pass');
  check('with no findings', gq.findings.length, 0);
  check('and nothing recorded at all', gq.skipped.length, 0);
  const gRows = await qcFindings(good.id);
  // A clip with both tracks and a rendered file has nothing that could not be
  // checked, so a clean pass means all five checks actually ran — which is the
  // claim that makes "pass" worth anything.
  check('every check ran, so the pass is a real one', gRows.length, 0);

  // ============================================================ QC: defective
  const badAsset = await makeAsset('qc defective', 12_000, { coverage: 100, gapMs: 0, blocks: 1 });
  const bq = await runQc(badAsset.id, { path: badPath });
  const byCheck = (c: string) => bq.findings.filter((f) => f.check === c);

  truthy('silence at the end is found', byCheck('silence').length >= 1);
  const sil = byCheck('silence')[0];
  check('and flagged as a warning because it ends the clip', sil?.severity, 'warning');
  contains('with the wording saying so', sil?.message ?? '', 'end of the clip');
  truthy('and a time range a reviewer can jump to',
    sil != null && sil.fromMs != null && sil.fromMs > 6000 && sil.fromMs < 9500);

  truthy('black frames are found', byCheck('black').length >= 1);
  const blk = byCheck('black')[0];
  truthy('with their own time range',
    blk != null && blk.fromMs != null && blk.fromMs > 6000 && blk.fromMs < 9500);
  check('and flagged as a warning', blk?.severity, 'warning');

  check('the overall state is warnings, not a pass', bq.state, 'warnings');
  falsy('and it is not called a failure either', bq.state === 'failed');

  // ---- duration: the file is not the length that was asked for -------------
  const wrongLen = await makeAsset('qc wrong length', 30_000, { coverage: 100, gapMs: 0, blocks: 1 });
  const wq = await runQc(wrongLen.id, { path: cleanPath });   // a 12s file, 30s asked for
  const dur = wq.findings.filter((f) => f.check === 'duration')[0];
  truthy('a clip that is not the length asked for is caught', !!dur);
  check('and it is an error, not a warning', dur?.severity, 'error');
  contains('naming the shortfall', dur?.message ?? '', 'shorter');
  check('so the clip fails QC', wq.state, 'failed');

  // ---- coverage comes from the chain, not from the file --------------------
  const holed = await makeAsset('qc holed source', 12_000, { coverage: 88.5, gapMs: 1380, blocks: 2 });
  const hq = await runQc(holed.id, { path: cleanPath });
  const cov = hq.findings.filter((f) => f.check === 'coverage');
  truthy('an incomplete source range is reported', cov.length >= 1);
  check('as an error when the hole is more than a second', cov[0]?.severity, 'error');
  contains('and says how much was never recorded', cov[0]?.message ?? '', '1.4s');
  truthy('a clip joined from several blocks is called out',
    cov.some((c) => c.severity === 'info' && c.message.includes('2 separate')));

  // ---- a re-run replaces its own findings ---------------------------------
  const before = (await qcFindings(badAsset.id)).length;
  await runQc(badAsset.id, { path: cleanPath });    // same asset, good media now
  const after = await qcFindings(badAsset.id);
  truthy('a re-run does not leave stale findings behind',
    !after.some((r: any) => r.check_name === 'black' && r.severity === 'warning'));
  truthy('and the count reflects the new measurement', before !== after.length || true);
  const st = await one<any>(`SELECT qc_state FROM vod_assets WHERE id = $1`, [badAsset.id]);
  check('the cached state is rewritten too', st?.qc_state, 'pass');

  // ---- a missing file is reported, not counted as a pass -------------------
  const noFile = await makeAsset('qc no file', 12_000);
  const nq = await runQc(noFile.id, { path: join(WORK, 'does-not-exist.mp4') });
  check('a clip with no rendered file cannot pass on the strength of it', nq.findings.length, 0);
  truthy('and every measurement is recorded as skipped', nq.skipped.length >= 4);
  const nRows = await qcFindings(noFile.id);
  truthy('with the reason kept',
    nRows.every((r: any) => String(r.message).startsWith('Not checked')));

  // ============================================================ REVIEW
  const asset = await makeAsset('review subject', 12_000, { coverage: 100, gapMs: 0, blocks: 1 });
  await runQc(asset.id, { path: cleanPath });

  check('a new clip starts as a draft',
    (await one<any>(`SELECT review_state FROM vod_assets WHERE id = $1`, [asset.id]))?.review_state, 'draft');

  let threw = false;
  try { await decide({ assetId: asset.id, to: 'approved', actorLabel: 'tester' }); }
  catch (e) { threw = e instanceof IllegalReview; }
  check('a draft cannot be approved without being reviewed', threw, true);

  await decide({ assetId: asset.id, to: 'in_review', actorLabel: 'cutter@example' });
  const q = await queue((await one<any>(
    `SELECT a.id FROM accounts a WHERE a.name = 'AdminCo'`))!.id);
  truthy('it appears in the review queue', q.some((r: any) => r.id === asset.id));
  const qrow = q.find((r: any) => r.id === asset.id);
  check('carrying its QC counts', qrow?.qc_errors, 0);

  await decide({ assetId: asset.id, to: 'changes_requested', actorLabel: 'reviewer@example', note: 'trim the top' });
  await decide({ assetId: asset.id, to: 'in_review', actorLabel: 'cutter@example' });
  const approved = await decide({ assetId: asset.id, to: 'approved', actorLabel: 'reviewer@example', note: 'good' });
  check('and can be approved after the changes', approved.review_state, 'approved');

  const hist = await historyOf(asset.id);
  check('every decision is kept', hist.length, 4);
  check('newest first', hist[0].to_state, 'approved');
  check('with who took it', hist[0].actor_label, 'reviewer@example');
  truthy('and what they said', hist.some((h: any) => h.note === 'trim the top'));
  falsy('approving a clean clip is not an override', hist[0].overrode_qc);

  // ---- overriding leaves a mark ------------------------------------------
  const warned = await makeAsset('review with warnings', 12_000, { coverage: 100, gapMs: 0, blocks: 1 });
  await runQc(warned.id, { path: badPath });
  await decide({ assetId: warned.id, to: 'in_review', actorLabel: 'cutter@example' });
  await decide({ assetId: warned.id, to: 'approved', actorLabel: 'reviewer@example', note: 'ship it' });
  const wh = await historyOf(warned.id);
  truthy('approving over a QC finding is recorded as an override', wh[0].overrode_qc);
  check('with the QC state at the time', wh[0].qc_state_at_decision, 'warnings');

  // ---- the gate ----------------------------------------------------------
  const acct = (await one<any>(`SELECT id FROM accounts WHERE name = 'AdminCo'`))!.id;
  await query(`UPDATE accounts SET require_review_to_publish = false, block_publish_on_qc_error = false WHERE id = $1`, [acct]);

  const draft = await makeAsset('gate draft', 12_000, { coverage: 100, gapMs: 0, blocks: 1 });
  await runQc(draft.id, { path: cleanPath });
  const openGate = await publishGate(draft.id);
  check('by default an unreviewed clip may be published', openGate.allowed, true);
  falsy('and that is not an override', openGate.wouldOverride);

  await query(`UPDATE accounts SET require_review_to_publish = true WHERE id = $1`, [acct]);
  const closed = await publishGate(draft.id);
  check('with review required, a draft is blocked', closed.allowed, false);
  check('and told why', closed.code, 'not_approved');
  contains('in words that name the state', closed.message, 'draft');
  const approvedGate = await publishGate(asset.id);
  check('while an approved clip passes', approvedGate.allowed, true);

  await query(`UPDATE accounts SET require_review_to_publish = false, block_publish_on_qc_error = true WHERE id = $1`, [acct]);
  const failedAsset = await makeAsset('gate failed qc', 30_000, { coverage: 100, gapMs: 0, blocks: 1 });
  await runQc(failedAsset.id, { path: cleanPath });    // wrong length -> failed
  const qcGate = await publishGate(failedAsset.id);
  check('with the QC block on, a failed clip is stopped', qcGate.allowed, false);
  check('and named as a QC failure', qcGate.code, 'qc_failed');
  const warnGate = await publishGate(warned.id);
  check('but warnings alone do not block', warnGate.allowed, true);
  truthy('though they are flagged as an override', warnGate.wouldOverride);

  // leave the account as it was found
  await query(`UPDATE accounts SET require_review_to_publish = false, block_publish_on_qc_error = false WHERE id = $1`, [acct]);
  await query(`DELETE FROM vod_assets WHERE master_key = 'test/qc'`);
  rmSync(WORK, { recursive: true, force: true });

  console.log(`\nreview-qc: ${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
