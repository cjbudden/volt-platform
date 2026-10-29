---
title: Content Types
sidebar_position: 9.6
description: Decide which metadata fields each kind of station, channel, event and on-demand asset carries, and which guide fields they fill.
guide: section
---

# Content Types

Content Types decides what Volt records about each kind of content: the fields a radio station, a TV channel, an event or an on-demand asset has, which of them are required, and which guide (EPG) fields they fill. Every account starts with a set of standard types; most people come here to add a field to one of them, or to make their own type that builds on one.

![The Content Types page: the list of types on the left with filters for what each is offered for, and the field editor for the chosen type on the right](/img/screens/content-types.png)

## What it is for

- **Standard types.** Every account has the same starting set, based on the public schema.org vocabulary: **Radio station**, **TV channel**, **Broadcast event**, **Town hall / conference**, **Worship service**, **Sports match**, **Multi-sport event**, **Clip / highlight**, **Song**, **Interview**, **Programme / episode** and **Movie / feature film**. You can edit them, but never delete them, so you can always get back to a known starting point.
- **Your own types.** A new type starts from an existing one and inherits all of its fields. Add the fields your organisation needs, relabel them, or override an inherited field with one of your own.
- **Fields that do work.** Each field has a type (text, a number, a date, a list of choices, an image and so on), can be required, and can fill a guide field such as the programme title or a presenter credit.
- **A publishing rule per type.** Everything of a type can share publishing settings, such as where it goes and how long it stays available.

The people who look after metadata, the guide and the library use it, usually with an administrator.

## Before you start

- **Account settings: Manage** to change a type (see [Who can do it](#who-can-do-it)).
- Decide which kinds of content the type is for: radio stations, TV channels, events, on-demand assets, or several of these.
- If a field should fill the guide, know which guide field it belongs in (title, description, category, a credit).

## Step by step

### Find a type

1. Open **Admin** and choose **Content Types** (under **Media setup**).
2. Narrow the list with **All**, **Radio stations**, **TV channels**, **Events** or **On-demand assets**.
3. Each row shows the type's name, a **standard** tag if it is one of the standard types, what it is offered for, its schema.org type and how many fields it has. Choose a row to open it on the right.

### Change a type's fields

1. Choose the type. Its name is at the top and can be changed there. Beside it you see whether it is standard, its schema.org type and, for a type built on another, which type it **extends**.
2. Set **Description** and, under **Offered for**, choose **Radio stations**, **TV channels**, **Events** and **On-demand assets** as needed. A type is only offered in the **Content type** picker for the kinds chosen here.
3. Under **Fields**, each row is one field:

   | Column | What to enter |
   |---|---|
   | **Key** | The field's name in the data: letters, numbers and underscores only |
   | **Label** | What people see on the form |
   | **Type** | **string** (one line), **text** (several lines), **number**, **boolean** (yes or no), **date**, **enum** (a list of choices), **url**, **image**, **tags**, **reference** or **content** (a link to another record in the library, such as the film a trailer promotes) |
   | **Options / ref** | For **enum**, the choices separated by commas, and tick **multi** to allow more than one. For **reference**, the kind of thing it points at, such as `sports-team`. For **content**, which way it points: **Trailer or promo for** or **Related to** |
   | **Req.** | Tick to make the field required |
   | **EPG field** | The guide field this value fills: **title**, **sub-title**, **description**, **category**, **episode**, **language**, **icon** or a credit (**credits.presenter**, **credits.actor**, **credits.commentator**, **credits.producer**, **credits.director**, **credits.guest**). Leave it empty if it fills none |
   | **schema.org** | The schema.org property it corresponds to, if any |

4. Choose **Add field** for a new row, or **✕** on a row to remove that field.
5. Choose **Save type**. **Saved.** appears beside the button.

A type built on another shows the fields it inherits above the table (**Inherited from** and the parent's name). A field you add with the same key replaces the inherited one for this type.

### Add your own type

1. Choose the type you want to build on. The button under the list reads **New type extending** followed by that type's name.
2. Choose it. A new type called the parent's name with **(copy)** after it appears and opens (**(copy 2)**, **(copy 3)** and so on when that name is taken). It is offered for the same kinds as its parent and has no fields of its own yet: it inherits all of the parent's.
3. Give it a proper name, add the fields that make it different, and choose **Save type**.

Each click makes another new type, so choose the button once per type you need.

### Use a type

A type is chosen where the content is set up:

- On a channel, station or event, open its settings, then the **Metadata** tab, and choose the **Content type**. The form under it shows the type's fields. A new channel, station or event starts on the standard type for its kind. Custom types are marked **(custom)** in the picker.
- On an asset in the [Media Library](media-library.md), on its **Metadata** tab.
- In [Ingest Rules](ingest-rules.md), a rule can give arriving files a content type.

### Set a publishing rule for a type

1. Choose the type and scroll to **Publishing rule for this type**.
2. Grey values are inherited from the account default. Tick a field to set it for this type, then set its value.
3. Choose **Save publishing rule**. **Remove this rule (inherit everything)** clears every value set here.

The fields are explained in [Publishing Rules](publishing-rules.md).

### Delete a type you made

1. Choose the type and then **Delete type**, and confirm. Standard types have no **Delete type** button.
2. If any channel, station, event or asset still uses the type, Volt refuses and says how many. Give those items another type first.

## How it connects

| Section | How it relates |
|---|---|
| [Channels](channels.md), [Radio](radio.md), [Events](events.md) | Each one chooses its content type on the **Metadata** tab of its settings, and fills in the type's fields there |
| [Media Library](media-library.md) | Each asset has a content type; the library can filter by it and by missing required fields |
| [EPG](epg.md) | Fields with an **EPG field** fill that part of the guide |
| [Publishing Rules](publishing-rules.md) | A type can override the account's publishing defaults, from here or from Publishing Rules |
| [Ingest Rules](ingest-rules.md) | A rule can give arriving files a content type, or apply only to files of one type |

See [How Volt fits together](../getting-started/how-volt-fits-together.md) for the whole map.

## Who can do it

| Task | Access needed |
|---|---|
| See Content Types in the sidebar and read the types | Account settings: View |
| Change, add or delete a type | Account settings: Manage |
| Set a type's publishing rule | Account settings: Manage |
| Choose the content type of a channel, station or event | That stream's own Manage access (for example TV channels: Manage) |

Roles and levels are explained in [Roles and access](../getting-started/roles-and-access.md).

## Troubleshooting

| You see | What it means | What to do |
|---|---|---|
| **Couldn't load content types.** | The list did not arrive | Choose **Retry**; if it keeps failing, reload the page |
| "duplicate field key" and a key, after **Save type** | Two fields in the type have the same key | Change one of the keys and save again |
| "each field needs a non-empty key" | A field's key is empty (characters other than letters, numbers and underscores are removed as you type) | Give every field a key |
| "enum field … needs options[]" | A field of type **enum** has no choices | Type the choices in **Options / ref**, separated by commas |
| **A content type named ... already exists. Choose another name.** after **New type extending** | Someone else made a type with that name a moment before (the console picks a free name from the list it last loaded) | Choose **New type extending** again: the list has been reloaded, so the next free name is used |
| "This type is assigned to … item(s). Reassign them first." | Something still uses the type you are deleting | Give those channels, stations, events or assets another type, then delete |
| A type is missing from a stream's **Content type** picker | It is not offered for that kind of stream | Tick the kind under **Offered for** and save |

## Through the API

Content types are called metadata schemas in the API.

| Request | Does |
|---|---|
| `GET /api/metadata-schemas` | Lists the types; add `?appliesTo=radio`, `tv`, `event` or `vod` for the ones offered for that kind |
| `GET /api/metadata-schemas/{id}` | One type |
| `GET /api/metadata-schemas/{id}/effective-fields` | Its fields with the inherited ones merged in: what a form should show |
| `POST /api/metadata-schemas` | Creates a type (`name`, `fields`, `appliesTo`, and `extendsId` to build on another) |
| `PATCH /api/metadata-schemas/{id}` | Changes a type |
| `DELETE /api/metadata-schemas/{id}` | Deletes a type you made; refused while anything uses it |
| `GET /api/metadata-schemas/{id}/history` | Every change made to it |
| `PUT /api/publishing-rules/schema/{id}` | Sets the type's publishing rule |

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "https://your-volt-host/api/metadata-schemas/$TYPE_ID/effective-fields"
```

Every route is in the [API reference](/api-reference).
