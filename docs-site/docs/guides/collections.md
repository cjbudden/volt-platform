---
title: Collections
sidebar_position: 3.55
description: Group library media your own way, by hand or by rules that keep the collection up to date, nested as deep as you need and in your own order.
guide: section
---

# Collections

Collections are your own groupings of library media: a collection per channel or show, with a sub-collection for each week's line-up. Pick titles by hand, or give a collection rules (for example: Sport, first aired in the last two weeks) and it keeps itself up to date as media arrives and changes. A title can be in any number of collections, each collection keeps its own order, and removing a collection never removes media.

![The Collections page: the tree of collections on the left, and a sub-collection open on the right with its name, description, colour and parent, then its media in order](/img/screens/collections.png)

## What it is for

- **Grouping the way you program.** Keep everything one channel can air together, with a sub-collection per week, theme or season.
- **Collections that keep themselves current.** Rules pick titles by their fields: title, genre, tags, length, content type, rights profile, provider, dates and your content types' own fields. New and changed media joins or leaves on its own.
- **Running order.** Each collection holds its titles in an order you set, or sorted by a field such as newest first.
- **Finding media.** The **Collections** rail beside the [Media Library](media-library.md) narrows the library to one collection, with or without its sub-collections, and every other filter still works inside it.
- **Packages and access by app and region.** A collection can ask more of viewers in chosen apps and countries: that they sign in, or that they buy it as a package, priced per app. Every title in it is then locked there, whatever other collection it is in (see [Set who can watch](#set-who-can-watch-access-by-app-and-region) and, for the API, [Access by app and region](#access-by-app-and-region)).
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

### Add media by rules

1. Open the collection and tick **Add media by rules** on the **Rules** card.
2. Choose **Match all** or **Match any**, then build each condition: a field, a test that fits it, and a value. Text can be *is*, *contains* or *starts with*; numbers *=*, *\<*, *>* or *between*; dates *before*, *after*, *between* or *within the last* so many days, weeks or months; lists, content types and rights profiles *is any of*; tags *has any of*, *has all of* or *has none of*.
3. Use **Group** for a mix, for example: Genre is Sport, and (first aired within the last 14 days, or tags have any of *classic*).
4. Watch the count under the rules: it shows how many titles match now, with a few of them, as you type.
5. Choose **Save rules**. The whole library is matched at once.

![A rule-based collection: the Rules card with two conditions and the live count, the order, and its media marked Rule or Added](/img/screens/collections-rules.png)

From then on the collection keeps itself up to date: a title that is added or changed joins or leaves within seconds, and every rule collection is checked in full each night. **Check now** runs the full check straight away.

- **Added by hand** titles (marked **Added**) stay whatever the rules say.
- **Taking a title out** of a rule collection leaves it out: the rules will not put it back. **Show left out** lists them, and **Let back in** returns one to the rules.
- Untick **Add media by rules** and choose **Turn rules off** to stop: what the rules added comes out, what people added stays.

### Set who can watch: access by app and region

1. Open the collection. The **Access** card says what it asks now, and a sub-collection lists what it inherits from each parent.
2. Tick **Set access here**.
3. Under **Apps**, keep **All apps** or choose **Chosen apps** and tick them. An app the rights of every title here keep out is greyed, with the reason; when the rights keep only some titles out, the card names them.
4. Under **Territories**, keep **Everywhere (Global)**, or choose **Only in these territories** or **Everywhere except these** and type the two-letter country codes (for example `AU, NZ`). Outside these apps and territories the collection asks nothing.
5. Under **Region rules**, add a rule for each region: the countries (or **Everywhere else**) and what a viewer needs there: **Free**, **Members (signed in)** or **Premium (a package)**. The first rule naming the viewer's country decides.
6. For **Premium**, fill in the package's products: a name, a product key, the period (or **for the published dates**), the price and the currency. To charge differently in one app (an app store price, for example), choose **Own prices in an app** and give that app its own products.
7. Choose **Save access**. Every title here and in sub-collections follows it at once; the card shows how many.

![The Access card of a collection: all apps, everywhere, a premium rule for Australia and New Zealand with its pass and the iOS app's own price, and members everywhere else](/img/screens/collections-access.png)

A sub-collection can only ask more than its parents. If it would let viewers in where a parent locks them, **Save access** is refused and the card lists where. Untick **Set access here** and choose **Clear access** to go back to what the parents ask.

### Check what a viewer gets: View as

The **View as** card under **Access** answers the way the player does. Choose an app, type a country code and choose the viewer: **Not signed in**, **Signed in** or **Holding a package**. Each title shows **Plays**, **Sign in**, **Locked** (with the packages and prices that unlock it) or **Blocked by rights** (with the reason), and which collections decided.

Below it, the matrix shows every app against each country the access names (this collection's, and that of the other collections its titles are in), plus one country no rule names, for a viewer who is not signed in.

![View as on a collection: the web player in Australia for a viewer not signed in, two titles locked with the pass that unlocks them and one blocked by rights, then the matrix of apps by regions](/img/screens/collections-view-as.png)

### Titles another collection locks

The strictest collection wins, so a title can sit in a free collection while another collection it is in sells it as part of a package. Each collection shows this in its own way:

- **In a rule collection**, the rules did not choose a locked title, so the collection **leaves it out** for the apps and countries where the package is asked. The media list marks it **Left out where locked by** the package, and **View as** tags it **Left out** and says how many titles are left out there and which package locks them. Elsewhere it stays in. To keep it in everywhere, add it by hand.
- **In a collection you fill by hand**, the title stays, because a person put it there. The media list marks it **Locked by** the package, and **View as** says it is kept and locked.

A title that only asks viewers to sign in in another collection is not locked: it stays in, and the player asks the viewer to sign in.

![View as on a rule collection in Australia: two titles the rules put there left out because Premium picks sells them, the hand-added promo kept and marked, and the matrix with the left-out counts](/img/screens/collections-left-out.png)

### See one title's access

On a title in the [Media Library](media-library.md), open the **Rights** tab. The **Collection access** card lists the collections the title is in, how each came to hold it (**Rule** or **Added**) and what each asks where. Choose an app, a country and a viewer to see what that viewer gets, and the matrix shows every app against the countries those collections name. It gives the same answer as **View as** and the player.

### Put a collection in order

Choose **Order** on the **Rules** card: **By hand**, or sorted by title, by when titles were added or first aired, or by length. A collection sorted by a field keeps that order as titles join.

1. Open the collection and set **Order** to **By hand**. **Media** lists its titles in order, with how many there are and their total length.
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
| [FAST](fast.md) | A run order takes a collection two ways: **Add all** makes a slot of each title that can air, and **Add as one slot** makes a collection slot that airs the collection's next title each time and follows the collection as it changes |
| [Apps and keys, for developers](../api/apps-and-keys.md) | Your apps show a collection as a row or rail with `GET /api/public/collections/{id}` (below) |
| [Rights](rights.md) | Rules can pick titles by rights profile or provider |
| [Content Types](content-types.md) | A content type's own fields can be used in rules |
| [API keys and apps](api-keys-and-apps.md) | A collection's access names the apps it applies to and each app's own products |
| [Publishing Rules](publishing-rules.md) | A title's own access rules still apply: a collection can only add to them |

See [How Volt fits together](../getting-started/how-volt-fits-together.md) for the whole map.

## Who can do it

| Task | Access needed |
|---|---|
| See collections and what is in them, browse the library by collection | Media library & publishing: View |
| Make, rename, colour, move and remove collections, add titles, order them and take them out, set rules and access | Media library & publishing: Manage |

Roles and levels are explained in [Roles and access](../getting-started/roles-and-access.md).

## Troubleshooting

| You see | What it means | What to do |
|---|---|---|
| **Nothing in it yet.** | The collection holds no titles | Add some from the Media Library: tick them, then **Add to collection** |
| **This collection is empty** in the Media Library | The library is narrowed to a collection with no titles | Choose **All media**, tick titles and use **Add to collection** |
| "Collections nest at most 6 levels deep." | The new collection, or the one you are moving, would sit deeper than six levels | Put it higher up, or move fewer levels under it |
| **Add** is greyed out in the **Add to collection** window | No collection is picked, or every ticked title is already in the one you picked | Pick another collection |
| No up and down arrows on titles | **Include sub-collections** is ticked, or the collection is sorted by a field | Untick it, or set **Order** to **By hand** |
| **Fill in every condition to see what it matches.** | A condition has no value yet | Give every condition a value, or remove the empty one |
| A title you took out comes back | It was added by hand somewhere else in the same collection, or someone chose **Let back in** | Take it out again; it stays out |
| A rule collection has not picked up a change to a rights profile's provider yet | Provider changes are matched within ten minutes | Choose **Check now** |
| A title in a collection has gone | It was deleted from the library, which takes it out of every collection | Nothing to do, or add a replacement |
| "It asks for less than the parent in ... A child collection can only tighten its parent's access." | A sub-collection's access would let viewers in where its parent locks them | Ask the same or more than the parent there, or clear the sub-collection's access so it inherits |
| A title is not added, with "The rights do not allow ..." | The collection has access that the title's rights rule out: apps, territories or premium access its rights profile does not allow | Add it to a collection without that access, or change the title's [rights](rights.md) |
| "Another collection or rule already sells ..." | A product key names one product, and another collection or access rule uses it | Give this package its own product keys |
| A title is locked although its own rules make it free | Another collection it is in asks more in that app and country: the strictest collection wins | Open the collection and use **View as** to see which collection decides, then take the title out of it or change that collection's access |
| A rule collection shows fewer titles in an app or a country than it holds | Another collection sells those titles as a package there, so the rule collection leaves them out | **View as** names them and the package. Add a title by hand to keep it in, or change the other collection's access |

## Through the API

| Request | Does |
|---|---|
| `GET /api/collections`, `POST /api/collections` | Every collection in the account with its counts, or a new one (`name`, and `parentId`, `description`, `color` if you want them) |
| `GET /api/collections/{id}`, `PATCH /api/collections/{id}`, `DELETE /api/collections/{id}` | One collection with its path and sub-collections; rename, describe, colour or move it (`parentId`); remove it and its sub-collections (never the media) |
| `GET /api/collections/{id}/items` | Its titles in order; `?deep=true` adds the sub-collections' titles |
| `POST /api/collections/{id}/items`, `POST /api/collections/{id}/items/remove` | Adds titles at the end (`assetIds`), or takes them out |
| `PUT /api/collections/{id}/items/order` | The new order, every title of the collection in `assetIds` |
| `GET /api/collections/memberships?assetIds=…` | Which collections each title is in |
| `GET /api/collections/rules/fields` | The fields and tests rules can use, with the choices for lists |
| `POST /api/collections/rules/preview` | How many titles some `rules` match now, with a few of them |
| `PATCH /api/collections/{id}` with `rules` and `orderBy` | Sets the rules (`null` turns them off) and the order; saving matches at once |
| `POST /api/collections/{id}/recheck` | Matches the rules over the whole library now |
| `GET /api/collections/{id}/exclusions`, `POST /api/collections/{id}/exclusions/remove` | What people left out of a rule collection; let them back in |
| `GET /api/vod?collection={id}&collection_deep=true` | The Media Library list narrowed to a collection |

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"assetIds": ["<asset id>", "<asset id>"]}' \
  "https://your-volt-host/api/collections/$COLLECTION_ID/items"
```

Rules are a tree: `{ "match": "all", "conditions": [ { "field": "genre", "op": "is", "value": "Sport" }, { "match": "any", "conditions": [ ... ] } ] }`.

```bash
curl -X PATCH -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"rules": {"match": "all", "conditions": [{"field": "genre", "op": "is", "value": "Sport"}, {"field": "first_aired_at", "op": "within_last", "value": {"count": 14, "unit": "day"}}]}, "orderBy": "-first_aired_at"}' \
  "https://your-volt-host/api/collections/$COLLECTION_ID"
```

### A collection as a row in your app

Your apps read a collection with the app's publishable key, no sign-in: `GET /api/public/collections/{id}?appKey=pk_...`. The answer has the collection's name, description and sub-collections, and its titles in its order (the sub-collections' after it; `deep=false` for its own only). Only titles that are public and listed are in it, and a title whose publishing rule turns **Sitemap and schema.org** off is left out. Each title says what a viewer who is not signed in gets in that app and country: `access` is `free`, `members` (sign in to watch) or `premium` (a purchase). A title the rights or a geo rule keep from that app or country is not in the answer at all.

| Field | What it is |
|---|---|
| `items[].id`, `title`, `description`, `artworkUrl`, `durationMs` | The title, as the player shows it |
| `items[].series`, `season`, `episode` | For rows that group episodes |
| `items[].access` | `free`, `members` or `premium`, for a viewer not signed in |
| `items[].status`, `availableFrom` | `scheduled` for a title listed before it can be played, with when it can |
| `territoryGroup` | The same for every country with this exact answer; it is also the ETag |
| `nextChangeAt` | When a title in it opens or closes on its own: ask again then |

The country is the viewer's, from the CDN. Countries with the same answer share it, so a row polled with `If-None-Match` answers 304 until it changes. Adding or taking out a title, or changing one, reaches the answer at once.

```bash
curl "https://your-volt-host/api/public/collections/$COLLECTION_ID?appKey=$PUBLISHABLE_KEY"
```

### Access by app and region

A collection says nothing about who may watch until you give it access. Access has three parts:

- **Apps**: `"all"`, or the ids of the [apps](api-keys-and-apps.md) it applies to.
- **Territories**: `world`, `allow` (only these countries) or `block` (everywhere but these), with the countries as two-letter codes.
- **Rules**, region by region: the first rule naming the viewer's country (or `WORLD`) decides whether the title is `free`, `members` (signed in) or `premium`. A premium rule lists the products that unlock it in `terms`, and an app with its own store prices has its own list in `appTerms`, by app id. Saving makes or updates those products, so payments for them unlock the collection.

Outside its apps and territories a collection asks nothing. Inside them, **the strictest collection wins**: a title in a collection that is premium for the iPhone app in the United Kingdom is premium there, even when another collection it is in is free. A viewer who has bought any of the packages that lock it can watch. A title's own [publishing rules](publishing-rules.md) still apply on top, and its [rights](rights.md) cap everything: a collection cannot unlock what the rights refuse, and a title whose rights rule out a collection's apps, territories or premium access is refused when you add it, with the reason.

A sub-collection inherits its parent's access and can only tighten it: it can apply to fewer apps or countries and ask the same or more. A change reaches the titles at once, including those in sub-collections; a viewer whose country is not known is treated as being in the strictest region.

| Request | Does |
|---|---|
| `GET /api/collections/{id}/access` | The collection's own access (`null` when it inherits), what its parents ask, the account's apps (each with `ruledOut`: how many of the titles here its rights keep out of that app, of how many, and a few of their titles) and how many titles it governs |
| `PUT /api/collections/{id}/access` | Sets the access (`{"access": null}` clears it). `422` with `code: "looser_than_parent"` or `"invalid_access"` and the problems; `409` with `code: "product_key_taken"` |
| `GET /api/collections/{id}/access/view-as?appId=…&country=GB&viewer=anonymous` | What a viewer gets for each title here: `plays`, `sign_in`, `locked` (with the packages and products), or `blocked_by_rights`, and which collections decided. `viewer` is `anonymous`, `member`, or `package` with `packageId`. A title another collection sells as a package there carries `lockedBy` (that package); one the rules put here also has `leftOut: true`, and `leftOut` gives the `count` and the `reason` |
| `GET /api/collections/asset-access/{assetId}?appId=…&country=GB&viewer=anonymous` | The same answer for one title (`result`), with the collections it is in (`collections`: each one's `source` and what its levels ask), the `packages` that can unlock it and the `regions` to show |

`GET /api/collections/{id}/items` marks a title another collection sells as a package with `lockedBy` (`packages`, and `by`: the collections), and `GET /api/collections/{id}/access` lists in `titleRegions` the countries named by the access governing the titles here.

```bash
curl -X PUT -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"access": {"apps": "all", "territories": {"mode": "world", "countries": []}, "rules": [
        {"countries": ["GB", "IE"], "access": "premium",
         "terms": [{"productKey": "sport-pass-web", "kind": "period", "count": 1, "unit": "month", "priceCents": 999, "currency": "GBP"}],
         "appTerms": {"<iPhone app id>": [{"productKey": "sport-pass-ios", "kind": "period", "count": 1, "unit": "month", "priceCents": 1099, "currency": "GBP"}]}},
        {"countries": ["WORLD"], "access": "members"}]}}' \
  "https://your-volt-host/api/collections/$COLLECTION_ID/access"
```

On the [play gate](../api/play-gate.md), a title a package locks answers `402` with `mode: "paywall"`, the `packages` that unlock it and the `products` this app sells; a members-only one answers `403` with `mode: "sign_in"`.

Every route is in the [API reference](/api-reference).
