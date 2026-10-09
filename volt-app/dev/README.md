# volt-app/dev — legacy harness, NOT the product

Two things retired here, both from before `volt-web` and `run-on-mac.sh`
existed. Neither is used by the product, the test suites, or the Docker image.

## run-local.sh — DANGEROUS, and that is why it moved

Its second real line was:

```sql
DROP SCHEMA public CASCADE; CREATE SCHEMA public;
```

No prompt. No flag. No confirmation.

It ran by accident. Somebody in `volt-app/` typed `cd volt-encoder`, the `cd`
failed, the shell stayed where it was, and the next line — `bash run-local.sh` —
found THIS script rather than the encoder one. It dropped the whole schema and
reseeded demo data. Twice. Every channel, station, recording, VOD asset, API key
and user, gone, because of a failed `cd`.

It now refuses unless `RESET=1` is set, and says what it would have destroyed.

It also runs with `ORCH_LAUNCHER=mock`, so nothing actually streams: it was only
ever a way to look at the UI against seeded data.

**To start the product, keeping your data:** `bash run-on-mac.sh` from the repo
root.

## console.html — the "weeks old interface"

A 205-line single-file test console, served at `/console`, written before
`volt-web` existed. It looked enough like a console that finding it reasonably
suggested the app had a second, older front end. It does not. `/console` now
redirects to `/`, which serves the real console.

## What is still worth having

`dev/run-local.sh` with `RESET=1` is a fast way to get a clean, fully seeded demo
database when you actually want one. That is a real need; the problem was only
ever that it was one typo away from doing it to you unasked.
