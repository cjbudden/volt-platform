import { createServer } from './server';
import { config } from './config';
import { pool, query } from './db';
import { startScheduler } from './services/orchestrator';

const app = createServer();

// Idempotent lightweight schema top-ups (there is no migration runner yet). Each
// is safe to re-run on every boot and covers both fresh and long-lived dev DBs.
async function ensureSchema(): Promise<void> {
  await query(`ALTER TABLE channels ADD COLUMN IF NOT EXISTS epg_enabled BOOLEAN NOT NULL DEFAULT true`);
}

const server = app.listen(config.port, () => {
  console.log(`Volt control plane listening on :${config.port} (${config.env})`);
  ensureSchema().catch((e) => console.error('[schema] ensure failed', e));
});

// orchestrator background scheduler (event provisioning, recording roll, retention sweep)
const stopScheduler = startScheduler();

async function shutdown(signal: string) {
  console.log(`\n${signal} received — shutting down`);
  stopScheduler();
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
