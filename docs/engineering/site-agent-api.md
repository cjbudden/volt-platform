# The site agent API

The routes `volt-agent` uses on a Hybrid Site: enrolment, heartbeat and
config, on-prem watchfolders, the job lease and file transfers. They are
machine-to-machine (`machine` in `volt-app/docs/api-routes.json`), so the
customer API reference leaves them out on purpose (`volt-app/scripts/openapi.mjs`
includes only public, admin, sign-in, delivery and discovery routes). This page
is their reference. The console routes for sites and Mirror and Archive
(`/api/sites`, `/api/archive`) are customer routes and are in the customer API
reference and the guides (`docs-site/docs/guides/hybrid-sites.md`,
`docs-site/docs/workflows/mirror-and-archive.md`).

The design is `HYBRID_SITES.md`. Customers running a site read
`docs-site/docs/guides/running-a-site.md`.

**Every route below is checked:** the `site-agent-api` suite
(`volt-app/test/site-agent-api.check.ts`) reads the routes from the real
Express app and fails when one is missing from the tables here, or when a
table names a route that no longer exists.

```bash
cd volt-app
node scripts/check.js site-agent-api
```

## Who may call them

| Credential | Routes |
|---|---|
| A one-time enrolment token (`vsenrol_...`, made in Admin, Sites), in the body | `POST /api/site-agent/enrol` only |
| The host's credential (`Bearer vsite_...`) | Everything else. A pending host may only heartbeat and read config; work needs an approved host, and only of its own site |
| The URL itself (signed for one job, lease, transfer and expiry) | `/api/site-agent/transfers/:token` |

Licences: either `hybrid_sites` or `mirror_archive` opens enrolment,
heartbeat, config and the job lease (Mirror and Archive runs on the same
sites). The watchfolder routes need `hybrid_sites`. A disabled site, a
rejected host or a withdrawn licence answers `401` or `403`, and the agent
stops (`volt-agent/src/site.ts`, `runSite`). Code: `volt-app/src/modules/sites.ts`
(routes), `volt-app/src/services/sites/` (the work).

## Enrolment, heartbeat and config

| Route | Body and answer |
|---|---|
| `POST /api/site-agent/enrol` | `{ token, host }` with the host's facts (cores, memory, GPUs and encode sessions, free disk, versions). Answers the site, the new host (`pending`) and its credential, shown once |
| `POST /api/site-agent/heartbeat` | `{ host, configVersion }`. Answers the host's standing, `heartbeatSeconds` (30), `pullConfig` when the agent's config is behind, and `rotate.credential` when an administrator rotated it. The agent saves a rotated credential before using it; the old one works until the new one is first used |
| `GET /api/site-agent/config` | What the host should run: the site, its add-ons, the config version |

A host not heard from for 90 seconds is stale and after 10 minutes offline
(`volt-app/src/services/sites/sites.ts`).

## On-prem watchfolders

An approved host of the folder's own site only, with `hybrid_sites`. The
agent runs the same rules as the cloud scanner
(`volt-app/src/services/watchfolder/rules.ts`, shared, not copied) and the
cloud keeps the truth: the agent's memory in its state file only saves work.

| Route | Does |
|---|---|
| `GET /api/site-agent/watchfolders` | The site's folders with their rules, as the scanner takes them |
| `POST /api/site-agent/watchfolders/:id/known` | `{ objectKey, checksum }`: has the cloud already got this file? |
| `GET /api/site-agent/watchfolders/:id/quarantine-keys` | Names in use in the review folder, so a refused file never overwrites one |
| `POST /api/site-agent/watchfolders/:id/items` | One decision: accepted (with its target), or refused and moved to review |
| `GET /api/site-agent/watchfolders/:id/uploads` | Accepted files still to upload, each with its open upload |
| `GET /api/site-agent/watchfolders/:id/registrations` | Encode at site: accepted video and audio still to register |
| `POST /api/site-agent/watchfolders/:id/registrations/:itemId` | `{ sizeBytes, checksum, head, probe }`: registers the file, which stays at the site. The answer carries `sidecar`, the ingest sidecar to write beside it |
| `GET /api/site-agent/watchfolders/:id/fallbacks` | Encode at site: originals to send to the cloud because the site did not encode them in time |
| `POST /api/site-agent/watchfolders/:id/fallbacks/:itemId` | `{ ok: false, error }`: the original could not be sent (gone, or changed size) |
| `GET /api/site-agent/watchfolders/:id/returns` | Refused files an operator sent back for another try |
| `POST /api/site-agent/watchfolders/:id/returns/:itemId` | `{ ok, error }`: the file was moved back, or not |
| `GET /api/site-agent/watchfolders/:id/reviews` | Files the cloud sent to review, to move into the review folder |
| `POST /api/site-agent/watchfolders/:id/reviews/:itemId` | `{ ok, error }`: the file was moved to review, or not |
| `POST /api/site-agent/watchfolders/:id/scanned` | `{ error }`: a pass finished, with the error if it failed (shown as **Last scan failed**) |

## Uploads (tus)

The file itself, resumable, on the tus protocol, with the host credential
(`volt-app/src/modules/siteTus.ts`). The upload metadata names the folder
and item; `fallback 1` marks an original sent for a cloud encode.

| Route | Does |
|---|---|
| `OPTIONS /api/site-agent/tus` | tus capabilities |
| `POST /api/site-agent/tus` | Starts an upload |
| `HEAD /api/site-agent/tus/:id` | How much has arrived, to resume |
| `PATCH /api/site-agent/tus/:id` | Sends the next part |
| `DELETE /api/site-agent/tus/:id` | Abandons an upload |
| `OPTIONS /api/site-agent/tus/:id` | tus capabilities for one upload |

## The job lease

Work for a site (encodes, archive copies and checks) is a job in the pool
`site:<id>` (`volt-app/src/services/sites/siteJobs.ts`). An approved host
leases it; the lease lasts 120 seconds and every progress call extends it.
A host that goes quiet loses the lease to the reaper and the job goes back to
the pool; every later call by that host answers `409 lease_lost`.

| Route | Body and answer |
|---|---|
| `POST /api/site-agent/jobs/lease` | `{ types? }`: the next job of the site's pool with its `leaseId`, or `204`. GPU jobs only to hosts that reported an NVIDIA card |
| `POST /api/site-agent/jobs/:id/progress` | `{ leaseId, pct?, note? }`: extends the lease |
| `POST /api/site-agent/jobs/:id/complete` | `{ leaseId, result? }`: the cloud judges the result (an archive copy's checksum, an encode's package) before the job counts as done |
| `POST /api/site-agent/jobs/:id/fail` | `{ leaseId, error, code?, permanent? }`: retried with backoff unless `permanent` |
| `POST /api/site-agent/jobs/:id/transfer-url` | `{ leaseId, name }`: one URL for one transfer the job lists, valid 15 minutes |
| `POST /api/site-agent/jobs/:id/outputs` | `{ leaseId, files: [{ path, bytes, sha256 }] }`: declares a site encode's package before it is uploaded |

## Transfers

A job lists its transfers in its payload (`{ name, direction, uri }`), written
by the cloud when it queued the job. The host asks for a URL for one of them
by name and can never name a path or key of its own.

- On AWS the URL is a presigned S3 GET or PUT (an upload's SHA-256 signed in),
  so the bytes never pass through the control plane.
- On the single Mac server it is a URL on this API, signed for that job,
  lease, transfer and expiry, and checked against the lease again when used:

| Route | Does |
|---|---|
| `GET /api/site-agent/transfers/:token` | Downloads the file the token names (an archive copy's source) |
| `PUT /api/site-agent/transfers/:token` | Uploads the file the token names (a site encode's package file) |

## Adding a route

Add it to `volt-app/src/modules/sites.ts` (its header lists every route),
document it in a table here, then run `npm run docs:routes` in `volt-app` so
the route inventory has it, and the suite above.
