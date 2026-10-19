# volt-image-proto: on-the-fly image service (superseded prototype)

> **Superseded. Not used by the app.** The production image service is part of
> the control plane (`volt-app/src/modules/images.ts`) and is documented in
> [`volt-app/docs/IMAGES.md`](../volt-app/docs/IMAGES.md). Nothing starts or
> imports this folder, including `run-on-mac.sh`. It is kept as the record of
> the August 2026 prototype. Do not deploy it: it accepts unsigned (`unsafe`)
> URLs and has no size, source or concurrency guards.

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

## Productionise: done
Every item that was listed here (S3 sources per account, S3 + CloudFront
derivative cache, required signatures, size and format guards, a signing helper
for the console and SDK, `src/modules/images.ts`) shipped in the control plane
on 15 Oct 2026. The prototype's path-style URLs still work there, behind a
signature. See `volt-app/docs/IMAGES.md`, section 9.
