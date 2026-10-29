---
scope: core
type: fixed
area: Encoder
---
When a source drops and comes back, the stream now carries on from where it was instead of jumping back in time, so playback no longer breaks after a failover. A timing warning no longer shows as "encoder failed". Admins now get an inbox message (and an email and push where those are set up) when a stream's encoder stops unexpectedly, its source cannot be read, it has been on the slate for over a minute, or its output timing goes wrong. Each stream sends at most one alert per problem every half hour.
