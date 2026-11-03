# FAST DRM: how we add it (option, not built)

Status: design option, 30 Oct 2026. FAST channels play CLEAR today. Live channels
already encrypt (encoder.py: SPEKE keys from Axinom, Shaka Packager `cbcs`), and the
player SDK already takes licence servers (`drm: { servers, headers }`). This note is
what it takes to give FAST the same, so it can be switched on per channel when a
rights holder asks for it.

## The shape

FAST never encodes at air time: it plays assets already packaged to the channel's
ladder (`services/fast/ladder.ts`, job `vod.ladder`). So DRM belongs at that
packaging step, not in the playout:

| Step | Today | With DRM |
|---|---|---|
| Ladder packaging (`vod.ladder`) | clear CMAF | CMAF encrypted `cbcs`, keys from SPEKE (the same `fetch_drm_keys` / `shaka_drm_flags` the live encoder uses) |
| Playout (`fast_playout.py`) | copies segment lists | also carries each part's `EXT-X-KEY` (HLS) and `ContentProtection` (DASH, per Period) |
| Delivery | CloudFront, public segments | unchanged: encrypted segments are safe to cache publicly |
| Player | clear | licence servers per channel; FairPlay certificate on Apple |
| Entitlement | public / private channel | licence token (JWT) issued by our API names the channel; the licence server checks it |

**One scheme, `cbcs`, one set of segments for every device.** `cbcs` is played by
FairPlay (Safari, iOS, tvOS), Widevine (Chrome, Android, most TVs, Chromecast) and
PlayReady 4+ (Edge, Xbox, newer smart TVs). No second `cenc` copy unless a customer
names older PlayReady devices.

## Decisions to take

1. **Key per asset or per channel.**
   - *Per asset (recommended).* The asset is encrypted once and reused on every channel
     that schedules it; access is decided by the licence policy (the token names the
     channel, the licence server checks the asset is entitled there). No re-packaging when
     a title moves between channels.
   - *Per channel.* Simpler policy, but every asset is packaged again for every channel
     it airs on. Only worth it if a rights holder insists on channel-unique keys.
2. **What else is encrypted.** Loop, slate, idents and house spots.
   - *Everything encrypted (recommended).* The house media gets a channel "house key".
     The stream never switches between clear and encrypted, which is where real devices
     fail (older Android, some smart TVs and Chromecast stall on a clear-to-encrypted
     switch at a discontinuity).
   - *Content only.* Less packaging, but every programme join is a clear/encrypted switch.
     Shaka and Safari handle it (`EXT-X-KEY:METHOD=NONE` after the discontinuity, a Period
     without `ContentProtection`), but it has to be device-tested before it is offered.
3. **Ads.** Ads we stitch are transcoded to the ladder by us (`prepare.ts`), so they can be
   encrypted with the house key too. Ads a downstream platform inserts (SCTE-35 to their
   SSAI) are their concern; the markers do not change.
4. **Key rotation.** Not needed for FAST (VOD keys, a licence policy with a short
   duration does the job). Live channels keep their own rotation settings.

## Work, in order

1. `vod.ladder`: an encrypted variant (`ladderVariant.drm = 'cbcs'`, its own folder, so
   clear and encrypted packagings sit side by side and a channel can switch back).
   Readiness (`prepare.ts`) treats "encrypted for this channel" as part of "ready".
2. `fast_playout.py`: read `EXT-X-KEY` from each asset's media playlists and write it
   after every discontinuity (and `METHOD=NONE` for a clear part); copy each asset's
   `ContentProtection` (with its PSSH) into the Period. The parser today ignores
   `EXT-X-KEY`, so an encrypted asset must not reach a channel before this lands.
3. Licence tokens: `GET /api/player/...` issues a short-lived token naming the channel
   and the viewer's entitlement; the licence server (Axinom, as for live) validates it.
4. Player SDK: FairPlay server certificate (`drm.advanced['com.apple.fps'].serverCertificateUri`)
   alongside `drm.servers`; Safari's own HLS needs the same through EME. Widevine and
   PlayReady are already wired through Shaka.
5. Console: a DRM switch on the FAST channel (with the "everything / content only" choice),
   showing readiness while the ladder is re-packaged.
6. Test matrix before it is offered: Safari macOS, iOS, tvOS (FairPlay); Chrome, Android,
   Chromecast, an Android TV (Widevine L1 and L3); Edge, one Samsung/LG TV (PlayReady);
   each across a programme join, a loop and an ad break.

## Cost of running it

Encryption is done once at packaging: no extra compute while a channel plays. Licence
requests are the running cost (one per viewer session, priced by the DRM vendor), and
packaging time roughly doubles while a channel's library is re-packaged the first time.
