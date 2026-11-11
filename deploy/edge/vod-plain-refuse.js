// ============================================================================
//  VOLT EDGE PLAY TOKENS, ENFORCED: CloudFront Function, viewer-request,
//  cloudfront-js-2.0, on the plain on-demand behaviours /vod/* and
//  /clips/vod/* (deploy/terraform/edge_tokens.tf, only when
//  edge_tokens = "enforce"; build queue P2-2b).
//
//  Under enforce an on-demand title plays only through a play token
//  (/t/<token>/..., checked by vod-token-viewer-request.js), so a copied plain
//  address is refused here with the same words the token check uses for a
//  path it does not open. The console's previews and share pages carry tokens
//  too, so nothing of Volt's own needs a plain path.
// ============================================================================
function handler(event) {
  return {
    statusCode: 403,
    statusDescription: 'Forbidden',
    headers: { 'cache-control': { value: 'no-store' }, 'content-type': { value: 'text/plain' } },
    body: 'Not available',
  };
}
