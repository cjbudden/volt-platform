// ============================================================================
//  JOB LOGS: what a job's process printed, kept with the job (migration 0088).
//
//  The console's Encoding queue shows it while the job runs and after it ends,
//  whichever server ran it, so it goes to the database, not to a file on the
//  worker's disk. Lines are batched (every 1.5 s or 200 lines) and capped per
//  job: past MAX_LINES only a rolling tail is kept and written at close() behind
//  a "lines skipped" note, because when an encode fails it is the LAST lines
//  that say why. Writing never fails the job: a log is evidence, not work.
//
//  Progress lines ("progress encode 41% at 3.2x") arrive about once a second;
//  only one per PROGRESS_STEP percent is kept, the job's own progress shows the rest.
// ============================================================================
import { one, query } from '../../db';

const MAX_LINES = 4000;
const TAIL_LINES = 200;
const PROGRESS_STEP = 5;
const MAX_LINE_CHARS = 2000;

type Stream = 'out' | 'err' | 'step' | 'warn';
interface Line { stream: Stream; line: string; at: Date }

export class JobLog {
  private seq: number;
  private kept = 0;
  private skipped = 0;
  private buf: Line[] = [];
  private tail: Line[] = [];
  private partial: Record<'out' | 'err', string> = { out: '', err: '' };
  private lastProgress = -1;
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushing: Promise<void> = Promise.resolve();

  private constructor(readonly jobId: string, readonly attempt: number, startSeq: number) {
    this.seq = startSeq;
    this.timer = setInterval(() => { void this.flush(); }, 1500);
    (this.timer as any).unref?.();
  }

  /** Continue the job's log (a retry appends to the same log under its own attempt number). */
  static async open(jobId: string, attempt: number): Promise<JobLog> {
    let start = 0;
    try { start = Number((await one<{ n: number }>(`SELECT COALESCE(max(seq), 0)::int AS n FROM job_logs WHERE job_id = $1`, [jobId]))?.n ?? 0); }
    catch { /* table missing on an old database: the log is simply not kept */ }
    const log = new JobLog(jobId, attempt, start);
    if (attempt > 1) log.step(`attempt ${attempt} started`);
    return log;
  }

  /** A stage the handler announces ("encoding 1080p 720p 480p"). */
  step(text: string): void { this.push('step', text); }
  /** A step that failed without failing the job (no sprite sheets, say). */
  warn(text: string): void { this.push('warn', text); }
  /** A chunk of the process's stdout or stderr; split into lines here. */
  out(chunk: string): void { this.chunk('out', chunk); }
  err(chunk: string): void { this.chunk('err', chunk); }

  private chunk(stream: 'out' | 'err', chunk: string): void {
    const parts = (this.partial[stream] + chunk).split(/\r\n|\n|\r/);
    this.partial[stream] = parts.pop() ?? '';
    for (const l of parts) this.push(stream, l);
  }

  private push(stream: Stream, raw: string): void {
    const line = raw.replace(/\s+$/, '');
    if (!line) return;
    const m = /progress encode (\d+(?:\.\d+)?)%/.exec(line);
    if (m) {
      const bucket = Math.floor(Number(m[1]) / PROGRESS_STEP);
      if (bucket === this.lastProgress) return;
      this.lastProgress = bucket;
    }
    const l: Line = { stream, line: line.length > MAX_LINE_CHARS ? line.slice(0, MAX_LINE_CHARS) + ' …' : line, at: new Date() };
    if (this.kept < MAX_LINES) { this.kept++; this.buf.push(l); if (this.buf.length >= 200) void this.flush(); return; }
    // Past the cap: keep only the most recent lines, written at close().
    this.tail.push(l);
    if (this.tail.length > TAIL_LINES) { this.tail.shift(); this.skipped++; }
  }

  /** Write what is buffered. Serialised, so seq stays in order. */
  flush(): Promise<void> {
    this.flushing = this.flushing.then(async () => {
      if (!this.buf.length) return;
      const rows = this.buf.splice(0);
      const seqs = rows.map(() => ++this.seq);
      try {
        await query(
          `INSERT INTO job_logs (job_id, seq, attempt, at, stream, line)
           SELECT $1, s, $2, a, st, ln FROM unnest($3::int[], $4::timestamptz[], $5::text[], $6::text[]) AS u(s, a, st, ln)
           ON CONFLICT DO NOTHING`,
          [this.jobId, this.attempt, seqs, rows.map((r) => r.at.toISOString()), rows.map((r) => r.stream), rows.map((r) => r.line)]);
      } catch { /* never fail the job over its log */ }
    });
    return this.flushing;
  }

  /** Flush the partial lines and the kept tail; stop the timer. */
  async close(): Promise<void> {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    for (const s of ['out', 'err'] as const) { if (this.partial[s]) { this.push(s, this.partial[s]); this.partial[s] = ''; } }
    if (this.tail.length) {
      const note: Line = { stream: 'warn', line: `log capped at ${MAX_LINES} lines: ${this.skipped} lines skipped, the last ${this.tail.length} follow`, at: new Date() };
      this.buf.push(note, ...this.tail.splice(0));
    }
    await this.flush();
  }
}

/** A job's log lines after `afterSeq` (for tailing a running job). */
export async function readJobLog(jobId: string, afterSeq = 0, limit = 1000) {
  return query<{ seq: number; attempt: number; at: string; stream: string; line: string }>(
    `SELECT seq, attempt, at, stream, line FROM job_logs WHERE job_id = $1 AND seq > $2 ORDER BY seq LIMIT $3`,
    [jobId, afterSeq, Math.min(Math.max(1, limit), 5000)]).catch(() => []);
}
