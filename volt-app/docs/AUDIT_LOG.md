# Audit log, channel deletes and channel limits

What an account administrator can see and do about who changed what, and how
channel creation and deletion behave around group limits.

## 1. Every delete is logged

Every `DELETE` in the admin API (`/api/*`) ends in the account's audit log,
whether the route records it itself or not:

| Outcome | Row written | Detail |
|---|---|---|
| Done (2xx), the route wrote its own row | the route's own `delete` row (e.g. a channel's name, group and what was removed with it) | `actor`, `snapshot` |
| Done (2xx), the route wrote nothing | `delete`, written by the request-level net | `actor`, `method`, `path`, `status`, `logged_by: "request"` |
| Refused (400, 403, 409, 412, 422...) | `delete_refused` | the same, plus `reason`: the error the caller was given |
| 401, 404, 428, 5xx | nothing | not signed in, nothing there, the "are you sure?" step of a two-step delete, or a server fault (in the server log) |

The net is `services/deleteAudit.ts`, mounted once on `/api` in `server.ts`.
Each `DELETE` runs inside an `AsyncLocalStorage` context; `writeAudit()` marks
it when a route records its own delete, so a delete is never logged twice.
A route added later is covered without any change. Public viewer
self-deletes (`/api/public/*`) and the platform console (`/api/platform/*`,
which writes its own cross-tenant rows) are outside it.

`entity_type` comes from the path (`/api/output-profiles/<id>` gives
`output_profile`), and `entity_id` is the first id in it.

## 2. Deleting a channel or station

* **Administrators only.** `DELETE /api/channels/:id` needs the admin or owner
  tier (`requireMinRole('admin')`), for TV channels and radio stations alike.
  Anyone else gets 403, and the attempt is logged as `delete_refused`.
* **Stop it first.** A live channel, or one whose encoder is still running,
  is refused with 400 and the reason.
* **See what goes with it.** `GET /api/channels/:id/delete-impact` answers
  `{id, name, kind, group, status, blocker, counts: {recordings, clips,
  published_clips, programmes, scheduled_clips, sources}}`. `blocker` is the
  reason a delete would be refused now, or `null`. The counts go into the
  audit row's `snapshot.removed`.

In the console, administrators remove from a row's **⋯** menu (Remove) on the
Channels and Radio lists, from the Remove button on a channel or station page,
or several at once by ticking rows and choosing Remove in the bulk bar. One:
the dialog shows what goes with it, blocks a running channel with the reason,
and asks for the name to be typed. Several: it lists what will go and what
will be skipped and why, adds up what goes with them, and asks for
"remove N". Each removal is its own request and audit row. See
[UI_FEEDBACK.md](UI_FEEDBACK.md) for the row menu, bulk and confirmation rules.

## 3. Channel limits and create errors

A group's `max_channels` counts **TV channels and radio stations together**.
`GET /api/groups` returns `channel_count` (both kinds) and `radio_count`.

* When a group is full, `POST /api/channels` answers 409 with the numbers:
  *"This group is full: it allows 10 channels and stations together and has
  2 TV channels and 8 radio stations. Remove one, choose another group, or
  ask for a higher limit."*
* The console does not offer what would fail. With every group of a type
  full, **New channel** (and **New station** on Radio) is disabled and the
  reason is a warning in the page notice region at the top of the page
  ([UI_FEEDBACK.md](UI_FEEDBACK.md)). In the create drawer a full group cannot be
  picked, the first group with room is chosen, and the footer says why
  Create is unavailable.
* Anything that goes wrong on Create is shown in the drawer's footer,
  whichever tab is open: validation, a 409 from a group that filled up while
  the drawer was open, a network failure.
* Validation errors (422) now read as sentences:
  `{"error": "Check these fields: name: Required", "code": "ValidationError", "details": [...]}`.
  Programs keep `code` and `details`; people see `error`.

The account-level `accounts.max_channels` is not enforced at create; group
limits are.

## 4. Reviewing the log

**Console:** Insight, then **Audit log** (administrators only). Filter by
action (Deleted, Delete refused, Changed, Created), kind of thing, person,
date range and free text; open a row for the full detail; Export CSV downloads
what is filtered.

**API** (admin or owner; always the caller's own account):

| Route | Answers |
|---|---|
| `GET /api/audit` | `{total, limit, offset, items}` newest first. Filters: `action` (comma list), `entityType` (comma list), `entityId`, `userId`, `q` (text in the detail, the person's email, the type or the id), `from`, `to` (ISO date or epoch ms), `limit` (1-500, default 50), `offset`. Each item: `id, created_at, action, entity_type, entity_id, user_id, user_email, actor, name, detail`. |
| `GET /api/audit/facets` | the actions, entity types and people that appear, with counts |
| `GET /api/audit/export.csv` | the same filters, up to 50,000 rows. Cells a spreadsheet would run as a formula are prefixed with `'`. |

Migration `0050_audit_log_report.sql` adds the indexes these filters use.

## 5. Tests

`bash test/channel-admin.check.sh` (with `DATABASE_URL`): readable validation,
the full-group 409 and `radio_count`, operator delete refused and logged,
delete impact and blockers, admin delete logged once with its snapshot, 404s
not logged, a route with no audit of its own still logged, and the audit API
(admin-only, filters, search, paging, facets, account isolation, CSV export
and formula defusing). 43 checks.
