/**
 * Public live delivery.
 *
 * This is the PUBLIC playback surface for a live channel: the URL a viewer app
 * (or the public API) hits to watch. In production this is served by CloudFront;
 * locally it redirects to the origin the control plane already serves.
 *
 * The contract Christian asked for: the public URL ONLY returns the stream when
 * the channel is ON AIR and the output has VALID CONTENT. So:
 *   - off air            -> 404 { available:false, reason:'not_on_air' }  (nothing public)
 *   - on air, no content -> 503 { available:false, reason:'no_valid_content' }
 *   - on air + valid     -> 302 to the CDN (prod) or /origin (local) manifest
 *
 * The On air gate in the console is computed from the SAME two facts (published +
 * valid content), so the gate is green only when this URL would actually serve.
 *
 * NO admin auth: viewers are the public. (Per-viewer account/client tokens hook in
 * here later; the shape is ready for it.)
 */
import { Router } from 'express';
import { one } from '../db';
import { config } from '../config';
import { liveDirFor, liveUrlBase } from '../services/liveOrigin';
import { asyncHandler } from '../util/http';
import { existsSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** GROUND TRUTH: is the channel's origin manifest advancing right now? Shaka rewrites
 *  master.m3u8 / manifest.mpd on every new segment, so a recent mtime = valid content. */
export function outputHasValidContent(channelId: string): boolean {
  try {
    const dir = liveDirFor(channelId);   // per-run namespace: probe the CURRENT run
    if (!existsSync(dir)) return false;
    let newest = 0;
    for (const f of readdirSync(dir)) {
      if (f.endsWith('.m3u8') || f.endsWith('.mpd')) {
        try { const m = statSync(join(dir, f)).mtimeMs; if (m > newest) newest = m; } catch { /* ignore */ }
      }
    }
    return newest > 0 && (Date.now() - newest) < 15000;
  } catch { return false; }
}

/** The public playback URL for a channel (what a viewer/app would open). Relative in
 *  local/dev (served by this box), absolute CDN in production. */
export function publicPlaybackUrl(channelId: string, file: 'master.m3u8' | 'manifest.mpd' = 'master.m3u8'): string {
  return `/live/${channelId}/${file}`;
}

export const publicLiveRouter = Router();

publicLiveRouter.get(
  '/live/:id/:file(master.m3u8|manifest.mpd)',
  asyncHandler(async (req, res) => {
    const { id, file } = req.params;
    const ch = await one<any>('SELECT id, status, on_air FROM channels WHERE id = $1', [id]);
    // Off air: the public URL exposes nothing. This is the whole point of "On means
    // available to the public" — private previews never leak here.
    if (!ch || !ch.on_air) {
      res.status(404).json({ available: false, reason: 'not_on_air' });
      return;
    }
    // On air but the encoder isn't producing valid content -> the public stream is
    // broken; say so honestly rather than 302 to a dead manifest.
    if (ch.status !== 'live' || !outputHasValidContent(id)) {
      res.status(503).json({ available: false, reason: 'no_valid_content' });
      return;
    }
    // Production: the CloudFront distribution in front of S3. Local/dev: the origin
    // this control plane already serves at /origin.
    const cdn = config.aws?.cdnBaseUrl;
    if (cdn && config.env === 'production' && !/example\.com/.test(cdn)) {
      res.redirect(302, `${cdn.replace(/\/$/, '')}/channel/${id}/${file}`);
      return;
    }
    res.redirect(302, `${liveUrlBase(id)}/${file}`);
  })
);
