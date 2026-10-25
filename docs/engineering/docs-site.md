# The docs site

The customer documentation is one static Docusaurus site in `docs-site`:
guides, the API reference and release notes, for signed-in customers only.
`docs-site/MAINTAINING.md` is the full manual; this page is what an engineer
needs to change it without breaking the checks.

## What is written and what is generated

| Part | Source | Edit by hand? |
|---|---|---|
| Guides | `docs-site/docs` | yes, to a template |
| Which guide covers which part of Volt | `docs-site/coverage.json` | yes |
| Templates | `docs-site/templates` (section, workflow, developer) | with care: the coverage check reads their headings |
| Code samples in the developer guides | `docs-site/samples` | yes; the page includes the file, never pasted code |
| Screenshots | `docs-site/static/img/screens` | no: retaken from `docs-site/screenshots.json` |
| Release notes | `docs-site/release-notes` | written by the release command |
| API reference | `volt-app/docs/openapi.json` | no: regenerated; wording goes in `volt-app/docs/openapi-overlay.json` |
| Terms that must never appear | `docs-site/scrub.json` | yes |

## Working on it

```bash
cd docs-site
npm ci
npm start                                    # http://localhost:3000 with live reload
npm run coverage                             # which console sections, workflows and developer topics lack a guide
npm run check                                # banned terms in the sources
npm run build                                # the real build: also fails on broken links and banned terms in the output
```

With the whole stack, `bash run-on-mac.sh` serves the docs on :3000 and
`bash run-on-mac.sh docs` runs the checks and the build, then exits (see
[Running Volt on a Mac](running-on-the-mac.md)).

## The rules the checks hold

- **Coverage.** `docs-site/scripts/check-coverage.mjs` reads the console's
  sidebar from `volt-web/src/App.tsx`. A new console section fails the check
  until `docs-site/coverage.json` says which guide covers it. Each finished
  guides batch is listed in `required`, so what was finished stays finished.
  `volt-app/test/docs-coverage.check.ts` runs it on the tree and on broken
  sites.
- **Templates.** A guide's frontmatter (`guide: section`, `workflow` or
  `developer`) and its level-two headings must match its template.
- **Banned terms.** `docs-site/scripts/check-scrub.mjs` with
  `docs-site/scrub.json`: internal names, former product names, third
  parties, source paths, environment variables, infrastructure. Checked on the
  sources and on the built site. Customer guides never say how Volt is built;
  that is what these engineering guides are for.
- **Samples run.** A developer guide shows a sample with an empty code block
  that names the file (` ```bash file=uploads/upload.sh `); the build fills it
  (`docs-site/src/remark/include-samples.mjs`) and fails on a missing file or
  pasted code. `volt-app/test/docs-samples.check.ts` runs every sample against
  the real API on a seeded database.
- **Screenshots** are never taken by hand. `docs-site/scripts/screenshots.mjs`
  retakes them from the running app on a neutral demo account, and refuses to
  save a picture that shows a banned term. Look at every changed picture
  before committing it.
- **Walk it.** Before a guide is published, every step it describes is done
  in the app. Anything that does not work as written is fixed if small or
  queued as its own build item.

## Retaking screenshots

Three terminals, with `DATABASE_URL` pointing at a fresh, migrated database
(`npm run migrate` in `volt-app`). The docs seed links a sandbox social
account, so the seed and the API both need `SOCIAL_TOKEN_KEY` set to the same
32-byte key; any throwaway one will do (make it with openssl rand -base64 32).

```bash
cd volt-app
npx tsx scripts/seed-docs.ts                 # a demo account with neutral names
PORT=8080 npx tsx src/index.ts
```

```bash
cd volt-web
npx vite --port 5173
```

```bash
cd docs-site
npm run screenshots                          # all of them
npm run screenshots -- audit-log             # or name some
```

The screenshot script imports `playwright` and launches its own browser.
`docs-site` does not install it (the site build needs no browser), so install
it once per checkout with `npm install --no-save playwright` and
`npx playwright install chromium` in `docs-site` (the same steps are in
`docs-site/MAINTAINING.md`). To use another copy, set `PLAYWRIGHT` to the path of that copy's index.mjs and `CHROMIUM`
to a browser binary.

## Publishing

After the app is deployed, never before, so the reference never describes
routes that are not live:

```bash
scripts/docs/publish-docs.sh --dry-run --from-terraform     # (AWS) build, then show what would change
scripts/docs/publish-docs.sh --from-terraform               # (AWS) build and publish
```

The docs have their own stack in `deploy/terraform-docs` (private bucket,
own CloudFront, own state). The platform only signs a cookie when a customer
opens the docs from Volt, so docs traffic never reaches the platform. First
setup and key rotation are at the end of `docs-site/MAINTAINING.md`.
