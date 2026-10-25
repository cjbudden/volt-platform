# Volt engineering guides

For whoever builds and runs Volt: how the pieces fit together, how to run it on
a Mac, how it is tested, how work is queued and released, how the customer docs
are made, and how it goes to AWS. These live in the repository, not on the
customer site. Customer guides are in `docs-site/docs` and follow their own
rules (`docs-site/MAINTAINING.md`).

| Guide | Read it when |
|---|---|
| [Architecture and service map](architecture.md) | you need to know which process does what, and where its code is |
| [Running Volt on a Mac](running-on-the-mac.md) | you want the whole product running on one machine |
| [Check suites](check-suites.md) | you want to run the tests, or add one |
| [The build queue and runbook](build-queue.md) | you are taking the next item, by hand or as the scheduled task |
| [Releasing](releasing.md) | you are writing a change note or cutting a version |
| [The docs site](docs-site.md) | you are changing a customer guide, a screenshot or a code sample |
| [Deploying to AWS](deploying-to-aws.md) | you are preparing or running the cloud deployment |

The design documents these guides point into are listed in `DOCS.md` (the
project map). The status of every capability is in `VOLT_BUILD_STATUS.md`.

## Conventions

- **Paths** in code are from the repository root (the `volt` folder).
- **Commands** in a code block start at the repository root. A block that
  needs another folder starts with `cd`.
- **(Mac)** marks a command that needs the Mac's Docker, ffmpeg or audio, and
  **(AWS)** one that needs AWS credentials. Everything else runs on any machine
  with Node 20+ and, for the database suites, Postgres 16.
- **No secrets.** No keys, tokens or passwords appear here. The local sign-in
  is printed by `run-on-mac.sh` when it starts.
- Source paths and environment variable names are fine here; they are banned
  only from the customer site.
- No em dashes, plain sentences, Australian spelling.

## How these guides stay true

A small checker reads every guide here and fails on a path that is not in the
tree, a command whose script, file or `npm run` script is missing (it follows
each block's `cd`), a `node scripts/check.js` filter that matches no suite, a
broken relative link, a guide this page does not link to, anything that looks
like a secret, and an em dash:

```bash
node scripts/docs/check-engineering.mjs
node scripts/docs/check-engineering.mjs --list    # also print every path and command it checked
```

The `engineering-guides` check suite (`volt-app/test/engineering-guides.check.ts`)
runs it on the real tree and on small broken trees, so a checker that stopped
noticing would fail too. When you rename a script or move a file, this is what
tells you which guide to fix.
