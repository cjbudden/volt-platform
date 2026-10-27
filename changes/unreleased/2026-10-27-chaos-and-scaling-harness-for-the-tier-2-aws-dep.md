---
scope: internal
type: added
area: Deploy
---
Chaos and scaling harness for the Tier-2 AWS deployment: kill an encoder task, lose a source, lose a zone, interrupt a Spot server and scale out under viewer load, each with a dry run, time budgets from the code and a pass or fail verdict (deploy/loadtest/chaos.mjs, run sheet CHAOS.md, FIS templates in deploy/terraform/chaos.tf, off by default).
