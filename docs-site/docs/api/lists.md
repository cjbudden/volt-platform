---
title: Search, filter, sort and page
sidebar_position: 3
description: The one way every Volt list works, from recordings to users, and how to follow links between records.
guide: developer
---

# Search, filter, sort and page

Every Volt endpoint that returns a list of records works the same way. Learn it
once and it applies to recordings, VOD assets, jobs, events, users and the rest.
Each list's page in the [API reference](/api-reference) shows exactly which
fields it can search, filter and sort on.

## What it is for

- Showing your catalogue, schedule or recordings in your own tools, filtered and sorted on the server.
- Syncing Volt records into your own systems page by page, however many there are.
- Building search boxes and filters that behave the same on every list.

## Before you start

- An account secret key or an admin session: see [Getting started with apps and keys](apps-and-keys.md).
- `curl` and `jq` for the shell examples, Node 18 or later for the JavaScript one.

## At a glance

| Parameter | What it does | Example |
|---|---|---|
| `q` | Searches the list's text fields. Every word must match, in any order, ignoring case | `q=evening news` |
| `field=value` | Keeps rows where the field equals the value. A comma list means any of them | `state=live,scheduled` |
| `field[op]=value` | Compares with an operator (below) | `created_at[gte]=2026-10-01` |
| `sort` | Orders by one or more fields. Put `-` in front for newest or largest first | `sort=-created_at,name` |
| `limit` | How many rows per page (usually up to 200) | `limit=100` |
| `cursor` | Gets the next page | from the previous response |
| `count=true` | Also tells you how many rows match in total | `X-Total-Count: 1284` |

Field names are the names you see in the response, such as `created_at` or
`channel_id`.

## Step by step

### 1. Filter, sort and read the first page

```bash file=lists/filter-sort-page.sh
```

The first page has two assets, the headers say how many match in all and where the next page starts, and the second request with `cursor=` returns the rest:

```text
X-Total-Count: 3
X-Next-Cursor: eyJmIjoiMEJhTmFTSnVZY09PIiwidiI6...
```

### 2. Read every page

Follow the `Link` header until there is no `rel="next"`:

```js file=lists/all-pages.mjs
```

### 3. When a request is not valid

```bash file=lists/invalid-query.sh
```

### 4. Follow links instead of building addresses

Ask for `application/ld+json` and every answer links to what is related: the entry point to each collection, a collection to its members, a record to its parent and to related records such as a channel's live status.

```bash file=lists/follow-links.sh
```

```json
{
  "id": "https://your-volt-host/api/channels/0000000e-...",
  "type": "volt:Channel",
  "name": "Example News",
  "status": "https://your-volt-host/api/status?channelId=0000000e-..."
}
```

In this form a list is a `hydra:Collection` with `hydra:member` and `hydra:totalItems`. Plain JSON stays as it is when you do not ask for it.

## Operators

| Operator | Means | Works on |
|---|---|---|
| `eq` | equals (the same as `field=value`) | all |
| `ne` | does not equal | all |
| `gt`, `gte`, `lt`, `lte` | greater than, at least, less than, at most | numbers, dates and times |
| `in`, `nin` | any of, none of (comma list) | text, ids, states, numbers |
| `contains`, `starts` | contains, starts with (ignoring case) | text |
| `exists` | has a value (`true`) or is empty (`false`) | all |

Combine as many as you need. They all have to match:

```text
GET /api/jobs?state=failed,cancelled&type[ne]=thumbnail&created_at[gte]=2026-10-17T00:00:00Z&created_at[lt]=2026-10-18T00:00:00Z
```

**Values:** dates and times in ISO 8601 (`2026-10-18` or
`2026-10-18T09:30:00Z`), ids as UUIDs, states from the values the reference
lists, `true` or `false` for yes/no fields.

## Paging

Each response tells you whether there is more, in its headers:

```text
Link: </api/vod?q=news&sort=-created_at&limit=50&cursor=eyJm...>; rel="next"
X-Next-Cursor: eyJm...
X-Page-Limit: 50
```

To get the next page, request the `Link` URL, or send the same request with
`cursor=` added. When there is no `rel="next"`, you have the last page. A
cursor only works with the same search, filters and sort it came from, so the
pages always belong to one consistent view, even while new records arrive.

The [Read every page](#2-read-every-page) example above does exactly this.

Some lists also accept `offset` for jumping to a page number; their reference
page says so. Prefer `cursor` everywhere else.

**Lists that used to return everything** still return up to 1,000 rows when
you send no `limit`, so existing integrations keep working. New code should
always send `limit` and follow the cursor.

## When a request is not valid

Volt tells you what it can do instead, so you can fix the call in one go:

```json
{
  "error": "Unknown filter \"colour\". Filter on: id, title, state, published, channel_id, created_at",
  "code": "invalid_list_query",
  "details": { "parameter": "colour", "filterable": ["id", "title", "state", "published", "channel_id", "created_at"] }
}
```

The same happens for a field you cannot sort on, an operator the field does
not support, a value of the wrong type, a `limit` that is too large, or a
cursor from a different search. See [Errors and limits](errors.md).

## Good practice

- Ask for what you need: filter and sort on the server rather than fetching
  everything and filtering in your app.
- Use `count=true` only when you show a total. It costs an extra count.
- Keep the cursor as an opaque value. Do not build or edit it.
- Your account is never a filter: it comes from your credential, and you only
  ever see your own records.

## Troubleshooting

| Response | Means | Do |
|---|---|---|
| `400` with code `invalid_list_query` and `details.parameter` | A filter, sort field, operator or value the list does not support | Use one of the fields in `details.filterable` (or `sortable`) |
| `400` about the cursor | The cursor came from a different search, filter or sort | Send the cursor with exactly the request it came from |
| `400` about `limit` | Larger than the list allows (usually 200) | Ask for fewer and follow the cursor |
| Square brackets in the URL are rejected by `curl` | `curl` treats `[...]` as a range | Use `curl -g`, or write `%5B` and `%5D` |
