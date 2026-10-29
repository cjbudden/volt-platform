---
scope: internal
type: added
area: Analytics
---
QoE collector live path (services/qoe): raw reports kept first (local folder, or gzipped objects on S3 every 10 s), view rows and DDSketch minute aggregates in a separate analytics database with its own pool, held and retried while that database is down, replay by day partition (src/tools/qoe-replay.ts). Terraform for the raw archive bucket (versioning, Object Lock governance, 30 d Glacier IR, 90 d Deep Archive, 760 d expiry). Check suite test/qoe-reports.check.ts.
