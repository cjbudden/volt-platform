---
scope: core
type: added
area: Player
---
The Volt player now reports what each viewer sees, in the CMCD v2 standard. Every playlist and segment request carries CMCD, and the player sends its play states, errors, bitrate changes, a heartbeat every 30 seconds and a sample of response timings to POST /api/public/cmcd. A view starts when play is pressed, so a refused entitlement or a failed licence is still counted, with the step it failed at.
