# @volt/image-url

Build and sign URLs for the Volt image service: resize, crop, focus and filter
any image in an account's library, by URL. No dependencies. The same code runs
in Node, browsers, workers and React Native, and signs synchronously.

```
npm install @volt/image-url
```

## Use

```ts
import { imageUrl } from '@volt/image-url';

const url = imageUrl({
  baseUrl: 'https://img.example.com',             // GET /api/images/config -> baseUrl
  accountKey,                                     // GET /api/images/signing-key -> key
  key: `library/${accountId}/posters/final.png`,  // the image's store key
  width: 1280, height: 720,
  focus: 'smart',
  format: 'avif', quality: 60,
});
```

Fetch the account key once, server side or after sign-in, and keep it like an
API secret: it can sign render URLs for that account's images (and only that
account's). The URLs need no token and never expire, which is what lets the CDN
cache them for a year.

| Function | Returns |
|---|---|
| `imageUrl({ baseUrl?, key, accountKey, ...options })` | A complete signed URL. |
| `imageSpec(options)` | The canonical spec string, e.g. `640x360,cover,focus=30-20,gray`. |
| `signedImageUrlForSpec(accountKey, spec, key, baseUrl?)` | A signed URL for a spec you composed yourself. |
| `signImagePath(accountKey, "{spec}/{key}")` | Just the 22-character signature. |
| `accountOfKey(key)` | The account id inside a store key, or null. |

## Options

| Option | Values |
|---|---|
| `width`, `height` | Pixels. 0 or omitted = auto from the other side. |
| `fit` | `cover` (default, crop to fill), `inside`, `contain` (letterbox), `fill` (stretch) |
| `crop` | `{ x, y, w, h }` in percent of the source, applied first |
| `focus` | `{ x, y }` percent, or `center`, `top`, `bottom`, `left`, `right`, `top-left`, `top-right`, `bottom-left`, `bottom-right`, `smart`, `entropy` |
| `grayscale` | boolean |
| `blur` | 0.3 to 50 |
| `brightness`, `saturation` | percent, 100 = unchanged |
| `sharpen` | `true`, or a sigma 0.3 to 10 |
| `background` | `RRGGBB` for `contain` bars and JPEG transparency |
| `quality` | 1 to 100 (default 80) |
| `format` | `webp` (default), `avif`, `jpeg`, `png` |
| `enlarge` | allow scaling past the source size |
| `version` | cache-busting token, letters and digits |

Full guide (every option, limits, errors, caching):
`volt-app/docs/IMAGES.md` in the Volt repository.

## Source of truth

`src/index.ts` is a byte-for-byte copy of `volt-app/src/services/images/sdk.ts`,
made by `npm run sync` (also run by `build` and `test`). Edit it there. The
control plane's image tests fail if the copies drift.
