// ============================================================================
//  Encoder UDP-bus port service.
//
//  The local encoder wires ffmpeg -> Shaka over a block of loopback UDP ports
//  (UDP_BASE_PORT + i per rendition, audio shares +0). The recurring "Could not
//  bind UDP socket, error = 48" (EADDRINUSE) came from launching on a FIXED base
//  (20000) while a previous run's ffmpeg/packager still held it.
//
//  The definitive fix: never pick a busy port. Before each launch we PROBE for a
//  free contiguous block by actually attempting to bind each candidate port. Any
//  port held by a lingering process (even with SO_REUSEADDR) fails the probe and
//  is skipped, so a restart always lands on free ports and can never collide.
//
//  Ports are reserved in-process so concurrent launches don't pick the same block,
//  and released on stop. Probing + reservation together make restarts bullet-proof.
// ============================================================================
import { createSocket } from 'node:dgram';

const BLOCK = 10;          // ports reserved per stream (>= max renditions + audio headroom)
const START = 20000;       // first candidate base
const MAX_BLOCKS = 400;    // scan up to 400 blocks (20000..24000) before giving up

// bases currently handed out (not yet released) so concurrent launches don't clash
const reserved = new Set<number>();

/** True if this loopback UDP port can be bound right now (i.e. nothing holds it). */
function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createSocket('udp4');
    s.once('error', () => { try { s.close(); } catch { /* ignore */ } resolve(false); });
    s.bind(port, '127.0.0.1', () => { s.close(() => resolve(true)); });
  });
}

/**
 * Find and RESERVE a free contiguous UDP base for `count` renditions. Probes each
 * candidate block; the first block whose every port is bindable wins. Call
 * releaseUdpBase(base) when the encoder stops.
 */
export async function reserveUdpBase(count: number): Promise<number> {
  const need = Math.max(1, Math.min(count, BLOCK));
  for (let i = 0; i < MAX_BLOCKS; i++) {
    const base = START + i * BLOCK;
    if (reserved.has(base)) continue;
    let ok = true;
    for (let j = 0; j < need; j++) {
      // eslint-disable-next-line no-await-in-loop
      if (!(await portFree(base + j))) { ok = false; break; }
    }
    if (ok) { reserved.add(base); return base; }
  }
  throw new Error(`no free UDP port block for ${need} port(s) in ${START}..${START + MAX_BLOCKS * BLOCK}`);
}

export function releaseUdpBase(base: number): void {
  reserved.delete(base);
}
