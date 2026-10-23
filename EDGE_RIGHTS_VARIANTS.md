# Edge rights: manifest variants per rule set

Requirements from Christian, 22 Oct 2026, for time-of-day rights replacement.
This supersedes the single `_rp` replacement playlist in the 20 Oct edge-rights
build (`deploy/edge/rights-viewer-request.js`, `services/edgeRights.ts`).

## What it must do

1. **Decided at the CDN, per viewer.** On every manifest request the edge
   decides, from the viewer's country and their access rights, which version of
   the stream they get. The play address never changes.
2. **Time of day from the guide.** Blackout and replace windows come from the
   EPG (programme rights: countries, allow or block, block or replace, and the
   replacement asset), so a viewer in Malaysia gets the normal stream while a
   viewer in Australia gets a loop over the same programme.
3. **Several versions at once.** Different audiences can have different windows
   at the same moment (AU replaced 20:00 to 21:00, NZ 21:00 to 22:00): at 21:30
   an AU viewer gets the normal stream and an NZ viewer the loop. One `_rp`
   playlist cannot express that.
4. **Delivery side only.** Nothing in the encoder, the origin's own playlists,
   the segments or the recordings changes. Recording, DVR, clipping and auto-VOD
   read the untouched output.
5. **Smooth.** Switches land on segment boundaries with a discontinuity, and the
   replacement is pre-packaged to the channel's own ladder (the same pre-built
   loop failover uses, `services/fillerPrep.ts`), so players do not stall or
   change codec mid-variant. A loop of any length repeats to fill the window
   and is cut at its end (a 5 minute loop over a 20 minute window plays four
   times). PROGRAM-DATE-TIME stays continuous.
6. **Scales.** Work grows with the number of distinct rule outcomes, never with
   viewers.

## Design

**Variants, not viewers.** For a stream, the control plane reduces the active
rules to a small set of *variants*: each is one replace timeline (a list of
windows and the asset for each). Every audience whose rules produce the same
timeline shares a variant. Typical channels have one to a handful.

- Variant key: a short stable hash of its timeline (`v` + 8 hex), so it is the
  same on every edge and cache entry.
- The KeyValueStore entry for the stream (`s:<id>`) lists the variants and, per
  rule, which variant it maps to. The viewer-request function picks
  `allow` / `block` / `replace:<key>` and rewrites the URI to
  `/live/<id>/v/<key>/<file>`. Allow keeps the normal path.

**Variant manifests are made on the delivery side, not by the encoder.** A small
stateless manifest service (part of the control plane, or its own ECS service
when it needs to scale separately) answers `/live/<id>/v/<key>/<playlist>`:
it reads the current delivered playlist, and for segments inside a replace
window substitutes the pre-packaged replacement segments for the matching
rendition, with `EXT-X-DISCONTINUITY` at each boundary and at each loop wrap
(HLS), or a new Period (DASH). It holds no state beyond a short cache.

**Caching.** CloudFront caches each variant manifest for about one segment
(the same `liveRedirectMaxAgeSec` rule as today), with Origin Shield in front of
the manifest service, so origin load is roughly
variants × renditions ÷ segment duration, independent of audience size.
Replacement segments are immutable and cache for a long time. Main segments are
unchanged and shared by every variant.

**Access rights at the edge.** Country comes from `CloudFront-Viewer-Country`.
Access rights (for example a subscription tier that is exempt from a blackout)
come from the playback token the play gate already issues: it carries a short
`rc` (rights class) claim, HMAC-signed, which the CloudFront Function verifies
with the key held in the KeyValueStore (cloudfront-js-2.0 has `crypto`
HMAC). No valid claim means the default class. Entitlement to watch at all
stays with the play gate, as today.

**One decision function, tested twice.** The decide logic exists in two places
by necessity (the CloudFront Function cannot import from the app): the edge
function and `services/edgeRights.ts`. A parity test runs both against the same
fixture table (countries, classes, times, windows) and fails on any
difference.

## Testing it from the admin side

A **Rights preview** on the channel and event pages (and an API for it):

- Choose a country, a rights class and a time (now, or any time in the guide).
- It shows the decision (normal, replaced with which asset, blocked), the
  variant key, and why (which rule).
- It plays that exact variant through a private, admin-only path
  (`/origin/<id>/v/<key>/...` behind admin auth), so what the operator watches
  is byte for byte what that viewer would get, including the loop wraps.
- A 24 hour strip per audience shows when each audience is replaced or blocked,
  read from the same variant table, to spot a window that is wrong before it
  airs.

`GET /api/channels/:id/access-check` (and the event version from queue item
1.2) already answers the play-gate side for a country and viewer type; the
preview adds the edge decision and the playable variant beside it.

## On the Mac first (single server), then the cloud

Christian, 22 Oct: this has to be testable on the Mac before the AWS setup.

- **Local edge.** There is no CloudFront on the Mac, so the API's public route
  (`/live/<id>/<file>`, `modules/publicLive.ts`) runs the same decision
  (`services/edgeRights.ts`) and serves the variant from the same manifest
  service. Only the place the decision runs differs; the variants are identical.
- **Pretend to be a viewer.** In development only (never in production), the
  public route accepts a test country and rights class
  (`?as=AU&rc=standard`, or the `X-Volt-Test-Country` / `X-Volt-Test-Rights`
  headers), so two browser tabs can play the AU and MY versions side by side.
  Production ignores them and uses `CloudFront-Viewer-Country` and the signed
  claim.
- **Pretend it is a different time.** Also development only: `&at=<ISO time>`
  evaluates the rules as of that time, so a 20:00 window can be tested at 15:00.
  The Rights preview uses the same parameter through its admin-only path.
- **Same parity fixtures.** The parity test runs the edge function file itself
  (loaded in Node with a stubbed `cloudfront` module), so the Mac path and the
  CloudFront path are proven to decide the same way before anything is
  deployed.
- The Mac end-to-end run sheet (queue 1.15) includes a rights step: AU at a
  replace time gets the loop, MY gets the normal stream, the recording is
  unchanged.

## Built so far

- 23 Oct 2026, queue 1.14a: the reducer, the store value (`vm`, exempt classes, `vs`), the signed rights-class claim (`vrc`, key at `k:rc`), the edge decision and rewrite to `/<kind>/<id>/v/<key>/`, and the same decision on the Mac's public route with `?as`, `&rc` and `&at`. Tests: `volt-app/test/edge-variants.check.ts`. Exempt classes are read from `programmes.metadata.rights_exempt` for now. Until the manifest service (1.14b) runs, a replace is enforced as a block.
- 23 Oct 2026, queue 1.14b: the manifest service, `volt-app/src/services/variantManifest.ts`, answering `/live/<id>/v/<key>/<file>` (the Mac's public route redirects a replaced viewer there, test stand-ins carried along) and `/channel|event/<id>/v/<key>/<file>` (where the edge function sends a rewritten request, picking the `variants` origin by id). It reads the delivered playlist (from disk on the Mac, from S3 in the cloud, shared through a 1 s cache) and, inside each window, puts the stream's pre-built loop in place of the live segments: HLS slot for slot (the live segment's duration and PROGRAM-DATE-TIME kept, discontinuity and the loop's init at the window start, at every wrap and at the window end, the discontinuity sequence worked out from the windows so it holds as the playlist slides; subtitles get an empty WebVTT, an encrypted stream announces the clear loop), DASH as Periods (live cut at the window edges, one Period per pass of the loop from loop time 0, only what is available). It answers each viewer with their own variant whatever the key says (so a key is a cache name, not a permission; a viewer whose window closed gets the normal stream through the same path), 451 for a block, the normal on-air rules, and 503 rather than the programme when the loop is missing or a rendition has no match. On outside production by default (`EDGE_VARIANT_SERVICE=0` turns it off), on in the cloud when Terraform sets `EDGE_VARIANT_SERVICE=1`. Terraform: the `variants` origin (the control plane's load balancer, Origin Shield in the stack's region), `/channel/*/v/*` and `/event/*/v/*` behaviours with the rights function, an origin request policy passing the country and the `vrc` claim, the load balancer's public path rule. Tests: `volt-app/test/edge-variant-manifests.check.ts`. Every replacement window uses the stream's own pre-built loop (the failover loop), whatever asset the programme names.

## What stays the same

- Segment paths, the encoder, recordings, DVR, clipping: untouched.
- No rules for a stream, or an unreadable store: fail open, as today, with the
  play gate still enforcing.
- Account and channel geo blocks: still a 451 at the edge.
