---
scope: core
type: added
area: Access
---
**FAST channels have their own permission, and a FAST Manager role.** Building and running FAST channels is now its own area in roles ("FAST channels": view, operate, manage), separate from live TV channels, and covers a FAST channel's own pages too. Encoding profiles and ladders are their own area as well, out of Account settings, and handling the ingest queue (held uploads, metadata, duplicates) is part of Files, uploads & storage. Existing roles keep exactly the access they had. The new built-in **FAST Manager** role runs FAST channels, the titles they air, the Image Library, Loops & Fillers, uploads and the encode queue, and ladders, and sees reports, with no access to live TV, radio, events, users or account settings. `npm run seed:fast-user` adds a FAST test user to the local demo account.
