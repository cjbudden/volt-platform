# Check suites

Volt's tests are check suites: plain scripts that print one line per
assertion and finish with a tally like `33 passed, 0 failed`. There is no
test framework to learn. About two hundred of them live in `volt-app/test`;
the encoder's Python tests live beside the encoder in `volt-encoder/bin`.

## Typechecks, always

```bash
cd volt-app
npx tsc --noEmit -p .
cd ../volt-web
npx tsc -b
```

Both need the folder's `node_modules` (`npm install` once). They need no
database, so they run anywhere, including the device shell the build queue
uses.

## The database suites

```bash
cd volt-app
export DATABASE_URL=postgres://volt:volt@localhost:5432/volt
node scripts/check.js                        # every suite, one at a time, each on its own database
node scripts/check.js vod clip               # only suites whose file name contains vod or clip
KEEP_DB=1 node scripts/check.js epg          # keep a failing suite's database to look at
```

The local database above is the throwaway one `run-on-mac.sh` creates. Any
Postgres 16 works: the runner only uses the server in the URL and
makes its own databases on it.

What `volt-app/scripts/check.js` does, so you know what a result means:

1. Builds a template database with the real migration runner (the one the
   service runs on boot), then seeds it with `volt-app/scripts/seed-demo.ts`
   and the shared fixture in `volt-app/scripts/seed-check.ts`. It is rebuilt
   every run, so a suite never tests yesterday's schema.
2. Gives each suite its own copy (`CREATE DATABASE ... TEMPLATE`), so suites
   cannot trample each other's fixtures, and drops it afterwards.
3. Starts a control plane for a suite that talks to one (it mentions
   `localhost:8080` or reads `process.env.API`), on its own port from 8300,
   against that suite's database, with encoders mocked. A suite that starts
   its own `volt-app/src/index.ts` is left alone.
4. Reads the `N passed, M failed` tally. A suite with no tally is judged on
   its exit code; a suite that runs past five minutes fails.
5. Prints one line per suite, the tail of each failure, and a total. The exit
   code is the number of failing suites.

**One test signing secret.** Several suites sign their own access tokens
with the test value `devsecret` unless `JWT_ACCESS_SECRET` is set, while the
control plane's own default is different. The runner sets
`JWT_ACCESS_SECRET=devsecret` and `JWT_REFRESH_SECRET=devrefresh` when they
are not set and passes its environment to every suite and every control plane
it starts, so both sides agree. Before 25 Oct 2026 a run with nothing set
failed `auth-boundary`, `station-clear`, `timeline-grid`, `recordings-counts`
and others with 401 answers that looked like product faults. A value you
export yourself is kept.

`SHARED_DB=1` runs everything on the one database in `DATABASE_URL`, the old
way. Only use it to reproduce a suite that depends on another's leftovers.

### A scratch Postgres with no Docker

This is how the build queue runs the suites in a Linux container. Postgres 16
binaries, a data folder the `postgres` user can reach, and a socket in that
folder:

```bash
D=$HOME/pgdata
su postgres -s /bin/bash -c "/usr/lib/postgresql/16/bin/initdb -D $D -U postgres -A trust"
su postgres -s /bin/bash -c "/usr/lib/postgresql/16/bin/pg_ctl -D $D -o '-p 55432 -k $D' -l $D/log start"
export DATABASE_URL="postgres://postgres@localhost:55432/postgres?host=$D"
```

## Browser suites

Suites with `browser` in the name (and `docs-samples`) drive Chromium with
`playwright-core`. Without it they print `SKIP` and a zero tally, which the
total counts as passed, so read the line. To run them, install it next to the
app and say where Chromium is:

```bash
cd volt-app
npm i --no-save playwright-core
CHROMIUM_PATH=/opt/pw-browsers/chromium node scripts/check.js browser
```

Some also need ffmpeg with VP9 (`libvpx-vp9`) and `npm install` in
`volt-player`; the `SKIP` line names whatever is missing.

## Encoder tests (Python)

```bash
cd volt-encoder/bin
python3 test_output_check.py
python3 test_timed_events.py
python3 test_id3_emsg.py
```

Each `test_*.py` file in `volt-encoder/bin` runs on its own and prints the
same tally. Most need ffmpeg; none need a database.

## Other harnesses

| Harness | Needs | Run |
|---|---|---|
| API collection (Newman) | a throwaway database: it is dropped and recreated | `volt-app/api/verify.sh` with `DATABASE_URL` set |
| End-to-end media pipeline | Docker | `e2e/run-e2e.sh` |
| Hands-on workflow tests on the Mac | the running stack | `TESTING_WORKFLOWS.md` |

## The ClickHouse analytics store

`clickhouse-store` needs a ClickHouse. With `CLICKHOUSE_URL` unset it starts
the stand-in itself: `volt-app/scripts/chdb-http.py`, the ClickHouse engine
through chDB (`pip install chdb`), serving the part of the HTTP interface the
store uses. It cannot replicate, so the replica drill
(`volt-app/scripts/clickhouse-drill.ts`) needs a real cluster.

The QoE suites run on either store. To run them against ClickHouse, start the
stand-in and point them at it:

```bash
python3 volt-app/scripts/chdb-http.py --port 18123 &
cd volt-app
QOE_STORE=clickhouse CLICKHOUSE_URL=http://127.0.0.1:18123 node scripts/check.js qoe-reports cdn-logs journey cmcd.check
node scripts/check.js clickhouse-store
```

Two harnesses measure it (each prints its numbers and a JSON line):
`volt-app/scripts/qoe-ch-bench.ts` fills 13 months of views at a chosen
audience inside ClickHouse and times every report through the product's own
code; `volt-app/scripts/qoe-load.ts` runs the real collector against 100 000
simulated viewers at the modelled report rate and prints CPU per report.

## Adding a suite

1. Name it `volt-app/test/<what-it-checks>.check.ts` (or `.check.sh`).
   `volt-app/scripts/check.js` finds it by the name; there is nothing to register.
2. Start with a comment that says what it holds true and why it matters, then
   count assertions and print the tally on the last line:

```ts
let passed = 0, failed = 0;
function ok(cond: unknown, msg: string) {
  if (cond) { passed++; console.log(`  ok   ${msg}`); } else { failed++; console.log(`  FAIL ${msg}`); }
}
// ... the checks ...
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
```

3. Use `process.env.DATABASE_URL` for the database and `process.env.API` for
   the control plane, never a fixed `localhost:8080`: the runner gives each
   suite its own. Seed what the suite needs itself; do not rely on another
   suite having run.
4. Prove it can fail: run it once without the change it covers and see it
   fail. A test that cannot fail is not a test. For checkers, feed it a small
   broken input on purpose (`volt-app/test/docs-coverage.check.ts` and
   `volt-app/test/engineering-guides.check.ts` do this).
5. Add a line for it under "Test base" in `DOCS.md`.

The bar the build queue holds every item to: new behaviour has a suite that
would fail without it, the suites around it still pass, and the result is
written as numbers (`33/33`), not adjectives.
