import 'dotenv/config';
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

function req(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Missing required env var: ${name}`);
  return v;
}

/**
 * WHERE THE BUILT CONSOLE IS, and why this is not a constant.
 *
 * It used to be `${process.cwd()}/web`, which is where the Docker image puts
 * the console and is correct there. In a SOURCE CHECKOUT it is a trap, and the
 * trap sprang repeatedly: somebody copies volt-web/dist to volt-app/web once
 * to make a local run work, and from that moment the control plane serves a
 * FROZEN SNAPSHOT. Every later `npm run build` in volt-web updates
 * volt-web/dist and changes nothing about what is served, because the copy is
 * never refreshed. The symptom is the worst kind: the console loads, every
 * page works, and it is simply an old version of the app. Nothing errors.
 * There is nothing in the network tab to notice. It looks like the new work
 * did not happen.
 *
 * Resolution order, most explicit first:
 *
 *   1. WEB_DIST_DIR, if set. An explicit answer is never second-guessed.
 *   2. <cwd>/web, if it exists. The image layout, where this is the only copy.
 *   3. <repo>/volt-web/dist, if it exists. The source layout, where the build
 *      output IS the thing to serve and there is no copy to go stale.
 *
 * `staleConsoleWarning` catches the case that started this: both exist, and
 * the real build is newer than the copy. It cannot be fixed silently — the
 * copy may be deliberate — so it is reported loudly at boot with the two paths
 * and the one command that fixes it.
 */
function resolveWebDist(): string {
  if (process.env.WEB_DIST_DIR !== undefined) return process.env.WEB_DIST_DIR;
  const inImage = resolve(process.cwd(), 'web');
  if (existsSync(`${inImage}/index.html`)) return inImage;
  const inRepo = resolve(process.cwd(), '..', 'volt-web', 'dist');
  if (existsSync(`${inRepo}/index.html`)) return inRepo;
  // Neither: keep the historical default so the "no bundle built" path is
  // unchanged, and the server serves the API alone.
  return inImage;
}

/**
 * Is the console being served from a copy that the real build has moved past?
 *
 * Returns the message to print, or null when there is nothing to say. Exported
 * rather than logged here so the check is testable without booting a server.
 */
export function staleConsoleWarning(servedDir = config.webDistDir): string | null {
  const built = resolve(process.cwd(), '..', 'volt-web', 'dist');
  if (resolve(servedDir) === built) return null;
  const servedIndex = `${resolve(servedDir)}/index.html`;
  const builtIndex = `${built}/index.html`;
  if (!existsSync(servedIndex) || !existsSync(builtIndex)) return null;
  const servedAt = statSync(servedIndex).mtimeMs;
  const builtAt = statSync(builtIndex).mtimeMs;
  // A second of slack: a copy made immediately after a build can land with a
  // marginally later mtime on either file depending on the copy tool.
  if (builtAt <= servedAt + 1000) return null;
  const age = Math.round((builtAt - servedAt) / 60000);
  return [
    `[console] SERVING A STALE BUNDLE. ${servedDir} is ${age} minute(s) behind ${built}.`,
    `[console] Every page will load and every page will be an old version of the app.`,
    `[console] Fix: rm -rf ${servedDir}   (the source run then serves volt-web/dist directly)`,
    `[console] or re-copy it, or set WEB_DIST_DIR=${built}`,
  ].join('\n');
}

/**
 * WHERE THE BUILT PLAYER BUNDLE IS.
 *
 * Same trap as the console, same resolution: an image copy at <cwd>/player
 * when one exists, otherwise the live build next door in a source checkout.
 * Serving the bundle from the control plane rather than a CDN is deliberate —
 * an embed then needs one script tag from the same origin the API is on, so
 * there is no second host to configure and no CORS to open.
 */
function resolvePlayerBundle(): string {
  if (process.env.PLAYER_BUNDLE_DIR !== undefined) return process.env.PLAYER_BUNDLE_DIR;
  const inImage = resolve(process.cwd(), 'player');
  if (existsSync(`${inImage}/volt-player.js`)) return inImage;
  const inRepo = resolve(process.cwd(), '..', 'volt-player', 'dist');
  if (existsSync(`${inRepo}/volt-player.js`)) return inRepo;
  return inImage;
}

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  port: Number(process.env.PORT ?? 8080),
  databaseUrl: req('DATABASE_URL', 'postgres://volt:volt@localhost:5432/volt'),
  jwt: {
    accessSecret: req('JWT_ACCESS_SECRET', 'dev-access'),
    refreshSecret: req('JWT_REFRESH_SECRET', 'dev-refresh'),
    accessTtl: Number(process.env.ACCESS_TTL ?? 900),
    refreshTtl: Number(process.env.REFRESH_TTL ?? 60 * 60 * 24 * 14),
  },
  aws: {
    region: process.env.AWS_REGION ?? 'ap-southeast-1',
    s3Bucket: process.env.S3_BUCKET ?? 'volt-origin-dev',
    cdnBaseUrl: process.env.CDN_BASE_URL ?? 'https://cdn.example.com',
  },
  // shared secret the encoder uses to POST status/events to /api/streams/:id/report
  ingestToken: req('INGEST_TOKEN', 'dev-ingest-token'),
  // where encoder/thumbnailer tasks reach the control plane (status + media reports)
  // default follows PORT: a control plane on any port other than 8080 used to send its
  // encoders' status reports to a port nobody was listening on (gates stuck at starting)
  internalApiBaseUrl: process.env.INTERNAL_API_BASE_URL ?? `http://localhost:${process.env.PORT ?? 8080}`,
  publicBaseUrl: process.env.PUBLIC_BASE_URL ?? 'http://localhost:8080',   // origin used in share links
  // orchestrator: how channel/event start launches encoder tasks
  orchestrator: {
    // 'ecs' launches real Fargate/EC2 tasks; 'local' spawns the real encoder.py /
    // thumbnailer.py as on-box child processes (no AWS); 'mock' records intent (tests).
    launcher: (process.env.ORCH_LAUNCHER ?? 'mock') as 'ecs' | 'mock' | 'local' | 'docker',
    ecsCluster: process.env.ECS_CLUSTER ?? 'volt',
    encoderTaskDef: process.env.ENCODER_TASK_DEF ?? 'volt-encoder',
    thumbnailerTaskDef: process.env.THUMBNAILER_TASK_DEF ?? 'volt-thumbnailer',
    captionsTaskDef: process.env.CAPTIONS_TASK_DEF ?? 'volt-captions',   // GPU add-on task (whisper+NLLB)
    radioTaskDef: process.env.RADIO_TASK_DEF ?? 'volt-radio',           // audio-only station (ffmpeg alone, no packager)
    // HOW A STATION RUNS. 'container' launches volt-radio through the launcher,
    // exactly like a television channel. 'inprocess' is the old path where the
    // control plane spawns ffmpeg as its own child.
    //
    // 'container' is the default now. The read side was migrated off the
    // in-process table onto the instance row plus status reports, which is what
    // was blocking it, and the whole path is covered end to end against a real
    // relay by test/radio-container.check.sh.
    //
    // THIS HAS A DEPLOYMENT PREREQUISITE. A station pushes MP3 to Icecast, so
    // ICECAST_HOST and friends must point at a running relay.
    //
    // That sentence used to end "the MP3 output fails while HLS and DASH carry
    // on regardless", and that was simply FALSE. One ffmpeg carries every
    // output and opens them all before encoding anything, so a refused
    // icecast:// connection killed the process and no HLS or DASH was written
    // either — the station produced nothing, exited rc=195 a second after
    // start, and was relaunched by auto connect twenty seconds later, forever.
    // bin/radio.py now probes the relay first and drops the MP3 output when it
    // is unreachable, which is what makes the claim true. Set
    // RADIO_MODE=inprocess to
    // get the old behaviour back, which is the only reason that path still
    // exists; it cannot be deployed, replicated or reaped like anything else
    // and a control-plane restart takes every station off air.
    radioMode: (process.env.RADIO_MODE ?? 'container') as 'container' | 'inprocess',
    radioImage: process.env.RADIO_IMAGE ?? 'volt-radio:local',          // docker-launcher image (local dev)
    encoderImage: process.env.ENCODER_IMAGE ?? 'volt-encoder:local',   // docker-launcher image (local dev)
    // networking + placement (from Terraform outputs)
    subnets: (process.env.ECS_SUBNETS ?? '').split(',').filter(Boolean),
    securityGroups: (process.env.ECS_SECURITY_GROUPS ?? '').split(',').filter(Boolean),
    // Spot with on-demand fallback (capacity providers); base keeps 1 on-demand for stability
    spotProvider: process.env.ECS_SPOT_PROVIDER ?? 'volt-spot',
    onDemandProvider: process.env.ECS_ONDEMAND_PROVIDER ?? 'volt-ondemand',
    tickSeconds: Number(process.env.ORCH_TICK_SECONDS ?? 30),
    retentionSweepSeconds: Number(process.env.RETENTION_SWEEP_SECONDS ?? 3600),
    // THE FLEET PASS: observe where tasks landed, accrue billable time, take a
    // telemetry reading. Slower than the orchestrator tick on purpose. It costs
    // an AWS describe per running task and a CloudWatch call per region, and
    // none of its outputs decide anything. The meter is exact at any interval
    // because it accrues from a mark rather than from now, so a longer interval
    // costs resolution in the fleet view and nothing at all in the usage
    // figures.
    fleetTickSeconds: Number(process.env.FLEET_TICK_SECONDS ?? 60),
    // AUTO CONNECT after a reboot. Every stream that was started and never
    // deliberately stopped is put back: adopted if its task is still running,
    // restarted if it is definitely gone, left alone if the launcher cannot
    // say. Five attempts twenty seconds apart, then it stops trying and
    // records why — an unbounded retry against a dead source launches a
    // billable container every twenty seconds forever.
    resumeRetrySeconds: Number(process.env.RESUME_RETRY_SECONDS ?? 20),
    resumeMaxAttempts: Number(process.env.RESUME_MAX_ATTEMPTS ?? 5),
    /**
     * HOW LONG A SPENT RECOVERY BUDGET STAYS SPENT.
     *
     * The five-attempt cap exists to stop a TIGHT LOOP: a stream relaunching
     * every twenty seconds against a source that is gone. It was never meant to
     * be a permanent verdict, and as written it was one -- the counter is in the
     * database and nothing reset it, so a station that hit the cap stayed given
     * up across every restart of the control plane and simply never came back
     * on its own. That is the opposite of what auto connect is for.
     *
     * So the budget is scoped to the loop rather than to the stream. If the last
     * attempt was longer ago than this, the loop is over: whatever the situation
     * is now, it is not the one that spent those attempts, and the stream is
     * given a fresh five. Ten minutes is far longer than the twenty second retry
     * interval, so a real loop can never age out mid-loop.
     */
    resumeBudgetTtlSeconds: Number(process.env.RESUME_BUDGET_TTL_SECONDS ?? 600),
    // A run shorter than this never really started, and counts against the
    // retry budget. Without it a stream that launches and dies a second later
    // is retried forever, because a start that SUCCEEDS resets the counter and
    // the crash afterwards was invisible to it.
    resumeFlapSeconds: Number(process.env.RESUME_FLAP_SECONDS ?? 60),
    // Switch the whole behaviour off for a deployment that would rather bring
    // its fleet up by hand. Per-stream opt-out is the `auto_connect` column.
    resumeEnabled: (process.env.AUTO_CONNECT ?? 'true') !== 'false',
    // How long CPU/network history is kept. The usage ledger is NEVER pruned;
    // this is only the telemetry beside it.
    sampleRetentionDays: Number(process.env.FLEET_SAMPLE_RETENTION_DAYS ?? 14),
  },
  health: {
    /**
     * HOW LONG A NEW RUN IS GIVEN BEFORE A FAULT IS PRESENTED AS AN ERROR.
     *
     * A pipeline takes a few seconds to come up and auto connect retries a
     * genuine failure every twenty seconds without anybody watching, so a fault
     * in the first moments is usually either the pipeline still starting or a
     * blip the system will fix on its own. Showing it immediately trains an
     * operator to ignore the error state, which is worse than showing nothing.
     *
     * The fault is RECORDED the instant it happens either way. This governs
     * only when it is PRESENTED as an error rather than as "starting".
     *
     * Ninety seconds covers roughly four auto-connect attempts, so a station
     * that can recover by itself will have done so before anyone is told.
     */
    settleSeconds: Number(process.env.HEALTH_SETTLE_SECONDS ?? 90),
  },
  // RADIO RELAY. The Icecast tier that fans MP3 out to listeners. The station
  // container is a SOURCE client; nothing in the control plane sits in the
  // audio path, which is what lets a station survive an API restart.
  //
  // `publicBase` is what a listener is given and is normally the CDN or load
  // balancer in front of Icecast, NOT `host:port` — those are how the station
  // reaches the relay from inside the VPC and must never be handed to a client.
  icecast: {
    host: process.env.ICECAST_HOST ?? 'localhost',
    port: Number(process.env.ICECAST_PORT ?? 8000),
    sourceUser: process.env.ICECAST_SOURCE_USER ?? 'source',
    sourcePassword: process.env.ICECAST_SOURCE_PASSWORD ?? 'hackme',
    tls: process.env.ICECAST_TLS === '1',
    publicBase: process.env.ICECAST_PUBLIC_BASE ?? '',
    // Shared secret the relay presents when it asks us whether to admit a
    // listener. Empty disables the check, which is only safe when the relay
    // can reach the control plane on a network nobody else can.
    authSecret: process.env.ICECAST_AUTH_SECRET ?? '',
  },
  // NOW-PLAYING ENRICHMENT. Turning a station's ICY string into an album and a
  // cover, via MusicBrainz and the Cover Art Archive.
  //
  // OPEN DATA ON PURPOSE. No key, no account, and no display terms — unlike
  // the iTunes Search API, whose artwork may only be shown beside a store
  // badge for a promotional purpose, which is not what a station skin is.
  //
  // `minGapMs` is not tuning. MusicBrainz permits ONE call per second per
  // application and enforces it by blocking the IP, so exceeding it stops
  // artwork for every tenant at once. The User-Agent is likewise mandatory and
  // must be meaningful; set TRACK_META_UA to something that names your
  // deployment and gives a contact.
  trackMeta: {
    enabled: (process.env.TRACK_META ?? 'true') !== 'false',
    musicbrainzBase: process.env.MUSICBRAINZ_BASE ?? 'https://musicbrainz.org/ws/2',
    coverArtBase: process.env.COVERART_BASE ?? 'https://coverartarchive.org',
    userAgent: process.env.TRACK_META_UA
      ?? 'VoltStream/0.1 ( https://github.com/volt-stream )',
    minGapMs: Number(process.env.TRACK_META_MIN_GAP_MS ?? 1100),
    timeoutMs: Number(process.env.TRACK_META_TIMEOUT_MS ?? 6000),
    // Below this MusicBrainz score the match is treated as a MISS. Without a
    // floor an unknown track quietly acquires the cover of whatever it
    // half-matched, and wrong artwork is worse than none.
    minScore: Number(process.env.TRACK_META_MIN_SCORE ?? 85),
    // Transient failures only. A miss is never retried.
    errorRetryMs: Number(process.env.TRACK_META_ERROR_RETRY_MS ?? 6 * 3600_000),
    maxErrorAttempts: Number(process.env.TRACK_META_MAX_ATTEMPTS ?? 4),
  },
  // THE EMBEDDABLE PLAYER.
  player: {
    // Where the built bundle is served from. Same origin as the API by
    // default, so an embed needs one script tag and no CORS.
    bundleDir: resolvePlayerBundle(),
    // How long a player session token is good for. Short, because it is handed
    // to a browser; the player renews it when it expires.
    sessionTtlSec: Number(process.env.PLAYER_SESSION_TTL ?? 3600),
    eventRetentionDays: Number(process.env.PLAYER_EVENT_RETENTION_DAYS ?? 30),
  },
  // WHERE THE BUILT CONSOLE LIVES. Served by the control plane on the same
  // origin, which is why CORS_ORIGIN can be left alone in a normal deployment.
  // Empty disables it and the API is served alone. See resolveWebDist() above
  // for the order and for the stale-copy trap it exists to close.
  webDistDir: resolveWebDist(),
  corsOrigin: process.env.CORS_ORIGIN ?? '*',
  // TEST BUILD: local FFmpeg test-stream origin. ORIGIN_DIR holds the generated
  // HLS/DASH/WebVTT; ENCODER_BIN is where test-stream.sh / test-captions.mjs live.
  testStream: {
    originDir: process.env.ORIGIN_DIR ?? `${process.cwd()}/origin`,
    encoderBin: process.env.ENCODER_BIN ?? `${process.cwd()}/../volt-encoder/bin`,
    pythonBin: process.env.PYTHON_BIN ?? 'python3',
  },
  // GENERATED CLIP OUTPUT. Kept OUT of the origin tree on purpose: origin is the
  // encoder's live namespace and is pruned per the channel's retention rules, so
  // a clip written inside it would be deleted along with the run it came from.
  // A clip must outlive its source.
  clips: {
    dir: process.env.CLIPS_DIR ?? `${process.cwd()}/clips`,
    ffmpegBin: process.env.FFMPEG_BIN ?? 'ffmpeg',
  },
  // UPLOADS — resumable chunk staging, and where finished filler bytes land.
  //
  // Chunks are staged OUTSIDE the finished-media directory on purpose: a partial
  // upload is not an asset, and anything that scans the media directory must not
  // find half a file sitting in it.
  uploads: {
    dir: process.env.UPLOAD_STAGING_DIR ?? `${process.cwd()}/uploads-staging`,
    fillerDir: process.env.FILLER_DIR ?? `${process.cwd()}/filler`,
  },
  // INGEST DESTINATION — where the ingest framework puts the object and its
  // sidecar once the rules have named it. 'local' keeps them beside the
  // vod-src copy; 's3' streams them as a multipart upload. Transfer
  // Acceleration is on by default (decision of 17 Sep) and needs the bucket
  // to have it enabled, otherwise S3 refuses the call; set it off for MinIO.
  ingest: {
    destination: (process.env.INGEST_DESTINATION ?? 'local') as 'local' | 's3',
    s3Bucket: process.env.INGEST_S3_BUCKET ?? (process.env.S3_BUCKET ?? 'volt-origin-dev'),
    s3Prefix: process.env.INGEST_S3_PREFIX ?? 'media',
    s3Accelerate: (process.env.INGEST_S3_ACCELERATE ?? 'true') === 'true',
    s3Endpoint: process.env.INGEST_S3_ENDPOINT || undefined,
    // S3 watchfolders are mirrored here before the local scanner sees them.
    s3StagingDir: process.env.INGEST_S3_STAGING_DIR ?? `${process.cwd()}/uploads-staging/s3-watch`,
  },
  // MEDIA STORE — where recorded media lives, and whether this deployment has
  // an archive at all.
  //
  // Archiving is offered ONLY when the driver is 's3' AND it is explicitly
  // enabled. A local deployment has one tier, so cold and archive actions are
  // not offered and a retention rule that names one is refused at write time
  // rather than accepted and silently never fired. See services/media/storage.ts.
  mediaStore: {
    driver: (process.env.MEDIA_STORE_DRIVER ?? 'local') as 'local' | 's3',
    archiveEnabled: (process.env.MEDIA_ARCHIVE_ENABLED ?? 'false') === 'true',
    // Which tier each rung of the ladder means here. Glacier Instant Retrieval
    // is the default cold tier because it still serves a byte range with no
    // restore step, so cooling costs nothing in latency.
    coldTier: (process.env.MEDIA_COLD_TIER ?? 's3_glacier_ir') as
      's3_ia' | 's3_glacier_ir',
    archiveTier: (process.env.MEDIA_ARCHIVE_TIER ?? 's3_glacier_flexible') as
      's3_glacier_flexible' | 's3_deep_archive',
    // Default restore speed when a request does not name one.
    restoreSpeed: (process.env.MEDIA_RESTORE_SPEED ?? 'standard') as
      'expedited' | 'standard' | 'bulk',
    // How long a restored copy stays readable before lapsing back to archived.
    restoreKeepDays: Number(process.env.MEDIA_RESTORE_KEEP_DAYS ?? 7),
  },
  // Image library store: local base dir for local runs, S3 bucket+prefix in cloud.
  imageStore: {
    driver: (process.env.IMAGE_STORE_DRIVER ?? 'local') as 'local' | 's3',
    localDir: process.env.IMAGE_STORE_DIR ?? `${process.cwd()}/image-store`,
    s3Bucket: process.env.IMAGE_S3_BUCKET ?? (process.env.S3_BUCKET ?? 'volt-origin-dev'),
    s3Prefix: process.env.IMAGE_S3_PREFIX ?? '',
  },
};
