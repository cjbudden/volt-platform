/**
 * WRITE BATCHING.
 *
 * A Batcher collects rows in memory and writes them as one multi-row INSERT,
 * every `flushMs` or as soon as `maxRows` are waiting. 5,000 rows in one
 * statement cost a few milliseconds; 5,000 statements cost 5-15 seconds of
 * database time and 5,000 commits.
 *
 * Rows that fail to write are retried on the next flush, up to `maxBuffered`;
 * beyond that the oldest are dropped and counted, because unbounded growth
 * would take the process down with the database.
 */
import { pool } from '../db';

export class Batcher {
  private rows: unknown[][] = [];
  private timer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> | null = null;
  dropped = 0;
  written = 0;

  constructor(
    readonly name: string,
    /** e.g. INSERT INTO t (a,b,c): VALUES are appended. */
    private readonly insertHead: string,
    /** SQL cast per column, e.g. ['uuid','text','jsonb']. Placeholders become $n::cast. */
    private readonly casts: string[],
    private readonly opts: { flushMs: number; maxRows: number; maxBuffered: number; tail?: string } =
      { flushMs: 1000, maxRows: 1000, maxBuffered: 100_000 },
  ) {}

  add(row: unknown[]): void {
    if (row.length !== this.casts.length) throw new Error(`[batch:${this.name}] expected ${this.casts.length} columns`);
    this.rows.push(row);
    if (this.rows.length > this.opts.maxBuffered) {
      const over = this.rows.length - this.opts.maxBuffered;
      this.rows.splice(0, over);
      this.dropped += over;
    }
    if (this.rows.length >= this.opts.maxRows) void this.flush();
  }

  pending(): number { return this.rows.length; }

  async flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    if (!this.rows.length) return;
    const take = this.rows.splice(0, this.rows.length);
    this.flushing = (async () => {
      // Postgres allows 65,535 parameters per statement.
      const per = Math.max(1, Math.floor(60_000 / this.casts.length));
      for (let i = 0; i < take.length; i += per) {
        const chunk = take.slice(i, i + per);
        const params: unknown[] = [];
        const values = chunk.map((r) => '(' + r.map((v, j) => {
          params.push(v);
          return `$${params.length}::${this.casts[j]}`;
        }).join(',') + ')').join(',');
        try {
          await pool.query(`${this.insertHead} VALUES ${values}${this.opts.tail ? ' ' + this.opts.tail : ''}`, params);
          this.written += chunk.length;
        } catch (e) {
          console.error(`[batch:${this.name}] write failed, ${chunk.length} row(s) kept for retry`, (e as Error).message);
          this.rows.unshift(...take.slice(i));
          break;
        }
      }
    })();
    try { await this.flushing; } finally { this.flushing = null; }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.flush(); }, this.opts.flushMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.flush();
  }
}

/** Radio/embedded player telemetry (POST /api/player/events). */
export const playerEventBatch = new Batcher(
  'player_events',
  'INSERT INTO player_events (account_id, channel_id, app_id, session_id, event, origin, layout, detail, at)',
  ['uuid', 'uuid', 'uuid', 'text', 'text', 'text', 'text', 'jsonb', 'timestamptz'],
  { flushMs: 1000, maxRows: 2000, maxBuffered: 200_000 },
);

export const allBatchers: Batcher[] = [playerEventBatch];
