/**
 * The media-jobs task's entrypoint (build queue 2.1a-4).
 *
 * On AWS the control plane's worker hands each media job (clip extract, VOD
 * encode, loop preparation, intro detection and the rest, see
 * services/jobs/mediaJobs.ts) to a task of the volt-media-jobs image, which
 * is the control plane's code plus ffmpeg, ffprobe, the packager and Python.
 * The task is told the job and the lease holder name it must use, runs that
 * one job with the normal handler and exits:
 *
 *   MEDIA_JOB_ID=<job uuid> MEDIA_JOB_WORKER=task:<uuid> node dist/tools/run-media-job.js
 *
 * Exit 0 when the job succeeded or was recorded as failed (the queue decides
 * about retries), 1 when the job was not ours or the lease was lost (another
 * attempt owns it now), 2 on a usage error.
 */
import { registerAllJobHandlers } from '../services/jobs/registerAll';
import { handlerFor } from '../services/jobs/worker';
import { runClaimedJob } from '../services/jobs/mediaJobs';

async function main(): Promise<number> {
  const jobId = process.env.MEDIA_JOB_ID;
  const workerId = process.env.MEDIA_JOB_WORKER;
  if (!jobId || !workerId) {
    console.error('usage: MEDIA_JOB_ID=<job> MEDIA_JOB_WORKER=<lease holder> run-media-job');
    return 2;
  }
  await registerAllJobHandlers();
  const outcome = await runClaimedJob(jobId, workerId, handlerFor);
  console.log(`[media-job] ${jobId}: ${outcome}`);
  return outcome === 'succeeded' || outcome === 'failed' ? 0 : 1;
}

main().then((code) => process.exit(code)).catch((e) => {
  // The lease runs out and the reaper requeues the job; say why here.
  console.error('[media-job] crashed', e);
  process.exit(1);
});
