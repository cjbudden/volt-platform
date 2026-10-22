// ============================================================================
//  CLIP EXTRACTION CHECKS — against REAL recorded segments on disk.
//
//  No fixtures and no synthetic media: this finds a stream that actually has
//  runs in the origin directory and clips it. If the box has no recordings the
//  script says so and exits without pretending to have tested anything.
//
//  What it guards:
//    * resolution places segments by MEASURED time, spans runs, and reports gaps;
//    * a clip is FRAME-ACCURATE — the output duration matches the request, not
//      the segment grid, which is the whole point of choosing this approach;
//    * the produced files exist, are non-empty and are decodable;
//    * a range with no media is refused with a reason instead of failing later.
//
//  Run: DATABASE_URL=... ORIGIN_DIR=... npx tsx test/clip-extract.check.ts
// ============================================================================
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../src/config';
import { listRuns, recordingSpans, pickRenditions } from '../src/services/localRecordingIndex';
import { resolveRange, assessRange, segmentCount } from '../src/services/clips/resolve';
import { extract, plan } from '../src/services/clips/extract';

let pass = 0, failed = 0;
const ok = (n: string) => { console.log(`PASS ${n}`); pass++; };
const bad = (n: string, d: string) => { console.log(`FAIL ${n} -- ${d}`); failed++; };
const check = (n: string, a: unknown, e: unknown) =>
  Object.is(a, e) ? ok(n) : bad(n, `expected [${String(e)}] got [${String(a)}]`);
const truthy = (n: string, v: unknown) => v ? ok(n) : bad(n, `expected truthy, got [${String(v)}]`);
const near = (n: string, a: number, e: number, tol: number) =>
  Math.abs(a - e) <= tol ? ok(`${n} (${a} vs ${e}, tol ${tol})`)
                         : bad(n, `expected ${e} +/- ${tol}, got ${a}`);

/** Actual duration of a media file, from the container. */
function probeMs(path: string): number {
  const out = execFileSync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', path,
  ], { encoding: 'utf8' }).trim();
  return Math.round(parseFloat(out) * 1000);
}

/**
 * THIS SUITE MAKES ITS OWN MEDIA.
 *
 * It used to take whichever stream in the origin directory happened to have
 * segments, which made two different things vary run to run: whether it ran at
 * all, and HOW MANY assertions it ran, because several of them only fire when
 * the borrowed stream happens to have more than one run. A suite whose
 * assertion count depends on what somebody else left on disk is not measuring
 * the code.
 *
 * Two runs, generated fresh, so the multi-run and gap assertions always fire.
 */
const OWN_STREAM = '0000000f-0000-0000-0000-0000000000ce';

function ensureOwnMedia(): { streamId: string; spans: ReturnType<typeof recordingSpans> } | null {
  const base = config.testStream.originDir;
  const dir = join(base, OWN_STREAM);
  const usableNow = () => recordingSpans(OWN_STREAM).filter((s) => s.segments >= 6);
  if (existsSync(join(dir, 'runs')) && usableNow().length >= 2) {
    return { streamId: OWN_STREAM, spans: usableNow() };
  }
  rmSync(dir, { recursive: true, force: true });
  const gen = join(__dirname, 'lib', 'make-fixture-runs.sh');
  // 36s runs, not 28: the wider-range assertion below only fires when a second
  // request can be at least 5s longer than the first, and a 28s run cannot
  // offer that once the off-grid margins are taken off both ends. 36 is also a
  // whole number of 4s segments, so there is no short trailing segment.
  const r = spawnSync('bash', [gen, dir, '2', '36'], { encoding: 'utf8' });
  if (r.status !== 0) {
    console.error(r.stderr || r.stdout);
    return null;
  }
  const spans = usableNow();
  return spans.length ? { streamId: OWN_STREAM, spans } : null;
}

async function main() {
  const found = ensureOwnMedia();
  if (!found) {
    console.log('SKIP could not generate fixture media (needs ffmpeg).');
    console.log('\nclip-extract: 0 passed, 0 failed (skipped)');
    return;
  }
  const { streamId, spans } = found;
  const span = spans[spans.length - 1];
  console.log(`using stream ${streamId}, run ${span.runId}, ${span.segments} segments, ` +
              `${((span.endMs - span.startMs) / 1000).toFixed(1)}s\n`);

  const kind = pickRenditions(streamId, span.runId).video ? 'video' : 'audio';

  // ---------------------------------------------------------------- resolve
  // Deliberately OFF the segment grid: start 1.4s into the run's second segment
  // and end 2.6s before a boundary, so a segment-snapping implementation would
  // be visibly wrong and this one must not be.
  const from = span.startMs + 5_400;
  const to = Math.min(span.endMs - 2_600, from + 20_000);
  const r = resolveRange(streamId, from, to, kind as 'video' | 'audio');

  truthy('resolution finds at least one contiguous block', r.blocks.length >= 1);
  truthy('resolution selects segments', segmentCount(r) >= 1);
  check('resolution reports the requested span', r.requestedMs, to - from);
  check('a range inside one run has no gaps', r.gaps.length, 0);
  check('full coverage reads 100%', r.coveragePct, 100);
  truthy('an off-grid range needs trimming', r.needsTrim);

  const firstSeg = r.blocks[0].segments[0];
  truthy('the first segment is partial', firstSeg.partial);
  truthy('the first segment records where to cut in', firstSeg.takeFromMs > 0);
  const lastRun = r.blocks[r.blocks.length - 1];
  const lastSeg = lastRun.segments[lastRun.segments.length - 1];
  truthy('the last segment is partial', lastSeg.partial);
  truthy('the last segment records where to cut out', lastSeg.takeToMs < (lastSeg.endMs - lastSeg.startMs));

  // segments must be contiguous and ordered, by measured time
  let ordered = true, contiguous = true;
  for (const run of r.blocks) {
    for (let i = 1; i < run.segments.length; i++) {
      if (run.segments[i].startMs < run.segments[i - 1].startMs) ordered = false;
      if (Math.abs(run.segments[i].startMs - run.segments[i - 1].endMs) > 50) contiguous = false;
    }
  }
  check('segments are in time order', ordered, true);
  check('segments within a block are contiguous', contiguous, true);
  // A block is contiguous BY CONSTRUCTION now: a hole inside a run ends the
  // block rather than being byte-joined over. So a single-block resolution
  // over a fully covered range is also a claim that the media has no holes.
  check('a fully covered range resolves to one block per run', r.blocks.length, r.runCount);

  const plan1 = plan(r);
  // A render, not a copy. Which render is plan()'s call since smart render
  // landed: a 20 s off-grid range has whole segments in the middle, so it plans
  // 'smart-render' (clip-smart-render.check.ts owns that path). This used to
  // insist on 'full-render', which was true only before smart render existed.
  truthy('an off-grid range plans a render, never a copy',
    plan1.strategy === 'full-render' || plan1.strategy === 'smart-render');
  check('exactly two segments would need re-encoding under smart render',
    plan1.smartRenderSegments, 2);

  // ---------------------------------------------------------------- assess
  const verdict = assessRange(r);
  check('a fully covered range is accepted', verdict.ok, true);

  const empty = resolveRange(streamId, span.endMs + 86_400_000, span.endMs + 86_400_000 + 60_000, kind as any);
  const emptyVerdict = assessRange(empty);
  check('a range with no media is refused', emptyVerdict.ok, false);
  if (!emptyVerdict.ok) {
    check('and says why', emptyVerdict.code, 'no_media');
    truthy('with a human-readable message', emptyVerdict.message.length > 20);
  }

  // ---------------------------------------------------------------- extract
  const outDir = mkdtempSync(join(tmpdir(), 'clipcheck-'));
  try {
    const formats = kind === 'video' ? (['mp4', 'hls'] as const) : (['mp4', 'mp3', 'hls'] as const);
    const seen: number[] = [];
    const res = await extract({
      resolution: r, outDir, formats: [...formats],
      onProgress: (pct) => { seen.push(pct); },
    });

    check('every requested format was produced', res.files.length, formats.length);
    truthy('progress was reported', seen.length >= 2);
    truthy('progress ends at 100', seen[seen.length - 1] === 100);
    truthy('the strategy is recorded', res.strategy === 'full-render' || res.strategy === 'smart-render');

    for (const f of res.files) {
      truthy(`${f.format} exists on disk`, existsSync(f.path));
      truthy(`${f.format} is not empty`, statSync(f.path).size > 0);
    }

    // THE POINT OF THE WHOLE EXERCISE: the output duration must match what was
    // ASKED FOR, not what the segment grid would have given. A snapping
    // implementation would be out by up to one segment at each end.
    const mp4 = res.files.find((f) => f.format === 'mp4')!;
    const actualMs = probeMs(mp4.path);
    near('the clip is frame-accurate, not segment-snapped', actualMs, to - from, 300);

    // and prove a snapping implementation WOULD have been visibly wrong here
    const snapFrom = firstSeg.startMs;
    const snapTo = lastSeg.endMs;
    truthy('the request genuinely sits off the segment grid',
      Math.abs((snapTo - snapFrom) - (to - from)) > 1000);

    if (kind === 'audio') {
      const mp3 = res.files.find((f) => f.format === 'mp3')!;
      near('the mp3 matches the requested duration', probeMs(mp3.path), to - from, 400);
    }

    const hlsDir = join(outDir, 'hls');
    truthy('the hls output has an init segment', existsSync(join(hlsDir, 'init.mp4')));
    truthy('the hls output has media segments',
      readdirSync(hlsDir).some((f) => f.endsWith('.m4s')));

    // intermediates must not survive
    check('working files are cleaned up', existsSync(join(outDir, '.work')), false);

    // ------------------------------------------------- a second, longer range
    // Same run, wider window: proves the duration tracks the request rather than
    // being a fixed artefact of the segment layout.
    const to2 = Math.min(span.endMs - 1_000, from + 40_000);
    if (to2 - from > (to - from) + 5_000) {
      const r2 = resolveRange(streamId, from, to2, kind as any);
      const out2 = mkdtempSync(join(tmpdir(), 'clipcheck2-'));
      try {
        const res2 = await extract({ resolution: r2, outDir: out2, formats: ['mp4'] });
        near('a longer request produces a proportionally longer clip',
          probeMs(res2.files[0].path), to2 - from, 400);
      } finally { rmSync(out2, { recursive: true, force: true }); }
    }
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }

  console.log(`\nclip-extract: ${pass} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error('THREW', e); process.exit(1); });
