# Volt API standards

How every Volt API endpoint behaves, so a developer who has used one can use
them all. New endpoints follow this; existing ones are brought into line (see
the rollout table at the end). Status: **in place** = enforced in code and
checks today, **adopting** = being rolled out endpoint by endpoint,
**proposed** = agreed direction, not built yet.

Built on established practice rather than invented here: Google's API
Improvement Proposals for lists ([AIP-132](https://google.aip.dev/132)) and
filtering ([AIP-160](https://google.aip.dev/160)), JSON:API's `sort=-field`
convention, Stripe's bracket operators (`created[gte]=`) and cursor paging,
RFC 8288 `Link` headers, RFC 9457 problem details, and Volt's own hypermedia
principle (every resource links to its parent, siblings and children).

## 1. Every API service says what it is for (in place)

Each service (a tag in the API reference) carries a usage statement: what it
is for, the key tasks with their endpoints, the credential and access it needs,
and one rule worth knowing. Written in `openapi-overlay.json` under `tags`.
`npm run docs:openapi -- --check` fails if a service has no statement, so a new
service cannot ship undocumented.

## 2. Lists: search, filter, sort, page (in place for 29 lists, adopting for the rest)

Every endpoint that returns a collection of records accepts the same query
parameters, implemented once in `src/util/listQuery.ts`:

| Parameter | Meaning | Example |
|---|---|---|
| `q` | Free-text search over the resource's searchable fields. Every word must match, case-insensitive, partial | `q=evening news` |
| `<field>=v` | Equals. A comma list means any of | `state=live,scheduled` |
| `<field>[op]=v` | Operators: `eq ne gt gte lt lte in nin contains starts exists` (which ones depends on the field's type) | `created_at[gte]=2026-10-01` |
| `sort` | Comma list of fields, `-` for descending. Ties are broken by id, so order is always stable | `sort=-created_at,name` |
| `limit` | Page size. Default 50, max 200 (a resource may document other values) | `limit=100` |
| `cursor` | Another page, from the previous response. Bound to the same search, filters and sort | from `Link: rel="next"`, `"prev"` or `"last"` |
| `offset` | Page jump, only where a resource allows it | `offset=200` |
| `count=true` | Also return the total that match (costs a count, so opt in) | `X-Total-Count: 1284` |

Rules:
- **Field names are the names in the response** (`created_at`, `channel_id`).
  Older camelCase parameter names keep working as aliases.
- **Only documented fields** can be filtered or sorted. Anything else is a `400`
  that lists what is allowed, so a developer fixes the call in one go.
- **Values are typed:** dates in ISO 8601, ids as UUIDs, enums from the listed
  values, booleans as `true`/`false`. A wrong type is a `400` naming the field.
- **Paging is in headers** (`Link: <...>; rel="next"`, `rel="prev"`,
  `rel="first"`, `rel="last"`, `X-Next-Cursor`, `X-Prev-Cursor`,
  `X-Total-Count`, `X-Page-Limit`), so the body keeps its shape and no existing
  client breaks. No `Link: next` means the last page, no `Link: prev` the
  first. Cursors are keyset in both directions: `prev` reads the rows before
  the first row of this page, `last` the final page of the view. A list that
  fits on one page sends no paging links.
- **Times page at millisecond precision.** Records in the same millisecond
  are ordered by id, so paging by a time never repeats or skips a record.
- **Never unbounded:** a list of records that grows (recordings, programmes,
  audit entries, jobs, notifications, users) always pages.
- **Documented automatically:** each list's filters, operators, sort fields,
  searchable fields and limits are exported from the same definition the
  server parses with, and appear as parameters in the API reference.
- **Tenancy is not a filter:** the account comes from the credential, never
  from a parameter.

Not every GET is a list: a computed view (status, a report, a stats summary)
or a small fixed lookup (languages, protocols) takes the parameters it needs
and says so, rather than pretending to be a table.

## 3. Methods and status codes (in place, being made uniform)

| Action | Method | Success |
|---|---|---|
| List / read | `GET` | `200` |
| Create | `POST` on the collection | `201`, body is the new resource (`Location` header: proposed) |
| Change some fields | `PATCH` | `200`, body is the updated resource |
| Replace | `PUT` | `200` |
| Delete | `DELETE` | `204` |
| An action that is not a field change (start, convert, copy-day) | `POST /resource/:id/<verb>` | `200`/`202` |

`202 Accepted` means queued work; the body links to a job to follow.

## 4. Errors (in place; RFC 9457 fields proposed)

```json
{ "error": "state must be one of: live, ended, scheduled",
  "code": "invalid_list_query",
  "details": { "field": "state", "allowed": ["live", "ended", "scheduled"] } }
```

- `error` is a sentence a person can act on. `code` is stable for programs.
  `details` says which field and what is allowed.
- `400` bad parameter, `401` no or expired credential, `403` signed in but not
  allowed (with the feature and level missing), `404` not found (also for
  another account's id, never 403), `409` conflict with current state, `422`
  body failed validation (field by field), `429` too many requests.
- **Proposed:** also send RFC 9457's `type`, `title` and `status` with
  `Content-Type: application/problem+json`. Additive: existing clients keep
  reading `error`.

## 5. Data formats (in place)

- Ids are UUIDs. Timestamps are ISO 8601 in UTC (`2026-10-18T07:30:00.000Z`).
- Durations in milliseconds with an `_ms` suffix, bitrates in kb/s with `_kbps`.
- Field names in responses are snake_case. JSON only.
- Collections link to items and items to their parents and related records
  (`self`, `up`, `related`, typed rels), so clients navigate rather than build
  URLs.

## 6. Safe writes (proposed)

- **Idempotency:** `Idempotency-Key` header on `POST` that creates, so a retry
  after a timeout cannot create twice. Keys kept 24 hours per account.
- **Concurrent edits:** `ETag` on reads, `If-Match` on `PATCH`/`PUT`; a stale
  write gets `412` instead of silently overwriting someone else's change.
- **Bulk:** where a UI acts on many rows, a bulk endpoint taking ids, answering
  per item.

## 7. Limits (proposed)

`RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset` on every response,
`429` with `Retry-After` when exceeded. Limits per credential, documented.

## 8. Change and versioning (in place)

- Changes are additive: new fields, new optional parameters, new endpoints.
  Clients must ignore fields they do not know.
- A breaking change needs a new version of that endpoint and a deprecation
  period. The old one sends `Deprecation` and `Sunset` headers (RFC 9745,
  RFC 8594) and is listed in the release notes (`changed`/`removed`).
- Every release's API changes are in the customer release notes
  (`RELEASING.md`).

## 9. Checklist for a new or changed endpoint

1. Belongs to a service with a usage statement (or add one).
2. Lists use `defineList` + `parseList` + `finishPage`; no hand-written sort or limit.
3. Tenant scoping from the credential in the SQL, not from a parameter.
4. Typed input validation (zod); errors per section 4.
5. `npm run docs:routes`, add a capture step for client-facing routes, `npm run docs:openapi`.
6. A change note (`scripts/release/change.mjs`), scope `core` if customers see it.

## 10. Rollout status (18 October 2026)

**On the standard (29 lists):** every one tested by `test/listStandard.check.ts`
(each sort both ways, every filter with every operator, search, paging,
unknown-filter refusal) against a real database.

| Area | Lists |
|---|---|
| Media | `/api/vod`, `/api/recordings`, `/api/scheduled-clips`, `/api/publications`, `/api/publish-targets`, `/api/share-links`, `/api/filler-assets` |
| Operations | `/api/jobs`, `/api/workflows/runs`, `/api/workflows/events`, `/api/status`, `/api/status/:kind/:id/events`, `/api/monitoring/feed`, `/api/notifications`, `/api/notifications/inbox`, `/api/storage/objects`, `/api/tickets` |
| Catalogue | `/api/channels`, `/api/events`, `/api/radio`, `/api/epg`, `/api/epg/channels`, `/api/epg/xmltv/feeds`, `/api/users`, `/api/apps`, `/api/apps/keys`, `/api/watchfolders/:id/items`, `/api/ingest/held`, `/api/ingest/transfers` |

**Already strong, own conventions, to align next:** `/api/audit` and
`/api/viewers` (q, filters, limit/offset, `{total, items}`), `/api/files`
(full-text search, sort names), `/api/radio/:id/log`, `/api/recordings/sources`.
These keep working as they are; aligning them means adding the standard names
alongside their current ones.

**Small configuration lists, low priority:** metadata schemas, groups,
user groups, encoding/output profiles, payment products, watch folders and
their rules, ingest rules and webhooks, XMLTV import sources and runs, add-ons,
notification devices, the review queue, uploads, and the public user's
purchases and sessions.

**Console:** lists that returned everything still do up to 1,000 rows when no
`limit` is sent (`unpagedLimit`). The VOD library, channels, events and
recordings pages filter and sort in the browser today; moving them to server
search and paging (with facet counts for the filter chips) is the next step,
after which the compatibility cap can drop to the default page size.

**Indexes to add** (so the new sorts and filters stay fast as tables grow):
`vod_assets (account_id, created_at DESC)`; `recordings (channel_id,
start_epoch_ms DESC)` and `(event_id, start_epoch_ms DESC)`; `jobs (created_at
DESC)`; `stream_events (ts DESC)`; `addon_runs (account_id, created_at DESC)`
(exists); `media_objects (updated_at DESC)`; `support_tickets (account_id,
created_at DESC)`; `channels (group_id, created_at DESC)`; `events (group_id,
scheduled_start DESC)`; `share_links`, `filler_assets`, `apps`, `api_keys`,
`ingest_transfers (account_id, created_at DESC)`; `watchfolder_items
(watchfolder_id, seen_at DESC)`; and for `q` on large libraries, trigram GIN
indexes on titles and names (`pg_trgm`). The programme title full-text index
exists but search does not use it yet.

**Fixed on the way:**
- **VOD ownership:** an uploaded or watch-folder asset (owned by its account,
  with no channel or event) was "not found" in eight places. Its publications
  could not be listed, it could not be published to social or shared, global
  search missed it, the review and QC counts and the app/player metadata
  skipped it, and clip thumbnails could not resolve it. Share links also missed
  assets recorded from events. All now use the library's ownership rule
  (`test/vodOwnership.check.ts`, which fails on the old code).
- **Ignored filter:** `/api/vod?recordingId=` was ignored and returned every asset.
- **Bad limit:** `/api/status/:kind/:id/events?limit=abc` was a server error.
