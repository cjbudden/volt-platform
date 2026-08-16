import { createServer } from './server';
import { config } from './config';
import { pool, query } from './db';
import { startScheduler } from './services/orchestrator';
import { reapAllEncoders } from './services/orchestrator/encoderCleanup';

const app = createServer();

// Idempotent lightweight schema top-ups (there is no migration runner yet). Each
// is safe to re-run on every boot and covers both fresh and long-lived dev DBs.
async function ensureSchema(): Promise<void> {
  await query(`ALTER TABLE channels ADD COLUMN IF NOT EXISTS epg_enabled BOOLEAN NOT NULL DEFAULT true`);
  // output retention as SECONDS (any unit from the UI: minutes..months). The coarse
  // recordings sweep still uses recording_retention_days, kept derived in sync.
  await query(`ALTER TABLE channels ADD COLUMN IF NOT EXISTS recording_retention_sec BIGINT`);
  // ON AIR (published to the public). Decoupled from the encoder being up: the encoder
  // can be running with a valid, private preview output while on_air=false. Going on air
  // is an explicit operator action; the public playback URL only serves when this is true
  // AND the output has valid content.
  await query(`ALTER TABLE channels ADD COLUMN IF NOT EXISTS on_air BOOLEAN NOT NULL DEFAULT false`);
  // Watermark / channel brand overlay (per channel). ref = library image URL.
  await query(`ALTER TABLE channels ADD COLUMN IF NOT EXISTS watermark_enabled BOOLEAN NOT NULL DEFAULT false`);
  await query(`ALTER TABLE channels ADD COLUMN IF NOT EXISTS watermark_ref TEXT`);
  await query(`ALTER TABLE channels ADD COLUMN IF NOT EXISTS watermark_position TEXT NOT NULL DEFAULT 'br'`);
  await query(`ALTER TABLE channels ADD COLUMN IF NOT EXISTS watermark_offset_x INTEGER NOT NULL DEFAULT 24`);
  await query(`ALTER TABLE channels ADD COLUMN IF NOT EXISTS watermark_offset_y INTEGER NOT NULL DEFAULT 24`);
  await query(`ALTER TABLE channels ADD COLUMN IF NOT EXISTS watermark_opacity INTEGER NOT NULL DEFAULT 100`);
  await query(`ALTER TABLE channels ADD COLUMN IF NOT EXISTS watermark_scale INTEGER NOT NULL DEFAULT 12`);
}

const server = app.listen(config.port, () => {
  console.log(`Volt control plane listening on :${config.port} (${config.env})`);
  ensureSchema().catch((e) => console.error('[schema] ensure failed', e));
  // BOOT CLEANUP: a control-plane (re)start reaps any orphaned encoder/ffmpeg/
  // packager from a previous run so nothing is left holding the bus ports. Only
  // meaningful for the local/docker launcher; a no-op with mock/ecs.
  if (config.orchestrator.launcher === 'local' || config.orchestrator.launcher === 'docker') {
    try { reapAllEncoders(config.testStream.encoderBin, config.testStream.originDir); }
    catch (e) { console.error('[encoder-cleanup] boot reap failed', e); }
  }
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
