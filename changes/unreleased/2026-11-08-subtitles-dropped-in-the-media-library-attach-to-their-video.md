---
scope: core
type: fixed
area: Media Library
---
Subtitle and metadata files dropped in the Media Library uploader are attached to their video by name, the way a watchfolder does it (Elephants_Dream_zh_tw.vtt goes with Elephants_Dream.mp4, in the same drop or already in the library), instead of each becoming a video queued to encode. A caption with no video named like it is shown as not attached, with the reason. Opening a VOD upload for a caption or sidecar file is now refused on every path, the API included. Lower case language names keep their region or script, so zh_tw, zh-hant and pt_br become Chinese (Taiwan), Chinese (Traditional) and Portuguese (Brazil) rather than plain Chinese or Portuguese.
