# Bulk actions and management confirmation

`services/bulkActions.ts`, `modules/vodBulk.ts`, console `BulkRemoveDialog.tsx` and `BulkRequests.tsx`.

## Bulk remove (Media Library)

Select assets, then **Remove** in the bulk bar. The dialog lists what goes and which cannot go now and why (an asset in
an active FAST lineup is left out), and asks for the number of assets to be typed. The server checks that number again
(`confirm`), so an API caller has to say it too.

Each asset goes the way a single delete does (`services/vodRemove.ts`): the `vod_assets` row and what cascades from it
into `trash_items`, its packaged media (HLS, DASH, FAST ladder variants, reframes, trick play) and an uploaded source
into the restore bin (`VOLT_TRASH_DIR`, and the origin bucket's `trash/` with `VOD_STORE=s3`), held for
`VOLT_LIBRARY_TRASH_DAYS` (default 2). **Undo** on the notice, or **Storage > Recently removed**, puts them back. The
hourly retention sweep purges them after that (`docs/RETENTION.md`).

| Route | |
|---|---|
| `POST /api/vod/bulk/remove/impact` `{ ids }` | what would go, per item, with a reason where it cannot |
| `POST /api/vod/bulk/remove` `{ ids, confirm, note? }` | 200 with `done` and `refused`, or 202 with a request |
| `POST /api/vod/bulk/restore` `{ ids }` | undo: each asset's latest bin item |
| `GET /api/vod/bulk/requests?pending=1` | requests, and whether the caller may decide |
| `POST /api/vod/bulk/requests/:id/approve` / `reject` `{ note? }` | administrator or owner, not the person who asked |
| `POST /api/vod/bulk/requests/:id/cancel` | the person who asked, or an administrator |

At most 500 items at a time. The routes need the Media Library's manage permission, like a single delete.

## Management confirmation

**Account settings > Bulk actions > A manager confirms bulk actions** (`accounts.bulk_needs_approval`). **Off by
default.** When on:

* a bulk action asked for by someone below administrator is not run: it becomes a request (`bulk_requests`) shown above
  the Media Library;
* an administrator or owner approves or rejects it; nobody approves their own; approving runs it there and then, on
  the items as they are now (one that has since gone or become blocked is refused with its reason);
* administrators and owners run their own bulk actions after the usual confirmation;
* a request nobody decides expires after 7 days; the person who asked can withdraw it while it waits;
* requests, decisions and every removal are in the audit log.

Bulk remove is the only bulk action registered so far. Another one joins by adding an entry to `BULK_ACTIONS` and
calling `runOrRequest`.
