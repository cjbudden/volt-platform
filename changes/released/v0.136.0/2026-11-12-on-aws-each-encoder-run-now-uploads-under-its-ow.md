---
scope: internal
type: changed
area: Encoder
---
On AWS each encoder run now uploads under its own prefix (<kind>/<id>/runs/<runId>/), with the stable playlists and current_run.txt at the stream's root, so a restart or a second encoder never writes over another run's segments. The play URL is unchanged.
