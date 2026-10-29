---
scope: core
type: changed
area: API
---
GET /api/workflows/map no longer returns each stage's impl field. The ingest lookups POST /api/ingest/preview, POST /api/ingest/sanitise, GET /api/ingest/baseline and GET /api/ingest/providers now need Files, uploads & storage: View or Account settings: View. Storage locations carry their uri only for whoever runs the Volt service.
