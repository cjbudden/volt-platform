import 'dotenv/config';

function req(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Missing required env var: ${name}`);
  return v;
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
  internalApiBaseUrl: process.env.INTERNAL_API_BASE_URL ?? 'http://localhost:8080',
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
    encoderImage: process.env.ENCODER_IMAGE ?? 'volt-encoder:local',   // docker-launcher image (local dev)
    // networking + placement (from Terraform outputs)
    subnets: (process.env.ECS_SUBNETS ?? '').split(',').filter(Boolean),
    securityGroups: (process.env.ECS_SECURITY_GROUPS ?? '').split(',').filter(Boolean),
    // Spot with on-demand fallback (capacity providers); base keeps 1 on-demand for stability
    spotProvider: process.env.ECS_SPOT_PROVIDER ?? 'volt-spot',
    onDemandProvider: process.env.ECS_ONDEMAND_PROVIDER ?? 'volt-ondemand',
    tickSeconds: Number(process.env.ORCH_TICK_SECONDS ?? 30),
    retentionSweepSeconds: Number(process.env.RETENTION_SWEEP_SECONDS ?? 3600),
  },
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
