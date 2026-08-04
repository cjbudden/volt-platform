# Volt — documentation index

All design, workflow and status docs live inside this repo, so they travel with
every update (local Mac copy + GitHub). This page is the map.

## Status & tracking
- [Build status board](volt_build_status.html) — every capability + state (HTML, open in a browser).
- [Build status (markdown)](VOLT_BUILD_STATUS.md) — same board as text.
- Feature tracker — `feature-tracker/` (product features + test/approve workflow).

## Design docs (`volt-app/docs/`)
- [Frame-accurate media access](volt-app/docs/DESIGN_frame_access.md)
- [On-the-fly image service](volt-app/docs/DESIGN_image_service.md)
- [File manager + watchfolder ingest](volt-app/docs/DESIGN_file_manager_watchfolder.md)
- [SaaS architecture](volt-app/docs/SAAS_ARCHITECTURE.md)
- [API access map (public vs admin)](volt-app/docs/API_ACCESS_MAP.md)
- [API reference](volt-app/docs/API.md) · [API additions](volt-app/docs/API-additions.md)

## Workflow docs (`volt-app/docs/`)
- [Share page](volt-app/docs/WORKFLOW_share_page.md)
- [Social publishing](volt-app/docs/WORKFLOW_social_publishing.md)
- [Captions + translation](volt-app/docs/WORKFLOW_captions_translation.md)

## Run & test
- [Quick start + test guide](volt-app/TEST_TONIGHT.md)
- Postman collection — `volt-app/api/Volt.postman_collection.json` (+ environment)
- API verification — `volt-app/api/verify.sh` (Newman, 38/38)

## Keeping this repo in sync
Claude builds in the cloud and drops a `volt-update.bundle` into this folder for
each update. To apply it and push to GitHub, run `./publish.sh`.
