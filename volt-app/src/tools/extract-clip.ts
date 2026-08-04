/**
 * Extractor entrypoint. Reads an ExtractJob JSON (path as argv[2] or
 * EXTRACT_JOB_JSON env) and produces the clip outputs on disk. The orchestrator
 * launches this as a CPU task (like the thumbnailer); the caller uploads
 * job.outDir to S3 and updates the vod_asset's formats/progressive_key.
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
  const job = JSON.parse(raw) as ExtractJob;
  const result = await runExtractJob(job);
  console.log(JSON.stringify(result));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
