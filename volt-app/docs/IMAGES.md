# Image service: resize, crop and filter images by URL

The image service turns any image in an account's library into the size,
crop and treatment a page, player, app or partner feed needs, on request.
Nothing is pre-generated. The first request for a URL renders it with sharp
(libvips), and every request after that is served from cache: memory, then the
derivative cache in S3, then the CDN edge.

It is part of the control plane (`src/modules/images.ts`). It runs with no
setup on a laptop and is deployed to the cloud by the same Terraform stack as
the rest of Volt.

- [1. Quick start](#1-quick-start)
- [2. Anatomy of an image URL](#2-anatomy-of-an-image-url)
- [3. Resize options](#3-resize-options)
- [4. Crop and focus](#4-crop-and-focus)
- [5. Filters](#5-filters)
- [6. Output format and quality](#6-output-format-and-quality)
- [7. Recipes](#7-recipes)
- [8. Signing URLs](#8-signing-urls)
- [9. Path-style URLs (older shape)](#9-path-style-urls-older-shape)
- [10. Limits and errors](#10-limits-and-errors)
- [11. Caching and scale](#11-caching-and-scale)
- [12. Configuration](#12-configuration)
- [13. Running and testing locally](#13-running-and-testing-locally)
- [14. Deploying to AWS](#14-deploying-to-aws)
- [15. Operations](#15-operations)
- [16. Moving from the earlier unsigned URLs](#16-moving-from-the-earlier-unsigned-urls)
- [17. Upload metadata and library search](#17-upload-metadata-and-library-search)
- [Encoder thumbnails, sprite sheets and hover previews: THUMBNAILS.md](THUMBNAILS.md)

---

## 1. Quick start

**In the console.** Open **Media > Image Library**, upload an image, select it
and choose **URL builder**. Set the size, drag the focus crosshair or draw a
crop, pick filters and a format, then **Copy**. The URL is signed and ready to
paste into a page, an app or a feed.

**From the API.** Sign a URL with an admin session or an account secret key:

```bash
curl -s -X POST "$API/api/images/sign" \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"path":"posters/grand-final.png","width":1280,"height":720,"format":"webp"}'
```

```json
{
  "url": "https://img.example.com/img/Xq3f0Yp1Lk7m2Hc9Rr4tUw/1280x720,cover,v=20261015120000/library/6f1e.../posters/grand-final.png",
  "path": "/img/Xq3f0Yp1Lk7m2Hc9Rr4tUw/1280x720,cover,v=20261015120000/library/6f1e.../posters/grand-final.png",
  "key": "library/6f1e.../posters/grand-final.png",
  "spec": "1280x720,cover,v=20261015120000",
  "signature": "Xq3f0Yp1Lk7m2Hc9Rr4tUw",
  "expires": null
}
```

The `url` needs no token. Put it in an `<img>` tag, a player poster, an EPG
feed or an email.

**From your own code**, with no round trip per image (section 8):

```ts
import { imageUrl } from '@volt/image-url';

const src = imageUrl({
  baseUrl: 'https://img.example.com',
  key: `library/${accountId}/posters/grand-final.png`,
  accountKey,                       // GET /api/images/signing-key, once
  width: 640, height: 360, focus: 'smart', format: 'avif',
});
```

## 2. Anatomy of an image URL

```
https://img.example.com/img/Xq3f0Yp1Lk7m2Hc9Rr4tUw/640x360,cover,focus=30-20,gray,q=70/library/{accountId}/slates/break.png
\_____________________/\__/\____________________/ \____________________________________/ \_____________________________/
   image base URL      route      signature            spec: size, fit, options                 store key (the image)
```

| Part | What it is |
|---|---|
| Image base URL | The image CDN in the cloud (`IMAGE_PUBLIC_BASE_URL`), the API itself locally. |
| Signature | 22 characters. Proves the URL was minted for this account (section 8). Unsigned URLs are refused. |
| Spec | `{W}x{H},{fit}` then options, comma-separated, in any order. The SDK and the console always write them in one canonical order. |
| Store key | `library/{accountId}/{path}` for library images, `derived/{accountId}/{path}` for generated keyframes. Each path segment is percent-encoded (spaces as `%20`). |

## 3. Resize options

**Size.** `{W}x{H}` in pixels. Use `0` for one side to keep the source's
aspect ratio: `1920x0` is 1920 wide with the height that fits, `0x1080` is 1080
tall. At least one side must be non-zero.

**Fit.** How the image maps into the box:

| Fit | Behaviour | Typical use |
|---|---|---|
| `cover` (default) | Fills the box exactly, cropping the overflow. What is kept is decided by `focus`. | Thumbnails, tiles, hero images |
| `inside` | The whole image, scaled to fit within the box. Output can be smaller than the box on one side. | Logos, artwork you must not crop |
| `contain` | The whole image, letterboxed to exactly the box. Bars are transparent, or the `bg` colour. | Fixed-size slots that cannot crop |
| `fill` | Stretched to exactly the box, ignoring aspect ratio. | Rarely: backgrounds that blur anyway |

**Enlargement.** By default an image is never scaled up past its own size (a
400 px logo asked for at 1200 px comes back at 400 px). Add `up` to allow it.

**Vector art (SVG)** is rasterised at the resolution the output needs, so it
stays sharp at any size. The service never serves SVG back: the output is
always a raster format.

## 4. Crop and focus

| Option | Example | Meaning |
|---|---|---|
| `crop=X-Y-W-H` | `crop=25-0-50-100` | Hard crop applied first, in percent of the source: keep the region starting X% across and Y% down, W% wide and H% tall. The example keeps the middle half. |
| `focus=X-Y` | `focus=80-20` | For `cover`: the point (percent of the source) to keep in frame. The crop window is centred on it and slides to stay inside the image. Works together with `crop`. |
| `focus={gravity}` | `focus=top-right` | For `cover`: keep this edge or corner. `center`, `top`, `bottom`, `left`, `right`, `top-left`, `top-right`, `bottom-left`, `bottom-right`. |
| `focus=smart` | | Content-aware: keeps the region with the most visual interest (libvips attention: skin tones, saturation, edges). |
| `focus=entropy` | | Content-aware: keeps the region with the most detail. |

In the console's URL builder the focus is a crosshair you drag and the crop is
a rectangle you draw. The blue outline shows exactly what a `cover` resize at
the current size will keep.

## 5. Filters

Filters run after resizing, in this order: brightness and saturation, gray,
blur, sharpen.

| Option | Range | Effect |
|---|---|---|
| `gray` | | Grayscale. |
| `blur=N` | 0.3 to 50 | Gaussian blur, N is the sigma in pixels of the output. 2 to 4 softens, 20+ makes a background wash. |
| `bright=N` | 10 to 300 | Brightness in percent. 100 is unchanged. |
| `sat=N` | 0 to 300 | Saturation in percent. 100 is unchanged, 0 removes colour. |
| `sharp` | | Light sharpen (sigma 1), good after downscaling photos. |
| `sharp=N` | 0.3 to 10 | Sharpen with sigma N. |
| `bg=RRGGBB` | hex | Fill colour for `contain` bars, and for transparent areas when the output is JPEG (default white). |

## 6. Output format and quality

| Option | Values | Default |
|---|---|---|
| `fmt=` | `webp`, `avif`, `jpeg`, `png` | `webp` |
| `q=` | 1 to 100 (ignored for PNG) | 80 |
| `v=` | 1 to 32 letters or digits | none |

- **webp** is the right default: small, and every current browser shows it.
- **avif** is 20 to 30% smaller again, but the first render is slower. Good for
  large hero images served many times.
- **jpeg** for systems that only take JPEG (some EPG and partner feeds). Encoded
  with mozjpeg.
- **png** when you need lossless output or transparency in a format older
  systems accept.

`v=` changes the URL without changing the image. `POST /api/images/sign` adds
the image's upload time automatically, so an image that is deleted and
uploaded again at the same path gets new URLs (rendered URLs are cached for a
year, so the old ones keep the old picture).

Metadata (EXIF, GPS, colour profiles other than sRGB) is stripped from every
output. EXIF orientation is applied first, so photos from phones come out the
right way up and crop percentages refer to the picture as people see it.

## 7. Recipes

| Need | Spec |
|---|---|
| Channel logo in a list, never cropped | `160x160,inside` |
| Square avatar, face-aware | `256x256,cover,focus=smart` |
| 16:9 card thumbnail | `640x360,cover` |
| Poster for a player, sharp and small | `1280x720,cover,sharp,fmt=avif,q=60` |
| EPG feed icon for a partner that wants JPEG | `256x256,inside,fmt=jpeg,q=85` |
| Logo letterboxed on brand colour | `800x450,contain,bg=0b1020` |
| Blurred backdrop behind a player | `480x270,cover,blur=25,bright=70,q=50` |
| Black-and-white "off air" slate | `1280x720,cover,gray,bright=80` |
| Top half of a portrait photo | `600x400,cover,crop=0-0-100-50` |
| Full width, natural height | `1920x0,inside` |

## 8. Signing URLs

**Why.** Each distinct URL is a render. Without signatures anyone could request
endless size and filter combinations (a cost and denial-of-service lever), or
fetch any account's images by guessing paths. The service renders only URLs
signed with the key of the account that owns the image. There is no unsigned
or "unsafe" mode in any environment.

**Keys are per account.** The account key is derived on the server from a
master secret and the account id. The account id in the image path decides
which key verifies a URL, so a key given to account A cannot produce a working
URL for account B's images. The master secret never leaves the server.

**Three ways to get signed URLs:**

1. **`POST /api/images/sign`** (admin session or account secret key). Options in,
   URL out. Send `{"items": [...]}` for up to 100 at once. Simplest for
   back-ends that make a few URLs at a time.

   ```json
   {
     "path": "posters/grand-final.png",
     "width": 1280, "height": 720, "fit": "cover",
     "focus": { "x": 70, "y": 30 },
     "crop": { "x": 0, "y": 0, "w": 100, "h": 80 },
     "grayscale": false, "blur": 0, "brightness": 100, "saturation": 100,
     "sharpen": true, "background": "000000",
     "format": "webp", "quality": 80, "enlarge": false
   }
   ```

   `path` is relative to the account's library (or a full
   `library/{accountId}/...` key). `focus` may also be a gravity string. You can
   pass a ready spec instead of options: `{"path": "...", "spec": "640x360,cover,gray"}`.
   The same limits as rendering apply, so a URL that signs is a URL that renders.

2. **The account key + the SDK.** `GET /api/images/signing-key` returns the
   account's key. Sign locally with `@volt/image-url` (`packages/image-url`),
   which has no dependencies and runs in Node, browsers, workers and React
   Native. This is what the console does, and the right choice for apps that
   build many URLs. Treat the key like an API secret: anyone holding it can
   create renders of that account's images (within the limits).

   ```ts
   import { imageUrl, imageSpec, signedImageUrlForSpec } from '@volt/image-url';

   imageUrl({ baseUrl, key, accountKey, width: 320, height: 180, focus: { x: 50, y: 30 } });
   signedImageUrlForSpec(accountKey, '320x180,cover,gray', key, baseUrl);
   imageSpec({ width: 320, height: 180, grayscale: true });   // '320x180,cover,gray'
   ```

3. **Inside the control plane:** `signedImageUrl(key, options)` from
   `src/modules/images.ts` (the XMLTV export uses it for channel icons).

**The algorithm,** for any other language:

```
text      = "{spec}/{key}"                          decoded, e.g. "640x360,cover/library/acc/a b.png"
signature = base64url( HMAC-SHA256( base64url_decode(accountKey), utf8(text) )[0:16] )   22 chars
url       = "{base}/img/{signature}/{spec}/{key, each segment percent-encoded}"
```

```python
import base64, hashlib, hmac, urllib.parse
def image_url(base, account_key, spec, key):
    k = base64.urlsafe_b64decode(account_key + '=' * (-len(account_key) % 4))
    sig = base64.urlsafe_b64encode(hmac.new(k, f"{spec}/{key}".encode(), hashlib.sha256).digest()[:16]).rstrip(b'=').decode()
    enc = lambda p: '/'.join(urllib.parse.quote(s, safe=",=:()@!*'") for s in p.split('/'))
    return f"{base}/img/{sig}/{enc(spec)}/{enc(key)}"
```

**URLs do not expire.** An expiring URL would be a new URL every time and could
never be cached. To withdraw an image, delete it from the library (and see
section 15 for purging the CDN).

## 9. Path-style URLs (older shape)

URLs in the shape of the earlier image service are still understood, behind a
signature like any other:

```
/img/{sig}/{fit}/{W}x{H}[/smart][/filter(k:v,...)]/{key}
/img/{sig}/fit-in/1920x0/filter(sharpen:100,format:webp)/library/{accountId}/live_channel/TV1.png
```

| Path style | Same as |
|---|---|
| `fit-in` | `inside` (or `contain` when a background is given and both sides are set) |
| `fill`, `cover` | `cover` |
| `stretch` | `fill` |
| `smart` segment, `focus:smart` | `focus=smart` |
| `focus:top-right` | `focus=top-right` |
| `focus:0.8x0.2` | `focus=80-20` |
| `sharpen:N` (0 to 1000) | `sharp=` 0.5 + N/100 |
| `blur:N`, `quality:N`, `grayscale`, `background:RRGGBB` | `blur=N`, `q=N`, `gray`, `bg=` |
| `format:webp\|avif\|jpeg\|jpg\|png` | `fmt=` |

Differences from the compact form: path style allows enlargement, uses quality
82, and without `format:` keeps the source's format (PNG stays PNG, anything
else becomes JPEG). New integrations should use the compact form.

## 10. Limits and errors

Requests outside a limit are **refused, not clamped**, so a caller never gets a
different image from the one it signed for.

| Limit | Default | Setting |
|---|---|---|
| Largest output side | 4096 px | `IMAGE_MAX_DIMENSION` |
| Largest output area | 16,777,216 px (4096 x 4096) | `IMAGE_MAX_OUTPUT_PIXELS` |
| Largest source file | 40 MB | `IMAGE_MAX_SOURCE_BYTES` |
| Largest source area (decompression bombs) | 100 megapixels | `IMAGE_MAX_INPUT_PIXELS` |
| Output formats | webp, avif, jpeg, png | `IMAGE_FORMATS` |
| Render time | 20 s | `IMAGE_RENDER_TIMEOUT_S` |
| Source types | png, jpg, jpeg, webp, avif, gif (first frame), tif, tiff, svg, heic, heif | |

| Status | When | Cached at the edge |
|---|---|---|
| 200 | Rendered or served from cache. `X-Image-Cache` says which: `MISS`, `MEMORY`, `HIT`. | 1 year |
| 304 | `If-None-Match` matched (the ETag is the signature). | |
| 400 | Bad spec, unknown option, out-of-range value, over a size limit, format not enabled. | 5 min |
| 403 | No signature, wrong signature, or signed for another account. | 1 min |
| 404 | No such image, or a path outside `library/` and `derived/`. | 1 min |
| 413 | Source file or source pixel count over the limit. | 5 min |
| 415 | Source is not an image type the service reads. | 5 min |
| 422 | Source could not be decoded (corrupt or truncated). | 5 min |
| 503 | Renderer saturated (see `IMAGE_MAX_QUEUE`) or render timed out. `Retry-After: 2`. | never |

Errors are JSON: `{"error": "size exceeds the 4096px limit"}`.

## 11. Caching and scale

```
viewer ─> CloudFront edge ── hit ─> done (1 year, immutable)
             │ miss
             v
          S3 images bucket, img-cache/img/{sig}/{spec}/{key} ── hit ─> done (no API involved)
             │ 403/404 (origin group failover)
             v
          ALB ─> api-public task
                   memory LRU ── hit ─> done
                   S3 cache   ── hit ─> done (another task rendered it)
                   single-flight per URL ─> render limiter ─> source (S3, size-checked)
                   ─> sharp ─> answer, and write img-cache/{path} in the background
```

- **Each derivative is rendered once, globally.** The API writes it to S3 at
  exactly the path CloudFront reads, so after the first render any edge in the
  world fetches it from S3 without touching the API.
- **Concurrent identical requests render once** (single-flight), even across
  a burst when a page with the same thumbnail goes live.
- **Renders are bounded.** At most `IMAGE_MAX_CONCURRENT` at once per task
  (default: CPU count), up to `IMAGE_MAX_QUEUE` waiting, beyond that 503. The
  api-public tier autoscales on requests and CPU (SCALING.md), so sustained
  load adds tasks instead of growing queues.
- **Hot items stay in memory:** a per-task LRU of derivatives
  (`IMAGE_MEMORY_CACHE_MB`) and of source images (`IMAGE_SOURCE_CACHE_MB`), so
  ten sizes of one logo fetch the original from S3 once.
- **Headers:** `Cache-Control: public, max-age=31536000, immutable`,
  `ETag` = signature, `Access-Control-Allow-Origin: *` and
  `Cross-Origin-Resource-Policy: cross-origin` (so images work in canvases and
  on other sites), `X-Content-Type-Options: nosniff`,
  `Content-Security-Policy: default-src 'none'`, `Server-Timing: render;dur=N`
  on renders.
- **The CDN cache key is the path only.** No cookies, query strings or headers,
  so every viewer of a URL shares one cache entry.
- **Storage housekeeping.** Derivatives in S3 expire after
  `image_cache_expire_days` (180) and are re-rendered on demand if asked for
  again. Originals are versioned, and replaced or deleted originals are
  recoverable for 30 days.

Measured render times (2 vCPU, a worst-case 2400 x 1350 noise PNG of 8.5 MB,
median of five): 640 x 360 WebP or JPEG about 90 ms, a 320 x 180 smart crop
about 70 ms, 640 x 360 AVIF about 330 ms. Ordinary photos and logos decode much
faster. Memory hits answer in a few milliseconds, and in the cloud repeat
requests never reach the API at all.

## 12. Configuration

Every setting has a safe default. Locally you need to set nothing.

| Variable | Default | What it does |
|---|---|---|
| `IMAGE_SIGNING_SECRET` | `dev-image-signing-secret` outside production; **required** in production | Master secret. Per-account keys are derived from it. Production refuses to start without a random value of 32+ characters. |
| `IMAGE_SIGNING_SECRET_PREVIOUS` | empty | Still verifies during a rotation (section 15). |
| `IMAGE_PUBLIC_BASE_URL` | `PUBLIC_BASE_URL` | Base of every signed URL. The image CDN in the cloud. When set, the console loads previews from it too. |
| `IMAGE_STORE_DRIVER` | `local` | Where originals live: `local` (directory) or `s3`. |
| `IMAGE_STORE_DIR` | `./image-store` | Local originals (`library/`, `derived/`). |
| `IMAGE_S3_BUCKET`, `IMAGE_S3_PREFIX` | `S3_BUCKET`, empty | S3 originals. |
| `IMAGE_CACHE_DRIVER` | follows `IMAGE_STORE_DRIVER` | Derivative cache: `local`, `s3` or `none`. |
| `IMAGE_CACHE_DIR` | `{IMAGE_STORE_DIR}/cache` | Local derivative cache. |
| `IMAGE_CACHE_S3_BUCKET`, `IMAGE_CACHE_S3_PREFIX` | image bucket, `img-cache` | S3 derivative cache. Must match the CloudFront origin path. |
| `IMAGE_CACHE_CONTROL` | `public, max-age=31536000, immutable` | Cache-Control on renders and cached objects. |
| `IMAGE_MAX_DIMENSION`, `IMAGE_MAX_OUTPUT_PIXELS`, `IMAGE_MAX_INPUT_PIXELS`, `IMAGE_MAX_SOURCE_BYTES`, `IMAGE_FORMATS`, `IMAGE_RENDER_TIMEOUT_S` | see section 10 | Guards. |
| `IMAGE_MAX_CONCURRENT` | CPU count (min 2) | Renders at once per task. |
| `IMAGE_MAX_QUEUE` | 200 | Renders waiting before 503. |
| `IMAGE_MEMORY_CACHE_MB` | 64 | Derivatives kept in memory per task. |
| `IMAGE_SOURCE_CACHE_MB` | 128 | Source images kept in memory per task. |
| `IMAGE_VIPS_THREADS` | libvips default | Threads libvips uses per render. |
| `S3_FORCE_PATH_STYLE`, `AWS_ENDPOINT_URL_S3` | off, AWS | Point the S3 drivers at MinIO or LocalStack. |

## 13. Running and testing locally

**Everyday development:** `bash run-on-mac.sh` from the repository root. The
image service is part of the API on :8080. Originals go to
`volt-app/image-store/library/`, rendered derivatives to
`volt-app/image-store/cache/` (both git-ignored), and the dev signing secret is
used. Open the console, upload to **Media > Image Library** and use the URL
builder.

**Production image, local disk:** `docker compose up --build` in `volt-app/`.
The container runs with `NODE_ENV=production`, so compose supplies a local
signing secret. Originals and cache live in the `images` volume.

**Production image, S3 code path (MinIO):**

```bash
cd volt-app
docker compose -f docker-compose.yml -f docker-compose.s3.yml up --build
```

This adds MinIO (console http://localhost:9001, `volt` / `voltvoltvolt`) with a
`volt-images` bucket, and points both the library and the derivative cache at
it, exactly as in the cloud: originals under `library/`, derivatives under
`img-cache/img/...` with their Content-Type and Cache-Control.

**Tests** (from `volt-app/`):

| Command | Covers | Needs |
|---|---|---|
| `npm run test:images` | SDK maths against node:crypto, SDK and server signatures agree, both grammars, every guard, per-account keys, rotation, the sharp pipeline (fits, focus, crop, formats, EXIF, SVG, bombs), memory/disk/S3 caches, single-flight, the busy limiter, the HTTP route, the signing API, SDK copies in sync | nothing |
| `npm run test:images:api` | The real control plane: upload, signing key, sign (incl. the first published request shape), render, refusals, tenancy, batch, stats | Postgres (`DATABASE_URL`) |
| `npm run test:images:s3` | The S3 drivers against a real S3 API: originals, derivative path, metadata CloudFront serves | an S3 endpoint (below) |
| `node scripts/check.js images` | All of the above that can run, each on its own database | Postgres |
| `cd ../packages/image-url && npm test` | The published SDK, built | nothing |

```bash
# S3 check against the compose MinIO
IMAGES_S3_TEST_BUCKET=volt-images AWS_ENDPOINT_URL_S3=http://localhost:9000 S3_FORCE_PATH_STYLE=1 \
AWS_ACCESS_KEY_ID=volt AWS_SECRET_ACCESS_KEY=voltvoltvolt npm run test:images:s3
```

After editing `src/services/images/sdk.ts`, run `npm run images:sdk-sync` to
copy it into the console and the package (the check fails until you do).

## 14. Deploying to AWS

`deploy/terraform/images.tf` adds everything; `terraform apply` as usual.

| Resource | Purpose |
|---|---|
| `aws_s3_bucket.images` (`{project}-{env}-images`) | Originals (`library/`, `derived/`, private, versioned) and the derivative cache (`img-cache/`, expires after 180 days). |
| `aws_cloudfront_distribution.images` | The image CDN. Origin group: S3 `img-cache/` first, the ALB on 403/404. Path-only cache key, 1-year TTL from the origin, HTTP/2 and 3, CORS and security headers. |
| `aws_secretsmanager_secret.images` | `IMAGE_SIGNING_SECRET` (random, 48 chars) and `IMAGE_SIGNING_SECRET_PREVIOUS`. |
| IAM | Control-plane tasks read and write the bucket. The execution role reads the secret. CloudFront may read `img-cache/*` only. |
| `local.image_env`, `local.image_secrets` | Passed to every control-plane role (api-admin, api-public, scheduler, worker). |

Variables: `enable_image_edge` (true), `image_edge_aliases` and
`image_edge_certificate_arn` (custom domain such as `img.example.com`, ACM
certificate in us-east-1), `image_edge_price_class`,
`image_edge_origin_protocol` (set `https-only` once the ALB has HTTPS),
`image_cache_expire_days`, `image_max_dimension`, `image_formats`,
`images_force_destroy` (false: `terraform destroy` will not delete customer
originals unless you set it).

Outputs: `image_cdn_base_url` (also passed to the tasks as
`IMAGE_PUBLIC_BASE_URL`) and `images_bucket`. Point your image domain's DNS at
the distribution when you use an alias.

Before this release the library had no S3 settings in Terraform, so cloud
tasks kept images on their own disk. If you set `IMAGE_STORE_DRIVER=s3` by
hand against another bucket, copy the library across once:
`aws s3 sync s3://{old-bucket}/library s3://{images-bucket}/library`.

## 15. Operations

- **Counters:** `GET /api/images/stats` (any admin session) returns this task's
  requests, memory and cache hits, renders, total render milliseconds (divide
  by renders for the average), rejections by status, busy refusals, and what is rendering and queued now.
- **Logs:** cache read or write failures and render errors are logged with the
  `[images]` prefix. A failed cache write never fails a request.
- **Rotating the signing secret:** in the `{project}-{env}/images` secret, copy
  the current `IMAGE_SIGNING_SECRET` into `IMAGE_SIGNING_SECRET_PREVIOUS`, set a
  new random `IMAGE_SIGNING_SECRET`, and force a new deployment. Old URLs keep
  working, new URLs use the new key. When pages, apps and feeds have refreshed,
  clear `PREVIOUS` and redeploy. Terraform ignores later changes to this secret,
  so it will not undo a rotation.
- **Withdrawing an image now:** delete it from the library, then invalidate the
  CDN (`aws cloudfront create-invalidation --distribution-id ... --paths '/img/*'`)
  and remove its derivatives (`aws s3 rm s3://{images-bucket}/img-cache/img/ --recursive --exclude '*' --include '*/library/{accountId}/{path}'`).
- **Changing limits** is a redeploy with new `IMAGE_*` values. Existing cached
  derivatives are unaffected.

## 16. Moving from the earlier unsigned URLs

Earlier builds served `/img/{W}x{H},{fit}/{key}` without a signature. Those URLs
now answer 403.

- **The console** signs everything itself. Nothing to do.
- **XMLTV exports** sign channel icons automatically.
- **URLs copied out of the URL builder before this release** (pasted into a
  web page, an app or a partner config) must be copied again, or regenerated
  with `POST /api/images/sign`.
- **The `volt-image-proto/` prototype** is superseded by this service and is
  kept only for reference.

## 17. Upload metadata and library search

**What an upload records.** Every image that enters the library (an upload, a
watchfolder drop, or an encoder still) becomes a `media_files` row. Besides its
path, folder, kind, tags, size and dimensions, the row now holds what the file
says about itself, read once when it arrives:

| Column | From |
|---|---|
| `taken_at` | EXIF DateTimeOriginal, with OffsetTimeOriginal when the camera wrote one (otherwise the camera's clock as written) |
| `gps_lat`, `gps_lng`, `gps_alt` | EXIF GPS (or XMP GPS), in decimal degrees and metres |
| `location` | Place names as written in IPTC / XMP: sublocation, city, state, country |
| `camera` | EXIF Make and Model |
| `title`, `description`, `keywords`, `creator`, `copyright` | XMP (Dublin Core), IPTC, EXIF and Windows XP tags, in that order |
| `checksum` | SHA-256 of the bytes. A second upload of the same bytes is accepted and reported as `duplicateOf` |
| `metadata` | Everything else worth showing: format, colour space, bit depth, alpha, orientation, lens, exposure, f-number, ISO, focal length, software, rating, credit, and the full tag set (no binary blobs) |
| `source` | `upload`, `watchfolder` or `encoder` |
| `channel_id`, `captured_at` | Encoder stills: the channel and the instant the frame shows ([THUMBNAILS.md](THUMBNAILS.md)) |

Location is what the file holds. There is no reverse geocoding, because that
would mean an outbound call per upload; a workflow add-on can add place names
from the coordinates if you want them.

**Privacy.** Originals are stored untouched, so GPS positions stay in them and
in the `/library/...` original URLs. Everything served through the image
service (section 2) has all metadata removed. Hand out image service URLs, not
original URLs, for anything public.

**Searching.** The Image Library has one search box for files and folders.
Words match as prefixes against names, tags, keywords, titles, place names,
programme and channel names (encoder stills), descriptions, cameras, creators
and the folder path, so `gra fin` finds "Grand Final". A fragment in the middle
of a file name is matched too. Folders whose path contains every word are
listed above the images; click one to open it. Filters: kind, **Uploaded /
Encoder thumbnails / Everything**, **Has location**, **images taken nearby**
(from an image's details, 5 km), and sort by name, newest or date taken.

The folder tree loads lazily (a folder's children load when it opens), so a
library holding months of encoder stills stays quick.

| Route | What it does |
|---|---|
| `GET /api/files` | List and search. `folder`, `recursive=1`, `kind`, `tag`, `q`, `source` (`upload`, `watchfolder`, `encoder`, or `library` = not encoder), `channel`, `from` / `to` (ISO, on captured or taken time), `hasLocation=1`, `near=lat,lng[,km]`, `sort` (`name`, `newest`, `oldest`, `taken`, `relevance`), `limit` (up to 2,000), `offset`. Answers an array; `X-Total-Count` says how many matched. |
| `GET /api/files/search` | Same filters; answers `{folders, files, total}` for a single search box. |
| `GET /api/files/folders?parent={path}` | One folder's children ('' = top level) with `count`, `total` (everything below) and `hasChildren`. `?q=words` finds folders. Without either, the full tree as before. |
| `POST /api/files/{id}/metadata/refresh` | Re-read one file's metadata from its stored bytes. |
| `POST /api/files/metadata/backfill` | Read metadata for up to 200 files that predate this feature; call until `remaining` is 0. |

Search uses one GIN index over a search vector kept by a database trigger
(migration 0049), plus indexes for time, location, source, channel and folder
prefixes, so it stays one index lookup as the library grows.


## 18. Moving images and removing folders

**Selecting.** In the Image Library, tick an image (the box appears on hover), Ctrl/Cmd-click or Shift-click for a
range. While anything is selected, a click selects instead of opening, and a bar offers **Move to folder…**, **Select
all shown** and **Clear**. An open image has **Move…** too. Encoder thumbnails stay in their channel's dated folders and
cannot be selected.

**Moving.** Choose a folder from the list (searchable), the top level, or type a new one (`posters/2026`). Or drag the
images onto a folder in the tree. Images keep their names; one whose name is already taken in the target folder is
skipped and the message says so.

**Nothing that uses a moved image breaks.** An image's store key is its path, so a move:

1. moves the bytes and the library row;
2. rewrites every reference in the database: every text, varchar, JSON and text-array column of every table, read
   from the schema, whatever the column is called (a `*_key` column, a JSON list of an asset's candidate frames, a song
   lookup's chosen cover, a field in a template), so a column added later is covered too; as a key, a `/library/` path
   or a URL, plain or percent-encoded (`a b.png` and `a%20b.png`), and never a longer name that starts the same
   (`a.png.bak`). Channel and event refs that hold a bare path are updated within the account only. History is left as
   it was recorded: audit, job and event logs, play and ad sessions, the restore bin's snapshots
   (`HISTORY_TABLES` in `libraryMoves.ts`); what they hold still opens through 3. Graphics templates hold images by
   id, not path, so they never need rewriting;
3. records the move (`media_file_moves`), and the image store forwards reads of the old key to the new one, so links
   outside the database (web pages, feeds, signed image URLs already handed out) keep working. Chains collapse to the
   newest place; moving an image back removes its forwarding.

Renaming an image, or changing its folder in its details, does the same.

**A video item moves as one.** A video in the library (an alpha video for graphics, `motionGraphics.ts`) is one row and
three files side by side: `<name>.webm` (what templates play), `<name>.png` (its first frame, the row's `store_key`) and
`<name>.source.<ext>` (the file as uploaded). Moving or renaming it moves all three into the new folder under the new
name, updates `metadata.motion`, forwards every old address and rewrites references to any of them (a channel's
graphics holding the WebM follows). Delete removes all three; Replace sends all three to the bin and forwards each to
the same part of the video that stays (a video is only replaced by another video, an image by an image); "where it is
used" looks for all three. Duplicates leave videos out: their checksum is their first frame's, and many videos open on
the same empty frame. Moves made before 28 Oct 2026 took only the first frame (named like the WebM) and left the rest
behind; a minute after start-up the server puts such items back together (`repairVideoItems`). Checked by
`test/library-video-items.check.ts`.

Until 28 Oct 2026 the rewrite read only columns with image-like names (`_ref`, `_key`, `_url`, `logo`, `icon`, `image`,
`artwork`, `poster`, `avatar`, `thumbnail`) and a few JSON columns by name, so a reference elsewhere (an asset's
candidate frames, a song lookup) kept the old key: it still opened through forwarding, but "is this image used?" checks
compare keys. A minute after start-up the server replays every recorded move through the full rewrite
(`repairMovedReferences`); running it again changes nothing. `test/library-move-references.check.ts` puts a reference to
one image in each kind of place and checks every one follows a move.

**Where an image is used.** `GET /api/files/uses?ids=` answers, per image, every place that uses it, in words
(Channel: Jazz FM, Asset: Late Show, Song, Social post...), found the same way a move finds references. The Duplicates
dialog, the Replace dialog and Delete show it, so the right copy is kept and nothing is deleted from under a channel.

**Replacing an image with another** (a duplicate, the same picture in another file or size, a better version, a broken
upload). Open the image, or select several, and choose **Replace with…**; pick the image that stays from the library or
upload it there. Everything that used the replaced images (assets, typed images, channels, metadata, song details,
social posts, links) is pointed at the one that stays, their old addresses forward to it, and they go to the **restore
bin** (Storage > Bin) with their library rows. Restoring puts the files and rows back at their own addresses (their
forwarding ends); uses stay on the image that was kept. Encoder stills cannot be replaced. Delete offers **Replace with
another image…** when the image is in use.

**Duplicates.** **Duplicates…** groups images stored more than once (the same bytes). Each copy shows where it is used;
click the copy to keep, then merge that group alone or all groups at once. Merging is a replace: the other copies go to
the bin and their uses move to the copy that stays.

**Removing a folder.** Open the folder and choose **Delete folder…**. A folder can be deleted only when it holds no
images, in it or in any folder inside it; the dialog says how many there are and where, with **Show them**. An empty
folder goes together with its empty subfolders.

| | |
|---|---|
| `GET /api/files/uses?ids=a,b` | per image id, every use: `{ table, column, id, label, what }` (up to 50 ids) |
| `POST /api/files/replace` `{ keep, drop[] }` | replace `drop` with `keep`: uses rewritten, old addresses forward, the dropped images to the bin. Answers `kept`, `removed`, `bytes`, `references`, `binId` |
| `POST /api/files/duplicates/merge` `{ keepers?, checksums? }` | merge duplicate groups (all, or the `checksums` given) keeping `keepers[checksum]`, through the bin. Answers `groups`, `removed`, `bytes`, `references`, `binIds` |
| `POST /api/files/move` `{ ids[], folder }` | move up to 500 images (`''` = top level). Answers `moved`, `skipped` (with the reason) and `references` (places updated, by table.column) |
| `GET /api/files/folders/contents?path=` | `{ images, here, inSubfolders, subfolders }` |
| `DELETE /api/files/folders?path=` | remove an empty folder and its empty subfolders; 409 with `contents` when it holds images, 404 when there is no such folder |

Code: `services/media/libraryMoves.ts`, forwarding in `services/imageStore.ts`, routes in `modules/mediaFiles.ts`,
console `pages/library/LibraryMove.tsx`. Migration `0092_media_file_moves.sql`. Test: `test/library-moves.e2e.ts`.

## 19. Tidy: empty folders, counts, song covers, an asset's own images, duplicates

**Empty folders go with their last image.** When retention removes images (encoder stills and sprite sheets of an
expired hour, the stills of a pruned recording) or an asset is removed, each folder they were in that now holds no
image, in it or below it, is removed, then each folder above it that is left empty (`libraryMoves.ts`
`pruneEmptyFolders`). A local store also loses the empty directories, and at most hourly any stray empty directory
in the library is tidied. A folder retention did not touch is left alone, so an empty folder a person just created
stays.

**An asset's own frames go with it.** Removing an asset (Delete in its Metadata form) puts the frames Volt saved for
it (`metadata.assetId`) into the same restore-bin item, unless another asset uses them, along with its companion
files and typed images; a restore brings them all back. Uploaded images and song covers are not the asset's to take.

**Counts follow the grid.** Folder counts used to count every image whatever the grid showed, so with Uploaded
selected a folder of encoder stills read 1,440 and opened empty, and All images left out images at the top level.
The tree now counts only what the source filter shows (Uploaded, Encoder thumbnails, Everything), lists only
folders that hold such images (plus folders a person created), and All images counts the top level.
`GET /api/files/folders?parent=&source=library|encoder` answers `total` and `top` too.

**Song covers are kind `cover`**, with a **cover** filter in the Image Library and in the usage-type list. Album
covers, covers a station's feed sent and covers chosen in Find song details are saved as covers; migration 0093
marks existing ones (a `coverOf` mark, or `cover.<ext>` in a song folder).

**One copy of each picture.** Volt never stores the same bytes twice: saving an image that is already in the library
answers the existing one (the same album cover for every song on it, the same frame chosen twice). For copies made
before, **Duplicates…** in the Image Library lists each set: the copy a person uploaded stays (else the oldest), or
click another to keep it. Removing the duplicates points every use of a copy (asset images, typed images, channels,
metadata, song details, links) at the copy that stays, forwards the copies' old addresses (section 18) and removes
empty folders they leave. Encoder stills are not compared.

| | |
|---|---|
| `GET /api/files/duplicates` | `{ groups: [{ checksum, keep, drop[] }], copies, bytes }` |
| `POST /api/files/duplicates/merge` `{ keepers?: { checksum: fileId }, checksums? }` | `{ groups, removed, bytes, references }` |

**Pickers open on the asset's own images.** Choosing an asset's image (or one of its typed images) opens on, in
order: what it uses now, what was made or uploaded for it, its song's cover (audio), and up to 48 encoder stills from
while it was on air, then the whole library. A video's picker no longer offers song covers. Uploads from the picker
go to the asset's own folder. `GET /api/vod/:id/images/related`.

Migration `0093_covers_and_asset_image_ids.sql` (covers; an `id` on `vod_asset_images` so the restore bin keeps them).
Test: `test/library-tidy.e2e.ts`.
