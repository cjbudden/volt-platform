# Design — On-the-fly image service (resize / crop / filter, cached)

## Goal
A high-performance image endpoint in the Volt API library: request any source image
at a target size and treatment via the URL, rendered on demand and cached. Powers
channel logos, thumbnails, watermarks, slates, poster art and portal imagery without
pre-baking every size. Built on **sharp** (libvips) for speed.

## URL grammar
```
/{sig}/{fit}/{WxH}/filter(...)/{path}
```
- **sig** — HMAC signature over the canonical request (see Security). Dev may use
  the literal `unsafe`.
- **fit** — how the image maps into the box:
  - `fit-in` — keep aspect, fit the whole image inside the box (letterbox with a
    `background` filter if a solid colour is given). No cropping.
  - `fill` (alias `cover`) — keep aspect, cover the box and crop the overflow; the
    crop is chosen by **focus**.
  - `stretch` — force exact WxH, ignore aspect (distorts).
- **WxH** — `1920x0` = width 1920, height auto (aspect kept); `0x1080` = height
  1080, width auto; `1920x1080` = exact box. At least one dimension must be non-zero.
- **filter(...)** — optional, comma-separated: `sharpen:N`, `blur:N`, `quality:N`,
  `format:webp|avif|jpeg|png`, `grayscale`, `background:RRGGBB`, and `focus:<g>`.
- **focus** — for `fill` crops: `center` (default), `top`, `bottom`, `left`,
  `right`, `top-left`, `top-right`, `bottom-left`, `bottom-right`, or `smart`
  (content-aware, sharp's attention strategy). Normalised coords (`0.8x0.2`) are a
  planned extension for an exact focal point.
- **path** — the source key in the origin (S3), e.g. `live_channel/TV1.png`.

Matches the shape we've used before, e.g.
`/fit-in/1920x0/live_channel/TV1.png` and
`/fit-in/1920x0/filter(sharpen:100)/live_channel/TV1.png`.

## Mapping to sharp
- `fit-in` → `resize(w, h, { fit: 'inside' })` (or `contain` + `background` to
  letterbox).
- `fill` → `resize(w, h, { fit: 'cover', position })` where `position` is the focus
  gravity, or `sharp.strategy.attention` for `smart`.
- `stretch` → `resize(w, h, { fit: 'fill' })`.
- filters → `grayscale()`, `blur(n)`, `sharpen({sigma})`, and the output encoder
  (`webp/avif/png/jpeg` with quality; jpeg uses mozjpeg).

## Caching
The rendered variant is immutable for a given URL, so it caches hard:
`Cache-Control: public, max-age=31536000, immutable`. A CDN sits in front; the
origin keeps a derivative cache (S3 prefix) keyed by the SHA-256 of the canonical
request. First request renders (MISS) and writes the cache; subsequent requests are
served from cache (HIT). In the prototype, HIT served in ~1.4 ms vs ~150 ms to
render.

## Security (why signing matters)
Unbounded size/filter combinations are a cost and DoS vector (each unique URL is a
render). The service therefore requires an **HMAC signature** over the canonical
path (a per-account or per-service secret), so only URLs your app minted are
rendered. `unsafe` is allowed only in dev. Optionally cap max dimensions and
restrict `format`/filters per plan.

## How it slots into Volt
- A module `src/modules/images.ts` mounts the grammar (public GET, signature-gated,
  no admin session). Source keys resolve to the account's S3 prefix, so an image
  URL only reaches that account's assets.
- Signing helper in the SDK/console so the app builds signed URLs.
- Reuses the same S3 origin + CloudFront as media; image derivatives are just
  another cached object type.
- Feeds: channel/portal logos, VOD posters/thumbnails, watermark previews, slate
  previews, and the file-manager thumbnails.

## Prototype (built + proven)
`volt-image-proto/` — a runnable sharp service. 14/14 assertions (`test.mjs`):
parses the two example URLs; `fit-in 1920x0` → 1920×1080 and `0x600` → 1067×600
(aspect kept); `stretch 600x600` exact/distorted; `fill 600x600` exact box;
`focus:top-right` keeps the focal badge (2.2% red vs 0.2% centre); `format:webp`
converts; `sharpen` changes output; HMAC sign/verify incl. unsafe dev/prod. A
gallery (screenshot delivered) shows fit-in / fill+focus(center/top-right/smart) /
stretch / grayscale+webp / blur over one 2400×1350 source, each tagged cache
HIT/MISS + render ms.

## To productionise
Resolve `{path}` from S3 (per-account prefix) instead of local; put the derivative
cache on S3 + CloudFront; require signatures (drop `unsafe`); add max-dimension and
format guards; wire a URL-signing helper into the console + SDK.
