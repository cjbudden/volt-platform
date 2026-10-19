# Timeline mode (Past · Now · Next)

Status: approved for build, phase 1 first. Concept screens: the "Volt Past Now Next concepts" design canvas (board 7, "As a view mode in today's app", is the phase 1 target; boards 1 to 3 show where it goes later).

## What it is

A third way of looking at the Live Streams page, beside the existing Board (and a plain List). Every stream the user can see is one row on a shared clock:

- left of the current-time line: what went to air, from the programmes that aired and the media actually recorded, with gaps (no media) drawn as hatched red;
- the current programme straddling the line, highlighted;
- right of the line: what is scheduled, drawn as outlined blocks.

It is a view, not a new place. The left menu does not change. A row opens the same detail page the Board opens. The channel detail page's existing Timeline tab is the same idea at the scope of one stream, so the row renderer is built to serve both (the "one surface, two scopes" rule in the IA notes).

## Phase 1 scope (this build)

Read-only timeline view on Live Streams.

1. View switch on Live Streams: `Board | List | Timeline`. The choice is remembered per user (local storage is enough for phase 1; a user preference field is a follow-up). Board stays the default.
2. Window control: presets `−1h/+2h`, `−2h/+4h` (default), `−6h/+6h`, `−12h/+12h`, plus "Now" to recentre. Pan by dragging the ruler; the current-time line moves in real time.
3. Rows: channels (TV), radio stations, events (window from `scheduled_start`/`scheduled_end`, actual times when known), loops (one continuous block). FAST rows show what played and what is queued only if that data exists; otherwise they are omitted in phase 1.
4. Grouping: by channel group (`groups` table), collapsible, with a "Pinned first" toggle (pins kept per user in local storage for phase 1). Trouble rows (degraded or error) sort to the top of their group, matching the Board's rule.
5. Each row: name, type, the same status pill the Board uses (from the server's five-gate roll-up, never computed in the client), segments, clip ticks when cheap to fetch.
6. Click a segment: past opens the recording workbench at that time; now opens the stream's detail page; future opens the programme drawer the EPG pages already use.
7. Live state comes from the existing status stream (`/api/status/stream`), so pills and the current block update without polling the grid.

Out of scope for phase 1: drag-to-clip, drag-to-create, dropping media on FAST rows, caption search hits, mobile layout, making Timeline the home screen.

## Backend: one grid call

Today the data exists per owner (`/api/epg?channelId|eventId&from&to`, `/api/epg/now-next`, `/api/channels/:id/timeline`, `/api/channels/:id/coverage`, `/api/monitoring/live`). A grid of 20 streams must not make 60 requests. Add:

`GET /api/timeline/grid?from=<iso>&to=<iso>&kinds=channel,radio,event,loop&groupId=<id>&cursor=<c>&limit=<n>`

- Account-scoped and permission-filtered exactly like `/api/monitoring/live` (rows a role cannot `view` are absent, not empty).
- Window cap: 48 hours (reject wider with 400 and a clear message). Row cap per page: 50, with a cursor, following the existing list conventions (`parseList`/`finishPage`) and the hypermedia links rule in the API standards.
- Response:

```json
{
  "window": {"from": "...", "to": "...", "now": "..."},
  "rows": [
    {
      "kind": "channel", "id": "...", "name": "Channel 2", "groupId": "...", "groupName": "News",
      "status": {"state": "onair", "label": "On air"},
      "programmes": [{"id": "...", "title": "...", "start": "...", "end": "...", "asRun": true, "vodState": "converted"}],
      "media": {"runs": [{"start": "...", "end": "..."}], "gaps": [{"start": "...", "end": "..."}]},
      "clips": [{"id": "...", "start": "...", "end": "..."}],
      "links": {"self": "...", "detail": "...", "workbench": "...", "epg": "..."}
    }
  ],
  "next": "<cursor or null>"
}
```

- Build it by composing the existing services, not new SQL logic: programmes from the same query `/api/epg` runs (as-run preferred over scheduled, as `/timeline` lane 3 already does), media runs and gaps from the same resolver `/coverage` uses (measured from disk, not declared windows), status from the same function the Live board uses. Batch the programme query across owners with one `owner IN (...)` query rather than one query per row.
- `media` is only filled for the past part of the window; the future part never touches disk.
- Events: one programme-like block from the event's window; actual start/end when known.
- Keep it cheap: no thumbnail or waveform work in this call.

## Frontend

- New `TimelineGrid` component in `volt-web/src` (reuse the existing timeline engine state, `{startMs, msPerPx}`, and the EPG timeline's block and now-line styling; do not add a timeline library).
- Render only visible rows (simple windowing) so 200 rows stay smooth.
- Tokens only: colours, type sizes and radii from `index.css` / the design system. Past blocks `--panel-3`, now block a `--brand-dim` fill with a 1px brand border, future blocks dashed `--border-2`, gaps hatched in `--down`. Status pills via `<StatusPill>`. No coloured edge bars on rows or blocks.
- Keyboard: arrow keys pan, `+`/`-` zoom, `N` recentres on now, Enter opens the focused block.

## Tests

- `test/timeline-grid.check.ts`: window cap, permission filtering (a viewer without radio rights gets no radio rows), cursor paging, as-run preferred over scheduled, gaps reported from coverage not from declared windows, events placed from their window.
- Add the route to the Postman collection and the API docs (`npm run docs:routes`, `docs:openapi`).
- `npm run typecheck` clean for `volt-app` and `volt-web`.

## Later phases

2. Past actions: drag across a row to select, hand off to the existing clip flow (coverage verdict `clippable` guards it); outage markers from the status event log.
3. Next actions: clash overlay from `/api/epg/conflicts`; drag on empty time to create an event (the EPG timeline already does click-to-add).
4. FAST drop-to-schedule (needs FAST scheduled playout), searching inside captions (needs a caption index), mobile layout, Timeline as an optional home screen.
