---
scope: internal
type: added
area: Control plane
---
Migrate-only entry (dist/migrateOnly.js): applies the migrations and boot schema top-ups under the boot lock and exits, for the deploy's one-off migration task. The top-ups moved unchanged from index.ts to services/bootSchema.ts.
