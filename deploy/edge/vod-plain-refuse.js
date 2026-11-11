// ============================================================================
//  VOLT EDGE PLAY TOKENS, ENFORCED: CloudFront Function, viewer-request,
//  cloudfront-js-2.0, on the plain on-demand behaviours /vod/*,
//  /clips/vod/* and /clips/* (deploy/terraform/edge_tokens.tf, only when
//  edge_tokens = "enforce"; build queue P2-2b and P2-2d).
//
//  Under enforce an on-demand title plays only through a play token
//  (/t/<token>/..., checked by vod-token-viewer-request.js), so a copied plain
//  address is refused here with the same words the token check uses for a
//  path it does not open. The console's previews and share pages carry tokens
//  too, so nothing of Volt's own needs a plain path.
//
//  TOKEN-FREE TITLES (build queue P2-2c): a title whose publishing rule asks
//  for token-free playback and that no viewer condition applies to has
//  "f:<asset id>" in the KeyValueStore while it is Available (the value: when
//  that ends, epoch seconds, or 0 for no end; services/edgeTokens.ts
//  syncEdgeOpen). Its plain addresses pass through unchanged. The reference
//  is plainPathVerdict in services/edgeTokens.ts; test/edge-token-free.check.ts
//  runs this file against it.
//
//  CLIP OUTPUT FOLDERS (build queue P2-2d): a clip cut from a recording keeps
//  its files in /clips/<asset id>/ (hls/, clip.mp4), refused plain the same
//  way. The /clips/* behaviour also sees paths that are not titles (ad
//  creatives under /clips/ads/): those pass unchanged, as the reference says.
// ============================================================================
import cf from 'cloudfront';

const kvs = cf.kvs('${kvs_id}');
const GUARD = /^\/(clips\/vod|vod|clips\/[0-9a-fA-F-]{36})\//;
const ID = /^\/(?:clips\/vod|vod|clips)\/([0-9a-fA-F-]{36})\//;

function refuse() {
  return {
    statusCode: 403,
    statusDescription: 'Forbidden',
    headers: { 'cache-control': { value: 'no-store' }, 'content-type': { value: 'text/plain' } },
    body: 'Not available',
  };
}

async function handler(event) {
  const req = event.request;
  if (!GUARD.test(req.uri)) return req;
  const m = ID.exec(req.uri);
  if (!m || req.uri.indexOf('/../') >= 0) return refuse();
  let open = null;
  try { open = await kvs.get('f:' + m[1].toLowerCase()); } catch (e) { open = null; }
  if (open === null || open === undefined) return refuse();
  const until = Number(open);
  if (!(until === 0 || Math.floor(Date.now() / 1000) < until)) return refuse();
  return req;
}
