---
scope: core
type: added
area: API
---
Stream aggregate API: `GET /api/live-streams/{channel|event}/{id}` shows a stream as its production plane (origin, processing profile, placement) and distribution plane (schema.org VideoObject published by a BroadcastEvent, metadata, availability), its preset (live channel, live event, FAST channel) and its source-provider contract per tier (delivery, descriptive, guide, timed, rights, control). /schema.org serves the JSON-LD, with the sports fixture as broadcastOfEvent for sports events.
