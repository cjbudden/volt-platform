# The build queue and runbook

Most of Volt's recent work arrives through a queue: Christian writes the list,
a scheduled task takes one item at a time, builds it, tests it, records the
result and stops. Two files run it and one records it:

| File | What it is |
|---|---|
| `BUILD_QUEUE.md` | the work list, in order, with each item's status, acceptance test and result, and a run log |
| `BUILD_RUNBOOK.md` | the procedure one run follows, step by step |
| `VOLT_BUILD_STATUS.md` | the record of what is built, where, how it was checked and what is not done yet |

## The queue

Each row has an id, the item, a status, how it will be accepted and
validated, and the result once it is done. The phases are deliberate:

1. **Phase 1:** every key element in place and tested end to end on a single
   Mac server.
2. **Phase 2:** ready to deploy to AWS with `deploy/terraform`, and the cloud
   functions that make Volt cost effective (encoder launch on Spot, per-run S3
   prefixes, retention and archive, consolidation, edge rights, scaling).
3. **Phase 3:** worthwhile, not on the critical path.

A run takes the **first** `todo` item. Do not reorder without writing the
reason into the item.

| Status | Means |
|---|---|
| `todo` | waiting |
| `doing (since <time>, run <id>)` | a run has it. Younger than 3 hours: another run is active, leave it. Older: treat it as abandoned and say so in the run log |
| `done (vX.Y.Z, <date>)` | built, validated and released; `done (no release yet, <date>)` when the release could not be cut |
| `skipped: <why>` | already done, or no longer makes sense |
| `needs input: <question>` | only Christian can decide; the exact question is written down |
| `blocked: <what>` | it could not be made to pass; what failed and what was tried |

Questions that need Christian and do not belong to one item sit in the **Set
aside** table at the end of `BUILD_QUEUE.md`. A run never guesses a product
decision: it writes the question and moves on.

## Adding an item

Write the acceptance and validation column first: what will be true and how a
run will prove it (which suite, which browser check, which numbers). An item
that cannot say how it will be tested is not ready for the queue. Name the
design document it follows. Add a run-log line such as "queue change by
Christian: ..." so the reason for the order is kept.

Items found while doing other work are queued by the run that found them,
straight after the batch, with a letter suffix (`1.14-G6a` came from the
`1.14-G6` run).

## One run

`BUILD_RUNBOOK.md` is the authority; in short:

1. **Start.** Check `git log` and `git status`. Other sessions may be working
   in the same tree; note which uncommitted files are not yours and never
   commit or overwrite them. Respect the `doing` lock. Decide whether the item
   still makes sense, then mark it `doing`.
2. **Build.** Surgical edits (a read-modify-write that fails loudly if its
   anchor moved), the repository's conventions, account scoping and the list
   standard for API routes, the overlay entry and regenerated API reference
   for client-facing routes.
3. **Validate.** Typechecks on the Mac; database suites and browser checks in
   a Linux container on a copy (see [Check suites](check-suites.md)). New
   behaviour needs a test that would fail without it.
4. **Document.** The queue row and run log, the `VOLT_BUILD_STATUS.md` entry,
   the customer guide for anything a customer can see (not optional), and a
   change note.
5. **Commit and release.** Only your files. Then
   `scripts/release/release.mjs`: `minor` for new or changed behaviour,
   `patch` for fixes only (see [Releasing](releasing.md)).
6. **Finish.** One item per run. A short message to Christian: the item, what
   was built, the numbers, the version, and anything waiting on him.

A run never pushes to GitHub, deploys to AWS, runs `terraform apply`, touches
credentials or deletes user data. Christian pushes and deploys.

### Where a run works

The repository is on Christian's Mac. The scheduled task reaches it through a
device shell that can edit files and run typechecks but has no Postgres,
Docker or browser. So a run edits on the Mac and validates in its own Linux
container on a copy: a tarball of the tree (without `node_modules`, the origin,
the image store and the clips folders), `npm install` there, Postgres 16 and
Chromium from the container. That container's Chromium has no H.264, so
video previews fail there with a codec error; that is the environment, not the
product.

The mounted folder refuses deletes, so git leaves `.lock` files behind after
a commit. Move them aside before every git command (the runbook has the
loop). Used tarballs go to the `_to_delete` folder beside the repository for the
same reason.

### When a release cannot be cut

`scripts/release/release.mjs` moves every note in `changes/unreleased/` into the release and
rewrites `CHANGELOG.md`. If another session has uncommitted change notes or an
uncommitted `CHANGELOG.md` in the tree, a release would sweep up its work. The
run then commits its own work, marks the item `done (no release yet, ...)`,
and leaves the release for Christian.

## The status board

`VOLT_BUILD_STATUS.md` is the source; `volt_build_status.html` is generated
from it, so the two never drift:

```bash
node scripts/build-status.mjs
```

Each queue item adds a dated section in the same shape as the others: what was
built and where in the code, how it was checked with the numbers, and what is
not yet done.
