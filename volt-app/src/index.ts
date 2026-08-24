import { createServer } from './server';
import { config } from './config';
import { pool, query } from './db';
import { startScheduler } from './services/orchestrator';
import { migrate } from './services/migrate';
import { startWorker } from './services/jobs/worker';
import { registerClipHandlers } from './services/jobs/handlers/clipExtract';
import { registerQcHandlers } from './services/jobs/handlers/qcRun';
import { backfillContainers } from './services/containers';
import { reconcileAll } from './services/media/reconcile';
import { reapAllEncoders } from './services/orchestrator/encoderCleanup';
import { stopAllRadio } from './services/radio/pipeline';

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
  // Events: fine-grained retention (parity with channels) + the automated
  // live-to-VOD switch (derive a full-event VOD asset when the recording closes).
  await query(`ALTER TABLE events ADD COLUMN IF NOT EXISTS recording_retention_sec BIGINT`);
  await query(`ALTER TABLE events ADD COLUMN IF NOT EXISTS auto_vod BOOLEAN NOT NULL DEFAULT true`);
  // EPG: programmes belong to a channel OR an event (event guides schedule the
  // day's proceedings); per-programme slot REPLACEMENT (slate/loop/vod for the
  // period) and post-airing auto-clip bookkeeping.
  await query(`ALTER TABLE programmes ALTER COLUMN channel_id DROP NOT NULL`);
  await query(`ALTER TABLE programmes ADD COLUMN IF NOT EXISTS event_id UUID REFERENCES events(id) ON DELETE CASCADE`);
  await query(`CREATE INDEX IF NOT EXISTS idx_prog_event_start ON programmes(event_id, starts_at)`);
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_prog_source_event ON programmes(event_id, source_ref) WHERE source_ref IS NOT NULL AND event_id IS NOT NULL`);
  await query(`ALTER TABLE programmes ADD COLUMN IF NOT EXISTS replacement_kind TEXT NOT NULL DEFAULT 'none'`);
  await query(`ALTER TABLE programmes ADD COLUMN IF NOT EXISTS replacement_ref TEXT`);
  await query(`ALTER TABLE programmes ADD COLUMN IF NOT EXISTS clip_status TEXT NOT NULL DEFAULT 'none'`);
  await query(`ALTER TABLE programmes ADD COLUMN IF NOT EXISTS clip_asset_id UUID`);
  await query(`ALTER TABLE programmes ADD COLUMN IF NOT EXISTS clip_error TEXT`);
  await query(`DO $$ BEGIN
    ALTER TABLE programmes ADD CONSTRAINT chk_prog_owner CHECK ((channel_id IS NOT NULL) OR (event_id IS NOT NULL));
  EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
  // ADMIN: user groups carry per-feature access (none/view/manage) for their
  // members; users reference one; accounts gain a suspension hook (SaaS).
  await query(`CREATE TABLE IF NOT EXISTS user_groups (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    permissions JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (account_id, name)
  )`);
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS user_group_id UUID REFERENCES user_groups(id) ON DELETE SET NULL`);
  await query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'`);
  // RADIO: audio-only channels. kind picks the workflow surface (tv = video chain,
  // radio = audio pipeline: MP3/HLS/DASH single-bitrate outputs, ICY metadata log).
  // radio_config: { outputs:{mp3,hls,dash}, bitrateKbps, metadataCapture, classify,
  // transcode, transcription } — see RADIO.md.
  await query(`ALTER TABLE channels ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'tv'`);
  await query(`ALTER TABLE channels ADD COLUMN IF NOT EXISTS radio_config JSONB`);
  // Icecast / HTTP audio ingest (ICY). ADD VALUE cannot run inside a transaction;
  // each query() here is a single autocommit statement, so this is safe to re-run.
  await query(`ALTER TYPE ingest_protocol ADD VALUE IF NOT EXISTS 'icecast'`);
}

// BOOT ORDER MATTERS. Migrations run to completion BEFORE anything that reads
// or writes the new tables: the scheduler, the worker and the first request all
// assume the schema they were written against. A failure here is fatal rather
// than logged, because a half-migrated database serving traffic is worse than a
// process that refuses to start.
async function boot(): Promise<void> {
  await migrate();
  await ensureSchema();
  // Give existing recordings their broadcast-day container. Additive and
  // idempotent: it only fills container_id where it is NULL, and no row's
  // day_utc or unique index is touched, so the old roll logic keeps working.
  await backfillContainers().catch((e) => console.error('[containers] backfill failed', e));
  // Register what is on disk into the media lifecycle before anything reads it.
  // Retention governs media_objects, so a deployment that has never reconciled
  // has a ladder pointed at an empty set while the disk fills.
  await reconcileAll({ actor: 'boot' }).catch((e) => console.error('[media] boot reconcile failed', e));
}

const server = app.listen(config.port, () => {
  console.log(`Volt control plane listening on :${config.port} (${config.env})`);
  // BOOT CLEANUP: a control-plane (re)start reaps any orphaned encoder/ffmpeg/
  // packager from a previous run so nothing is left holding the bus ports. Only
  // meaningful for the local/docker launcher; a no-op with mock/ecs.
  if (config.orchestrator.launcher === 'local' || config.orchestrator.launcher === 'docker') {
    try { reapAllEncoders(config.testStream.encoderBin, config.testStream.originDir); }
    catch (e) { console.error('[encoder-cleanup] boot reap failed', e); }
  }
});

// orchestrator background scheduler (event provisioning, recording roll, retention
// sweep) and the job worker, both started only once the schema is in place.
let stopScheduler: () => void = () => {};
let worker: { stop: () => Promise<void> } | null = null;
boot().then(() => {
  stopScheduler = startScheduler();
  // Handlers are registered BEFORE the worker starts polling: the worker only
  // claims types it can handle, so an unregistered type would sit queued.
  registerClipHandlers();
  registerQcHandlers();
  worker = startWorker();
}).catch((e) => {
  console.error('[boot] schema preparation failed — refusing to serve', e);
  process.exit(1);
});

async function shutdown(signal: string) {
  console.log(`\n${signal} received — shutting down`);
  stopScheduler();
  if (worker) await worker.stop();   // let in-flight jobs unwind; the reaper covers the rest
  stopAllRadio();   // detached ffmpeg trees would otherwise outlive the control plane
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
