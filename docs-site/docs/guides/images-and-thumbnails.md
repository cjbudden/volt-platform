---
title: Image Library
sidebar_position: 3.7
description: Keep your slates, watermarks, posters and brand images in folders, find any image, and serve it at the size and crop a page or app needs.
guide: section
---

# Image Library

The Image Library holds the still images your streams and apps use: slates, watermarks, posters and channel brands, plus the stills Volt takes from your streams while they run. Most people come here to upload an image with the right usage type, or to make a URL for it at the size a page or app needs.

![The Image Library: the folder tree on the left, the search box and filters at the top, and a grid of images with their usage type, size and folder](/img/screens/image-library.png)

## What it is for

- **One place for images.** Upload once into folders, and pick the same image in channel, station, guide, graphics and media forms.
- **The right image in the right picker.** Each image has a usage type (**slate**, **watermark**, **poster**, **brand** or **other**) that decides where it is offered.
- **Find anything.** One search box looks through names, tags, places, cameras, programmes and more, across every folder.
- **Any size, any crop.** The URL builder makes a link to the image at the size, crop and treatment you need. Nothing is made in advance; the first request renders it and later ones come from the cache.
- **Stills from your streams.** Every TV channel and event with video adds a still a minute, named after the programme on air.

Channel operators, designers and anyone who looks after branding use it.

## Before you start

- Image files: PNG, JPEG, WebP and other common image formats.
- **Files, uploads & storage: Manage** to upload, organise or delete. Browsing and making URLs needs View (see [Who can do it](#who-can-do-it)).

## Step by step

### Upload images

1. Open **Image Library** in the sidebar. Open the folder you want them in first, if you like.
2. Choose **Upload images** and pick one or more files, or drag them anywhere onto the page (**Drop images to add**).
3. The **Add** panel lists each image. Check the **Destination folder** (leave it empty for the top level, or type a path such as `slates/news`).
4. Each image gets a usage type from the folder: **slate** in `slates`, **watermark** in `watermarks`, **brand** in `brands`, **poster** in `posters`, otherwise **other**. Use **Set all to type** to change them all, or the list beside each image to change one. You can rename an image here too, or remove it with **✕**.
5. Choose **Upload** (it shows how many). **Uploading 3 images in the background…** (with your count) appears and the images carry on uploading while you work. Progress shows under **Uploads** at the top of the console; **Retry failed** tries again and **Clear** tidies the list. The grid refreshes as each one finishes.

### Organise folders

1. Choose **+ New folder**, type a name and choose **Create folder**. Use `/` for a folder inside another, for example `slates/news`. Starting from inside a folder fills in its path for you.
2. With no folders yet, the tree offers **slates**, **watermarks**, **brands** and **posters** to create in one click.
3. Click a folder in the tree to open it; the arrow beside it shows the folders inside. **All images** shows everything. The number beside each folder counts the images in it.

### Find an image

1. Type in **Search images and folders: name, tag, place, camera, programme…**. A search looks through every folder. Words match the start of names, tags, keywords, titles, place names, programme and channel names, descriptions, cameras and creators, so `gra fin` finds "Grand Final". Matching folders are listed above the images under **Folders**.
2. Narrow by usage type with **all**, **slate**, **watermark**, **poster**, **brand**, **other**, **still** (stills from your streams) or **sprite sheet** (scrub-bar preview sheets).
3. Choose where images came from: **Uploaded** (the default), **Encoder thumbnails** or **Everything**. Opening the thumbnails folder shows everything, newest first.
4. **Has location** shows only images that carry a GPS position or a place name.
5. Sort with **Sort by name**, **Newest first** or **Date taken**.
6. The count of images is at the right. Choose **Show more** at the bottom to load the next page.

### Look at an image and change its usage type

1. Click an image. Its folder, size, file size and type are under the name.
2. **Details** shows what the file says about itself: when and where it was taken, the camera, title, keywords, creator and copyright, read when it was uploaded. Choose **Re-read** to read them from the file again.
3. If it has a GPS position, choose **images taken nearby** to see images taken within 5 km. Choose **Within 5 km ✕** to clear that filter.
4. Change **Usage type** to move it to another picker (slate, watermark, brand or poster). It saves straight away.
5. Choose **Close** when you are done.

Originals keep their GPS position. For anything public, share a URL from the URL builder, which removes it.

### Make a URL at the size you need

1. Click an image and choose **URL builder…**.
2. Set **Width** and **Height** in pixels, or choose **16:9**, **4:3**, **1:1** or **9:16** to set the height from the width.
3. Choose a **Fit**: **Cover** (fill the box and crop the overflow), **Inside** (fit within and keep the shape), **Contain** (fit within and pad to the box) or **Fill** (stretch to the box).
4. With **Focus point** selected, drag on the picture to place the crosshair: a cover resize keeps that point in frame. The blue outline is exactly what your size keeps. Choose **Crop** and drag a rectangle to crop first. **clear focus** and **clear crop** remove them.
5. Under **Filters**, set **Brightness**, **Saturation** and **Blur**, and tick **Grayscale** or **Sharpen**. The preview shows an approximation.
6. Under **Output**, set **Quality** and a **Format**: **WebP (recommended)**, **AVIF (smallest)**, **JPEG** or **PNG (lossless)**.
7. Choose **Copy** (**URL copied** confirms it) and paste the URL into a page, an app or a partner feed. **View** opens the result in a new tab, and **Reset** puts everything back.

URLs are signed for your account and do not expire, so they can be cached for a long time. The largest side is 4096 pixels.

### Delete an image

1. Click the image, then the bin button (**Delete**).
2. **Delete image?** names it and warns that this cannot be undone. Choose **Delete**.
3. If a channel still falls back on it as a slate, Volt names the channels (**In use as a slate by 1 channel(s)**). Choose **Force delete** only if you mean it, then give those channels another fallback in [Loops & Fillers](loops-and-fillers.md).

Volt only checks slates. An image used as a logo, artwork, watermark or guide icon is deleted without a warning, so check before you delete one.

To withdraw an image from every URL made from it, delete it here.

### Use stills from your streams

Every TV channel and event with video gets pictures of itself while it runs:

- **Stills in the library**: one a minute at 640 × 360, named after the programme on air (or the channel). Choose **Encoder thumbnails** or **still** to see them. Their details say which channel and programme they came from and when they were captured.
- **Scrub-bar previews**: sprite sheets and WebVTT files that a web player can use to show a frame while the viewer hovers over the timeline.
- **Hover previews in the console**: on the recording timeline, the source timeline and the on-demand player.
- **Clip previews**: every clip gets its own preview file, timed to the clip.

Previews trail live by a couple of minutes. Older hours are built when someone asks for them.

## How it connects

| Section | How it relates |
|---|---|
| [Channels](channels.md), [Radio](radio.md) | **Channel logo**, **Station artwork** and watermark images are picked from here |
| [EPG](epg.md) | Guide icons and a programme's replacement slate are picked from here |
| [Media Library](media-library.md) | An asset's image is picked from here, or uploaded into `posters` |
| [Graphics](graphics.md) | Images in graphics setups are picked from here |
| [Account settings](account-settings.md) | The share page logo is picked from here |
| [Loops & Fillers](loops-and-fillers.md) | Older fallback slates kept here can be copied into Loops & Fillers |
| [Recordings](recordings.md) | Stream stills and scrub-bar previews show on the recording timelines |
| [Player SDK](player-sdk.md), [Embedding](embedding.md) | URLs from the URL builder work as player posters and page images |

See [How Volt fits together](../getting-started/how-volt-fits-together.md) for the whole map.

## Who can do it

| Task | Access needed |
|---|---|
| See the Image Library, search it, look at images, make URLs | Files, uploads & storage: View |
| Upload, create folders, change usage type, **Re-read**, delete | Files, uploads & storage: Manage |
| Pick an image in another section's form | Any access to that section; reading the library needs nothing more |
| Sign image URLs through the API | Any role above the Viewer tier |

Roles and levels are explained in [Roles and access](../getting-started/roles-and-access.md).

## Troubleshooting

| You see | What it means | What to do |
|---|---|---|
| **No image files in that selection** | None of the files chosen is an image | Choose image files (PNG, JPEG, WebP) |
| A **!** beside an upload under **Uploads**; hovering says **An image already exists at** a path | An image with that name is already in that folder | Upload it again with another name or folder, or **Retry failed** after deleting the old one |
| **No images here** | The folder or the library is empty, or the filters leave nothing | Choose **all** and **Everything**, clear the search, or upload |
| Stills from your streams are missing | The library shows **Uploaded** images unless you ask for others | Choose **Encoder thumbnails** or **Everything** |
| No **Usage type** on an image | It is a still from a stream, which has no usage type | Nothing to do; upload your own copy if you want it in a picker |
| **The file carries no camera, place or caption metadata.** | The file has no embedded details | Nothing to do, or choose **Re-read** if you replaced the file |
| The URL field says **Loading the signing key…** | The key that signs URLs has not arrived | Wait a moment, or close the builder and open it again |
| **Couldn't load the image library.** | The library could not be read | Choose **Retry** |
| **In use as a slate by** channels when deleting | Channels still fall back on this image | Give those channels another slate first, or **Force delete** |

## Through the API

| Request | Does |
|---|---|
| `GET /api/files/search` | Searches the library (`q`, `folder`, `kind`, `source`, `hasLocation`, `sort`, `limit`, `offset`) |
| `GET /api/files/folders?parent={path}` | The folders inside one folder |
| `POST /api/files/folders` | Creates a folder (`{"path": "slates/news"}`) |
| `POST /api/files` | Uploads an image (`folder`, `name`, `kind`, `contentType`, `dataBase64`) |
| `GET /api/files/{id}`, `PATCH /api/files/{id}` | One image; changes its usage type |
| `DELETE /api/files/{id}?confirm=true` | Deletes it; add `&force=true` when channels still use it as a slate |
| `POST /api/images/sign` | Signs an image URL |
| `GET /api/images/signing-key` | Your account's key for signing URLs yourself |

### Sign an image URL

Ask Volt to sign a URL, with an admin session or your account secret key:

```bash
curl -s -X POST "https://your-volt-host/api/images/sign" \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"path":"posters/grand-final.png","width":1280,"height":720,"format":"webp"}'
```

The answer's `url` needs no token. Put it in an `<img>` tag, a player poster, a guide feed or an email. Send `{"items": [...]}` to sign up to 100 at once.

To build many URLs without a request each, get your account's signing key from `GET /api/images/signing-key` and sign locally (HMAC-SHA256 over `{spec}/{key}`, the first 16 bytes, base64url). Treat the key like a password: anyone holding it can create renders of your images.

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

### Thumbnails from your streams

| Request | Answers |
|---|---|
| `GET /api/thumbnails/storyboard?stream={id}` | The preview sheets for a span (default the last hour, at most 48 hours) |
| `GET /api/thumbnails/vtt?stream&from&to` | A WebVTT preview file for any span (at most 7 days) |
| `GET /api/thumbnails/recordings/{id}.vtt` | A recording's preview file |
| `GET /api/thumbnails/vod/{id}.vtt` | A clip's preview file |
| `POST /api/thumbnails/build` | Builds the previews for an older span in the background |

Every route is in the [API reference](/api-reference).
