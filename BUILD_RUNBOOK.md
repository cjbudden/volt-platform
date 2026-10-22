# How a build-queue run works

For the scheduled **Volt build queue** task (and anyone doing the same by hand).
One run = one item from `BUILD_QUEUE.md`: build, validate, document, commit,
release. Written 22 Oct 2026 from what worked in practice.

## 0. Where things are

- **The repo** is on Christian's Mac, reached through the device shell
  (`device_bash`): `$HOME/mnt/LiveEventsAndChannelsManager/volt`. Edit files
  there. `node_modules` exist on the device for `volt-app` and `volt-web`, so
  typechecks run there.
- **The device shell cannot run Postgres, Docker or a browser.** Validation that
  needs them runs in the session's cloud container (`Bash`), on a copy:
  Postgres 16 is at `/usr/lib/postgresql/16/bin`, Chromium at
  `/opt/pw-browsers/chromium` (launch Playwright with `executablePath`; do not
  run `playwright install`). Its Chromium has **no H.264**: video previews fail
  there with a codec error; that is the environment, not the product.
- **Files move** device → container with `device_stage_files` (a tarball you
  make in `../_xfer3/`, then `tar xzf` in the container). Move used tarballs
  into `../_to_delete/` afterwards (the mount refuses `rm`).

## 1. Start

1. `git log --oneline -5` and `git status --short`. Another Claude session or
   Christian may be working in the same tree (see project memory
   `concurrent_sessions.md`). Note which uncommitted files are NOT yours; never
   commit or overwrite them.
2. Open `BUILD_QUEUE.md`. If an item says `doing (since …)` less than 3 hours
   ago, another run is active: stop now and log nothing. Older than 3 hours:
   treat it as abandoned, note that in the run log, and carry on with it.
3. Take the first `todo` item. Before building, decide if it still makes sense:
   read its row in `VOLT_BUILD_STATUS.md` and the docs it names, and check the
   code. If it is already done, no longer makes sense, or needs a decision
   only Christian can make, set `skipped: <why>` or `needs input: <the exact
   question>`, commit that (docs only, `--scope internal` note not needed for
   docs-only commits: use `git commit --no-verify`), and take the next item.
   Do not guess a product decision.
4. Set the item to `doing (since <ISO time>)` and save (no commit yet).

## 2. Build

- Change files surgically: a short Python read-modify-write with
  `assert old in s` so a moved anchor fails loudly. Never rewrite a whole file
  from memory or from truncated tool output.
- Follow the repo's conventions: comments explain WHY in plain words; no em
  dashes in anything written for Christian or customers; UI uses the existing
  tokens and classes in `volt-web/src/index.css`, icons alongside text, no
  thick accent border on one edge of an element.
- API routes: account-scoped through `groups.account_id`, list routes use
  `util/listQuery`, new client-facing routes get an overlay entry in
  `volt-app/docs/openapi-overlay.json` and `npm run docs:routes` +
  `npm run docs:openapi` (both run on the device; they need no database).

## 3. Validate

Typechecks on the device, always:

```bash
cd volt-app && npx tsc --noEmit -p .
cd volt-web && npx tsc -b
```

Database suites, in the container:

```bash
S=<scratchpad>; D=$S/pgdata
chmod o+x <each parent dir of $S> $S          # the postgres user must reach $D
su postgres -s /bin/bash -c "/usr/lib/postgresql/16/bin/initdb -D $D -U postgres -A trust"
su postgres -s /bin/bash -c "/usr/lib/postgresql/16/bin/pg_ctl -D $D -o '-p 55432 -k $D' -l $D/log start"
# copy volt-app: tar on the device with --exclude=node_modules --exclude=./volt-app/origin
#   --exclude=./volt-app/image-store --exclude=./volt-app/clips   (anchor the clips
#   exclude: src/services/clips must come across), then npm install in the container
export DATABASE_URL="postgres://postgres@localhost:55432/postgres?host=$D"
node scripts/check.js <suite-name-fragment>    # each suite gets its own database
```

The container can reset directory permissions between commands; if Postgres
stops with "Permission denied" on `pg_control`, repeat the `chmod` and
`pg_ctl restart`.

Browser checks (when the item has UI): run the real API against a seeded
database (`PORT=8080 npx tsx src/index.ts` with `IMAGE_STORE_DIR`, `FILLER_DIR`
and `ORIGIN_DIR` in the scratchpad) and `npx vite --port 5173` in a copy of
`volt-web` (it needs `../volt-player` beside it). Sign in through the form;
the session is in memory, so move between pages with
`history.pushState(...); dispatchEvent(new PopStateEvent('popstate'))`, never
`page.goto`, or you are signed out. Look at every screenshot before calling
it done.

**The bar:** new behaviour has a test that would fail without the change, and
the suites around it still pass. Write down numbers (`33/33`), not adjectives.
If a test cannot run here (GPU, real AWS, real Mac audio), say exactly that
and what Christian should run.

**If it cannot be made to pass,** do not commit broken work: restore each file
you changed from `git show HEAD:<path> > <path>`, set the item to
`blocked: <what failed, what was tried>`, commit the queue change, and take
the next item.

## 4. Document

1. `BUILD_QUEUE.md`: status `done (vX.Y.Z, <date>)` (fill the version after
   the release) and a short result: what was built, test numbers, anything
   left over. Add a run-log line.
2. `VOLT_BUILD_STATUS.md`: update the item's row (or add one) the same way
   the 22 Oct rows are written: what, where in the code, how it was checked,
   what is not yet done.
3. A change note per customer-visible change, written for the customer:
   `node scripts/release/change.mjs --scope core --type <added|improved|fixed|changed> --area <Area> "<one or two sentences>"`;
   tooling and tests get `--scope internal`.

## 5. Commit and release

```bash
git log --oneline -3                        # did HEAD move while you worked?
for l in .git/index.lock .git/HEAD.lock; do [ -e $l ] && mv $l ../_to_delete/gitlocks/$(basename $l).$(date +%s); done
git add <your files only> changes/unreleased BUILD_QUEUE.md VOLT_BUILD_STATUS.md
git commit -F <message file>                # what, why, and the validation numbers
node scripts/release/release.mjs minor --commit   # patch if the item only fixes
```

The mounted folder refuses deletes, so git leaves `.lock` files behind; move
them aside (above) before every git command. `release.mjs` usually fails at its
final `--amend` because of that: when it does, move the locks and finish it by
hand: `git add release/state.json && git commit --no-verify -m "Release vX.Y.Z: record release baseline"`.
The tag stays on the release commit, which is correct.

Every commit message ends with:

```
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

**Never** push, deploy to AWS, run `terraform apply`, touch credentials or
secrets, or delete user data. Christian pushes and deploys.

## 6. Finish

Put the version into the item's status and the run-log line, commit that with
`--no-verify` (docs only). Then stop: one item per run. Tell Christian in one
short message what was done, the test numbers, the version, and anything that
now needs his input.
