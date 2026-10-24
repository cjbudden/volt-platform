---
scope: internal
type: added
---
Guides framework: docs-site/coverage.json maps every console section, workflow and developer topic to its guide, with a check (npm run coverage, also in the docs build and the docs-coverage suite) that fails when the console and the map disagree or a required batch has gaps; section, workflow and developer page templates; npm run screenshots retakes every guide screenshot from the app on a fresh docs seed (volt-app/scripts/seed-docs.ts) and refuses a picture that shows a banned term.
