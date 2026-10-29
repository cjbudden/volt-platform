---
title: Genres
sidebar_position: 9.65
description: Keep the account's own genre list, which stations, channels, events and on-demand titles are tagged from, without breaking anything already tagged.
guide: section
---

# Genres

Genres is the account's own genre list. Stations, channels, events and on-demand titles are tagged from it, and it fills the category in the programme guide and the genre that search engines read. Rename, merge, retire or remove genres here, and everything already tagged follows.

![The Genres page: the genre list with the box to add genres, each genre with Retire and Remove, and beside it where the list is used and how changes land](/img/screens/genres.png)

## What it is for

- **One list for the whole account,** so the same programme is not tagged *Sport*, *Sports* and *sport*.
- **Changing it safely.** A renamed or merged genre is changed on everything that carries it when you save; a retired one stays where it is set but is no longer offered.
- **Your order.** Forms offer the genres in the order of the list.

An administrator usually sets it up once and tidies it now and then.

## Before you start

- Every account starts with the platform list (marked **platform default**). You only need to change it if it does not suit you.
- To have a content type's field offer this list, link it in [Content Types](content-types.md): a field with fixed options, its options taken from the Genres list. **Where it is used**, on the right, shows the fields linked now.
- **Account settings: Manage** to change the list (see [Who can do it](#who-can-do-it)).

## Step by step

Changes stay on the page until you choose **Save genres**, so you can try things and use **Discard changes** to start again. Before you save, a line beside the buttons sums up the renames, merges and removals, and how many items will be updated.

### Add genres

1. Open **Admin**, then **Genres** under Media setup.
2. Type a genre in the box at the top, or several separated by commas (for example *Podcasts, True crime*), then **Add**. A genre already on the list is skipped, and a message says so.
3. Choose **Save genres**.

### Rename a genre

1. Change its name in the list. It is marked **renamed**, with how many items will be updated.
2. Choose **Save genres**. Every station, channel, event and title tagged with it now carries the new name, and the message says how many were updated.

### Merge two genres

1. On the genre you no longer want, choose **Merge into…** and pick the genre to keep. (It is offered on genres that something uses.)
2. Choose **Save genres**. Everything tagged with the first genre now carries the second, and the first leaves the list. **Undo merge** takes it back before you save.

### Retire or remove a genre

- **Retire** keeps a genre on whatever already carries it but stops offering it in forms. **Restore** offers it again.
- **Remove** takes a genre off the list. It is only possible when nothing uses it: the count beside each genre says **used by** and a number, or **not used**. Retire or merge a genre that is in use instead.

Choose **Save genres** afterwards. Keep at least one genre that is not retired.

### Put the list in order

- Drag a genre by its handle, or select it and press Alt and the up or down arrow.
- **Sort A to Z** sorts the whole list.
- **Find a genre** narrows the list while you look (drag to reorder is off while it is narrowed).

Choose **Save genres** afterwards.

### Tidy genres that are in use but not on the list

**In use but not on the list** shows genres set before the list was linked, or brought in by an import, with how many items carry each. Choose one to add it to the list, then rename, merge or retire it like any other.

### Go back to the platform list

1. Choose **Reset to platform list**, then **Reset**.
2. The list goes back to the platform's genres in their order. Your own genres that something still uses are kept, retired; the rest are removed. Nothing tagged is changed.

## How it connects

| Section | How it relates |
|---|---|
| [Content Types](content-types.md) | A field with fixed options can take them from this list; saving the list updates the content types that offer it |
| [EPG](epg.md) | The genre fills a programme's category in the guide. Programmes already in the guide keep the category they were announced with |
| [Media Library](media-library.md) | Titles are tagged with a genre from the list in their metadata |
| [Channels](channels.md), [Radio](radio.md) and [Events](events.md) | Each stream can carry a genre from the list |

See [How Volt fits together](../getting-started/how-volt-fits-together.md) for the whole map.

## Who can do it

| Task | Access needed |
|---|---|
| See the list and where it is used | Account settings: View |
| Add, rename, merge, retire, remove, reorder and reset genres | Account settings: Manage |

Without Manage the list is read-only, and the page says so.

Roles and levels are explained in [Roles and access](../getting-started/roles-and-access.md).

## Troubleshooting

| You see | What it means | What to do |
|---|---|---|
| **Two genres have the same name. To combine them, use Merge on one of them.** | Two genres differ only in capitals or spaces | Rename one, or use **Merge into…** |
| **A genre has no name.** | A name box is empty | Type a name, or remove the genre |
| **Keep at least one genre that is not retired.** | Every genre is retired | **Restore** at least one |
| **Remove** is greyed out | Something carries that genre | **Retire** it, or merge it into another genre |
| **No content type field takes its options from this list.** | No form offers the list yet | Link a field in [Content Types](content-types.md) |
| A save fails because the list changed | Someone else saved the list while you were editing | Reload the page and make your change again |
| A programme in the guide still shows the old genre | Programmes already announced keep the category they were sent with | New and updated programmes use the new name |

## Through the API

| Request | Does |
|---|---|
| `GET /api/metadata-lists`, `GET /api/metadata-lists/genres` | The account's lists, or the genre list with each genre's use, the fields linked to it and the genres in use but not on the list |
| `PUT /api/metadata-lists/genres` | Saves the list: `items` in order (each with `retired` if it is), `renames` from one genre to another (a rename or a merge), and the `version` you read so a change by someone else is not overwritten |
| `POST /api/metadata-lists/genres/reset` | Goes back to the platform list |

```bash
curl -X PUT -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"items": [{"value": "News"}, {"value": "Sport"}, {"value": "Podcasts"}], "renames": [{"from": "Sports", "to": "Sport"}], "version": 3}' \
  "https://your-volt-host/api/metadata-lists/genres"
```

Every route is in the [API reference](/api-reference).
