---
scope: core
type: fixed
area: FAST
---
**FAST channels play one ladder.** A FAST channel now has a ladder (picked when it is made, the account default unless another is chosen, changeable on On air), and every title, house spot, slate and ident on it is packaged to exactly that ladder in the background. Before, the channel took its renditions from its first title, so a smaller source, or a film wider than 16:9 whose height dropped the 1080p rendition, put 720p pictures under the 1080p rendition and players stalled at the join. A title whose own encode already matches is used as it is; anything else gets a copy made for the ladder beside its own encode (letterboxed to 16:9, every rendition, the channel's frame rate), recorded against the title so other channels on the same ladder reuse it.

**The library offers what can fill the channel.** A channel's library lists sources at or above its top rendition, by picture size and bitrate (a scope film counts by its width), and says how many smaller titles it is leaving out, with a way to show them anyway. On air shows the ladder, how many titles are packaged to it and the progress of the rest.

**Ladder, slate and loop in a FAST channel's Settings.** Settings now has the channel's ladder beside its slate and gap loop (which moved there from Build > Brand). Pick a ladder or make one, and set its renditions (height and bitrate, or a standard HD, HD lite or UHD set), picture sizes, frame rate, encoder, formats and segment length right there. It is the same editor Encoding profiles now uses, and it says what else shares the ladder before you change it; channels on it re-package what they air on their own.

**Ingest straight into the channel's renditions.** A ladder can now make fixed sizes: every rendition at its 16:9 size, letterboxed where the picture's shape differs, none dropped. Make such a ladder the account default (or a watch folder's) and uploads are encoded to exactly the renditions a FAST channel on that ladder plays, so they go to air without a second encode.
