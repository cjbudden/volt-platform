// ============================================================================
//  STORAGE PROJECTION: what a stream will write, worked out from its bitrates
//  before it runs, next to the CPU and network the load model projects.
//
//  Two different places fill up, and they cost differently:
//
//    TASK DISK  the encoder packages into a local folder and a sidecar
//               (s3-uploader.sh) mirrors that folder to S3. The packager
//               keeps every segment of the run locally (Shaka's
//               preserved_segments_outside_live_window is 0, "keep
//               everything"), so without more the task disk grows at the full
//               output rate for as long as the run lasts. On AWS the sidecar
//               keeps only a window (LOCAL_KEEP_SECONDS on the encoder task,
//               ENCODER_LOCAL_KEEP_SECONDS here; build queue 2.4c): segments
//               older than that are removed once they are in S3, so the disk
//               levels off at the rate times the window. On the Mac the local
//               run is the recording and nothing is removed. This is what can
//               make a server run short of disk, and it is what placement
//               checks (capacity.ts fits()).
//    S3         the same bytes again, held under the recording retention
//               (cfg.recording.retention_sec) or kept until deleted when no
//               retention is set. This is the storage bill.
//
//  Both are the output bitrate times time: every rendition's video bitrate,
//  the audio tracks, and the container overhead (K.muxOverhead in
//  streamLoad.ts). Nothing here is measured; projectionReport.ts sets these
//  figures against what the uploader actually sent.
//
//  Pure: no DB, no clock, no IO.
// ============================================================================

export interface StorageProjection {
  /** Everything written per second, container overhead included (kbps). */
  outKbps: number;
  /** Bytes written to the task disk per hour of running. */
  scratchBytesPerHour: number;
  /** The same in MiB, the unit a server's disk is measured in. */
  scratchMibPerHour: number;
  /**
   * The most the task disk holds for this stream when the uploader keeps only
   * a local window (MiB); null when the whole run stays on the disk.
   */
  scratchCapMib: number | null;
  /** Bytes uploaded to S3 per hour of running (the sidecar mirrors everything). */
  s3BytesPerHour: number;
  /** Recording retention in days, null when the run is kept until deleted. */
  retentionDays: number | null;
  /** S3 bytes held at steady state for a stream that runs all day under its retention; null when kept until deleted. */
  s3HeldBytesAtSteadyState: number | null;
}

const MIB = 1024 * 1024;

/** Slack on top of the window: the sync interval, a slow pass, the segment being written. */
const WINDOW_SLACK_SEC = 120;

/**
 * The window s3-uploader.sh keeps on the task disk, in seconds, or null when
 * it keeps the whole run. Mirrors the script: never shorter than the job's
 * DVR window plus two minutes, and nothing is removed for a local output
 * (the Mac, where the uploader does not run and the local run is the
 * recording) or when ENCODER_LOCAL_KEEP_SECONDS is unset.
 */
export function localWindowSeconds(job: { output?: { mode?: string } | null; dvr_seconds?: number | null } | null | undefined,
  keepSeconds: number | null | undefined = Number(process.env.ENCODER_LOCAL_KEEP_SECONDS) || null): number | null {
  if (!keepSeconds || keepSeconds <= 0) return null;
  if (String(job?.output?.mode ?? '').toLowerCase() === 'local') return null;
  return Math.max(keepSeconds, (Number(job?.dvr_seconds) || 0) + 120);
}

/**
 * Project storage from the total output rate.
 *
 * @param outKbps       output rate including audio and container overhead
 * @param retentionSec  the job's recording retention (cfg.recording.retention_sec), null or 0 when none
 * @param windowSec     the local window the uploader keeps (localWindowSeconds), null for the whole run
 */
export function projectStorage(outKbps: number, retentionSec?: number | null, windowSec?: number | null): StorageProjection {
  const kbps = Math.max(0, Number(outKbps) || 0);
  const bytesPerHour = (kbps * 1000 / 8) * 3600;
  const retentionDays = retentionSec && retentionSec > 0 ? retentionSec / 86400 : null;
  return {
    outKbps: Math.round(kbps),
    scratchBytesPerHour: Math.round(bytesPerHour),
    scratchMibPerHour: Math.round((bytesPerHour / MIB) * 10) / 10,
    scratchCapMib: windowSec && windowSec > 0
      ? Math.round((bytesPerHour / MIB) * ((windowSec + WINDOW_SLACK_SEC) / 3600) * 10) / 10
      : null,
    s3BytesPerHour: Math.round(bytesPerHour),
    retentionDays: retentionDays != null ? Math.round(retentionDays * 100) / 100 : null,
    s3HeldBytesAtSteadyState: retentionDays != null ? Math.round(bytesPerHour * 24 * retentionDays) : null,
  };
}

/**
 * Task disk a run will hold `hours` from now, given how long it has already
 * run: the rate times the total time while the whole run stays on the disk,
 * and no more than `capMib` when the uploader keeps only a window.
 */
export function scratchMibAt(mibPerHour: number, hoursSoFar: number, hoursAhead: number, capMib?: number | null): number {
  const whole = Math.max(0, mibPerHour) * (Math.max(0, hoursSoFar) + Math.max(0, hoursAhead));
  return capMib != null && capMib >= 0 ? Math.min(whole, capMib) : whole;
}

/** Human-readable size for notes and reports. */
export function formatBytes(b: number): string {
  if (b >= 1e12) return `${Math.round(b / 1e11) / 10} TB`;
  if (b >= 1e9) return `${Math.round(b / 1e8) / 10} GB`;
  if (b >= 1e6) return `${Math.round(b / 1e5) / 10} MB`;
  return `${Math.round(b / 1e3)} kB`;
}
