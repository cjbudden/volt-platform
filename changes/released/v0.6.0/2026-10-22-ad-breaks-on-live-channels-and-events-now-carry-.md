---
scope: core
type: added
area: Channels
---
Ad breaks on live channels and events now carry SCTE-35 in the delivered streams: an SCTE-35 cue on the break in HLS, cue out and cue in on the segments it covers, and an SCTE-35 event in DASH. Downstream ad insertion and distribution partners see every break you start, schedule or send through the API.
