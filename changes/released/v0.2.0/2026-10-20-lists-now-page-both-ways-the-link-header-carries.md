---
scope: core
type: added
area: API
---
Lists now page both ways: the Link header carries rel="prev", "first" and "last" alongside "next" (with an X-Prev-Cursor header). Filler assets, scheduled clips, publish targets, publications and programmes can now be read by id (`GET /api/<resource>/{id}`), so every record's link opens it.
