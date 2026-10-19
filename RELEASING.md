# Releasing Volt: change notes, versions, release notes and docs

One routine, the same every time. The aim: every release says what changed for
customers, the API reference always matches the API, and nothing about the SaaS
platform or Volt's internals reaches customer-facing notes.

| What | Where it lives | Who writes it |
|---|---|---|
| Customer release notes | `docs-site/release-notes/` (published at `/release-notes`) | The release command, from `core` change notes |
| Team changelog (everything) | `CHANGELOG.md` | The release command, from all change notes |
| Change notes waiting for a release | `changes/unreleased/` | You, with each change |
| What shipped in each release | `changes/released/vX.Y.Z/` | The release command |
| Product version | `VERSION`, git tag `vX.Y.Z` | The release command |
| API reference | `volt-app/docs/openapi.json` (published at `/api-reference`) | Generated from the running API |
| Guides | `docs-site/docs/` | You |

## One-time setup (per clone)

```bash
scripts/release/install-hooks.sh     # turns on the change-note check at commit time
```

## With every change: a change note

A commit that touches **core** product code is refused until a change note is
staged with it. Add one:

```bash
node scripts/release/change.mjs --scope core --type fixed --area EPG \
  "Add EPG on a channel page now opens that channel's programme guide."
git add changes/unreleased
```

**Scope** decides who sees it. The path rules are in `release/scopes.json`
(first match wins); the note's scope is your call when they disagree.

| Scope | Means | Customer release notes? |
|---|---|---|
| `core` | The streaming product every customer gets: channels, events, radio, EPG, recordings, VOD, player, encoder, the customer API | Yes |
| `saas` | Running Volt as SaaS: tenancy, Volt-staff admin, billing, support tickets, docs hosting | No (changelog only) |
| `internal` | Tests, tooling, infrastructure, refactors with no visible change | No (changelog only) |

**Type:** `added` (New), `improved`, `fixed`, `changed`, `removed`, `security`.
**Area** (core only): the part of the product, as customers know it: Channels,
Events, Radio, EPG, Recordings, VOD, Player, API, Encoder, Monitoring, Account.

**Write it for the customer:** what they will notice, in one or two sentences.

- Good: "Transcoded audio is now always delivered at 48 kHz, which removes a recurring audio timing warning from the channel log."
- Not: "Added -ar 48000 to audio_track_args in ladder_args."

Nothing customer-visible in a core change (a refactor)? Still add a note, with
`--scope internal`. The decision is made by whoever made the change, when they
made it. `git commit --no-verify` skips the check for a genuine exception.

`node scripts/release/change.mjs list` shows what is waiting.

## When the API changes

```bash
cd volt-app
npm run docs:routes            # route inventory, read from the running app (needs DATABASE_URL)
npm run api:capture            # only for a new client-facing route: add a step to api/build.ts first
npm run docs:openapi           # the API reference, from the two above
```

`test/docs.check.sh` fails if any of these is out of date, so a route cannot
ship without appearing in the reference. Better wording for a route goes in
`volt-app/docs/openapi-overlay.json` (summary, description, tag), never in
`openapi.json`, which is regenerated.

## Cutting a release

```bash
node scripts/release/check.mjs                       # every core change since the last release has notes
node scripts/release/release.mjs minor --dry-run     # read the customer notes before they exist
node scripts/release/release.mjs minor --commit      # version, notes, changelog, spec, commit, tag
git push && git push origin vX.Y.Z
```

Then, in this order:

1. **Deploy the app** (control plane, web, encoder images) as usual.
2. **Publish the docs:** `scripts/docs/publish-docs.sh --from-terraform`
   (docs-site/MAINTAINING.md). After the app, so the reference never
   describes routes that are not live yet.

**Which number:** `patch` for fixes only, `minor` for anything new or changed,
`major` for a change that breaks an existing API client or workflow (say so in a
`changed` or `removed` note). A release with no core notes still gets a version
and a one-line "maintenance" post.

## If something goes wrong

- **Wrong release notes:** edit `docs-site/release-notes/<date>-vX.Y.Z.md` and republish the docs. The change notes are kept in `changes/released/` as the record.
- **Bad docs publish:** check out the previous tag's `docs-site` and `volt-app/docs/openapi.json` and publish again. The docs bucket is versioned for emergencies.
- **A hook complains about the wrong files:** fix the path rules in `release/scopes.json`.
