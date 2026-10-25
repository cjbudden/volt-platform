# Releasing

Every change carries a note; a release turns the notes into a version, the
customer release notes and the team changelog in one command. The full
routine, with the rules for wording and what to do when something goes wrong,
is `RELEASING.md`. This page is the engineer's short version.

## Once per clone

```bash
scripts/release/install-hooks.sh             # the commit hook that asks for a change note
```

## With every change: a change note

```bash
node scripts/release/change.mjs --scope core --type fixed --area EPG "Add EPG on a channel page now opens that channel's programme guide."
node scripts/release/change.mjs --scope internal --type added "The engineering guides are checked against the tree."
node scripts/release/change.mjs list         # what is waiting for the next release
```

Notes land in `changes/unreleased/`; stage them with the change. A commit
that touches core product code is refused until a note is staged with it
(`git commit --no-verify` for a genuine exception, and for docs-only commits).

| Scope | For | In the customer release notes? |
|---|---|---|
| `core` | the product every customer gets | yes, grouped by type and area |
| `saas` | running Volt as a service: tenancy, staff admin, billing | no, changelog only |
| `internal` | tests, tooling, infrastructure, refactors | no, changelog only |

Which paths count as which scope is in `release/scopes.json`. Write core notes
for the customer: what they will notice, in one or two sentences, never the
implementation.

## When the API changes

```bash
cd volt-app
npm run docs:routes                          # the route inventory, read from the app
npm run docs:openapi                         # the API reference, from the inventory and the overlay
```

Better wording for a route goes in `volt-app/docs/openapi-overlay.json`, never
in `volt-app/docs/openapi.json`, which is regenerated. `volt-app/test/docs.check.sh`
fails when either is stale, so a route cannot ship without appearing in the
reference.

## Cutting a release

```bash
node scripts/release/check.mjs               # every core change since the last release has a note
node scripts/release/release.mjs minor --dry-run
node scripts/release/release.mjs minor --commit
```

`patch` for fixes only, `minor` for anything new or changed, `major` for a
change that breaks an existing API client or workflow. `--commit` bumps
`VERSION`, writes `docs-site/release-notes/<date>-v<version>.md` from the core
notes, prepends `CHANGELOG.md`, moves the notes to `changes/released/v<version>/`,
regenerates the API reference, records the release in `release/state.json`,
commits and tags `v<version>`.

**On the Mac's mounted folder** git cannot delete its own lock files, so
`scripts/release/release.mjs` usually fails at its last step (an amend). Move the locks aside
and finish by hand; the tag stays on the release commit, which is correct:

```bash
for l in .git/index.lock .git/HEAD.lock; do [ -e $l ] && mv $l ../_to_delete/gitlocks/$(basename $l).$(date +%s); done
git add release/state.json
git commit --no-verify -m "Release vX.Y.Z: record release baseline"
```

**Before you release, look at `git status`.** The release takes every note in
`changes/unreleased/` and rewrites `CHANGELOG.md`. Notes or a changelog that
another session has not committed would be swept into your release; leave the
release until the tree is clean of other people's work.

## After a release

Christian pushes and deploys, in this order: the app (control plane, console
and encoder images), then the docs (`scripts/docs/publish-docs.sh --from-terraform`),
so the API reference never describes routes that are not live. See
[The docs site](docs-site.md) and [Deploying to AWS](deploying-to-aws.md).
