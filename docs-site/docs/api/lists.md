---
title: Search, filter, sort and page
sidebar_position: 3
description: The one way every Volt list works, from recordings to users.
---

# Search, filter, sort and page

Every Volt endpoint that returns a list of records works the same way. Learn it
once and it applies to recordings, VOD assets, jobs, events, users and the rest.
Each list's page in the [API reference](/api-reference) shows exactly which
fields it can search, filter and sort on.

## At a glance

```bash
curl -s "https://your-volt-host/api/vod?q=evening%20news&published=true&created_at[gte]=2026-10-01&sort=-created_at&limit=50" \
  -H "Authorization: Bearer $TOKEN" -D headers.txt
```

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

```
GET /api/jobs?state=failed,cancelled&type[ne]=thumbnail&created_at[gte]=2026-10-17T00:00:00Z&created_at[lt]=2026-10-18T00:00:00Z
```

**Values:** dates and times in ISO 8601 (`2026-10-18` or
`2026-10-18T09:30:00Z`), ids as UUIDs, states from the values the reference
lists, `true` or `false` for yes/no fields.

## Paging

Each response tells you whether there is more, in its headers:

```
Link: </api/vod?q=news&sort=-created_at&limit=50&cursor=eyJm...>; rel="next"
X-Next-Cursor: eyJm...
X-Page-Limit: 50
```

To get the next page, request the `Link` URL, or send the same request with
`cursor=` added. When there is no `rel="next"`, you have the last page. A
cursor only works with the same search, filters and sort it came from, so the
pages always belong to one consistent view, even while new records arrive.

```js
// Every failed job from the last day, page by page
let url = '/api/jobs?state=failed&created_at[gte]=2026-10-17&limit=200'
while (url) {
  const res = await fetch(base + url, { headers: { Authorization: `Bearer ${token}` } })
  handle(await res.json())
  url = (res.headers.get('Link') ?? '').match(/<([^>]+)>;\s*rel="next"/)?.[1]
}
```

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
