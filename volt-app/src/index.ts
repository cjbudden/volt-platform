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
  // Channel brand image (identity logo shown in place of the initials box).
  await query(`ALTER TABLE channels ADD COLUMN IF NOT EXISTS brand_ref TEXT`);
  // Share links: viewer verification level. auth_mode 'none' | 'pin' (creator-set PIN,
  // pin_hash) | 'email_pin' (viewer confirms a recipient email; a one-time PIN is
  // emailed to it; verify_* hold the emailed code hash + who it went to + its expiry).
  await query(`ALTER TABLE share_links ADD COLUMN IF NOT EXISTS auth_mode TEXT NOT NULL DEFAULT 'none'`);
  await query(`ALTER TABLE share_links ADD COLUMN IF NOT EXISTS verify_code_hash TEXT`);
  await query(`ALTER TABLE share_links ADD COLUMN IF NOT EXISTS verify_email TEXT`);
  await query(`ALTER TABLE share_links ADD COLUMN IF NOT EXISTS verify_expires_at TIMESTAMPTZ`);
  // Run identity for encoder status reports: seq restarts on every encoder boot, so
  // boot_ms disambiguates runs (a newer boot always wins the status upsert).
  await query(`ALTER TABLE stream_status ADD COLUMN IF NOT EXISTS boot_ms BIGINT NOT NULL DEFAULT 0`);
  // EXPLICIT recording toggle. Previously recording-on was inferred from retention
  // being set, while the form said 'blank retention = keep forever': contradictory
  // (blank actually meant recording OFF at the encoder). Now: recording_enabled says
  // whether run segments are KEPT; retention (when set) says for how long.
  await query(`ALTER TABLE channels ADD COLUMN IF NOT EXISTS recording_enabled BOOLEAN NOT NULL DEFAULT true`);
  await query(`ALTER TABLE events ADD COLUMN IF NOT EXISTS recording_enabled BOOLEAN NOT NULL DEFAULT true`);
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
