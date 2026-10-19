/**
 * EDGE HELPERS: where a viewer is, and what the edge may cache.
 *
 * Geo. The play gate used to take the viewer's country from the request body,
 * which the viewer controls. Behind CloudFront the country comes from the
 * CloudFront-Viewer-Country header CloudFront itself sets (and the staging
 * nginx sets X-Viewer-Country). With TRUST_EDGE_GEO=true that header wins and
 * the body is ignored. Off by default, because on a box reached directly a
 * client could send the header itself.
 *
 * Caching. Responses that are the same for every anonymous viewer of an app,
 * asset and country are marked `s-maxage` so CloudFront (or nginx in staging)
 * answers repeat requests without reaching the API. `max-age=0` keeps
 * browsers from holding a token past its life.
 */
import type { Request, Response } from 'express';
import { scaleConfig } from './config';

export function viewerGeo(req: Request, fromClient?: string | null): string | undefined {
  const e = scaleConfig.edge;
  if (e.trustGeoHeader && (!e.sharedSecret || req.get('x-volt-edge') === e.sharedSecret)) {
    for (const h of scaleConfig.edge.geoHeaders) {
      const v = req.get(h);
      if (v && /^[A-Za-z]{2}$/.test(v)) return v.toUpperCase();
    }
  }
  const c = fromClient ?? undefined;
  return c && /^[A-Za-z]{2}$/.test(c) ? c.toUpperCase() : undefined;
}

/** Shared-cache for `sec` seconds at the edge, never in the browser. */
export function edgeCache(res: Response, sec: number, varyByViewer = false): void {
  const s = Math.floor(sec);
  if (s <= 0) return noStore(res);
  res.setHeader('Cache-Control', `public, max-age=0, s-maxage=${s}`);
  // nginx (the staging edge) reads its cache time from X-Accel-Expires and
  // does not pass the header on; CloudFront reads s-maxage.
  res.setHeader('X-Accel-Expires', String(s));
  // CloudFront keys on its cache policy, not Vary; nginx (staging) honours Vary.
  if (varyByViewer) res.setHeader('Vary', ['Origin', ...scaleConfig.edge.geoHeaders].join(', '));
}

export function noStore(res: Response): void {
  res.setHeader('Cache-Control', 'private, no-store');
}
