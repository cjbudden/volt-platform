// ============================================================================
//  RUN SIDECARS — the derived files that are nobody's media object.
//
//  A media object's location points at a RENDITION directory, e.g.
//  <origin>/<stream>/runs/<runId>/720p, and deleting the object removes exactly
//  that. But a run also carries derived files that sit BESIDE the renditions
//  rather than inside them:
//
//      <run>/thumbs/        filmstrip frames and the WebVTT that indexes them
//      <run>/.peaks.json    the decoded audio peak cache the waveform reads
//
//  Nothing owns those. They are not registered as media objects, so no rung
//  ever fires on them and no location ever points at them, which meant a
//  retention delete removed the media they describe and left them behind.
//  Every filmstrip frame of every deleted recording, permanently, uncounted:
//  the storage view could not show them because as far as the lifecycle was
//  concerned they did not exist.
//
//  They are derived, so they are worthless once the media is gone; and they are
//  cheap to regenerate if the media ever comes back. The rule is simply that
//  they go when the last rendition of their run goes.
// ============================================================================
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';

/** Files and directories that belong to a run rather than to one rendition. */
const SIDECARS = ['thumbs', '.peaks.json'];

/** A rendition directory is one that holds an init.mp4, same rule the index uses. */
function isRenditionDir(runDir: string, name: string): boolean {
  try {
    return statSync(join(runDir, name)).isDirectory()
      && existsSync(join(runDir, name, 'init.mp4'));
  } catch { return false; }
}

/**
 * Called after a rendition's bytes have been removed. If that was the LAST
 * rendition in its run, the run's derived files have nothing left to describe,
 * so take them and the now-empty run directory with them.
 *
 * Deliberately conservative: it only acts when no rendition remains, it only
 * ever removes the two known sidecars plus a directory that is then empty, and
 * every failure is swallowed. Reclaiming disk must never be the reason a
 * retention sweep reports a failure on media it has already correctly deleted.
 *
 * Returns the number of bytes reclaimed, for the sweep's own accounting.
 */
export function reclaimRunSidecars(renditionUri: string): number {
  // Only meaningful for on-disk locations. An s3:// or file:// URI is somebody
  // else's namespace and this must not try to reason about it.
  if (/^[a-z0-9+.-]+:\/\//i.test(renditionUri)) return 0;

  const runDir = dirname(renditionUri);
  if (!runDir || !existsSync(runDir)) return 0;
  // Guard against ever walking up out of a run: the parent of a rendition dir
  // must itself sit under a `runs` directory.
  if (basename(dirname(runDir)) !== 'runs') return 0;

  let entries: string[];
  try { entries = readdirSync(runDir); } catch { return 0; }
  if (entries.some((e) => isRenditionDir(runDir, e))) return 0;   // media remains

  let freed = 0;
  for (const name of SIDECARS) {
    const p = join(runDir, name);
    if (!existsSync(p)) continue;
    try {
      freed += sizeOf(p);
      rmSync(p, { recursive: true, force: true });
    } catch { /* the bytes are the point, not the bookkeeping */ }
  }
  // Whatever is left is manifests and logs for media that no longer exists.
  try {
    const left = readdirSync(runDir);
    if (!left.some((e) => isRenditionDir(runDir, e))) {
      freed += sizeOf(runDir);
      rmSync(runDir, { recursive: true, force: true });
    }
  } catch { /* ignore */ }
  return freed;
}

function sizeOf(p: string): number {
  try {
    const st = statSync(p);
    if (!st.isDirectory()) return st.size;
    let total = 0;
    for (const e of readdirSync(p)) total += sizeOf(join(p, e));
    return total;
  } catch { return 0; }
}
