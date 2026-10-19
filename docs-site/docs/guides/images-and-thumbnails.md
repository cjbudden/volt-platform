---
title: Images and thumbnails
sidebar_position: 7
description: Resize, crop and filter library images by URL, search the library, and use the thumbnails Volt makes from your streams.
---

# Images and thumbnails

## The image service

Any image in your library can be served at the size, crop and treatment a page, player, app or partner feed needs, just by changing its URL. Nothing is generated in advance, and every result is cached, so the second request for a URL is fast.

### In the console

Open **Media > Image Library**, upload an image, select it and choose **URL builder**. Set the size, drag the focus crosshair or draw a crop, pick filters and a format, then **Copy**. The URL is ready to paste into a page, an app or a feed.

### From the API

Ask Volt to sign a URL, with an admin session or your account secret key:

```bash
curl -s -X POST "https://your-volt-host/api/images/sign" \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"path":"posters/grand-final.png","width":1280,"height":720,"format":"webp"}'
```

The answer's `url` needs no token. Put it in an `<img>` tag, a player poster, a guide feed or an email. Send `{"items": [...]}` to sign up to 100 at once.

To build many URLs without a request each, get your account's signing key from `GET /api/images/signing-key` and sign locally with the `@volt/image-url` package. Treat the key like a password: anyone holding it can create renders of your images.

### How an image URL is built

```
https://img.example.com/img/{signature}/640x360,cover,focus=30-20,gray,q=70/library/{accountId}/slates/break.png
```

| Part | What it is |
|---|---|
| Signature | Proves the URL was made for your account. Unsigned URLs are refused. |
| Spec | `{width}x{height},{fit}`, then options, separated by commas |
| Image | The image's place in your library |

### Size and fit

`{W}x{H}` in pixels. Use `0` for one side to keep the aspect ratio: `1920x0` is 1920 wide with the height that fits.

| Fit | Behaviour | Typical use |
|---|---|---|
| `cover` (default) | Fills the box, cropping the overflow. `focus` decides what is kept. | Thumbnails, tiles, hero images |
| `inside` | The whole image, scaled to fit within the box | Logos, artwork you must not crop |
| `contain` | The whole image, letterboxed to exactly the box | Fixed-size slots |
| `fill` | Stretched to the box, ignoring aspect ratio | Rarely: backgrounds that are blurred anyway |

Images are never enlarged past their own size unless you add `up`. Vector art (SVG) is drawn at the size needed, so it stays sharp.

### Crop, focus and filters

| Option | Example | Effect |
|---|---|---|
| `crop=X-Y-W-H` | `crop=25-0-50-100` | Hard crop first, in percent of the source |
| `focus=X-Y` | `focus=80-20` | For `cover`: the point to keep in frame |
| `focus=top-right` (and other edges and corners) | | For `cover`: keep this edge or corner |
| `focus=smart` | | Keep the most interesting area (faces, colour, edges) |
| `focus=entropy` | | Keep the most detailed area |
| `gray` | | Greyscale |
| `blur=N` | `blur=25` | Blur, 0.3 to 50 |
| `bright=N`, `sat=N` | `bright=80` | Brightness and saturation in percent (100 is unchanged) |
| `sharp` or `sharp=N` | | Sharpen |
| `bg=RRGGBB` | `bg=0b1020` | Colour for `contain` bars and for transparency in JPEG |
| `fmt=` | `webp` (default), `avif`, `jpeg`, `png` | Output format |
| `q=` | `q=70` | Quality, 1 to 100 (default 80) |

All metadata (including GPS) is removed from served images, and phone photos come out the right way up.

### Recipes

| Need | Spec |
|---|---|
| Channel logo in a list, never cropped | `160x160,inside` |
| Square avatar, face-aware | `256x256,cover,focus=smart` |
| 16:9 card thumbnail | `640x360,cover` |
| Sharp, small player poster | `1280x720,cover,sharp,fmt=avif,q=60` |
| Guide feed icon for a partner that wants JPEG | `256x256,inside,fmt=jpeg,q=85` |
| Logo letterboxed on a brand colour | `800x450,contain,bg=0b1020` |
| Blurred backdrop behind a player | `480x270,cover,blur=25,bright=70,q=50` |

### Limits

Requests outside a limit are refused rather than quietly changed, so you never get a different image from the one you asked for. The largest output side is 4096 px and the largest source file is 40 MB. Errors come back as JSON, for example `{"error": "size exceeds the 4096px limit"}`.

URLs do not expire, so they can be cached for a long time. To withdraw an image, delete it from the library.

## Searching the library

The Image Library has one search box for files and folders. Words match the start of names, tags, keywords, titles, place names, programme and channel names, descriptions, cameras and creators, so `gra fin` finds "Grand Final". You can filter by kind, by **Uploaded**, **Encoder thumbnails** or **Everything**, by **Has location**, and find **images taken nearby**.

Each upload's own information (date taken, location, camera, title, keywords, creator, copyright) is read when it arrives. Originals keep their GPS position, so share image service URLs, not originals, for anything public.

## Thumbnails from your streams

Every TV channel and event with video gets pictures of itself while it runs:

- **Stills in the image library**: one a minute at 640 × 360, named after the programme on air (or the channel), and searchable like any image.
- **Scrub-bar previews**: sprite sheets and WebVTT files that any web player can use to show a frame while the viewer hovers over the timeline.
- **Hover previews in the console**: on the recording timeline, the source timeline and the on-demand player.
- **Clip previews**: every clip gets its own preview file, timed to the clip.

Previews trail live by a couple of minutes. Older hours are built when someone asks for them.

### Thumbnails through the API

| Request | Answers |
|---|---|
| `GET /api/thumbnails/storyboard?stream={id}` | The preview sheets for a span (default the last hour, at most 48 hours) |
| `GET /api/thumbnails/vtt?stream&from&to` | A WebVTT preview file for any span (at most 7 days) |
| `GET /api/thumbnails/recordings/{id}.vtt` | A recording's preview file |
| `GET /api/thumbnails/vod/{id}.vtt` | A clip's preview file |
| `POST /api/thumbnails/build` | Builds the previews for an older span in the background |

See the [API reference](/api-reference) for every parameter.
