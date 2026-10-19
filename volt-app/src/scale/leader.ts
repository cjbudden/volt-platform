/**
 * ONE SCHEDULER, HOWEVER MANY PROCESSES.
 *
 * The scheduler (event provisioning, recording roll, retention sweeps, the
 * stream reconciler, auto connect) must run in exactly one process. Before
 * this, every API replica ran its own copy: two replicas meant every sweep
 * twice and two reconcilers racing over the same rows.
 *
 * Leadership is a Postgres session advisory lock held on a dedicated
 * connection. Whoever holds it runs the scheduler; the others try again every
 * LEADER_RETRY_SEC. If the leader dies or its connection drops, Postgres
 * releases the lock and another process takes over within one retry interval.
 * No extra infrastructure, and it works the same on one box and on ECS.
 *
 * The connection is checked every few seconds. A leader that cannot reach the
 * database stops its scheduler immediately: it may already have lost the lock
 * to someone else, and two schedulers is the one outcome this file exists to
 * prevent.
 */
import { Client } from 'pg';
import { scaleConfig } from './config';

const LOCK_NS = 0x0108; // "leader" (0x0107 is the orchestrator's per-stream start lock)

export interface Leadership {
  isLeader: () => boolean;
  stop: () => Promise<void>;
}

export function runAsLeader(name: string, lockId: number, becomeLeader: () => (() => void | Promise<void>)): Leadership {
  const retryMs = Number(process.env.LEADER_RETRY_SEC ?? 10) * 1000;
  let client: Client | null = null;
  let leading = false;
  let stopFn: (() => void | Promise<void>) | null = null;
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const resign = async (why: string) => {
    if (leading) console.warn(`[leader:${name}] stepping down: ${why}`);
    leading = false;
    const f = stopFn;
    stopFn = null;
    if (f) { try { await f(); } catch (e) { console.error(`[leader:${name}] stop failed`, e); } }
    const c = client;
    client = null;
    if (c) await c.end().catch(() => {});
  };

  const tick = async () => {
    if (stopped) return;
    try {
      if (!client) {
        const c = new Client({ connectionString: scaleConfig.listenUrl, application_name: `volt-leader-${name}` });
        c.on('error', () => { void resign('connection error'); });
        await c.connect();
        client = c;
      }
      if (leading) {
        await client.query('SELECT 1');   // still connected = still holding the lock
      } else {
        const r = await client.query('SELECT pg_try_advisory_lock($1, $2) AS ok', [LOCK_NS, lockId]);
        if (r.rows[0]?.ok) {
          leading = true;
          console.log(`[leader:${name}] this process is now the leader`);
          stopFn = becomeLeader();
        }
      }
    } catch (e: any) {
      await resign(e?.message ?? 'check failed');
    } finally {
      if (!stopped) timer = setTimeout(() => { void tick(); }, leading ? Math.min(retryMs, 5000) : retryMs);
    }
  };
  void tick();

  return {
    isLeader: () => leading,
    stop: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      await resign('shutdown');
    },
  };
}
