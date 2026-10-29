---
scope: internal
type: added
area: Deployment
---
Terraform is ready for a first apply: deploy/terraform/APPLY.md is the runbook, every control-plane setting is either set by Terraform or listed with its reason in env-coverage.json (checked by scripts/deploy/check-terraform-env.mjs and the terraform-env suite), media and uploads go to the origin bucket on AWS, the operator's own settings go in app_env and app_secret_keys, and a prod destroy no longer empties the origin bucket.
