---
title: Collections
sidebar_position: 3.55
description: Group library media your own way, nested as deep as you need and in your own order, then browse the library or program a FAST channel from a collection.
guide: section
---

# Collections

Collections are your own groupings of library media: a collection per channel or show, with a sub-collection for each week's line-up. A title can be in any number of collections, each collection keeps its own running order, and removing a collection never removes media.

![The Collections page: the tree of collections on the left, and a sub-collection open on the right with its name, description, colour and parent, then its media in order](/img/screens/collections.png)

## What it is for

- **Grouping the way you program.** Keep everything one channel can air together, with a sub-collection per week, theme or season.
- **Running order.** Each collection holds its titles in an order you set, so a week's line-up reads top to bottom.
- **Finding media.** The **Collections** rail beside the [Media Library](media-library.md) narrows the library to one collection, with or without its sub-collections, and every other filter still works inside it.
- **Programming a FAST channel.** In a [FAST](fast.md) channel's run order, pick a collection in the library and choose **Add the whole collection in its order**.

Programmers and media librarians use it day to day.

## Before you start

- Media in the [Media Library](media-library.md) to put in a collection.
- **Media library & publishing: Manage** to make and change collections (see [Who can do it](#who-can-do-it)).

## Step by step

### Make a collection

1. Open **Collections** in the sidebar.
2. Choose **New collection**, type a name (for example *Food & Travel*) and choose where it goes: at the top level or inside another collection.
3. Choose **Create**. The new collection opens on the right, empty.

You can also make one from the Media Library: the **+** at the top of the **Collections** rail, or **New collection** in the **Add to collection** window.

### Make a sub-collection

1. Open the collection it belongs in.
2. Choose **Sub-collection**, type its name (for example *Week 44: Markets*) and choose **Create**.

Collections nest up to six levels deep. Two collections at the same level cannot share a name.

### Add media to a collection

1. Open the **Media Library**.
2. Tick the titles you want in the list or the grid.
3. Choose **Add to collection**, pick the collection, then **Add**. The titles go at the end of the collection, in the order shown, and a message says how many were added (and how many were already in it).

A collection that already holds every title you ticked is marked **in it**, and one that holds some of them shows how many.

### Put a collection in order

1. Open the collection. **Media** lists its titles in order, with how many there are and their total length.
2. Use the up and down arrows on a title to move it. The order is saved as you go.
3. Use the **×** on a title to take it out of the collection. It stays in the library and in any other collection.

With **Include sub-collections** ticked, the list shows the titles of the collection and everything under it, each sub-collection's titles marked with where they are. Order each sub-collection on its own.

### Rename, describe, colour or move a collection

1. Open the collection.
2. Change **Name** or **Description**; each is saved when you leave the box.
3. Pick a **Colour** to tell collections apart in the tree, or **×** for none.
4. Change **Inside** to move it, with its sub-collections, under another collection or to the top level. A collection cannot move inside itself, or so deep that its sub-collections would pass six levels.

### Browse the library by collection

1. Open the collection and choose **Open in Media Library**, or pick it in the **Collections** rail of the Media Library.
2. Tick **Include sub-collections** under the rail to see everything below it as well.
3. Choose **All media** to see the whole library again. **Manage collections** comes back here.

### Remove a collection

1. Open the collection and choose **Remove**.
2. Type the collection's name to confirm, then **Remove collection**.

Its sub-collections go with it. The titles in them stay in the Media Library and in any other collection.

## How it connects

| Section | How it relates |
|---|---|
| [Media Library](media-library.md) | Where titles are added to collections, and where the **Collections** rail filters the library |
| [FAST](fast.md) | A run order takes a whole collection with **Add the whole collection in its order**: every title that can air, in the collection's order |

See [How Volt fits together](../getting-started/how-volt-fits-together.md) for the whole map.

## Who can do it

| Task | Access needed |
|---|---|
| See collections and what is in them, browse the library by collection | Media library & publishing: View |
| Make, rename, colour, move and remove collections, add titles, order them and take them out | Media library & publishing: Manage |

Roles and levels are explained in [Roles and access](../getting-started/roles-and-access.md).

## Troubleshooting

| You see | What it means | What to do |
|---|---|---|
| **Nothing in it yet.** | The collection holds no titles | Add some from the Media Library: tick them, then **Add to collection** |
| **This collection is empty** in the Media Library | The library is narrowed to a collection with no titles | Choose **All media**, tick titles and use **Add to collection** |
| "Collections nest at most 6 levels deep." | The new collection, or the one you are moving, would sit deeper than six levels | Put it higher up, or move fewer levels under it |
| **Add** is greyed out in the **Add to collection** window | No collection is picked, or every ticked title is already in the one you picked | Pick another collection |
| No up and down arrows on titles | **Include sub-collections** is ticked | Untick it, or open the sub-collection to order its titles |
| A title in a collection has gone | It was deleted from the library, which takes it out of every collection | Nothing to do, or add a replacement |

## Through the API

| Request | Does |
|---|---|
| `GET /api/collections`, `POST /api/collections` | Every collection in the account with its counts, or a new one (`name`, and `parentId`, `description`, `color` if you want them) |
| `GET /api/collections/{id}`, `PATCH /api/collections/{id}`, `DELETE /api/collections/{id}` | One collection with its path and sub-collections; rename, describe, colour or move it (`parentId`); remove it and its sub-collections (never the media) |
| `GET /api/collections/{id}/items` | Its titles in order; `?deep=true` adds the sub-collections' titles |
| `POST /api/collections/{id}/items`, `POST /api/collections/{id}/items/remove` | Adds titles at the end (`assetIds`), or takes them out |
| `PUT /api/collections/{id}/items/order` | The new order, every title of the collection in `assetIds` |
| `GET /api/collections/memberships?assetIds=…` | Which collections each title is in |
| `GET /api/vod?collection={id}&collection_deep=true` | The Media Library list narrowed to a collection |

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"assetIds": ["<asset id>", "<asset id>"]}' \
  "https://your-volt-host/api/collections/$COLLECTION_ID/items"
```

Every route is in the [API reference](/api-reference).
