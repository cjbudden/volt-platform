---
scope: internal
type: added
area: Deploy
---
Deploy and rollback script (scripts/deploy/deploy.mjs, build queue D1): release checks, images tagged v<version>-<sha> (never latest), migrations once as a one-off task before services move, rolling service moves with steady-state wait, a smoke test (ready, play gate, manifest) with automatic rollback, explicit --rollback, new encoder revisions for new streams only, and release/deployments.json as the record. Terraform image tags must name a release and services no longer have their revision moved by apply. The staging compose file takes the image tag from VOLT_IMAGE_TAG, mailpit is a service again (it sat inside depends_on, so compose refused the file), and IMAGE_SIGNING_SECRET is passed (the API would not start without it).
