// ============================================================================
//  JOB HANDLERS — reframe.analyse and reframe.render (volt/REFRAME.md)
//
//  reframe.analyse  runs volt-encoder/bin/reframe_analyse.py over the asset's
//                   picture once, keeps the track store as a sidecar, and plans
//                   a framing path for every format the account makes. A path a
//                   person has edited is kept as it is: re-analysis never
//                   throws away someone's work.
//  reframe.render   encodes one format from its path (services/reframe/render.ts).
//
//  Both cores are exported (analyseAsset, renderFormat) so a social publish can
//  run them inline when a platform needs a format that is not made yet.
// ============================================================================
import { spawn } from 'node:child_process';
import { mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../../../config';
import { enqueue } from '../queue';
import { PermanentError, registerHandler, type JobContext } from '../worker';
import { FORMAT_KEYS, isFormatKey, type FormatKey } from '../../reframe/formats';
import { planPath, type FramingPath } from '../../reframe/framing';
import { buildRenderArgs, runRender } from '../../reframe/render';
import {
  assetWithAccount, formatRow, formatRows, isAudioOnlyAsset, readTrackStore, reframeDir, reframeKey, saveTracks,
  setRender, setTracksState, settingsFor, summarise, tracksRow, videoSourceFor, writePath,
} from '../../reframe/store';

export const REFRAME_ANALYSE = 'reframe.analyse';
export const REFRAME_RENDER = 'reframe.render';

export class ReframeError extends Error {
  constructor(message: string, public code = 'reframe') { super(message); this.name = 'ReframeError'; }
}

const script = () => join(config.testStream.encoderBin, 'reframe_analyse.py');

/** Run the analysis script; resolve with its JSON summary line. */
function runAnalysis(jobPath: string, onProgress: (pct: number, note: string) => void, isCancelled: () => boolean): Promise<any> {
  return new Promise((resolve) => {
    const p = spawn(config.testStream.pythonBin, [script(), jobPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setInterval(() => { if (isCancelled()) p.kill('SIGTERM'); }, 1000);
    p.stdout.on('data', (b) => { out += String(b); });
    p.stderr.on('data', (b) => {
      const s = String(b); err = (err + s).slice(-4000);
      for (const m of s.matchAll(/PROGRESS (\d+) ?(.*)/g)) onProgress(Number(m[1]), m[2] ?? '');
    });
    p.on('error', (e) => { clearInterval(timer); resolve({ ok: false, error: `the analysis could not start: ${e.message}` }); });
    p.on('close', (code) => {
      clearInterval(timer);
      const line = out.trim().split('\n').reverse().find((l) => l.trim().startsWith('{'));
      let j: any = null; try { j = line ? JSON.parse(line) : null; } catch { /* below */ }
      resolve(j ?? { ok: false, error: (err.trim().split('\n').slice(-2).join(' ') || `the analysis exited ${code}`).slice(0, 400) });
    });
  });
}

/**
 * Analyse an asset and (re)plan its formats. Throws ReframeError with a reason
 * an operator can act on.
 */
export async function analyseAsset(assetId: string, onProgress: (pct: number, note: string) => void = () => {},
  isCancelled: () => boolean = () => false): Promise<{ shots: number; subjects: number; formats: FormatKey[] }> {
  const a = await assetWithAccount(assetId);
  if (!a) throw new ReframeError('The asset no longer exists.', 'gone');
  if (isAudioOnlyAsset(a)) throw new ReframeError('This asset is sound only, so there is no picture to frame.', 'audio_only');
  const src = videoSourceFor(a);
  if (!src) throw new ReframeError('This asset has no media on this server yet (it is still being built, or it failed).', 'no_media');
  const dir = reframeDir(assetId);
  mkdirSync(dir, { recursive: true });
  const out = join(dir, 'tracks.json');
  const jobPath = join(dir, 'analyse.job.json');
  writeFileSync(jobPath, JSON.stringify({ input: src, out, sample_fps: 5, width: 640 }));
  await setTracksState(assetId, 'running');
  const r = await runAnalysis(jobPath, (pct, note) => onProgress(Math.round(pct * 0.9), note || 'analysing'), isCancelled);
  rmSync(jobPath, { force: true });
  if (!r?.ok) {
    const msg = `The analysis failed: ${r?.error ?? 'no reason given'}`;
    await setTracksState(assetId, 'failed', { error: msg });
    throw new ReframeError(msg, 'analysis_failed');
  }
  const key = reframeKey(assetId, 'tracks.json');
  const row0 = { tracks_key: key } as any;
  const store = readTrackStore(row0);
  if (!store) { await setTracksState(assetId, 'failed', { error: 'The analysis wrote no track store.' }); throw new ReframeError('The analysis wrote no track store.'); }
  await saveTracks(assetId, key, summarise(store));
  onProgress(93, 'planning the framing');
  const planned = await planFormats(assetId, a.owner_account);
  onProgress(100, 'done');
  return { shots: store.shots.length, subjects: store.subjects.length, formats: planned };
}

/** Plan (or re-plan) every enabled format that a person has not edited. */
export async function planFormats(assetId: string, accountId: string | null): Promise<FormatKey[]> {
  const settings = await settingsFor(accountId);
  const store = readTrackStore(await tracksRow(assetId));
  if (!store) return [];
  const done: FormatKey[] = [];
  for (const f of FORMAT_KEYS) {
    const prev = await formatRow(assetId, f);
    if (!settings.formats[f] && !prev) continue;
    if (prev?.edited) { done.push(f); continue; }
    const path = planPath({ store, format: f, settings, overrides: prev?.overrides ?? {} });
    const auto = !settings.requireApproval
      ? { by: 'Volt (approval not required)' }
      : settings.autoApproveAbove != null && path.confidence >= settings.autoApproveAbove ? { by: `Volt (confidence ${path.confidence.toFixed(2)})` } : null;
    await writePath(assetId, f, path, { overrides: prev?.overrides ?? {}, edited: false, approve: auto });
    done.push(f);
  }
  return done;
}

/** Encode one format to an MP4 beside the asset. */
export async function renderFormat(assetId: string, format: FormatKey, onProgress: (pct: number) => void = () => {},
  isCancelled: () => boolean = () => false): Promise<{ key: string; path: string; bytes: number; seconds: number }> {
  const a = await assetWithAccount(assetId);
  if (!a) throw new ReframeError('The asset no longer exists.', 'gone');
  const row = await formatRow(assetId, format);
  const path = row?.path as FramingPath | undefined;
  if (!row || !path?.keys) throw new ReframeError(`There is no ${format.replace('x', ':')} framing for this asset yet. Analyse it first.`, 'no_path');
  const tr = await tracksRow(assetId);
  const srcInfo = tr?.summary?.source;
  const src = videoSourceFor(a);
  if (!src || !srcInfo?.width) throw new ReframeError('This asset has no media on this server to render from.', 'no_media');
  const dir = reframeDir(assetId);
  mkdirSync(dir, { recursive: true });
  const final = join(dir, `${format}.mp4`), tmp = join(dir, `${format}.part.mp4`);
  const cmd = buildRenderArgs({ input: src, output: tmp, format, keys: path.keys, srcW: srcInfo.width, srcH: srcInfo.height,
    duration: Number(srcInfo.durationSec) || 0, ffmpegBin: config.clips.ffmpegBin });
  await setRender(assetId, format, 'rendering');
  const t0 = Date.now();
  const r = await runRender(cmd, Number(srcInfo.durationSec) || 0, onProgress, isCancelled);
  if (!r.ok) {
    rmSync(tmp, { force: true });
    await setRender(assetId, format, 'failed', { error: r.error });
    throw new ReframeError(`The ${format.replace('x', ':')} render failed: ${r.error}`, 'render_failed');
  }
  renameSync(tmp, final);
  const bytes = statSync(final).size;
  const seconds = Math.round((Date.now() - t0) / 100) / 10;
  const key = reframeKey(assetId, `${format}.mp4`);
  await setRender(assetId, format, 'ready', { key, width: cmd.out.w, height: cmd.out.h, bytes, seconds });
  return { key, path: final, bytes, seconds };
}

// ---------------------------------------------------------------- queueing
/**
 * Queue an analysis. Without `force` it runs only when the account analyses
 * automatically and the asset has a picture; that is the call made after every
 * clip and encode.
 */
export async function queueReframeAnalysis(assetId: string, o: { force?: boolean; createdBy?: string | null } = {}): Promise<string | null> {
  try {
    const a = await assetWithAccount(assetId);
    if (!a) return null;
    if (!o.force) {
      if (isAudioOnlyAsset(a)) return null;
      if (!(await settingsFor(a.owner_account)).autoAnalyse) return null;
    }
    const job = await enqueue({ type: REFRAME_ANALYSE, payload: { vodAssetId: assetId }, channelId: a.channel_id ?? undefined,
      eventId: a.event_id ?? undefined, dedupeKey: `reframe.analyse:${assetId}`, priority: 70, maxAttempts: 2, createdBy: o.createdBy ?? null });
    await setTracksState(assetId, 'queued', { jobId: job.id });
    return job.id;
  } catch (e) {
    console.error(`[reframe] ${assetId}: analysis not queued:`, e);
    return null;
  }
}

export async function queueReframeRender(assetId: string, format: FormatKey, createdBy?: string | null): Promise<string> {
  const a = await assetWithAccount(assetId);
  const job = await enqueue({ type: REFRAME_RENDER, payload: { vodAssetId: assetId, format }, channelId: a?.channel_id ?? undefined,
    eventId: a?.event_id ?? undefined, dedupeKey: `reframe.render:${assetId}:${format}`, priority: 80, maxAttempts: 2, createdBy: createdBy ?? null });
  await setRender(assetId, format, 'queued');
  return job.id;
}

// ---------------------------------------------------------------- handlers
async function handleAnalyse(ctx: JobContext): Promise<Record<string, unknown>> {
  const id = String((ctx.job.payload as any)?.vodAssetId ?? '');
  if (!id) throw new PermanentError('reframe.analyse needs vodAssetId', 'bad_payload');
  let last = 0;
  try {
    return await analyseAsset(id, (pct, note) => {
      if (pct >= last + 5 || pct === 100) { last = pct; void ctx.progress(pct, note); }
    }, ctx.isCancelled);
  } catch (e: any) {
    if (e instanceof ReframeError) throw new PermanentError(e.message, e.code);
    throw e;
  }
}

async function handleRender(ctx: JobContext): Promise<Record<string, unknown>> {
  const p = ctx.job.payload as any;
  const id = String(p?.vodAssetId ?? '');
  if (!id || !isFormatKey(p?.format)) throw new PermanentError('reframe.render needs vodAssetId and a format', 'bad_payload');
  let last = 0;
  try {
    const r = await renderFormat(id, p.format, (pct) => {
      if (pct >= last + 5) { last = pct; void ctx.progress(pct, `rendering ${String(p.format).replace('x', ':')}`); }
    }, ctx.isCancelled);
    return { key: r.key, bytes: r.bytes, seconds: r.seconds };
  } catch (e: any) {
    if (e instanceof ReframeError) throw new PermanentError(e.message, e.code);
    throw e;
  }
}

export function registerReframeHandlers(): void {
  registerHandler(REFRAME_ANALYSE, handleAnalyse);
  registerHandler(REFRAME_RENDER, handleRender);
}

/** The asset's formats with any render in flight, for the console. */
export async function renderJobs(assetId: string): Promise<Record<string, { state: string; pct: number; note: string | null }>> {
  const { query } = await import('../../../db');
  const rows = await query<any>(
    `SELECT DISTINCT ON (payload->>'format') payload->>'format' AS format, state, progress_pct, progress_note
       FROM jobs WHERE type = $1 AND payload->>'vodAssetId' = $2 ORDER BY payload->>'format', created_at DESC`, [REFRAME_RENDER, assetId]);
  return Object.fromEntries(rows.map((r) => [r.format, { state: r.state, pct: Number(r.progress_pct) || 0, note: r.progress_note }]));
}

export { formatRows };
