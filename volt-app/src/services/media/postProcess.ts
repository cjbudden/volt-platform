// ============================================================================
//  AFTER ENCODING: SUBTITLES AND AN AI DESCRIPTION (Christian, 12 Nov 2026).
//  Migration 0173. Guide: docs-site Media Library, "Subtitles and a
//  description made for you".
//
//  Two steps that can run on an asset once it has media:
//
//    subtitles  made from its audio, by Whisper on this server (the same
//               engine as live captions, volt-encoder/bin/vod_subtitles.py)
//               or by an external processing add-on (services/workflows),
//               and attached as companion caption files, so they play as
//               subtitle tracks and can be checked, edited or switched off
//               like a delivered SRT. A language the asset already has a
//               caption file for is not made again.
//    describe   a short description written by an AI model from the
//               subtitles (or the audio when there are none), ONLY when the
//               asset has no description from anything else. Counted against
//               the AI descriptions add-on (services/media/aiDescribe.ts).
//
//  WHO ASKS FOR THEM, in the ingest ladder (services/ingest/rules.ts):
//    account default (every file: "globally")  <  content type  <  source or
//    watch folder  <  the item. The ingest records the plan on the asset as
//    `waiting`, and the encode starts it when it finishes (vodEncode.ts).
//  A person can also ask on the asset's Files tab at any time
//  (POST /api/vod/:id/post-process), for an asset from any door: a recording's
//  clip, something ingested before this existed.
//
//  ORDER. Subtitles first, then the description, because the description is
//  best made from them. A failed or skipped subtitles step still lets the
//  description run (it then listens to the audio itself).
//
//  STATE lives in vod_assets.post_process, written one step at a time with a
//  jsonb merge so the two steps (and a person asking again) never overwrite
//  each other's part.
// ============================================================================
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { one, query } from '../../db';
import { config } from '../../config';
import { enqueue } from '../jobs/queue';
import { registerHandler, PermanentError, type JobContext } from '../jobs/worker';
import type { IngestSettings, IngestKey, Rung } from '../ingest/rules';

export const VOD_SUBTITLES = 'vod.subtitles';
export const VOD_DESCRIBE = 'vod.describe';

export type StepState = 'waiting' | 'queued' | 'running' | 'done' | 'skipped' | 'failed' | 'used_up' | 'off';
export type SubtitleEngine = 'off' | 'whisper' | 'addon';
export const MODEL_SIZES = ['tiny', 'base', 'small', 'medium', 'large-v3'] as const;

export interface Plan {
  subtitles: SubtitleEngine;
  addonId: string | null;
  /** 'auto' or the language spoken. */
  spoken: string;
  /** More languages to make besides the spoken one. */
  languages: string[];
  model: string;
  describe: 'off' | 'ai';
  /** Manual only: write the description even when the asset has one. */
  replace?: boolean;
  /** Who asked: 'ingest rules' or a person's name. */
  by: string;
  /** For an ingest: which rung chose each part (account, type, source, item). */
  from?: Partial<Record<'subtitles' | 'describe', string>>;
}

export interface Step { state: StepState; message?: string | null; at?: string; [k: string]: unknown }
export interface PostProcess { plan: Plan; subtitles?: Step; describe?: Step }

const LANG = /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/;
const now = () => new Date().toISOString();

// ---- pure ------------------------------------------------------------------------------------

/** The plan an ingest's resolved settings ask for; null when they ask for nothing. Pure. */
export function planFromSettings(s: Partial<IngestSettings>, sources?: Partial<Record<IngestKey, Rung>>): Plan | null {
  const subtitles = (s.subtitles ?? 'off') as SubtitleEngine;
  const describe = s.describe === 'ai' ? 'ai' : 'off';
  const engine: SubtitleEngine = subtitles === 'addon' && !s.subtitleAddonId ? 'off' : subtitles;
  if (engine === 'off' && describe === 'off') return null;
  return {
    subtitles: engine,
    addonId: engine === 'addon' ? s.subtitleAddonId ?? null : null,
    spoken: s.subtitleSpoken && (s.subtitleSpoken === 'auto' || LANG.test(s.subtitleSpoken)) ? s.subtitleSpoken : 'auto',
    languages: [...new Set((s.subtitleLanguages ?? []).filter((l) => LANG.test(l)))].slice(0, 10),
    model: (MODEL_SIZES as readonly string[]).includes(String(s.subtitleModel)) ? String(s.subtitleModel) : 'base',
    describe,
    by: 'ingest rules',
    from: sources ? { subtitles: sources.subtitles, describe: sources.describe } : undefined,
  };
}

/** What a new plan starts as: each step asked for waits for media; the rest are not there. Pure. */
export function initialState(plan: Plan, hasMedia: boolean): PostProcess {
  const first: StepState = hasMedia ? 'queued' : 'waiting';
  return {
    plan,
    ...(plan.subtitles !== 'off' ? { subtitles: { state: first, engine: plan.subtitles, at: now() } } : {}),
    ...(plan.describe === 'ai' ? { describe: { state: plan.subtitles !== 'off' ? 'waiting' : first, at: now() } } : {}),
  };
}

/**
 * Which languages still need making, given the caption files the asset has.
 * With the spoken language unknown ('auto'), any caption file is taken to be
 * the spoken one: a delivered SRT means the audio needs no subtitles from us.
 * Pure.
 */
export function languagesToMake(plan: Pick<Plan, 'spoken' | 'languages'>, have: string[]): { spoken: boolean; extra: string[] } {
  const base = (l: string) => l.toLowerCase().split('-')[0];
  const has = new Set(have.filter(Boolean).map(base));
  const spoken = plan.spoken === 'auto' ? has.size === 0 : !has.has(base(plan.spoken));
  return { spoken, extra: plan.languages.filter((l) => !has.has(base(l)) && l !== plan.spoken) };
}

export interface ReturnedCaption { language: string | null; label: string | null; format: 'vtt' | 'srt' | 'ttml' | null; content?: string; url?: string }

/**
 * Caption files an add-on returned in its result, in the documented shape:
 *   { captions: [{ language, label?, format?, content? | url? }] }
 * (`subtitles` is taken as the same). Bad entries are reported, not thrown.
 * Pure.
 */
export function captionsFromResult(result: any): { items: ReturnedCaption[]; problems: string[] } {
  const list = Array.isArray(result?.captions) ? result.captions : Array.isArray(result?.subtitles) ? result.subtitles : [];
  const items: ReturnedCaption[] = [], problems: string[] = [];
  list.slice(0, 20).forEach((c: any, i: number) => {
    const language = typeof c?.language === 'string' && LANG.test(c.language.trim()) ? c.language.trim() : null;
    const format = ['vtt', 'webvtt', 'srt', 'ttml', 'dfxp'].includes(String(c?.format ?? '').toLowerCase())
      ? (({ webvtt: 'vtt', dfxp: 'ttml' } as any)[String(c.format).toLowerCase()] ?? String(c.format).toLowerCase()) : null;
    const content = typeof c?.content === 'string' && c.content.trim() ? c.content : undefined;
    const url = typeof c?.url === 'string' && /^https:\/\/\S+$/i.test(c.url) ? c.url : undefined;
    if (!content && !url) { problems.push(`caption ${i + 1}: no content and no https url`); return; }
    items.push({ language, label: typeof c?.label === 'string' ? c.label.trim().slice(0, 80) || null : null, format: format as any, content, url });
  });
  if (!list.length) problems.push('the add-on returned no captions');
  return { items, problems };
}

// ---- state -----------------------------------------------------------------------------------

/** Merge into one step's state (and the plan, when given) without touching the other step. */
export async function setStep(assetId: string, step: 'subtitles' | 'describe', patch: Partial<Step>): Promise<void> {
  await query(
    `UPDATE vod_assets SET post_process = jsonb_set(COALESCE(post_process, '{}'::jsonb), ARRAY[$2::text],
            COALESCE(post_process->$2, '{}'::jsonb) || $3::jsonb, true), updated_at = now() WHERE id = $1`,
    [assetId, step, JSON.stringify({ ...patch, at: now() })]);
}

export async function postProcessOf(assetId: string): Promise<PostProcess | null> {
  return (await one<any>(`SELECT post_process FROM vod_assets WHERE id = $1`, [assetId]))?.post_process ?? null;
}

// ---- the asset and its media -----------------------------------------------------------------

async function assetRow(assetId: string) {
  return one<any>(
    `SELECT v.*, COALESCE(g.account_id, v.account_id) AS owner_account
       FROM vod_assets v LEFT JOIN channels c ON c.id = v.channel_id LEFT JOIN events e ON e.id = v.event_id
       LEFT JOIN groups g ON g.id = COALESCE(c.group_id, e.group_id) WHERE v.id = $1`, [assetId]);
}

/**
 * The asset's media for ffmpeg to read the sound from: the original when it
 * is kept, the progressive MP4, an audio or MP4 export, the HLS master on
 * this server, last a master on the CDN. Null when there is none yet.
 */
export async function mediaInput(a: any): Promise<string | null> {
  const { localPath, videoSourceFor } = await import('../reframe/store');
  const tests = [localPath(a.source_key), videoSourceFor(a), localPath(a.export_m4a_key), localPath(a.export_mp3_key)];
  const found = tests.find(Boolean);
  if (found) return found;
  for (const k of [a.progressive_key, a.master_key]) if (typeof k === 'string' && /^https?:\/\//i.test(k)) return k;
  return null;
}

// ---- Whisper on this server --------------------------------------------------------------------

const script = () => join(config.testStream.encoderBin, 'vod_subtitles.py');
let ready: { at: number; whisper: boolean; mt: boolean } | null = null;

/** Whether this server's Python can run Whisper (and NLLB for other languages). Asked once every 10 minutes. */
export async function whisperStatus(): Promise<{ whisper: boolean; mt: boolean }> {
  if (process.env.VOLT_SUBTITLES_FIXTURE) return { whisper: true, mt: false };
  if (ready && Date.now() - ready.at < 600_000) return { whisper: ready.whisper, mt: ready.mt };
  const dir = join(config.clips.dir, 'subs-work');
  const out = await new Promise<any>((resolve) => {
    try {
      mkdirSync(dir, { recursive: true });
      const job = join(dir, 'check.json'); writeFileSync(job, '{"check":true}');
      const p = spawn(config.testStream.pythonBin, [script(), job], { stdio: ['ignore', 'pipe', 'ignore'] });
      let s = ''; p.stdout.on('data', (b) => { s += String(b); });
      const t = setTimeout(() => p.kill('SIGKILL'), 20_000);
      p.on('error', () => { clearTimeout(t); resolve(null); });
      p.on('close', () => { clearTimeout(t); try { resolve(JSON.parse(s.trim().split('\n').pop() ?? '')); } catch { resolve(null); } });
    } catch { resolve(null); }
  });
  ready = { at: Date.now(), whisper: !!out?.whisper, mt: !!out?.mt };
  return { whisper: ready.whisper, mt: ready.mt };
}
export function resetWhisperStatus() { ready = null; }

function runScript(jobPath: string, onProgress: (pct: number, note: string) => void, isCancelled: () => boolean): Promise<any> {
  return new Promise((resolve) => {
    const p = spawn(config.testStream.pythonBin, [script(), jobPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setInterval(() => { if (isCancelled()) p.kill('SIGTERM'); }, 1000);
    p.stdout.on('data', (b) => { out += String(b); });
    p.stderr.on('data', (b) => {
      const s = String(b); err = (err + s).slice(-4000);
      for (const m of s.matchAll(/PROGRESS (\d+) ?([^\n]*)/g)) onProgress(Number(m[1]), m[2] ?? '');
    });
    p.on('error', (e) => { clearInterval(timer); resolve({ ok: false, error: `Whisper could not start: ${e.message}` }); });
    p.on('close', (code) => {
      clearInterval(timer);
      const line = out.trim().split('\n').reverse().find((l) => l.trim().startsWith('{'));
      let j: any = null; try { j = line ? JSON.parse(line) : null; } catch { /* below */ }
      resolve(j ?? { ok: false, error: (err.trim().split('\n').filter((l) => !l.startsWith('PROGRESS')).slice(-2).join(' ') || `Whisper exited ${code}`).slice(0, 400) });
    });
  });
}

/** Keep the job's lease while a long transcription runs: the script's own progress is coarse. */
function heartbeat(ctx: JobContext, note: () => string) {
  let pct = 5;
  const t = setInterval(() => { ctx.progress(pct, note()).catch(() => {}); }, 30_000);
  return { set: (p: number) => { pct = p; }, stop: () => clearInterval(t) };
}

/** Run Whisper over the asset's audio. transcriptOnly: the text, no files (for a description). */
export async function transcribe(a: any, o: { spoken: string; targets: string[]; model: string; transcriptOnly?: boolean },
  ctx: JobContext): Promise<any> {
  const input = await mediaInput(a);
  if (!input) return { ok: false, code: 'no_media', error: 'This asset has no media on this server yet to listen to.' };
  const dir = join(config.clips.dir, 'subs-work', `${a.id}-${Date.now().toString(36)}`);
  mkdirSync(dir, { recursive: true });
  const jobPath = join(dir, 'job.json');
  writeFileSync(jobPath, JSON.stringify({
    input, out_dir: dir, spoken: o.spoken, targets: o.targets, model: o.model, transcript_only: !!o.transcriptOnly,
    ffmpeg: config.clips.ffmpegBin, ...(process.env.VOLT_SUBTITLES_FIXTURE ? { offline_fixture: process.env.VOLT_SUBTITLES_FIXTURE } : {}),
  }));
  let note = 'listening';
  const hb = heartbeat(ctx, () => note);
  try {
    const r = await runScript(jobPath, (pct, n) => { note = n || note; hb.set(pct); ctx.progress(pct, note).catch(() => {}); }, ctx.isCancelled);
    if (r?.ok) for (const [lang, v] of Object.entries<any>(r.languages ?? {})) {
      try { v.text = readFileSync(v.file, 'utf8'); } catch { v.text = null; }
      v.lang = lang;
    }
    return r;
  } finally {
    hb.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- starting --------------------------------------------------------------------------------

async function queueSubtitles(assetId: string, accountId: string, plan: Plan, hook: string) {
  if (plan.subtitles === 'addon') {
    const { createRun } = await import('../workflows/runs');
    const { resolveSubject } = await import('../workflows/subjects');
    const subject = await resolveSubject('vod_asset', assetId);
    if (!subject) throw new Error('the asset no longer exists');
    try {
      const run = await createRun({
        accountId, addonId: String(plan.addonId), hook, subject, createdBy: plan.by,
        options: { purpose: 'subtitles', spoken: plan.spoken, languages: plan.languages, wants: 'captions' },
      });
      await setStep(assetId, 'subtitles', { state: 'running', engine: 'addon', runId: run.id, addonId: plan.addonId, message: 'Sent to the add-on' });
    } catch (e: any) {
      await setStep(assetId, 'subtitles', { state: 'failed', engine: 'addon', message: `The add-on could not be asked: ${String(e?.message ?? e).slice(0, 300)}` });
      await afterSubtitles(assetId);
    }
    return;
  }
  const job = await enqueue({ type: VOD_SUBTITLES, payload: { vodAssetId: assetId }, dedupeKey: `${VOD_SUBTITLES}:${assetId}`, maxAttempts: 2, priority: 120 });
  await setStep(assetId, 'subtitles', { state: 'queued', engine: 'whisper', jobId: job.id, message: null });
}

async function queueDescribe(assetId: string) {
  const job = await enqueue({ type: VOD_DESCRIBE, payload: { vodAssetId: assetId }, dedupeKey: `${VOD_DESCRIBE}:${assetId}`, maxAttempts: 3, priority: 130 });
  await setStep(assetId, 'describe', { state: 'queued', jobId: job.id, message: null });
}

/** Start whatever is waiting. Called when an encode finishes; never throws. */
export async function startPostProcess(assetId: string, hook = 'vod.encoded'): Promise<{ started: string[] }> {
  try {
    const a = await assetRow(assetId);
    const pp: PostProcess | null = a?.post_process ?? null;
    if (!a || !pp?.plan) return { started: [] };
    const acct = String(a.owner_account);
    const started: string[] = [];
    const subs = pp.subtitles?.state;
    if (pp.plan.subtitles !== 'off' && (subs === 'waiting' || subs === 'queued' && !pp.subtitles?.jobId)) {
      await queueSubtitles(assetId, acct, pp.plan, hook); started.push('subtitles');
    } else if (pp.plan.describe === 'ai' && (pp.describe?.state === 'waiting' || pp.describe?.state === 'queued' && !pp.describe?.jobId)
      && !['waiting', 'queued', 'running'].includes(String(subs))) {
      await queueDescribe(assetId); started.push('describe');
    }
    return { started };
  } catch (e) {
    console.warn('[post-process] could not start', assetId, e);
    return { started: [] };
  }
}

/** After subtitles end, however they ended: the description, when one is waiting. */
async function afterSubtitles(assetId: string) {
  const pp = await postProcessOf(assetId);
  if (pp?.plan?.describe === 'ai' && pp.describe?.state === 'waiting') await queueDescribe(assetId);
}

/**
 * A person asks (the asset's Files tab, or the API). Replaces the plan; a step
 * already queued or running is left to finish rather than run twice.
 */
export async function requestPostProcess(assetId: string, plan: Plan): Promise<PostProcess> {
  const a = await assetRow(assetId);
  if (!a) throw Object.assign(new Error('VOD asset not found'), { status: 404 });
  const cur: PostProcess | null = a.post_process ?? null;
  const busy = (s?: Step) => !!s && ['queued', 'running'].includes(s.state);
  if ((plan.subtitles !== 'off' && busy(cur?.subtitles)) || (plan.describe === 'ai' && busy(cur?.describe))) {
    throw Object.assign(new Error('That is already being made for this asset. Wait for it to finish.'), { status: 409 });
  }
  const hasMedia = !!(await mediaInput(a));
  const fresh = initialState(plan, hasMedia);
  // A step not asked for this time keeps what it had.
  const next: PostProcess = { plan, subtitles: fresh.subtitles ?? cur?.subtitles, describe: fresh.describe ?? cur?.describe };
  await query(`UPDATE vod_assets SET post_process = $2::jsonb, updated_at = now() WHERE id = $1`, [assetId, JSON.stringify(next)]);
  if (hasMedia) {
    if (plan.subtitles !== 'off') await queueSubtitles(assetId, String(a.owner_account), plan, 'manual');
    else if (plan.describe === 'ai') await queueDescribe(assetId);
  }
  return (await postProcessOf(assetId))!;
}

// ---- the subtitles job -------------------------------------------------------------------------

async function captionLanguages(assetId: string): Promise<string[]> {
  const rows = await query<any>(`SELECT language FROM vod_asset_files WHERE asset_id = $1 AND kind = 'captions' AND COALESCE((report->>'ok')::boolean, false)`, [assetId]);
  return rows.map((r: any) => r.language).filter(Boolean);
}
async function hasAnyCaptions(assetId: string): Promise<boolean> {
  return !!(await one(`SELECT 1 FROM vod_asset_files WHERE asset_id = $1 AND kind = 'captions' AND COALESCE((report->>'ok')::boolean, false) LIMIT 1`, [assetId]));
}

const fileBase = (a: any) => String(a.title || a.original_filename || 'subtitles').replace(/\.[a-z0-9]{2,4}$/i, '').replace(/[^\w\- ]+/g, '_').trim().slice(0, 80) || 'subtitles';

export async function handleSubtitles(ctx: JobContext): Promise<Record<string, unknown>> {
  const { vodAssetId } = ctx.job.payload as { vodAssetId: string };
  const a = await assetRow(vodAssetId);
  if (!a) throw new PermanentError('the asset no longer exists', 'gone');
  const pp: PostProcess | null = a.post_process ?? null;
  const plan = pp?.plan;
  if (!plan || plan.subtitles !== 'whisper') return { skipped: 'not asked for' };
  const acct = String(a.owner_account);
  const finish = async (patch: Partial<Step>) => { await setStep(vodAssetId, 'subtitles', patch); await afterSubtitles(vodAssetId); };

  const have = await captionLanguages(vodAssetId);
  const need = languagesToMake(plan, have);
  if (!need.spoken && !need.extra.length) {
    await finish({ state: 'skipped', message: `It already has subtitles${have.length ? ` (${[...new Set(have)].join(', ')})` : ''}.` });
    return { skipped: 'has subtitles' };
  }
  const st = await whisperStatus();
  if (!st.whisper) {
    await finish({ state: 'failed', code: 'whisper_missing', message: 'Whisper is not installed on this server. Install faster-whisper for the encoder\'s Python, or use an external add-on.' });
    throw new PermanentError('whisper is not installed', 'whisper_missing');
  }
  await setStep(vodAssetId, 'subtitles', { state: 'running', engine: 'whisper', message: 'Listening' });
  const r = await transcribe(a, { spoken: plan.spoken, targets: need.extra, model: plan.model }, ctx);
  if (!r?.ok) {
    const last = r?.code === 'no_media' || r?.code === 'whisper_missing' || ctx.job.attempts >= ctx.job.max_attempts;
    const msg = String(r?.error ?? 'Whisper failed').slice(0, 400);
    if (last) { await finish({ state: 'failed', code: r?.code ?? 'whisper_failed', message: msg }); throw new PermanentError(msg, r?.code ?? 'whisper_failed'); }
    await setStep(vodAssetId, 'subtitles', { state: 'queued', message: `${msg} Trying again.` });
    throw new Error(msg);
  }
  const { addFile } = await import('../companions/store');
  const { languageName } = await import('../companions/formats');
  // Made in this run; a language that arrived meanwhile (a delivered file) is not doubled.
  const nowHave = new Set((await captionLanguages(vodAssetId)).map((l) => l.toLowerCase().split('-')[0]));
  const files: { id: string; language: string; cues: number }[] = [];
  const problems: string[] = [];
  for (const v of Object.values<any>(r.languages ?? {})) {
    if (!v.text || nowHave.has(String(v.lang).toLowerCase().split('-')[0])) continue;
    try {
      const out = await addFile(vodAssetId, acct, {
        name: `${fileBase(a)}.${v.lang}.vtt`, buf: Buffer.from(v.text, 'utf8'), contentType: 'text/vtt', kind: 'captions',
        language: v.lang, label: `${languageName(v.lang)} (generated)`, by: `Whisper ${plan.model}`, source: 'generated',
      });
      if (!out.duplicate) files.push({ id: out.file.id, language: v.lang, cues: Number(v.cues) || 0 });
    } catch (e: any) { problems.push(`${v.lang}: ${String(e?.message ?? e).slice(0, 200)}`); }
  }
  const unmet: string[] = Array.isArray(r.unmet) ? r.unmet : [];
  const said = [
    files.length ? `Made ${files.map((f) => languageName(f.language)).join(', ')}.` : 'No speech was heard, so no subtitles were made.',
    unmet.length ? `Not made here: ${unmet.join(', ')} (translation to these needs NLLB on this server, or an add-on).` : '',
    problems.length ? `Not attached: ${problems.join('; ')}.` : '',
  ].filter(Boolean).join(' ');
  await finish({ state: files.length ? 'done' : 'skipped', engine: 'whisper', language: r.language ?? null, files, unmet, message: said });
  if (files.length) {
    const { fireHook } = await import('../workflows/hooks');
    fireHook('subtitles.ready', 'vod_asset', vodAssetId, { engine: 'whisper', languages: files.map((f) => f.language) });
  }
  return { files: files.length, language: r.language ?? null, unmet };
}

// ---- the add-on's answer -----------------------------------------------------------------------

async function fetchCaption(url: string): Promise<Buffer> {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 30_000);
  try {
    const res = await fetch(url, { signal: ac.signal, redirect: 'follow' });
    if (!res.ok) throw new Error(`the add-on's link answered ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const { MAX_BYTES } = await import('../companions/store');
    if (buf.length > MAX_BYTES) throw new Error('the file is larger than 25 MB');
    return buf;
  } finally { clearTimeout(t); }
}

/** Called by applyUpdate (workflows/runs.ts) when an add-on run ends. Only runs asked for subtitles do anything. */
export async function onAddonRunFinished(run: any): Promise<void> {
  if (run?.options?.purpose !== 'subtitles' || run.subject_type !== 'vod_asset') return;
  const assetId = String(run.subject_id);
  const pp = await postProcessOf(assetId);
  if (pp?.subtitles?.runId && pp.subtitles.runId !== run.id) return;        // an older run: a newer one owns the step
  const finish = async (patch: Partial<Step>) => { await setStep(assetId, 'subtitles', { engine: 'addon', runId: run.id, ...patch }); await afterSubtitles(assetId); };
  if (run.state !== 'succeeded') {
    await finish({ state: 'failed', message: `The add-on ${run.state === 'timed_out' ? 'did not answer in time' : run.state === 'cancelled' ? 'run was cancelled' : `failed${run.error ? `: ${String(run.error).slice(0, 300)}` : ''}`}.` });
    return;
  }
  const { items, problems } = captionsFromResult(run.result);
  const { addFile } = await import('../companions/store');
  const { languageName } = await import('../companions/formats');
  const a = await assetRow(assetId);
  if (!a) return;
  const addon = await one<any>(`SELECT name FROM addon_services WHERE id = $1`, [run.addon_id]);
  const files: { id: string; language: string | null }[] = [];
  for (const [i, c] of items.entries()) {
    try {
      const buf = c.content != null ? Buffer.from(c.content, 'utf8') : await fetchCaption(c.url!);
      const ext = c.format ?? 'vtt';
      const out = await addFile(assetId, String(a.owner_account), {
        name: `${fileBase(a)}.${c.language ?? `track${i + 1}`}.${ext}`, buf, kind: 'captions', language: c.language,
        label: c.label ?? `${languageName(c.language)} (${addon?.name ?? 'add-on'})`, by: addon?.name ?? 'add-on', source: 'addon',
      });
      if (!out.duplicate) files.push({ id: out.file.id, language: out.file.language });
    } catch (e: any) { problems.push(`caption ${i + 1}: ${String(e?.message ?? e).slice(0, 200)}`); }
  }
  await finish({
    state: files.length ? 'done' : 'failed', files,
    message: [files.length ? `Attached ${files.length} caption file${files.length === 1 ? '' : 's'} from ${addon?.name ?? 'the add-on'}.` : 'Nothing usable came back from the add-on.', problems.length ? problems.join('; ') : ''].filter(Boolean).join(' '),
  });
  if (files.length) {
    const { fireHook } = await import('../workflows/hooks');
    fireHook('subtitles.ready', 'vod_asset', assetId, { engine: 'addon', addonId: run.addon_id, languages: files.map((f) => f.language) });
  }
}

// ---- the description job -----------------------------------------------------------------------

/** The text to describe from: the default (else first) usable caption file, else a transcript of the audio. */
async function sourceText(a: any, ctx: JobContext): Promise<{ text: string; source: 'captions' | 'audio'; fileId: string | null; language: string | null } | { error: string; code: string }> {
  const f = await one<any>(
    `SELECT id, language FROM vod_asset_files WHERE asset_id = $1 AND kind = 'captions' AND enabled AND NOT forced AND COALESCE((report->>'ok')::boolean, false)
      ORDER BY is_default DESC, (source = 'upload' OR source = 'watchfolder') DESC, created_at LIMIT 1`, [a.id]);
  if (f) {
    const { fileContent } = await import('../companions/store');
    const { parseCaptions } = await import('../companions/formats');
    const { cuesToText } = await import('./aiDescribe');
    const c = await fileContent(a.id, String(a.owner_account), f.id, true);
    return { text: cuesToText(parseCaptions('vtt', c.buf.toString('utf8'))), source: 'captions', fileId: f.id, language: f.language ?? null };
  }
  const st = await whisperStatus();
  if (!st.whisper) return { code: 'no_text', error: 'It has no subtitles, and Whisper is not installed on this server to listen to the audio. Add a caption file, or turn on subtitles from an add-on.' };
  const pp: PostProcess | null = a.post_process ?? null;
  const r = await transcribe(a, { spoken: pp?.plan?.spoken ?? 'auto', targets: [], model: pp?.plan?.model ?? 'base', transcriptOnly: true }, ctx);
  if (!r?.ok) return { code: r?.code ?? 'whisper_failed', error: String(r?.error ?? 'Listening to the audio failed') };
  return { text: String(r.transcript ?? ''), source: 'audio', fileId: null, language: r.language ?? null };
}

export async function handleDescribe(ctx: JobContext): Promise<Record<string, unknown>> {
  const { vodAssetId } = ctx.job.payload as { vodAssetId: string };
  const a = await assetRow(vodAssetId);
  if (!a) throw new PermanentError('the asset no longer exists', 'gone');
  const pp: PostProcess | null = a.post_process ?? null;
  if (pp?.plan?.describe !== 'ai') return { skipped: 'not asked for' };
  const acct = String(a.owner_account);
  const step = (patch: Partial<Step>) => setStep(vodAssetId, 'describe', patch);
  const ai = await import('./aiDescribe');
  const { aiConfigured, AiUnavailable } = await import('./aiDetails');
  const addons = await import('../invoicing/addons');

  // Where it goes, and whether it is wanted at all.
  if (!a.schema_id) { await step({ state: 'skipped', message: 'Choose a content type first: the description goes into its description field.' }); return { skipped: 'no type' }; }
  const { resolveEffectiveFields } = await import('../../modules/metadataSchemas');
  const fields = (await resolveEffectiveFields(a.schema_id, acct).catch(() => null))?.fields ?? [];
  const key = ai.descriptionField(fields as any);
  if (!key) { await step({ state: 'skipped', message: 'Its content type has no description field.' }); return { skipped: 'no field' }; }
  if (ai.hasValue(a.metadata?.[key]) && !pp.plan.replace) {
    await step({ state: 'skipped', field: key, message: 'It already has a description, so none was written.' });
    return { skipped: 'has a description' };
  }
  if (!aiConfigured()) { await step({ state: 'off', message: 'AI descriptions is not available on this deployment.' }); return { skipped: 'not offered' }; }
  const left = await addons.allowanceLeft(acct, ai.DESCRIBE_ADDON);
  if (left === null) { await step({ state: 'off', message: 'AI descriptions is an add-on: an account administrator can turn it on in Admin, Billing.' }); return { skipped: 'add-on off' }; }
  if (left < 1) { await step({ state: 'used_up', message: 'This month\'s AI descriptions are used up. A bigger pack adds more; otherwise ask again after the 1st.' }); return { skipped: 'used up' }; }

  await step({ state: 'running', message: 'Reading what is said' });
  const src = await sourceText(a, ctx);
  if ('error' in src) {
    const last = src.code === 'no_text' || src.code === 'no_media' || ctx.job.attempts >= ctx.job.max_attempts;
    if (last) { await step({ state: 'failed', message: src.error }); throw new PermanentError(src.error, src.code); }
    await step({ state: 'queued', message: `${src.error} Trying again.` }); throw new Error(src.error);
  }
  if (src.text.trim().length < ai.MIN_TRANSCRIPT) {
    await step({ state: 'skipped', source: src.source, message: 'Too little is said in it to describe (music, or a short clip).' });
    return { skipped: 'too little speech' };
  }

  // Counted before the call, so nothing is sent once the month is used up; given back if the call fails.
  try { await addons.useAllowance(acct, ai.DESCRIBE_ADDON, 1); }
  catch (e) {
    if (e instanceof addons.AllowanceExceeded) { await step({ state: 'used_up', message: 'This month\'s AI descriptions are used up. A bigger pack adds more; otherwise ask again after the 1st.' }); return { skipped: 'used up' }; }
    throw e;
  }
  const text = ai.sampleTranscript(src.text);
  const hash = createHash('sha256').update(text).digest('hex');
  const known: Record<string, string> = {};
  for (const f of fields as any[]) {
    const v = a.metadata?.[f.key];
    if (f.key !== key && ['string', 'enum', 'number', 'tags'].includes(f.type) && ai.hasValue(v)) known[f.label ?? f.key] = Array.isArray(v) ? v.join(', ') : String(v);
  }
  const typeName = (await one<any>(`SELECT name FROM metadata_schemas WHERE id = $1`, [a.schema_id]))?.name ?? null;
  const req = ai.buildDescribeRequest({ transcript: text, title: a.title ?? null, typeName, language: src.language, known });
  const record = (o: { status: 'ok' | 'failed'; counted: boolean; model: string; ans?: any; description?: string | null; error?: string }) =>
    one<any>(`INSERT INTO ai_descriptions(account_id, vod_asset_id, field, source, source_file_id, text_hash, model, status, counted, input_tokens, output_tokens, cost_usd, description, error, created_by)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
      [acct, vodAssetId, key, src.source, src.fileId, hash, o.model, o.status, o.counted, o.ans?.inputTokens ?? null, o.ans?.outputTokens ?? null,
        o.ans?.cost ?? null, o.description ?? null, o.error ?? null, pp.plan.by]);
  let ans: Awaited<ReturnType<typeof ai.askDescribe>>;
  try { ans = await ai.askDescribe(req); }
  catch (e: any) {
    await addons.releaseAllowance(acct, ai.DESCRIBE_ADDON, 1);
    const msg = e instanceof AiUnavailable ? e.message : 'The AI model could not be asked.';
    await record({ status: 'failed', counted: false, model: req.model, error: msg });
    if (ctx.job.attempts >= ctx.job.max_attempts) { await step({ state: 'failed', message: `${msg} This one was not counted.` }); throw new PermanentError(msg, 'ai_failed'); }
    await step({ state: 'queued', message: `${msg} Trying again; not counted.` });
    throw new Error(msg);
  }
  if (!ans.description || !ans.enough) {
    // The model was asked and answered: it counts, as a lookup that found nothing does.
    const row = await record({ status: 'ok', counted: true, model: ans.model, ans, description: null });
    await step({ state: 'skipped', source: src.source, lookupId: row?.id, message: 'The AI model could not tell from what is said what it is about, so nothing was written.' });
    return { skipped: 'not enough to go on' };
  }
  const row = await record({ status: 'ok', counted: true, model: ans.model, ans, description: ans.description });
  const prov = { [key]: { source: 'ai_description', model: ans.model, from: src.source, fileId: src.fileId, lookup: row?.id ?? null, chosen: false, review: true, at: now(), was: a.metadata?.[key] ?? null } };
  // Written only while the field is still empty (unless a person asked to replace it): a description a
  // person typed while the model was working wins.
  const w = await one<any>(
    `UPDATE vod_assets SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object($2::text, $3::text),
            metadata_provenance = COALESCE(metadata_provenance, '{}'::jsonb) || $4::jsonb, updated_at = now()
      WHERE id = $1 AND ($5::boolean OR COALESCE(btrim(metadata->>$2), '') = '') RETURNING id`,
    [vodAssetId, key, ans.description, JSON.stringify(prov), !!pp.plan.replace]);
  if (!w) {
    await step({ state: 'skipped', source: src.source, lookupId: row?.id, message: 'Someone gave it a description while the model was writing one; theirs was kept.' });
    return { skipped: 'filled meanwhile' };
  }
  const { writeAudit } = await import('../audit');
  await writeAudit(null, { accountId: acct, userId: null, label: 'AI descriptions', action: 'update', entityType: 'vod_asset', entityId: vodAssetId,
    changes: { [key]: { from: a.metadata?.[key] ?? null, to: ans.description }, described_from: { from: null, to: { source: src.source, model: ans.model } } } });
  try { (await import('../../scale/cache')).invalidateTag(`asset:${vodAssetId}`); } catch { /* no cache */ }
  await step({ state: 'done', field: key, source: src.source, model: ans.model, lookupId: row?.id, description: ans.description, message: `Written from its ${src.source === 'captions' ? 'subtitles' : 'audio'}.` });
  const { fireHook } = await import('../workflows/hooks');
  fireHook('description.written', 'vod_asset', vodAssetId, { field: key, source: src.source });
  return { field: key, source: src.source, model: ans.model };
}

export function registerPostProcessHandlers(): void {
  registerHandler(VOD_SUBTITLES, handleSubtitles);
  registerHandler(VOD_DESCRIBE, handleDescribe);
}
