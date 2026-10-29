# The image that represents an asset

Every asset in the media library has one image: the grid card, the player poster, app feeds and schema.org all
read `vod_assets.poster_key`. Volt picks it automatically, says where it came from and why, and a person can
choose another, which then sticks.

Code: `services/media/assetImage.ts` (the decision), `musicLookup.ts` (songs), `frameScore.ts` (video frames),
`services/thumbnails/fileSprites.ts` (sprite sheets for uploaded files), `modules/vodImage.ts` (API),
`jobs/handlers/vodImage.ts` (job and sweep), `jobs/handlers/songArtwork.ts` (covers as songs air), `libraryPaths.ts` and
`libraryImages.ts` (library folders, images from web addresses), `services/rateGate.ts` (shared rate limits), `pageMeta.ts` and `songDetails.ts` (Find song details), console
`pages/vod/AssetImage.tsx` and `SongFinder.tsx`. Migrations `0072_asset_images.sql`, `0073_music_providers.sql`,
`0074_song_details.sql`.
Tests: `test/asset-images.check.ts`.

## 1. The order

| # | Source (`poster_source`) | When | Shape |
|---|---|---|---|
| 0 | `metadata` | An image a person put in the asset's own image field (Artwork, Thumbnail, Poster, Image, Logo). Images Volt filled itself do not count, so a better match can replace them. | as is |
| 1 | `manual` | A person chose a frame or a library image. `poster_locked`: automatic picks never replace it until someone asks for an automatic pick again. | as chosen |
| 2 | `cover_art` | A song: the album cover from the Cover Art Archive, copied into the Image Library (`media/<artist>/<album>/<song>/cover.jpg`, once per album per account). | square |
| 3 | `programme` | A radio asset made from a guide programme that has its own image. | square |
| 4 | `station` | Any other radio asset: the station artwork, then its guide icon, its guide feed's icon, its logo, then the account logo. A web address is imported into the library first (public addresses only). | square |
| 5 | `frame` / `live_frame` | Video: the best frame (section 3), copied into the library (`<asset folder>/poster.jpg`, section 7), because live keyframes are swept after their retention. | wide |
| 6 | `none` | Nothing yet; the card shows the colour key (section 10). | |

`poster_reason` is one sentence for people, for example "Album cover: Rumours (1977), Fleetwood Mac. MusicBrainz match
100/100" or "Best of 12 frames at 00:22 (sharp); skipped 1 bars, 1 black".

**Audio** is a radio station's asset, a file whose probe found no video, or an asset with MP3/M4A exports and no video
rendition. **A song** is the Song content type, a song from a station's now-playing log (ICY, class song), or audio whose
ID3 tags name an artist and title.

**In the grid**, square art is drawn whole in the middle of the 16:9 card over a blurred copy of itself, so a mixed
library keeps one card shape and no cover is cropped. Audio assets carry a note badge.

## 2. Songs: MusicBrainz, the Cover Art Archive, and other providers

Open data (MusicBrainz core data is CC0), no key and no display terms; the same providers, User-Agent and
one-request-a-second gate as the live now-playing card (`radio/trackMeta.ts` explains why not iTunes, Spotify or
Last.fm). The gate is shared: MusicBrainz limits per IP for the whole platform.

**The station's now-playing block.** Stations send a whole ICY block (`StreamTitle='Orange Crush – Infinite
Lights';StreamUrl='…';`); only the StreamTitle is the song, and artist and title may be split by a hyphen, a double
hyphen, or an en or em dash (`trackMeta.ts` `icyStreamTitle`, `parseIcyTitle`). Pasted into Find song details, the
block is cleaned the same way. A StreamUrl image counts as the song's artwork only when it changes from one song to
the next and does not look like a logo: many stations (SomaFM) send their station logo with every song.

**A song found makes the asset a Song.** An asset with no content type becomes a Song when its song is found, with
the Song fields filled. An asset of another type keeps it; Find song details offers Song as a change to tick.

**Apple** searches songs first, then (when the song search ranks covers above the original, as it does for Tame
Impala) the artist and their songs; equal matches go to the earliest release, the original album rather than a
playlist reusing it.

**Who:** a "Look up as" a person entered, the song fields, the ICY line ("Artist - Title"), the asset title after the
artist, the ID3 tags, or a title written "Artist - Title".

**Combinations tried**, in order, until one matches: as given; cleaned ("feat.", "with", "remastered", "radio
edit", "original mix" removed); without any brackets; artist and title swapped (some stations send them the wrong
way round). MusicBrainz also searches singles (release groups) for songs that only exist as a single.

**Providers** (`MUSIC_PROVIDERS`, default `musicbrainz,apple`) are tried in order, and the first confident match wins:

| Provider | Data | Rate limit | Commercial use |
|---|---|---|---|
| `musicbrainz` | recordings, albums, ISRC, label, genres; covers from the Cover Art Archive | about 1 request a second per IP (503 beyond it), no daily cap; User-Agent required | core data CC0; covers belong to their rights holders. Heavy commercial use: run a mirror (live replication needs a MetaBrainz commercial licence) |
| `apple` | track, album (a single's name without "- Single"), release date, genre, cover at 1200 px, Apple Music link | about 20 calls a minute per IP (gate: one every 3.1 s) | free, no key. Artwork and details may be used only **to promote the song**, shown with a link to it on Apple Music: the player's now-playing answer carries `listen` for an Apple cover and every built-in skin shows "Listen on Apple Music". On by default as the fallback |
| `deezer` | track, album, ISRC, release date, label, genres, cover up to 1000 px | about 50 requests per 5 seconds per IP | **non-commercial only** under Deezer's API terms unless Deezer agrees otherwise; off by default |

A cached miss is asked again when the provider list changes. "Check providers" in the asset panel (`POST
/api/vod/music-lookup`) runs every provider side by side for one song, without caching, to see what each finds.

**Matching.** A search for a well-known song returns dozens of recordings that all score 100: live sets, bootlegs,
karaoke, remasters, cast albums. The first hit for Queen's "Bohemian Rhapsody" is a two-minute live cut. So both a
strict query (official studio album, not live, compilation, soundtrack or video) and a loose one run, and every
candidate is scored:

* exact artist credit, exact title;
* versions named in the disambiguation or title (live, karaoke, remix, demo, outtake, alternate, Dolby Atmos mix...);
* its best release: official, album, no secondary types; bootleg-only, live-only and other artists' compilations
  ("Various Artists") lose; a recording on no release cannot have a cover and loses heavily;
* length close to the asset's;
* consensus: an album title that recurs across the candidates (remasters and deluxe editions all say "Rumours") gains,
  and ties go to the earliest release.

Below 70 it is a miss: wrong cover art on air is worse than the station logo. Verified against the live service:
Dreams goes to Rumours (1977), Bohemian Rhapsody to A Night at the Opera (1975), Get Lucky to Random Access Memories,
Padam Padam to Tension, Beds Are Burning to Diesel and Dust.

**Enrichment** (three more gated calls): ISRC and genres from the recording, the album's first release date from the
release group, the label from the release. Cached in `music_lookups` for every account by normalised artist|title:
a hit or a miss is kept; an error (MusicBrainz busy or down) is retried after six hours by the sweep, or at once when
someone presses Pick again.

**Filling metadata** never overwrites: only empty Song fields are filled (artist, album, ISRC, label, release date,
genre when it maps to one of the type's options), each recorded in `metadata_provenance` with the provider that found it.
The Title field is filled with the song title too.

**The cover** is the release group's front image (the album as a person means it), else the matched release's front.
Images in the Cover Art Archive belong to their rights holders; a station that plays the music normally shows its
cover, but the image's use is the customer's call.

## 3. Video: the best frame

Candidates are the live stream's keyframes over the asset's span (up to 24), or, for an uploaded file, 12 stills
taken from the file at 5% to 95% during the encode. Each is measured on a 160×90 sample (`frameScore.ts`):

| Measure | Effect |
|---|---|
| Exposure | black (mean < 6%) and white (> 96%) rejected; dark or very bright frames discounted |
| Contrast | a flat card or single colour rejected |
| Sharpness | variance of the Laplacian, log scale, the heaviest weight: blur and soft focus lose |
| Colourfulness | Hasler and Süsstrunk's measure |
| Detail | histogram entropy |
| Test patterns | colour bars (every column one colour top to bottom) rejected |
| Position | the first and last 3% (idents, slates, credits) discounted, not banned |

The candidates are kept scored on the asset (`poster_candidates`) and shown in the asset panel, best first, with
rejected ones greyed and labelled. Clicking one chooses it. No faces or models: a later step could add face and
text detection, with the same scoring interface.

## 4. Uploaded files: source, renditions, thumbnails

An uploaded or watchfolder file keeps its source (mezzanine) record on the asset: `source_key` (where the file is),
`original_filename`, `source_bytes`, `sha256`, the ingest probe. The encode uses the account's ladder, which can track a
live output profile (`encode_ladder_groups.tracks_output_profile_id`), so the file gets the same rungs, segment length
and GOP as the channel, packaged as HLS and DASH (`formats`). The asset panel shows the source file, checksum, ladder
(and the live profile it tracks), renditions and formats.

At the end of the encode, while the source is on disk:

* 12 candidate stills, scored, and the poster picked from them;
* sprite sheets for hover previews (`fileSprites.ts`): the live layout (tile size, columns, rows), about 200 previews
  whatever the length (one a second for a short clip, one every 36 s for two hours), in the library under
  `derived/<account>/sprites/assets/<asset>/` in the sprite store (not the Image Library; a `sprite_sheets` row each,
  THUMBNAILS.md section 1), recorded in `vod_assets.sprite`. `GET /api/thumbnails/vod/:id.vtt` serves their WebVTT
  with signed sheet URLs; recording-derived assets keep using the stream's hourly storyboards.

Files uploaded before this: the sweep (or "Rebuild from source" in the asset panel) builds the stills and sprites from
the source file if it is still there.

Verified end to end on a 40 s 1080p news clip: ladder tracking a live profile (720p, 480p, 360p), master.m3u8 and
manifest.mpd, 12 stills, one sprite sheet of 41 previews, poster at 00:22, 22 s in all.

## 5. When it runs

**Songs are looked up once, when the asset is created** (uploaded, or cut from a recording), and only for what is
missing: an asset that already has an image and its song details (artist and album) is not looked up at all; one with
an image but no album is looked up for the details and keeps its image. After that, nothing looks the song up again
by itself: Pick again, saving metadata and the sweep use what is already known (`music_lookup.at`, `attempts`). The
one exception is a lookup that could not run (provider busy or down): tried again after six hours, three tries in all.
A person can always check again with Find song details (section 12), and any change it finds is applied only when
they approve it.

* `vod.image` job (priority 80, below clips and encodes): queued after an upload's encode, by the console, and by a
  leader sweep every two minutes for any asset with no image yet (uploads only once encoded) and for song lookups that
  failed more than six hours ago. Every way an asset is created is covered without each one queuing it. A failure is
  recorded on the asset, not retried in a loop.

## 6. API

| | |
|---|---|
| `GET /api/vod/:id/image` | the image (signed URL), source, shape, reason, locked, the frames considered (scored, signed), the song lookup, sprite facts |
| `PUT /api/vod/:id/image` `{ ref }` | choose a candidate frame key or an Image Library ref of this account; locks it |
| `POST /api/vod/:id/image/auto` `{ lookup?, rebuild?, artist?, title? }` | pick automatically again (unlocks, retries a failed song lookup; `artist` and `title` look the song up as that); `rebuild` takes an upload's stills and sprites again from its source. Waits up to 25 s, then answers 202 and finishes in the background |
| `POST /api/vod/music-lookup` `{ artist, title, durationMs?, providers? }` | what each provider finds for a song (album, date, ISRC, label, genres, cover, link), plus the gate usage. Not cached |
| `GET /api/vod` | each row also has `poster_shape`, `poster_source`, `audio_only` and `media_kind` |

Feature `vod`: reading needs view, choosing needs manage.

## 7. Library folders

Every image Volt stores, and every image a person uploads or pastes for an asset, goes to a folder named from what it
belongs to. Names are lower case with hyphens, no spaces (`Beyoncé & JAY-Z` is `beyonce-and-jay-z`):

| What | Folder |
|---|---|
| A song | `media/<artist>/<album or singles>/<song>/` (cover.jpg) |
| A station or channel | `media/<station>/` (logo) |
| A programme on a station | `media/<station>/<show>/<date>/` |
| An episode | `media/<show>/<episode>/` |
| An event | `media/<event>/<date>/` |
| Anything else | `media/<title>/<date>/` |

## 8. Covers as songs air (the stream workflow)

The station's now-playing reader writes each song to the guide's as-run log. For each one it queues `song.artwork`,
which puts a cover on the guide entry (`programmes.metadata.image`) as early as possible:

1. the entry already has an image (the station's feed sent one): nothing to do;
2. the feed's StreamUrl points at an image: that, copied into the song's folder;
3. details a person chose for this song (section 12);
4. the song lookup, through the shared cache and rate gate. A song played before costs no external call.

The player's now-playing card and recently played list, the recording's log, and any clip later cut from that song
all use the stored cover. A miss is noted on the entry. Guide (EPG/XMLTV) song entries are not hooked yet.

## 9. Station fields and image fields

**Station fields.** A radio asset's empty fields are filled from its station: name, description, logo (or the
station artwork), and any other field both share. Provenance `station`.

**Image fields.** Content types have a field type `image`. Its value is an Image Library reference
(`/library/<account>/<path>`). The form offers the library picker, upload, or a pasted web address; on save a web
address is downloaded into the library (public addresses only, images up to 8 MB, the same address once per account)
in the asset's folder, and the field keeps the library reference. Another account's image is refused. The standard
types' logo, image, thumbnail and artwork fields are image fields (migration 0073).

## 10. Colour key

An asset with no image yet shows a solid card in its kind's colour, with an icon and a label, and the grid header
shows the key: video `#364fc7`, audio `#0b7285`, music `#c2410c`. List rows carry `media_kind`.

## 11. Rate limits and scale

All lookups for the platform share one gate per provider, held in Postgres (`rate_gates`), so several servers never
add up to more than the provider allows. MusicBrainz at one call a second is about 86,000 calls a day; a new song
costs 4 to 7 calls, so roughly 12,000 to 15,000 new songs a day at most. Repeat plays cost nothing (the cache is
shared by every account).

Apple's fallback allows about 20 calls a minute (some 28,000 a day), one or two calls a song. That is enough for a handful of stations. For commercial scale across many stations:

* prefer artwork the playout system already sends (Zetta, WideOrbit, Myriad and others can put an image URL in the
  feed; step 2 of section 8 uses it);
* run a MusicBrainz mirror (no rate limit; live replication needs a MetaBrainz commercial supporter licence);
* or license a commercial metadata service (Deezer by agreement, Apple Music, Gracenote, 7digital, Music Story) and
  add it as a provider.

Discogs is not suitable: its images are restricted data.

## 12. Find song details (a person checks)

In the asset panel, **Find song details** asks every source at once, MusicBrainz, Deezer and Apple (whatever
`MUSIC_PROVIDERS` says), and reads a page or image link the person pastes. Nothing changes until they apply.

* **A pasted page** (`pageMeta.ts`) is fetched once, like a link preview, and read for what it publishes about
  itself: schema.org JSON-LD (MusicRecording, MusicComposition, MusicAlbum), Open Graph and `music:` tags. Apple
  Music, Bandcamp track pages and most label and artist sites carry the artist, title, album, date, length and
  cover (Apple's share image is swapped for the 1200 px square cover, Bandcamp's for the original). A site that
  answers programs with a browser check says so, with how to copy the cover's image address instead. A pasted
  image address is used as the cover.
* **Never a site's search.** Bandcamp's robots.txt disallows `/search`, and Beatport and Discogs block programs, so
  the panel links to each site's search for the person to open in their browser and paste the song's page back.
* **Review**: each find is shown as the asset's own fields next to what the asset has now. Empty fields are ticked,
  values already there change only if ticked (and a value a person entered is flagged), the found values can be
  edited, the image is a tick of its own. "Type the details" enters them by hand.
* **Apply** (`POST /api/vod/:id/song/use`) writes exactly the ticked fields (provenance: the source, who approved,
  the old value), copies the cover into `media/<artist>/<album>/<song>/`, and **keeps the details for the song**
  (`song_details`, per account, under the name the station sends and the corrected one). Every later play of the
  song (the cover on the guide entry as it airs, any clip or asset of it) uses them at once, without a lookup.
  "Forget them" (`DELETE /api/vod/:id/song/details`) removes them.

Each source's terms are shown with its find: MusicBrainz open data; Deezer non-commercial unless agreed; Apple
promotional, with a link to Apple Music; a web page, check that you may use it.

| | |
|---|---|
| `POST /api/vod/:id/song/find` `{ artist?, title?, url?, providers? }` | every source plus the page; each find with `proposed` (as this asset's fields) and `terms`; `current` (fields, values, provenance, image); `searchLinks`; `chosen` |
| `POST /api/vod/:id/song/use` `{ provider, artist, title, album?, released?, label?, isrc?, genres?, link?, imageUrl? or imageRef?, fields[], useImage }` | apply what was approved; keep it for the song |
| `DELETE /api/vod/:id/song/details` | forget the kept details |

## 13. Image types: thumbnail, cover, poster and more

An asset's main image (sections 1 to 12, `poster_key`) is called the **Thumbnail** on video and the **Cover** on
audio. Beyond it, an asset offers more images, one per **type**, in two groups:

| Type | Key | Shape | Minimum | For | Falls back to |
|---|---|---|---|---|---|
| Thumbnail | `thumbnail` | 16:9 | 1280 × 720 | video (the main image) | |
| Cover | `cover` | 1:1 | 1400 × 1400 | audio (the main image); video (optional square art) | main image |
| Poster | `poster` | 2:3 | 1000 × 1500 | both | main image |
| Hero backdrop | `hero` | 16:9 | 1920 × 1080 | both | thumbnail, main image |
| Banner | `banner` | 3:1 | 1920 × 640 | both | hero, thumbnail, main image |
| Social share card | `social` | 1.91:1 | 1200 × 630 | both | hero, thumbnail, main image |
| Title art | `title` | any, transparent | 800 wide | both | nothing |

Thumbnail and Cover are content images; the rest are publishing images, for portals, apps and feeds.

**Per account.** The standard types are seeded the first time an account asks (`asset_image_types`). An account can
rename them, change the minimum size and fallbacks, switch them off (not Thumbnail or Cover), and add its own (a
partner's 4:3 tile, say). Deleting an account's own type that assets use needs `force`, which removes those images.

**Fallback.** A type with no image of its own answers with the first image in its fallback chain, cropped to its
shape by the image service around a smart focus point, marked `derived`. Nothing is stored for it, so a portal always
gets the right shape and a later own image replaces it at once. Title art never falls back.

**Focus.** Each own image can carry a focus point (percent across and down) that crops keep in frame
(`focus=X-Y` in the image URL, IMAGES.md section 4). Without one the crop is smart.

**Warnings**, not refusals: smaller than the type's minimum, or not its shape (it will be cropped).

**Image fields in the Metadata form.** Changing an image field and saving applies it during the save, even over an
image chosen earlier by hand: a field named after one of the asset's other types (`poster`, `hero`, ...) fills that
type, any other image field (`image`, `thumbnail`, `artwork`, `cover` on audio) becomes the main image, the changed
field first. Clearing it lets Volt pick again. (Before, the change was only queued, and skipped entirely when the
image was locked, so the old image stayed on screen.)

**Frames get their own file.** A chosen or picked frame is saved as `poster-<content hash>.jpg` (`hero-...` for a
type) instead of `poster.jpg` every time. Overwriting one path kept the image URL the same, so the browser, the image
service's caches and the CDN went on showing the old picture.

Code: `services/media/assetImageRules.ts` (pure), `assetImageSet.ts`, `modules/assetImages.ts`, console
`pages/vod/AssetImageSet.tsx`. Migration `0090_asset_image_types.sql`. Tests: `test/asset-image-types.check.ts` (51,
pure), `test/asset-images-and-files.e2e.ts`.

| | |
|---|---|
| `GET /api/vod/image-types` | the account's types |
| `POST /api/vod/image-types` `{ key, label, aspect, minWidth?, minHeight?, appliesTo?, purpose?, fallback?, transparent? }` | add a type |
| `PATCH /api/vod/image-types/:key` | rename, resize, switch on or off |
| `DELETE /api/vod/image-types/:key[?force=1]` | remove an account's own type |
| `GET /api/vod/:id/images[?fallback=0]` | every type the asset offers: its image (signed URLs, size, focus, warnings) or the derived fallback; `urls` maps each type to the URL a portal should use |
| `PUT /api/vod/:id/images/:type` `{ ref, focus? }` | choose an Image Library image or one of the asset's frames; for the main type, the same as `PUT /api/vod/:id/image` |
| `PATCH /api/vod/:id/images/:type` `{ focus }` | move the focus point |
| `DELETE /api/vod/:id/images/:type` | remove it (falls back again); for the main type, pick automatically again |

**Next:** feeds and the play gate answer only the main image today (`artworkUrl`); adding the `urls` map to the
public asset answer and schema.org `image` is the step that puts posters and heroes on portal pages.

## 14. Showing a new image at once: grid, player poster, live cards

**Why the grid kept the old picture.** The list (`GET /api/vod`) always held the new `poster_key`, but a card shows
it through the image service at a URL built from the key and the size, and every cache keeps a URL for a year: the
browser, the CDN, the image service's derivative cache. Frames used to be saved over the same `poster.jpg`, so the key,
and so the URL, did not change, and a refresh still showed the old render. The asset panel asked for another size,
which had never been rendered, so it showed the new one. Three changes:

* frames are saved by content (`poster-<hash>.jpg`, section 13), so a new frame is a new key;
* every image URL of the main image carries `v=<poster_picked_at>`: the grid card, the asset panel and the player
  poster, so a new pick is a new URL even for an image replaced at the same path;
* an image saved over an existing path drops the image service's in-memory copy of the old bytes (`forgetSource`).

**Player poster.** The Preview player shows the asset's image (1280×720; square art letterboxed on black) until it
plays, set on the video element and kept when a new source loads.

**Live cards.** While the Media Library is on screen it asks `GET /api/vod/changes?since=<last now>` every 8 seconds
(only while the tab is visible, at once when it comes back, backing off to a minute on errors) and merges the changed
rows into the page: image, title, availability, encode state. The first call answers only `now`; three seconds of
overlap catch rows committed after the last answer; more than 200 changes ask for a reload. Server side it is one range
scan on `vod_assets(updated_at)` (migration 0094), shared for two seconds between viewers of the same account. A
background pick that finishes while the asset panel is open also refreshes the card and the poster.
Test: `test/library-changes.e2e.ts`.

## 15. Image names and folders

Images Volt saves for an asset (a picked or chosen frame, a typed image made from a frame) are named after the asset:
its name without the file extension, lower case with hyphens, then the image type for a typed image, then a short
hash of the picture so a different frame is a different file:

| | |
|---|---|
| main image (thumbnail / cover) | `media/sintel-1080p/2026-10-20/sintel-1080p-21fe57ffc0.jpg` |
| typed image | `media/sintel-1080p/2026-10-20/sintel-1080p-hero-9a0c33b2e1.jpg` |

The folder's date is the programme's start, else the recording's start, else the day the asset was added. An upload
has no start (stored as 0), which used to give `1970-01-01`; a date before 1971 is now treated as unknown. Folder
names drop the media file extension too (`sintel-1080p`, not `sintel-1080p-mkv`).

Older images (`poster.jpg`, `poster-<hash>.jpg`, `1970-01-01` folders, an extension in the folder) are moved to
these names by the asset-image sweep, 50 a pass (`libraryMoves.ts tidyAssetImageNames`), with every reference
rewritten, old addresses forwarding and emptied folders removed. Each image remembers the asset name it was named
for (`metadata.namedFor`); renaming an asset renames its images on the next pass. Images a person uploaded keep their
own names. Test: `test/asset-image-names.e2e.ts`.
