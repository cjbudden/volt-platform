// ============================================================================
//  STORAGE PROJECTION: what a stream will write, worked out from its bitrates
//  before it runs, next to the CPU and network the load model projects.
//
//  Two different places fill up, and they cost differently:
//
//    TASK DISK  the encoder packages into a local folder and a sidecar
//               (s3-uploader.sh) mirrors that folder to S3. Today the packager
//               keeps every segment of the run locally (Shaka's
//               preserved_segments_outside_live_window is 0, "keep
//               everything"), so the task disk grows at the full output rate
//               for as long as the run lasts. That is what can make a server
//               run short of disk, and it is what placement checks
//               (capacity.ts fits()).
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
  /** Bytes uploaded to S3 per hour of running (the sidecar mirrors everything). */
  s3BytesPerHour: number;
  /** Recording retention in days, null when the run is kept until deleted. */
  retentionDays: number | null;
  /** S3 bytes held at steady state for a stream that runs all day under its retention; null when kept until deleted. */
  s3HeldBytesAtSteadyState: number | null;
}

const MIB = 1024 * 1024;

/**
 * Project storage from the total output rate.
 *
 * @param outKbps       output rate including audio and container overhead
 * @param retentionSec  the job's recording retention (cfg.recording.retention_sec), null or 0 when none
 */
export function projectStorage(outKbps: number, retentionSec?: number | null): StorageProjection {
  const kbps = Math.max(0, Number(outKbps) || 0);
  const bytesPerHour = (kbps * 1000 / 8) * 3600;
  const retentionDays = retentionSec && retentionSec > 0 ? retentionSec / 86400 : null;
  return {
    outKbps: Math.round(kbps),
    scratchBytesPerHour: Math.round(bytesPerHour),
    scratchMibPerHour: Math.round((bytesPerHour / MIB) * 10) / 10,
    s3BytesPerHour: Math.round(bytesPerHour),
    retentionDays: retentionDays != null ? Math.round(retentionDays * 100) / 100 : null,
    s3HeldBytesAtSteadyState: retentionDays != null ? Math.round(bytesPerHour * 24 * retentionDays) : null,
  };
}

/**
 * Task disk a run will hold `hours` from now, given how long it has already
 * run. The whole run stays on the task disk (see the header), so this is the
 * rate times the total time.
 */
export function scratchMibAt(mibPerHour: number, hoursSoFar: number, hoursAhead: number): number {
  return Math.max(0, mibPerHour) * (Math.max(0, hoursSoFar) + Math.max(0, hoursAhead));
}

/** Human-readable size for notes and reports. */
export function formatBytes(b: number): string {
  if (b >= 1e12) return `${Math.round(b / 1e11) / 10} TB`;
  if (b >= 1e9) return `${Math.round(b / 1e8) / 10} GB`;
  if (b >= 1e6) return `${Math.round(b / 1e5) / 10} MB`;
  return `${Math.round(b / 1e3)} kB`;
}
