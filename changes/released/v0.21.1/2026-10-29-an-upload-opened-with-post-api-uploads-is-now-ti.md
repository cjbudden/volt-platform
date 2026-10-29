---
scope: core
type: fixed
area: API
---
An upload opened with POST /api/uploads is now titled with the name you give it, with or without a content type. A title or name sent in metadata is kept as the title too. When the name is only the file name, the title is still read from the file as before.
