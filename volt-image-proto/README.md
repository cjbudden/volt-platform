# volt-image-proto — on-the-fly image service (prototype)

A high-performance image endpoint built on **sharp** (libvips): request any source
image at a size + treatment via the URL, rendered on demand and cached. See
`../volt-app/docs/DESIGN_image_service.md` for the full design.

## URL grammar
```
/{sig}/{fit}/{WxH}/filter(...)/{path}
```
- `sig` — HMAC of the rest, or `unsafe` in dev.
- `fit` — `fit-in` (keep aspect, no crop) · `fill` (cover + crop by focus) · `stretch` (exact, distorts).
- `WxH` — `1920x0` (width, auto height) · `0x1080` (height, auto width) · `1920x1080` (exact).
- `filter(...)` — `sharpen:N, blur:N, quality:N, format:webp|avif|jpeg|png, grayscale, background:RRGGBB, focus:<g>`.
- `focus` — center · top/bottom/left/right · top-right etc. · `smart` (content-aware).

Examples:
```
/unsafe/fit-in/1920x0/live_channel/TV1.png
/unsafe/fit-in/1920x0/filter(sharpen:100)/live_channel/TV1.png
/unsafe/fill/500x500/filter(focus:top-right,format:webp)/live_channel/TV1.png
```

## Run
```bash
cd volt-image-proto
npm install            # sharp
node gen.mjs           # make the 2400x1350 test card
node test.mjs          # 14/14 assertions (grammar, fit modes, focus, filters, signing)
node src/server.mjs    # then open http://localhost:8791/gallery
```

## Files
- `src/parse.mjs` — URL grammar → transform spec (pure)
- `src/render.mjs` — apply with sharp (fit modes, focus, filters, format)
- `src/sign.mjs` — HMAC URL signing / verify
- `src/server.mjs` — HTTP server + disk derivative cache (HIT/MISS headers)
- `gallery.html` — visual gallery of transforms
- `test.mjs` — assertions · `gen.mjs` — test-card generator

## Productionise
Resolve `{path}` from S3 (per-account prefix), put the derivative cache on S3 +
CloudFront, require signatures (drop `unsafe`), add max-dimension + format guards,
and add a URL-signing helper to the console/SDK. Then mount as `src/modules/images.ts`
in the API.
