# Icon guide

The Volt icon set is one family of 51 line icons, drawn for the product and reused unchanged in diagrams, documents, slides and marketing. The set extends the icons already shipping in the app sidebar, so a channel in a diagram looks like the Channels item an operator clicks.

## Construction

- **Grid:** 24 × 24 with a 2-unit live area margin. Nothing touches the edge.
- **Stroke:** 2 units, round caps, round joins, no fills. Dots are zero-length round-capped lines.
- **Corners:** 2 units on rectangles, 1 to 1.5 on small rectangles and servers.
- **Perspective:** flat and front-on. No isometric views, no shading, no second colour inside an icon.
- New icons must be drawn on the same grid with the same stroke, and added to every colourway.

## Sizes

| Context | Size | Stroke as drawn |
| --- | --- | --- |
| Interface buttons | 15px | 2 |
| Navigation, icon buttons | 18px | 2 |
| Default UI and documents | 20 to 24px | 2 |
| Diagram nodes | 28px inside a 56px node | 2 |
| Slides and marketing | 32 to 48px | 2, or 1.5 above 40px |

Above 48px the stroke gets heavy. Use the icon inside a node or tile instead of scaling it up.

## Colour

- In the product icons take `currentColor` and inherit the text colour of their control.
- In diagrams and on slides icons are `volt` on a `panel` node, or `ink` when the diagram is one colour.
- On a `volt-strong` fill, icons are `on-volt`.
- Status is never shown by colouring an icon. Pair the icon with a StatusPill.

The files in the Icons asset group are coloured `volt` (#5569f2) so they read on both themes. The brand folder also holds every icon in `currentColor`, `ink` (#0f1218) and white, plus a single SVG sprite, PNGs for Office and EPS for print.

## The set

| Group | Icons |
| --- | --- |
| Broadcast | live, channel, event, radio, fast, loop, epg, schedule, failover, overlay, multiview, monitoring |
| Media | live-to-vod, vod-to-live, recording, clip, media, image, captions, translate, audio, review |
| Pipeline | source, ingest, upload, encoder, packager, server, cdn, cloud, storage, watchfolder, player, drm, rights, geo, globe |
| Audience | tv, desktop, mobile, viewers, analytics |
| Platform | dashboard, tenant, users, key, api, webhook, bell, alert, settings |

## Naming and use

- File names are the icon name in kebab case: `live-to-vod.svg`. In the sprite each symbol id is `volt-<name>`.
- Use one icon for one concept everywhere. `server` is the origin, `cdn` is edge delivery, `globe` is "worldwide" in marketing.
- Protocols and formats (SRT, RTMP, NDI, HLS, DASH, CMAF) are not icons. Write them as protocol tags in mono.
- Third-party services (cloud providers, social networks, DRM vendors) use their own official brand marks, never a Volt-style redraw.
- Icons support a label. Except in the product's icon-only buttons, which carry a tooltip, always set the word beside or below the icon.
