# Volt docs site: maintaining and publishing

The customer documentation: guides, the API reference and release notes, as one
static site. Signed-in customers only. Releases and change notes are in
[../RELEASING.md](../RELEASING.md).

## What is written and what is generated

| Part | Source | Edit it? |
|---|---|---|
| Guides | `docs/**/*.md` | Yes. The sidebar follows the folders (`_category_.json` sets a folder's label and order, `sidebar_position` a page's) |
| Coverage map | `coverage.json` | Yes. Every console section, workflow and developer topic, and the guides that cover it |
| Guide templates | `templates/*.md` | Yes, with care: the coverage check reads their headings |
| Screenshots | `static/img/screens/*.png` | No. Retaken by `npm run screenshots` from `screenshots.json` |
| Release notes | `release-notes/*.md` | Written by `scripts/release/release.mjs`. Fix wording by hand if needed |
| API reference | `../volt-app/docs/openapi.json` | No. Regenerate (`npm run docs:openapi` in volt-app). Wording overrides go in `openapi-overlay.json` |
| Look | `src/css/custom.css`, fonts and logos from `../brand` | Yes |
| What must never appear | `scrub.json` | Yes |

## With the local stack (run-on-mac.sh)

`bash run-on-mac.sh` checks and serves the docs with the app, at
http://localhost:3000 (the **?** button in the app opens it):

- Every start (about 3 seconds): the route inventory and API reference are
  current (regenerated and named if not, so they get committed), the guides
  have no banned terms, core changes have change notes, and the docs sign-in
  endpoint passes its test against the local database.
- In the background, only when docs sources changed: the full site build
  (broken links, banned terms in the output). Log: `volt-app/origin/_docs.log`.

| Command | Does |
|---|---|
| `bash run-on-mac.sh docs` | Docs checks and build only, then exits (0 = all passed). Leaves a running app alone |
| `DOCS_DEV=1 bash run-on-mac.sh` | Docs with live reload while you write |
| `DOCS=0 bash run-on-mac.sh` | No docs |
| `DOCS_PORT=3001 ...` | Another port |

## Preview locally (without the stack)

```bash
cd docs-site
npm ci
npm start            # http://localhost:3000, live reload
npm run build        # the real build: also fails on broken links and banned terms
```

With `DOCS_URL=http://localhost:3000` in the API's environment and no signing
key, the Documentation button in Volt opens the local site (no cookie needed).

## Checks that keep it honest

- **Broken links** fail the build.
- **Banned terms** (`scrub.json`): internal names, former product names, third
  parties, source paths, environment variables, infrastructure, the Volt-staff
  API. Checked on the sources (`npm run check`) and on the finished build. For
  generated content, add a `replace` rule; for a guide, reword it.
- **API reference drift:** `openapi.json` must match the route inventory and the
  captured requests (`volt-app/test/docs.check.sh`, and again at publish).

## Writing guides

Write for customer staff and their developers: what Volt does and how to use
it, never how it is built. Plain sentences, Australian spelling, sentence-case
headings, few em dashes. Hosts are `your-volt-host` / `example.com`, keys are
`pk_live_...`. Check a feature exists in the app before documenting it.

### Coverage: which guide explains which part of Volt

`coverage.json` lists every section in the console's sidebar (daily and
Admin), every cross-section workflow and every developer topic, with the
guides that cover each and the build-queue batch that writes them.
`npm run coverage` prints what is missing, by batch. It fails when:

- the console gains, loses or renames a section and the map does not follow
  (it reads the sidebar from the console source, so a new section cannot ship
  without someone deciding where it is documented);
- a guide the map names does not exist, or a page marked as a guide is not on
  the map;
- a batch listed in `required` still has an entry with no guide, or only
  guides not written to the template.

Each guides batch (1.14-G1 to G6) adds its id to `required` when it is done,
so what was finished stays finished. The build runs the check too (counts
only). Volt-staff sections (System Admin) are marked `internal` and never get
a customer guide.

### The page template

Copy `templates/section.md` (a console section), `templates/workflow.md` (how
sections work together) or `templates/developer.md` (for customer developers).
The frontmatter `guide: section|workflow|developer` and the level-two headings
are what the coverage check looks for, so keep their wording:

| Section guide | Workflow guide |
|---|---|
| What it is for | What it is for |
| Before you start | Before you start |
| Step by step | The flow (with a diagram) |
| How it connects | Step by step |
| Who can do it | Who can do it |
| Troubleshooting | Troubleshooting |
| Through the API | Through the API |

The map of everything is `docs/getting-started/how-volt-fits-together.md`; it
must name every section, so add a new one there as well. Diagrams are SVG in
`static/img/flows/`, drawn to read on both the light and the dark theme.

Before a guide is published, walk every step it describes in the app on the
docs demo (below). Anything that does not work as written is fixed if small,
or queued as its own build item.

### Screenshots

Never take them by hand. `screenshots.json` lists each one (console path, what
to wait for, optionally an element to crop to, elements to hide or remove,
clicks to make first) and the guide it belongs to; `npm run screenshots` retakes them
all from the running app. A guide shows one with
`![What it shows](/img/screens/<name>.png)`, and the docs-coverage check suite
fails if a guide shows a screenshot the manifest does not list.

```bash
# volt-app: a fresh demo account with neutral names (Example Broadcaster)
DATABASE_URL=... npx tsx scripts/seed-docs.ts
PORT=8080 npx tsx src/index.ts
# volt-web
npx vite --port 5173
# docs-site: all shots, or name some
npm run screenshots
npm run screenshots -- audit-log
```

The browser runs in the manifest's `timezoneId` (Australia/Sydney by default), so
forms that start from the viewer's time zone look the same on every machine.

Before saving each picture the script checks the page's visible text (and
field values and placeholders) against `scrub.json` and refuses to save one
that shows a banned term: a picture is the one thing the build cannot read.
The console is dark; the site frames every PNG so it reads on both themes.
After retaking, look at every changed picture before committing it.

## Publishing

```bash
scripts/docs/publish-docs.sh --from-terraform     # from the repo root; needs AWS credentials
scripts/docs/publish-docs.sh --dry-run --from-terraform
```

It builds, uploads hashed assets first and pages second (so no page ever
references a missing script), removes files the new build no longer has, and
invalidates the CDN. The credentials need the docs stack's `publish_policy_arn`.

## How access works

```
Volt (signed in) --Documentation--> GET /api/docs/session
     <- 3 CloudFront signed cookies on .volt.example (12 h), + the docs URL
browser --> docs.volt.example (CloudFront checks the cookie; no cookie: sign-in page)
```

- The docs are a separate stack (`deploy/terraform-docs`): private S3, its own
  CloudFront, its own state. The platform only signs the cookie, so docs traffic
  never reaches it and a docs change cannot affect it.
- App and docs must share a parent domain (`app.volt.example`,
  `docs.volt.example`), because the cookie is set on it.
- Expired pass: CloudFront shows `_public/signin.html`, which links back to Volt.
- **Try it** in the API reference calls the customer's own Volt API from the
  browser with their own credential. Nothing goes through Scalar's services
  (AI, SDK generation and telemetry are off). If `CORS_ORIGIN` is ever narrowed
  from `*`, add the docs origin to it.

## Upgrading Docusaurus or Scalar

Versions are pinned in `package.json` (Scalar is served from this site, never a
CDN). Change the version, `npm install`, `npm run build`, look at
`/api-reference` and a guide page, then commit `package.json` and the lockfile.

## First-time setup of an environment

1. `deploy/terraform-docs`: copy `terraform.tfvars.example`, fill in the domain,
   cookie domain, us-east-1 certificate and app URL, then `terraform apply`.
2. Platform stack (`deploy/terraform`): set the four `docs_*` variables from
   that stack's outputs and apply. The app picks them up on its next deploy.
3. `scripts/docs/publish-docs.sh --from-terraform`.
4. In Volt, the **?** button in the top bar opens the docs.

Key rotation: `terraform apply -replace=tls_private_key.docs` in the docs stack,
then redeploy the platform. Readers are asked to open the docs from Volt again.
