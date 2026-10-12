// ============================================================================
//  ADD-ON RUNS — create, dispatch, report back, finish.
//
//  The lifecycle, and who moves it:
//
//    queued      created by a trigger or by hand; a dispatch job is queued.
//    dispatched  Volt POSTed the signed request and the add-on said 2xx.
//    running     the add-on called back with progress.
//    succeeded | failed      the add-on called back with an outcome.
//    cancelled   an operator stopped it (the add-on is told, best effort).
//    timed_out   the deadline passed with no outcome (sweeper).
//
//  Terminal states are final. A late "succeeded" after a timeout is logged on
//  the run, not applied: whoever acted on the timeout must not have the
//  ground move under them.
//
//  Delivery goes through the durable job queue, so a down endpoint gets the
//  queue's backoff and attempts, and a crash mid-dispatch is retried by the
//  reaper, not lost.
// ============================================================================
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { query, one } from '../../db';
import { config } from '../../config';
import { enqueue } from '../jobs/queue';
import { registerHandler, PermanentError, type JobContext } from '../jobs/worker';
import { publish } from '../statusHub';
import type { Subject } from './subjects';
import { resolveSubject } from './subjects';

export const ADDON_DISPATCH = 'addon.dispatch';

export type RunState = 'queued' | 'dispatched' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'timed_out';
export const TERMINAL: ReadonlySet<RunState> = new Set(['succeeded', 'failed', 'cancelled', 'timed_out']);

const LEGAL: Record<RunState, RunState[]> = {
  queued:     ['dispatched', 'running', 'succeeded', 'failed', 'cancelled', 'timed_out'],
  dispatched: ['running', 'succeeded', 'failed', 'cancelled', 'timed_out'],
  running:    ['running', 'succeeded', 'failed', 'cancelled', 'timed_out'],
  succeeded: [], failed: [], cancelled: [], timed_out: [],
};

/** Pure: may a run move from `from` to `to`? (`running`->`running` is a progress update.) */
export function canMove(from: RunState, to: RunState): boolean {
  return LEGAL[from]?.includes(to) ?? false;
}

// ---------------------------------------------------------------------------
//  Signing. Stripe-style: the signature covers the timestamp and the exact
//  body bytes, so a receiver can reject replays older than a few minutes.
// ---------------------------------------------------------------------------
export function sign(secret: string, ts: number, body: string): string {
  return createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
}
export function signatureHeader(secret: string, body: string, ts = Math.floor(Date.now() / 1000)): string {
  return `t=${ts},v1=${sign(secret, ts, body)}`;
}
/** Reference verifier (what an add-on does on receipt), used by our tests and docs. */
export function verifySignature(secret: string, header: string, body: string, toleranceSec = 300, nowSec = Math.floor(Date.now() / 1000)): boolean {
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=') as [string, string]));
  const ts = Number(parts.t);
  if (!ts || !parts.v1 || Math.abs(nowSec - ts) > toleranceSec) return false;
  const want = Buffer.from(sign(secret, ts, body), 'hex');
  const got = Buffer.from(parts.v1, 'hex');
  return want.length === got.length && timingSafeEqual(want, got);
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const newSecret = () => `whsec_${randomBytes(24).toString('base64url')}`;

// ---------------------------------------------------------------------------
async function logEvent(runId: string, e: { type: string; state?: string | null; progress?: number | null; step?: string | null; message?: string | null; data?: unknown }) {
  await query(
    `INSERT INTO addon_run_events (run_id, type, state, progress_pct, step, message, data)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
    [runId, e.type, e.state ?? null, e.progress ?? null, e.step ?? null, e.message ?? null, e.data === undefined ? null : JSON.stringify(e.data)]
  );
}

function notify(accountId: string, run: any) {
  try {
    publish(accountId, 'addon', { id: run.id, state: run.state, progress: run.progress_pct, step: run.step, subjectType: run.subject_type, subjectId: run.subject_id });
  } catch { /* live push is a nicety */ }
}

export interface CreateRunOpts {
  accountId: string;
  addonId: string;
  triggerId?: string | null;
  hook: string;
  subject: Subject;
  options?: Record<string, unknown>;
  createdBy?: string | null;
  hookData?: Record<string, unknown>;
}

export async function createRun(o: CreateRunOpts): Promise<any> {
  const addon = await one<any>(`SELECT * FROM addon_services WHERE id = $1 AND account_id = $2`, [o.addonId, o.accountId]);
  if (!addon) throw Object.assign(new Error('Add-on not found'), { status: 404 });
  if (!addon.enabled) throw Object.assign(new Error('This add-on is switched off'), { status: 409 });
  if (!(addon.accepts as string[]).includes(o.subject.type)) {
    throw Object.assign(new Error(`${addon.name} does not accept ${o.subject.type.replace('_', ' ')}s`), { status: 422 });
  }
  const run = await one<any>(
    `INSERT INTO addon_runs (account_id, addon_id, trigger_id, hook, subject_type, subject_id, subject_title,
                             channel_id, event_id, options, steps, callback_hash, created_by, deadline_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13, now() + make_interval(secs => $14))
     RETURNING *`,
    [o.accountId, o.addonId, o.triggerId ?? null, o.hook, o.subject.type, o.subject.id, o.subject.title,
     o.subject.channelId, o.subject.eventId, JSON.stringify({ ...(o.options ?? {}), ...(o.hookData ? { hook: o.hookData } : {}) }),
     JSON.stringify(addon.steps ?? []), sha256(randomBytes(32).toString('hex')), o.createdBy ?? null, addon.timeout_sec]
  );
  await logEvent(run.id, { type: 'created', state: 'queued', message: o.triggerId ? `Triggered by ${o.hook}` : 'Run by hand' });
  const job = await enqueue({
    type: ADDON_DISPATCH, payload: { runId: run.id },
    channelId: o.subject.channelId, eventId: o.subject.eventId,
    maxAttempts: addon.max_attempts, dedupeKey: `addon.dispatch:${run.id}`, priority: 60,
  });
  await query(`UPDATE addon_runs SET job_id = $2 WHERE id = $1`, [run.id, job.id]);
  notify(o.accountId, run);
  return { ...run, job_id: job.id };
}

export interface RunUpdate {
  state?: RunState;
  progress?: number;
  step?: string;
  message?: string;
  externalRef?: string;
  steps?: string[];
  result?: unknown;
  error?: string;
}

/**
 * The one place a run's state changes. Used by the callback endpoint, the
 * dispatcher, the demo agent, cancel and the timeout sweeper.
 */
export async function applyUpdate(runId: string, u: RunUpdate, source: string): Promise<{ applied: boolean; run: any; reason?: string }> {
  const run = await one<any>(`SELECT * FROM addon_runs WHERE id = $1`, [runId]);
  if (!run) return { applied: false, run: null, reason: 'not_found' };
  const from = run.state as RunState;
  let to: RunState = u.state ?? (u.progress != null || u.step ? (from === 'queued' || from === 'dispatched' ? 'running' : from) : from);
  if (TERMINAL.has(from)) {
    await logEvent(runId, { type: 'note', state: from, message: `Ignored ${u.state ?? 'update'} from ${source}: the run is already ${from}.`, data: u });
    return { applied: false, run, reason: 'terminal' };
  }
  if (to !== from && !canMove(from, to)) {
    await logEvent(runId, { type: 'note', state: from, message: `Ignored illegal move ${from} -> ${to} from ${source}.` });
    return { applied: false, run, reason: 'illegal' };
  }
  const progress = u.state === 'succeeded' ? 100 : (u.progress != null ? Math.max(0, Math.min(100, Math.round(u.progress))) : null);
  const updated = await one<any>(
    `UPDATE addon_runs SET
        state        = $2,
        progress_pct = COALESCE($3, progress_pct),
        step         = COALESCE($4, step),
        external_ref = COALESCE($5, external_ref),
        steps        = COALESCE($6::jsonb, steps),
        result       = COALESCE($7::jsonb, result),
        error        = COALESCE($8, error),
        dispatched_at = CASE WHEN $2 = 'dispatched' AND dispatched_at IS NULL THEN now() ELSE dispatched_at END,
        finished_at  = CASE WHEN $2 IN ('succeeded','failed','cancelled','timed_out') THEN now() ELSE NULL END,
        updated_at   = now()
      WHERE id = $1 RETURNING *`,
    [runId, to, progress, u.step ?? null, u.externalRef ?? null,
     u.steps ? JSON.stringify(u.steps.slice(0, 30)) : null,
     u.result === undefined ? null : JSON.stringify(u.result), u.error ?? null]
  );
  await logEvent(runId, {
    type: to !== from ? 'state' : 'progress', state: to, progress, step: u.step ?? null,
    message: u.message ?? u.error ?? (to !== from ? `${from} -> ${to} (${source})` : null),
  });
  notify(run.account_id, updated);
  return { applied: true, run: updated };
}

// ---------------------------------------------------------------------------
//  Dispatch
// ---------------------------------------------------------------------------
export function buildDispatchBody(run: any, addon: any, subject: Subject, callbackToken: string) {
  const base = config.publicBaseUrl.replace(/\/$/, '');
  return {
    type: 'run.dispatch',
    version: 1,
    run: {
      id: run.id,
      hook: run.hook,
      deadline: run.deadline_at,
      callbackUrl: `${base}/api/addon-callbacks/runs/${run.id}`,
      callbackToken,
    },
    addon: { id: addon.id, name: addon.name },
    account: { id: run.account_id },
    subject: {
      type: subject.type, id: subject.id, title: subject.title,
      channelId: subject.channelId, eventId: subject.eventId,
      durationMs: subject.durationMs, media: subject.media, apiUrl: subject.apiUrl,
    },
    options: run.options ?? {},
  };
}

async function dispatchWebhook(ctx: JobContext, run: any, addon: any, subject: Subject) {
  const token = `vrt_${randomBytes(24).toString('base64url')}`;
  await query(`UPDATE addon_runs SET callback_hash = $2 WHERE id = $1`, [run.id, sha256(token)]);
  const body = JSON.stringify(buildDispatchBody(run, addon, subject, token));
  await ctx.progress(30, `POST ${new URL(addon.endpoint_url).host}`);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15_000);
  let res: Response;
  try {
    res = await fetch(addon.endpoint_url, {
      method: 'POST', body, signal: ac.signal,
      headers: {
        'content-type': 'application/json',
        'user-agent': 'Volt-Addons/1',
        'x-volt-event': 'run.dispatch',
        'x-volt-run': run.id,
        'x-volt-delivery': randomUUID(),
        'x-volt-signature': signatureHeader(addon.signing_secret, body),
      },
    });
  } catch (e: any) {
    throw new Error(`could not reach ${addon.endpoint_url}: ${e?.name === 'AbortError' ? 'timed out after 15s' : e?.message ?? e}`);
  } finally { clearTimeout(timer); }

  let reply: any = null;
  try { reply = await res.json(); } catch { /* an empty 202 is fine */ }
  if (!res.ok) {
    const msg = `add-on answered ${res.status}${reply?.error ? `: ${reply.error}` : ''}`;
    // A client error will not fix itself on retry; rate limits and timeouts might.
    if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) throw new PermanentError(msg, 'addon_rejected');
    throw new Error(msg);
  }
  await applyUpdate(run.id, {
    state: (['running', 'succeeded', 'failed'] as const).includes(reply?.state) ? reply.state : 'dispatched',
    externalRef: reply?.externalRef ?? reply?.external_ref,
    steps: Array.isArray(reply?.steps) ? reply.steps.map(String) : undefined,
    progress: typeof reply?.progress === 'number' ? reply.progress : undefined,
    step: typeof reply?.step === 'string' ? reply.step : undefined,
    result: reply?.result, message: `Accepted by the add-on (${res.status})`,
  }, 'dispatch');
}

// ---------------------------------------------------------------------------
//  The DEMO agent: a built-in stand-in for an AI platform, so the dashboard
//  and the whole run lifecycle can be seen working with nothing external set
//  up. It is labelled as simulated everywhere it appears.
// ---------------------------------------------------------------------------
export const DEMO_STEPS = ['Fetch media', 'Transcribe audio', 'Detect topics and people', 'Write summary and chapters', 'Return results'];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runDemo(ctx: JobContext, run: any, subject: Subject) {
  const stepMs = Math.max(200, Number((run.options as any)?.demoStepMs) || 3000);
  await applyUpdate(run.id, { state: 'running', steps: DEMO_STEPS, step: DEMO_STEPS[0], progress: 2, externalRef: `demo-${run.id.slice(0, 8)}` }, 'demo');
  for (let i = 0; i < DEMO_STEPS.length; i++) {
    const cur = await one<any>(`SELECT state FROM addon_runs WHERE id = $1`, [run.id]);
    if (!cur || TERMINAL.has(cur.state)) return;          // cancelled while running
    await applyUpdate(run.id, { step: DEMO_STEPS[i], progress: Math.round(((i + 0.5) / DEMO_STEPS.length) * 100) }, 'demo');
    await ctx.progress(Math.round(((i + 1) / DEMO_STEPS.length) * 100), DEMO_STEPS[i]);
    await sleep(stepMs);
  }
  const dur = subject.durationMs ?? 30 * 60_000;
  const chapters = [0, 0.18, 0.47, 0.81].map((f, i) => ({ atMs: Math.round(dur * f), title: ['Opening', 'Main story', 'Interview', 'Wrap'][i] }));
  await applyUpdate(run.id, {
    state: 'succeeded', step: 'Done',
    result: {
      simulated: true,
      summary: `Simulated analysis of "${subject.title}". A real agent would return its transcript, summary, topics and chapters here, and Volt would store them against the ${subject.type.replace('_', ' ')}.`,
      topics: ['news', 'weather', 'sport'],
      chapters,
      language: 'en',
    },
  }, 'demo');
}

export async function handleDispatch(ctx: JobContext): Promise<Record<string, unknown>> {
  const { runId } = ctx.job.payload as { runId: string };
  const run = await one<any>(`SELECT * FROM addon_runs WHERE id = $1`, [runId]);
  if (!run) throw new PermanentError('run no longer exists', 'run_gone');
  if (TERMINAL.has(run.state)) return { skipped: run.state };
  const addon = await one<any>(`SELECT * FROM addon_services WHERE id = $1`, [run.addon_id]);
  if (!addon) throw new PermanentError('add-on no longer exists', 'addon_gone');
  const subject = await resolveSubject(run.subject_type, run.subject_id);
  if (!subject) {
    await applyUpdate(runId, { state: 'failed', error: `The ${run.subject_type} no longer exists.` }, 'dispatch');
    throw new PermanentError('subject gone', 'subject_gone');
  }
  try {
    if (addon.kind === 'demo') await runDemo(ctx, run, subject);
    else await dispatchWebhook(ctx, run, addon, subject);
    return { runId };
  } catch (e: any) {
    const last = e instanceof PermanentError || ctx.job.attempts >= ctx.job.max_attempts;
    if (last) await applyUpdate(runId, { state: 'failed', error: String(e?.message ?? e) }, 'dispatch');
    else await query(
      `INSERT INTO addon_run_events (run_id, type, state, message) VALUES ($1,'error',$2,$3)`,
      [runId, run.state, `Attempt ${ctx.job.attempts} of ${ctx.job.max_attempts} failed: ${e?.message ?? e}. Retrying.`]
    );
    throw e;
  }
}

/** Callback auth: the per-run bearer token, compared by hash in constant time. */
export async function authoriseCallback(runId: string, bearer: string): Promise<boolean> {
  if (!bearer) return false;
  const r = await one<{ callback_hash: string }>(`SELECT callback_hash FROM addon_runs WHERE id = $1`, [runId]);
  if (!r) return false;
  const a = Buffer.from(r.callback_hash, 'hex');
  const b = Buffer.from(sha256(bearer), 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function cancelRun(accountId: string, runId: string, by: string) {
  const run = await one<any>(`SELECT r.*, a.kind, a.endpoint_url, a.signing_secret FROM addon_runs r JOIN addon_services a ON a.id = r.addon_id WHERE r.id = $1 AND r.account_id = $2`, [runId, accountId]);
  if (!run) return null;
  const out = await applyUpdate(runId, { state: 'cancelled', message: `Cancelled by ${by}` }, 'operator');
  if (out.applied && run.kind === 'webhook' && run.state !== 'queued') {
    // Tell the add-on so it can stop spending. Best effort: it might be down.
    const body = JSON.stringify({ type: 'run.cancel', version: 1, run: { id: runId, externalRef: run.external_ref } });
    fetch(run.endpoint_url, { method: 'POST', body, headers: { 'content-type': 'application/json', 'x-volt-event': 'run.cancel', 'x-volt-run': runId, 'x-volt-signature': signatureHeader(run.signing_secret, body) } })
      .catch(() => {});
  }
  return out.run;
}

/** Ping an add-on endpoint with a signed `ping`, for the Test button. */
export async function pingAddon(addon: any): Promise<{ ok: boolean; status: number | null; ms: number; message: string }> {
  if (addon.kind === 'demo') return { ok: true, status: 200, ms: 0, message: 'The demo agent runs inside Volt; nothing to reach.' };
  const body = JSON.stringify({ type: 'ping', version: 1, addon: { id: addon.id, name: addon.name } });
  const t0 = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 10_000);
  try {
    const r = await fetch(addon.endpoint_url, { method: 'POST', body, signal: ac.signal, headers: { 'content-type': 'application/json', 'x-volt-event': 'ping', 'x-volt-signature': signatureHeader(addon.signing_secret, body) } });
    return { ok: r.ok, status: r.status, ms: Date.now() - t0, message: r.ok ? 'Reached and accepted the signed ping.' : `Reached, but it answered ${r.status}.` };
  } catch (e: any) {
    return { ok: false, status: null, ms: Date.now() - t0, message: e?.name === 'AbortError' ? 'No answer within 10 seconds.' : `Could not reach it: ${e?.message ?? e}` };
  } finally { clearTimeout(timer); }
}

/** Runs past their deadline become timed_out. Called on a timer. */
export async function sweepTimeouts(): Promise<number> {
  const due = await query<{ id: string }>(
    `SELECT id FROM addon_runs WHERE state IN ('queued','dispatched','running') AND deadline_at < now() LIMIT 200`);
  for (const r of due) await applyUpdate(r.id, { state: 'timed_out', error: 'No outcome before the deadline.' }, 'sweeper');
  return due.length;
}

let sweeper: NodeJS.Timeout | null = null;
export function registerAddonHandlers(): void {
  registerHandler(ADDON_DISPATCH, handleDispatch);
  if (!sweeper) {
    sweeper = setInterval(() => { sweepTimeouts().catch((e) => console.error('[workflows] timeout sweep failed', e)); }, 60_000);
    sweeper.unref();
  }
}
