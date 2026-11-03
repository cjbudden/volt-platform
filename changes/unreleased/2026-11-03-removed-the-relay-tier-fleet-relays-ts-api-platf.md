---
scope: internal
type: removed
area: Radio
---
Removed the relay tier (fleet/relays.ts, /api/platform/relays), the Icecast listener-auth callback, the ICECAST_* settings, the relay probe and MP3 push in radio.py, and the relay in run-on-mac.sh, compose and Terraform coverage. New accounts.mp3_feed_enabled (platform PATCH mp3FeedEnabled) and check suite mp3-feed; radio-container rewritten without a relay.
