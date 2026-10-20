---
scope: core
type: added
area: API
---
The hypermedia view of the API (send `Accept: application/ld+json` or add `?format=jsonld`) now covers every list and record. Every list is a Hydra collection with the full match count, first, previous, next and last page links, and its filters as a search template. Every record carries a breadcrumb from the entry point, links to its siblings, and one link per sub-resource. `GET /api` links every collection, and `GET /api/doc` declares each resource's operations (method, input and output) and properties. Plain JSON responses are unchanged and point at the hypermedia view with a `Link: rel="alternate"` header.
