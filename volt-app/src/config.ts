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
  // Image library store: local base dir for local runs, S3 bucket+prefix in cloud.
  imageStore: {
    driver: (process.env.IMAGE_STORE_DRIVER ?? 'local') as 'local' | 's3',
    localDir: process.env.IMAGE_STORE_DIR ?? `${process.cwd()}/image-store`,
    s3Bucket: process.env.IMAGE_S3_BUCKET ?? (process.env.S3_BUCKET ?? 'volt-origin-dev'),
    s3Prefix: process.env.IMAGE_S3_PREFIX ?? '',
  },
};
