/**
 * Extractor entrypoint. Reads an ExtractJob JSON (path as argv[2] or
 * EXTRACT_JOB_JSON env) and produces the clip outputs on disk. The orchestrator
 * launches this as a CPU task (like the thumbnailer).
 *
 * With `"upload": { "bucket": "...", "prefix": "vod/<assetId>" }` in the job
 * (20 Oct 2026) the task also uploads job.outDir to s3://bucket/prefix/ and
 * prints the location as `uploaded.uri`. The caller registers that URI as a
 * media object location (services/media/objects.ts registerObject, tier
 * s3_standard), which is what puts the extract on the retention ladder: the
 * sweep's S3 driver removes exactly that prefix when the rule says delete.
 *
 *   npx tsx src/tools/extract-clip.ts job.json
 */
import { promises as fs } from 'node:fs';
import { runExtractJob, type ExtractJob } from '../services/vod-extractor-job';

async function main() {
  const inline = process.env.EXTRACT_JOB_JSON;
  const jobPath = process.argv[2];
  const raw = inline ?? (jobPath ? await fs.readFile(jobPath, 'utf8') : null);
  if (!raw) {
    console.error('usage: extract-clip <job.json>  (or EXTRACT_JOB_JSON=...)');
    process.exit(2);
  }
  const job = JSON.parse(raw) as ExtractJob & { upload?: { bucket: string; prefix: string } };
  const result: any = await runExtractJob(job);
  if (job.upload) {
    const { uploadTree, mediaS3Client } = await import('../services/media/s3Driver');
    const region = process.env.AWS_REGION ?? 'ap-southeast-1';
    result.uploaded = await uploadTree(await mediaS3Client(region), job.outDir, job.upload.bucket, job.upload.prefix);
  }
  console.log(JSON.stringify(result));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
