// ============================================================================
//  MIRROR AND ARCHIVE: RECORDINGS (build queue H3-7, HYBRID_SITES.md "Format
//  for recordings", as Christian set it: consolidated files from the top
//  rendition only, joined without re-encoding, with a metadata sidecar).
//
//  A copy rule that says `on: ['recording']` for a storage target archives
//  the recordings of the channels and events it governs (account rung, or a
//  channel's or event's own rung):
//
//    - WITH A GUIDE: one file per programme, cut at the programme's start and
//      end (as aired, when the as-run times are known);
//    - WITHOUT ONE: one file per clock hour, in the channel's time zone;
//    - named `Title-Channel-YYYYMMDD-HHMM` (or `Channel-YYYYMMDD-HHMM` for an
//      hour) by `recordingFileName`, the same code the site agent compiles;
//    - beside it `<same name>.json`: what the file is, which programme, when,
//      in which zone, its size and checksum.
//
//  HOW. A pass every few minutes (orchestrator) looks for stretches that have
//  CLOSED since it last looked (the programme or hour has ended, plus a few
//  minutes for the last segment to land) and queues one `archive.recording`
//  job per stretch. That cloud job joins the segments into one file and hands
//  it to each target as an ordinary `archive.copy` (same agent code, same
//  read-back and checksum before it counts), within the rule's off-peak
//  window. When every target holds a verified copy the cloud's file goes.
//
//  JOINED WITHOUT RE-ENCODING, AT SEGMENT BOUNDARIES. A segment belongs to the
//  stretch its middle falls in, so consecutive files neither overlap nor drop
//  a segment, and a cut lands within half a segment of the programme's edge.
//  Frame-exact cuts would mean re-encoding the edges, which the rule rules
//  out. Segments are byte-joined per run (init + fragments is a valid MP4)
//  and the picture and sound muxed with ffmpeg `-c copy`.
//
//  NOT YET: on AWS the recording's segments are in the bucket and this reads
//  the task's disk (the per-run S3 prefixes are build queue 2.2), and the file
//  is served to the site by the task that made it.
// ============================================================================
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, createReadStream, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, rmdirSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { one, query } from '../../db';
import { config } from '../../config';
import { enqueue } from '../jobs/queue';
import { PermanentError, registerHandler, type JobContext } from '../jobs/worker';
import { listRuns, pickRenditions, scanRun, type LocalSegment } from '../localRecordingIndex';
import { originBaseFor } from '../liveOrigin';
import { ownedTarget, queueCopyJob, offPeakStart, validTimeZone, type ArchiveRule, type OffPeak } from './archive';
import { recordingFileName } from './naming';

export const ARCHIVE_RECORDING = 'archive.recording';
/** What a recording copy is: the joined file, and its metadata sidecar. */
export const RECORDING_WHATS = ['recording', 'recording-sidecar'] as const;

/** A stretch is handed on this long after it closes, so its last segment has landed. */
export const SETTLE_MS = 3 * 60_000;
/** A stream "has a guide" when a programme lies within this of the window. */
const GUIDE_REACH_MS = 24 * 3600_000;

/** Where the cloud makes recording files before the sites fetch them. */
export const buildDir = () => resolve(process.env.ARCHIVE_BUILD_DIR || join(process.cwd(), 'archive-build'));

// ---- which stretches (pure) ---------------------------------------------------------

export interface Piece { startMs: number; endMs: number; title: string | null; programmeId: string | null }
export interface GuideEntry { id: string; title: string; startMs: number; endMs: number }

function localMinute(ms: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, minute: '2-digit' }).formatToParts(new Date(ms));
  return Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
}

/**
 * The stretches that CLOSED in (afterMs, untilMs]: each programme of the
 * guide that ended then, or with no guide (`guide` null) each clock hour of
 * the zone that ended then. A stretch that began before `afterMs` is still
 * whole: closing is what makes it ready.
 *
 * Hours are found as the instants whose local minute is 0, on a 15-minute
 * grid, so zones with half and quarter hour offsets (India, Nepal) get their
 * own hours and a day when the clocks change has 23 or 25 of them.
 */
export function planPieces(o: { afterMs: number; untilMs: number; timeZone?: string | null; guide: GuideEntry[] | null }): Piece[] {
  if (!(o.untilMs > o.afterMs)) return [];
  if (o.guide) {
    return o.guide
      .filter((g) => g.endMs > o.afterMs && g.endMs <= o.untilMs && g.endMs > g.startMs)
      .sort((a, b) => a.startMs - b.startMs)
      .map((g) => ({ startMs: g.startMs, endMs: g.endMs, title: g.title, programmeId: g.id }));
  }
  const tz = o.timeZone && validTimeZone(o.timeZone) ? o.timeZone : 'UTC';
  const Q = 15 * 60_000;
  const bounds: number[] = [];
  for (let t = Math.floor((o.afterMs - 3 * 3600_000) / Q) * Q; t <= o.untilMs; t += Q) {
    if (localMinute(t, tz) === 0) bounds.push(t);
  }
  const out: Piece[] = [];
  for (let i = 1; i < bounds.length; i++) {
    const [s, e] = [bounds[i - 1], bounds[i]];
    if (e > o.afterMs && e <= o.untilMs) out.push({ startMs: s, endMs: e, title: null, programmeId: null });
  }
  return out;
}

// ---- which segments -----------------------------------------------------------------------

export interface PieceRun { runId: string; video: string | null; dir: string; main: LocalSegment[]; audio: LocalSegment[] }

const inPiece = (s: LocalSegment, a: number, b: number) => { const mid = s.startMs + s.durMs / 2; return mid >= a && mid < b; };

/**
 * The segments of [startMs, endMs) per run: the top video rendition (or the
 * sound alone for a radio run) and, beside it, the run's sound. A segment
 * belongs to the stretch its middle falls in.
 */
export function segmentsForPiece(streamId: string, startMs: number, endMs: number): PieceRun[] {
  const out: PieceRun[] = [];
  for (const runId of listRuns(streamId)) {
    const pick = pickRenditions(streamId, runId);
    const mainR = pick.video ?? (pick.audio ? 'audio' : null);
    if (!mainR) continue;
    const main = scanRun(streamId, runId, mainR).filter((s) => inPiece(s, startMs, endMs));
    if (!main.length) continue;
    const audio = pick.video && pick.audio ? scanRun(streamId, runId, 'audio').filter((s) => inPiece(s, startMs, endMs)) : [];
    out.push({ runId, video: pick.video, dir: join(originBaseFor(streamId), 'runs', runId), main, audio });
  }
  return out.sort((a, b) => a.main[0].startMs - b.main[0].startMs);
}

// ---- joining ---------------------------------------------------------------------------------

function run(bin: string, args: string[]): Promise<void> {
  return new Promise((res, rej) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
    p.on('error', rej);
    p.on('close', (code) => (code === 0 ? res() : rej(new Error(`${bin} exited ${code}: ${err.trim()}`))));
  });
}

/** init.mp4 then each fragment, byte for byte: a fragmented MP4 needing no re-encode. */
function byteJoin(rendDir: string, segs: LocalSegment[], dest: string) {
  const fd = openSync(dest, 'w');
  try {
    writeSync(fd, readFileSync(join(rendDir, 'init.mp4')));
    for (const s of segs) writeSync(fd, readFileSync(join(rendDir, s.file)));
  } finally { closeSync(fd); }
}

export function sha256File(path: string): Promise<string> {
  return new Promise((res, rej) => {
    const h = createHash('sha256');
    createReadStream(path).on('data', (d) => h.update(d)).on('error', rej).on('end', () => res(h.digest('hex')));
  });
}

async function probeMs(path: string): Promise<number | null> {
  return new Promise((res) => {
    const p = spawn(process.env.FFPROBE_BIN ?? 'ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', path]);
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('error', () => res(null));
    p.on('close', () => { const v = parseFloat(out); res(Number.isFinite(v) ? Math.round(v * 1000) : null); });
  });
}

export interface BuiltFile { path: string; bytes: number; sha256: string; durationMs: number | null; runs: number; segments: number; mediaStartMs: number; mediaEndMs: number; hasVideo: boolean; hasAudio: boolean }

/**
 * Join a stretch into one file at `dest`: per run, the byte-joined top
 * rendition and sound muxed with `-c copy`; several runs (an encoder restart
 * inside the stretch) joined with the concat demuxer, still without
 * re-encoding. Throws PermanentError when the stretch holds no media.
 */
export async function joinPiece(streamId: string, startMs: number, endMs: number, dest: string): Promise<BuiltFile> {
  const runs = segmentsForPiece(streamId, startMs, endMs);
  if (!runs.length) throw new PermanentError('No recording in this stretch', 'no_media');
  const ffmpeg = config.clips.ffmpegBin;
  const work = `${dest}.work`;
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  try {
    const parts: string[] = [];
    for (const [i, r] of runs.entries()) {
      const mainDir = join(r.dir, r.video ?? 'audio');
      const v = join(work, `main-${i}.mp4`);
      byteJoin(mainDir, r.main, v);
      const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', v];
      if (r.audio.length) {
        const a = join(work, `audio-${i}.mp4`);
        byteJoin(join(r.dir, 'audio'), r.audio, a);
        args.push('-i', a, '-map', '0:v:0', '-map', '1:a:0');
      } else args.push('-map', '0');
      const part = join(work, `part-${i}.mp4`);
      await run(ffmpeg, [...args, '-c', 'copy', part]);
      parts.push(part);
    }
    const tail = ['-c', 'copy', '-movflags', '+faststart', dest];
    if (parts.length === 1) await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', parts[0], '-map', '0', ...tail]);
    else {
      const list = join(work, 'parts.txt');
      writeFileSync(list, parts.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n') + '\n');
      await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-map', '0', ...tail]);
    }
  } finally { rmSync(work, { recursive: true, force: true }); }
  const first = runs[0].main[0], lastRun = runs[runs.length - 1], last = lastRun.main[lastRun.main.length - 1];
  return {
    path: dest, bytes: statSync(dest).size, sha256: await sha256File(dest), durationMs: await probeMs(dest),
    runs: runs.length, segments: runs.reduce((n, r) => n + r.main.length, 0),
    mediaStartMs: first.startMs, mediaEndMs: last.startMs + last.durMs,
    hasVideo: runs.some((r) => !!r.video), hasAudio: runs.some((r) => !!r.video ? r.audio.length > 0 : true),
  };
}

// ---- the pass ----------------------------------------------------------------------------------

interface StreamRow { id: string; kind: 'channel' | 'event'; name: string; tz: string | null; account_id: string }

async function guideFor(streamId: string, kind: 'channel' | 'event', afterMs: number, untilMs: number): Promise<GuideEntry[] | null> {
  const col = kind === 'channel' ? 'channel_id' : 'event_id';
  const near = await one(
    `SELECT 1 FROM programmes WHERE ${col} = $1 AND starts_at < $3 AND ends_at > $2 LIMIT 1`,
    [streamId, new Date(afterMs - GUIDE_REACH_MS), new Date(untilMs + GUIDE_REACH_MS)]);
  if (!near) return null;
  const rows = await query<any>(
    `SELECT id, title, COALESCE(actual_start, starts_at) AS s, COALESCE(actual_end, ends_at) AS e
       FROM programmes
      WHERE ${col} = $1 AND COALESCE(actual_end, ends_at) > $2 AND COALESCE(actual_end, ends_at) <= $3
      ORDER BY 3`, [streamId, new Date(afterMs), new Date(untilMs)]);
  return rows.map((r) => ({ id: r.id, title: r.title, startMs: new Date(r.s).getTime(), endMs: new Date(r.e).getTime() }));
}

async function setCursor(streamId: string, accountId: string, at: Date) {
  await query(
    `INSERT INTO archive_recording_cursors (stream_id, account_id, done_until) VALUES ($1,$2,$3)
     ON CONFLICT (stream_id) DO UPDATE SET done_until = GREATEST(archive_recording_cursors.done_until, EXCLUDED.done_until), updated_at = now()`,
    [streamId, accountId, at]);
}

/**
 * Queue an `archive.recording` job for every stretch of recording that closed
 * since the last pass, on every channel and event whose copy rule archives
 * recordings. Only accounts with the licence; a stream with recording off is
 * left alone.
 *
 * A stream seen for the first time (or whose rule archived nothing until now)
 * starts from this pass: switching the rule on does not reach back over the
 * recordings already kept, which can be months.
 */
export async function recordingPass(opts: { now?: Date; accountId?: string; streamId?: string } = {}): Promise<{ queued: number; streams: number; jobs: string[] }> {
  const now = opts.now ?? new Date();
  const until = new Date(now.getTime() - SETTLE_MS);
  const out = { queued: 0, streams: 0, jobs: [] as string[] };
  const streams = await query<StreamRow>(
    `SELECT c.id, 'channel' AS kind, c.name, c.tz, g.account_id
       FROM channels c JOIN groups g ON g.id = c.group_id JOIN accounts a ON a.id = g.account_id
      WHERE c.recording_enabled AND 'mirror_archive' = ANY(COALESCE(a.licences, '{}'))
        AND ($1::uuid IS NULL OR g.account_id = $1) AND ($2::uuid IS NULL OR c.id = $2)
     UNION ALL
     SELECT e.id, 'event' AS kind, e.name, NULL AS tz, g.account_id
       FROM events e JOIN groups g ON g.id = e.group_id JOIN accounts a ON a.id = g.account_id
      WHERE e.recording_enabled AND 'mirror_archive' = ANY(COALESCE(a.licences, '{}'))
        AND ($1::uuid IS NULL OR g.account_id = $1) AND ($2::uuid IS NULL OR e.id = $2)`,
    [opts.accountId ?? null, opts.streamId ?? null]);
  const { resolveForAsset } = await import('../publishingRules');
  for (const st of streams) {
    try {
      const rule = (await resolveForAsset(st.account_id, st.kind === 'channel' ? { channel_id: st.id } : { event_id: st.id })).settings.archive as ArchiveRule | undefined;
      const wanted = (rule?.copies ?? []).filter((c) => (c.on ?? []).includes('recording')).map((c) => c.targetId);
      const cur = await one<any>(`SELECT done_until FROM archive_recording_cursors WHERE stream_id = $1`, [st.id]);
      if (!wanted.length || !cur) { await setCursor(st.id, st.account_id, until); continue; }
      out.streams++;
      const after = new Date(cur.done_until).getTime();
      const guide = await guideFor(st.id, st.kind, after, until.getTime());
      for (const p of planPieces({ afterMs: after, untilMs: until.getTime(), timeZone: st.tz, guide })) {
        // A stretch with no media (the channel was off) makes no file.
        if (!segmentsForPiece(st.id, p.startMs, p.endMs).length) continue;
        const audioOnly = segmentsForPiece(st.id, p.startMs, p.endMs).every((r) => !r.video);
        const fileName = recordingFileName({ title: p.title, channel: st.name, start: p.startMs, timeZone: st.tz || 'UTC', ext: audioOnly ? 'm4a' : 'mp4' });
        const job = await enqueue({
          type: ARCHIVE_RECORDING, maxAttempts: 3,
          channelId: st.kind === 'channel' ? st.id : null, eventId: st.kind === 'event' ? st.id : null,
          dedupeKey: `${ARCHIVE_RECORDING}:${st.id}:${p.startMs}`,
          payload: {
            accountId: st.account_id, streamId: st.id, streamKind: st.kind, streamName: st.name, timeZone: st.tz || 'UTC',
            startMs: p.startMs, endMs: p.endMs, title: p.title, programmeId: p.programmeId, fileName,
            targetIds: wanted, offPeak: rule?.offPeak ?? null,
          },
        });
        out.queued++; out.jobs.push(job.id);
      }
      await setCursor(st.id, st.account_id, until);
    } catch (e: any) {
      console.warn(`[archive] recordings of ${st.kind} ${st.id} not handed on:`, e?.message ?? e);
    }
  }
  return out;
}

// ---- the job --------------------------------------------------------------------------------------

export interface RecordingPayload {
  accountId: string; streamId: string; streamKind: 'channel' | 'event'; streamName: string; timeZone: string;
  startMs: number; endMs: number; title: string | null; programmeId: string | null; fileName: string;
  targetIds: string[]; offPeak: OffPeak | null;
}

/** The sidecar: what the file is, in words a MAM or an archivist can read without Volt. */
export function sidecarFor(p: RecordingPayload, f: BuiltFile, programme: any | null) {
  const iso = (ms: number) => new Date(ms).toISOString();
  return {
    kind: 'volt.recording', version: 1,
    file: { name: p.fileName, bytes: f.bytes, sha256: f.sha256, durationMs: f.durationMs, video: f.hasVideo, audio: f.hasAudio },
    [p.streamKind]: { id: p.streamId, name: p.streamName },
    programme: programme ? {
      id: programme.id, title: programme.title,
      description: programme.metadata?.description ?? programme.metadata?.synopsis ?? null,
      scheduledStart: programme.starts_at, scheduledEnd: programme.ends_at,
      airedStart: programme.actual_start ?? null, airedEnd: programme.actual_end ?? null,
    } : null,
    stretch: { start: iso(p.startMs), end: iso(p.endMs), timeZone: p.timeZone, cut: programme ? 'programme' : 'hour' },
    media: { start: iso(f.mediaStartMs), end: iso(f.mediaEndMs), runs: f.runs, segments: f.segments, joined: 'without re-encoding, at segment boundaries' },
    madeAt: new Date().toISOString(),
  };
}

async function handleRecording(ctx: JobContext): Promise<Record<string, unknown>> {
  const p = ctx.job.payload as unknown as RecordingPayload;
  if (!p?.streamId || !Number.isFinite(p.startMs) || !Number.isFinite(p.endMs) || !p.fileName) throw new PermanentError('archive.recording payload is incomplete', 'bad_payload');
  const { hasLicence } = await import('../sites/licences');
  if (!(await hasLicence(p.accountId, 'mirror_archive'))) throw new PermanentError('The account no longer holds Mirror and Archive', 'licence_required');

  await ctx.progress(5, 'joining the recording');
  const dir = join(buildDir(), `${p.streamId}-${p.startMs}`);
  mkdirSync(dir, { recursive: true });
  const file = await joinPiece(p.streamId, p.startMs, p.endMs, join(dir, p.fileName));
  const programme = p.programmeId ? await one<any>(`SELECT * FROM programmes WHERE id = $1`, [p.programmeId]) : null;
  const sideName = p.fileName.replace(/\.[a-z0-9]+$/, '') + '.json';
  const sidePath = join(dir, sideName);
  writeFileSync(sidePath, JSON.stringify(sidecarFor(p, file, programme), null, 2) + '\n');
  const side = { bytes: statSync(sidePath).size, sha256: await sha256File(sidePath) };

  await ctx.progress(80, 'handing it to the storage targets');
  const runAfter = offPeakStart(new Date(), p.offPeak);
  const queued: string[] = [], skipped: { targetId: string; why: string }[] = [];
  for (const targetId of p.targetIds ?? []) {
    try {
      const t = await ownedTarget(p.accountId, targetId);
      if (t.status !== 'active' || t.site_status !== 'active') { skipped.push({ targetId, why: t.status !== 'active' ? 'target_disabled' : 'site_disabled' }); continue; }
      for (const [what, name, path, facts] of [
        ['recording', p.fileName, file.path, { bytes: file.bytes, sha256: file.sha256 }],
        ['recording-sidecar', sideName, sidePath, side],
      ] as const) {
        const row = await one<any>(
          `INSERT INTO archive_copies (account_id, target_id, stream_id, range_start, range_end, title, what, source_uri, file_name, expected_sha256)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           ON CONFLICT (target_id, stream_id, what, range_start) WHERE stream_id IS NOT NULL DO UPDATE
             SET source_uri = EXCLUDED.source_uri, file_name = EXCLUDED.file_name, expected_sha256 = EXCLUDED.expected_sha256,
                 range_end = EXCLUDED.range_end, title = EXCLUDED.title, state = 'queued', stored_path = NULL, sha256 = NULL, bytes = NULL,
                 error = NULL, error_code = NULL, copied_at = NULL, verified_at = NULL, checked_at = NULL, verify_job_id = NULL, updated_at = now()
             WHERE archive_copies.state <> 'verified'
           RETURNING id`,
          [p.accountId, t.id, p.streamId, new Date(p.startMs), new Date(p.endMs), p.title, what, path, name, facts.sha256]);
        if (!row) { skipped.push({ targetId, why: 'already_copied' }); continue; }
        await queueCopyJob(t, row.id, { fileName: name, uri: path, bytes: facts.bytes, sha256: facts.sha256 }, null, runAfter);
        queued.push(row.id);
      }
    } catch (e: any) {
      skipped.push({ targetId, why: e?.code ?? e?.message ?? 'error' });
    }
  }
  // Nothing to fetch it: the file is not kept.
  if (!queued.length) rmSync(dir, { recursive: true, force: true });
  console.log(`[archive] recording ${p.fileName}: ${file.segments} segment(s), ${file.bytes} bytes, ${queued.length} copy job(s)${runAfter ? ` from ${runAfter.toISOString()}` : ''}`);
  return { fileName: p.fileName, bytes: file.bytes, sha256: file.sha256, durationMs: file.durationMs, segments: file.segments, runs: file.runs, queued, skipped };
}

/**
 * The cloud's file is removed once every copy made from it is verified. Only
 * files under the build folder: an asset's original is never touched.
 */
export async function releaseBuilt(uri: string | null | undefined): Promise<boolean> {
  if (!uri) return false;
  const root = buildDir();
  const abs = resolve(uri);
  if (!abs.startsWith(root + '/')) return false;
  const open = await one(`SELECT 1 FROM archive_copies WHERE source_uri = $1 AND state <> 'verified' LIMIT 1`, [uri]);
  if (open) return false;
  try { unlinkSync(abs); } catch { return false; }
  try { const d = dirname(abs); if (d !== root && existsSync(d) && !readdirSync(d).length) rmdirSync(d); } catch { /* another file still there */ }
  return true;
}

export function registerArchiveRecordingHandlers(): void {
  registerHandler(ARCHIVE_RECORDING, handleRecording);
}
/** For the check suite: run the job body without a worker. */
export const runRecordingJob = handleRecording;
