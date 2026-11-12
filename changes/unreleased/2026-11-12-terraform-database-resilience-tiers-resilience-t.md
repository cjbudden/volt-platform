---
scope: internal
type: added
---
Terraform: database resilience tiers (resilience.tf). The SaaS service in prod is always Multi-AZ with a Valkey replica, 14 to 35 days of backups and a daily AWS Backup snapshot copied to a second region; a dedicated deployment picks resilience standard, high or dr. RDS Blue/Green for major Postgres upgrades is in APPLY.md.
