---
title: Publishing Rules
sidebar_position: 9.7
description: Set where on-demand content goes when it is published and how it stays available, for the whole account and for each content type, stream or item.
guide: section
---

# Publishing Rules

Publishing Rules decides what a publish does: where on-demand content goes, when it becomes available and when it expires, who can watch it, how it is protected, what else may be done with it, how long it is kept, and whether a review or a quality check must pass first. You set an **account default** here, and a content type, a channel, an event, a station or a single item can override any part of it, unless a rung above has locked it.

![The Publishing Rules page: the publishing points, and the account default with a preset picker and its Lifecycle and Access sections, each field with its padlock](/img/screens/publishing-rules.png)

## What it is for

- **One default for everything.** Set once where published content goes (the catalogue, your registered apps, your social accounts), how long it stays up, and the access, geo and paywall settings it carries.
- **Overrides where they are needed.** A rule is a ladder of five rungs. Each rung stores only what it changes, and anything it leaves alone comes from the rung beneath:

  | Rung | Where you set it |
  |---|---|
  | Account default | Here, under **Account default** |
  | Content type | [Content Types](content-types.md), under **Publishing rule for this type**, or here under **By content type** |
  | Channel, event or station | The stream's settings, on the **Access** tab |
  | Metadata rule | Here, under **Metadata rules**: the first rule whose conditions the item meets |
  | A single item | The asset in the [Media Library](media-library.md), under **What a publish does for this item** |

  The higher rung wins: an item's own value beats the metadata rule it meets, which beats its channel's, which beats its content type's, which beats the account default.
- **A gate before publishing.** Require an approved review, or block publishing while a quality check has failed.
- **Locks.** Lock a field on a rung and nothing beneath it can change it: lock DRM on for the account and no content type, stream or item can turn it off.
- **Problems caught before they are saved.** Every change is checked as you make it. A combination that cannot work (DRM with MP4 download, say) stops the save; one that is risky is saved with a warning; and you see how many titles the change affects before you save it.

Administrators set the default; the people who run a channel, an event or the library set the overrides.

## Before you start

- The places content can go. Only the catalogue, the apps registered to your account and the social accounts set up for it can be chosen. Apps are registered in API Keys & Apps; social accounts are added under Social accounts in the Admin area.
- **Account settings: Manage** to change the account default or a content type's rule. A stream's own rule needs Manage on that kind of stream (for example Events: Manage for an event), or Account settings: Manage (see [Who can do it](#who-can-do-it)).

## Step by step

### Check your publishing points

1. Open **Admin** and choose **Publishing Rules** (under **Media setup**).
2. **Publishing points** lists where content can be published: **Catalogue** is always there, then each registered app (**App:**, its name and type) and each social account (the platform and its name). A faded one is switched off.
   An Instagram account is a publishing point like any other: a rule that ticks it sends the clip as a Reel (the 9:16 version when it has one). Instagram's limit of posts made through apps in any 24 hours still applies, so a rule that publishes often can reach it; a post past the limit fails, says so, and can be retried later.
   A Threads profile works the same way: the clip goes as a video post with the clip's title and its first tag (Threads allows one hashtag), within Threads' own 24 hour limit.
3. To add one, choose **Register an app** (it opens [API Keys & Apps](api-keys-and-apps.md)) or **Add a social account** (it opens [Social accounts](social-accounts.md)).

### Set the account default

1. Under **Account default**, every field shows its current value, grouped in five sections: **Lifecycle**, **Access**, **Protection**, **Distribution** and **Retention**. On this rung there is nothing to tick: change the values directly.

   | Field | Choices |
   |---|---|
   | **Publish to** | **Catalogue (portal)**, and each registered app and social account. With nothing ticked, publishing does nothing |
   | **Auto-publish** | **Publish automatically once built and gated**, or leave it off to publish by hand. It applies to clips and full-event replays made from recordings: a clip when it is built, or when it is approved if the gate requires a review; a replay as soon as it is made. Uploaded and watch folder files are published by hand |
   | **Available from** | **When published**, or **At a set time** with a date and time |
   | **Expires** | **Never**, **After a number of days** (counted from when it becomes available), or **On a date** |
   | **Access rules** | Rules by viewer location, explained below. With none, the simpler fields below decide |
   | **Geo access** | **Worldwide**, **Only in these countries** or **Blocked in these countries**, with two-letter country codes such as `AU, NZ, GB` |
   | **Access** | **Free**, **Entitlement required** or **Paid (paywall)** |
   | **Paywall** | Tick **Paywall**, then a tier, a price in cents and a three-letter currency |
   | **Publish gate** | **Require an approved review before publishing** and **Block publishing while QC has failed** |
   | **Archive copies** | With the Mirror and Archive add-on, for account administrators: which storage targets the original is copied to, and when. See [Copy originals to your own storage](#copy-originals-to-your-own-storage) |
   | **DRM** | **Encrypt with DRM**. It changes the files, so turning it on or off for published titles asks first (see [Turn DRM on or off for published titles](#turn-drm-on-or-off-for-published-titles)) |
   | **Playback token lifetime** | Minutes a playback link stays valid; empty for the platform default |
   | **WAF profile** | **Off**, **Standard** (VPN and proxy flagged) or **Rights-managed** (VPN, proxy, hosting and Tor blocked) |
   | **Allowed referrer domains** | The sites a player may be embedded on, such as `example.com, *.example.com`; empty for any site |
   | **Concurrent streams** | How many streams one viewer may play at once; empty for no limit |
   | **MP4 download**, **Share links**, **FAST eligible**, **Sitemap and schema.org** | Whether a published title may be downloaded as MP4, shared with a link, scheduled on FAST channels, and listed in the sitemap |
   | **Retention**, **Retention days**, **Retention counts from** | **Keep forever**, or **Keep for a number of days** counted from when it came in, became available or stops being available |
   | **Legal hold allowed**, **Archive storage tier** | Whether a title may be put on legal hold, and the storage it moves to when archived |

   **Playback token lifetime**, **Allowed referrer domains**, **MP4 download** and **Share links** apply where titles are played and handed out (see [What the protection and distribution fields do](#what-the-protection-and-distribution-fields-do)). **Concurrent streams**, **FAST eligible**, **Sitemap and schema.org**, the WAF profile and retention are stored and checked now and take effect in later releases.
2. Check **Before you save** under the fields (see [Before you save](#before-you-save-conflicts-and-impact)).
3. Choose **Save publishing rule**. **Saved.** appears beside the button, or **Saved, with 1 warning.** when a warning stands.

### Override it for a content type, a stream or an item

1. Open the rule where it lives (see the table above). On a channel, event or station, open its settings and choose the **Access** tab. An event or station has to be created before its rule can be set.
2. Grey values are inherited; under each field name it says where the value comes from, for example **inherits: account default** or **inherits: content type rule**.
3. Tick a field to set it here. It changes to **set here** and its controls appear. The line at the top counts how many fields are set on this rung.
4. A field that a rung beneath this one has locked shows a closed padlock and **Locked by the account default** (or the rung that locked it). It cannot be ticked here.
5. Choose **Save publishing rule**.
6. To go back to inheriting everything, untick the fields and save, or choose **Remove this rule (inherit everything)** (on a content type or a stream).

### Choose a policy by metadata

A metadata rule gives a policy to every item whose metadata, tags, collections or source meet its conditions, for example every item tagged `premier-league`, or every item in the collection **Premium picks**. It wins over the item's content type and over the channel, event or station it came from, so an item gets the same terms whether it was recorded from a channel or uploaded. An item's own settings still win over it, and a field locked on the account default stays locked.

![Metadata rules on the Publishing Rules page: two rules in order, each with its conditions, what it sets, how many titles it governs and arrows to move it, and the box to test a title](/img/screens/publishing-metadata-rules.png)

1. On this page, under **Metadata rules**, choose **Add a rule**.
2. Give it a name, then build its conditions as you would for a [rule-based collection](collections.md): a field, a test that fits it and a value, with **Match all** or **any**, and groups for mixed conditions. The fields are the item's own (title, tags, genre, length and more), its content type's fields, **Collection**, and where it came from (channel, event, how it was made).
3. Choose **Add the rule**. It goes to the end of the list and opens.
4. Under **It gets this policy**, tick the fields it sets, exactly as on any other rung, and choose **Save publishing rule**. **Before you save** counts the items it governs and how many published items take the change up.

![A metadata rule opened: its name, its condition, and the start of its policy with Geo access set to Australia and New Zealand and locked](/img/screens/publishing-metadata-rule-open.png)

**The order matters.** An item gets the first rule it meets, from the top of the list; the rules below it are not used for that item. Drag a rule to move it, or use its up and down arrows. Each rule shows how many items it governs now.

**Test an item.** Paste an item's id into **Test a title** and choose **Test**. It says which rule the item meets and applies, which other rules it also meets (and that an earlier one applies), and the geo and access it then gets. The item's own publishing settings in the Media Library also name the metadata rule that applies to it.

**Switch a rule off** by unticking **On** and choosing **Save name and conditions**: items go to the next rule they meet. **Remove this rule** takes it away for good, after you confirm.

Published items take up a change within about a minute: a new or changed rule, a new order, and also a change to an item's own metadata, tags or collections that makes it meet a different rule. Nothing is posted to social accounts again.

### Lock a field

![The Protection section of the account default: DRM, playback token lifetime, WAF profile, allowed referrer domains and concurrent streams, with DRM's padlock closed](/img/screens/publishing-policy-locks.png)

1. On the account default, a content type or a stream, choose the padlock at the end of a field's row. It closes and the line at the top counts the fields locked here.
2. Choose **Save publishing rule**.

Every rung beneath now shows the field with **Locked by** and this rung's name, and cannot change it. A rung that already set its own value for that field says **This rung still sets a value of its own, which the lock overrides**; choose **Clear it** there, because its save is refused until it is cleared. Choose the padlock again to unlock. A single item has no padlocks: it is the last rung, so there is nothing beneath it to lock.

### Start from a preset

1. Choose **Start from a preset…** above the sections and pick one:

   | Preset | Sets |
   |---|---|
   | **Open** | Published when ready, free worldwide, no DRM, MP4 download and share links allowed |
   | **Members** | Sign-in required, worldwide, no DRM |
   | **Geo-locked** | Free, only in the countries you choose, Standard WAF profile |
   | **Premium** | Paid, DRM, no MP4 download |
   | **Rights-managed** | Only in the countries you choose, catalogue only, DRM, Rights-managed WAF profile, no MP4 download |

2. The preset's fields are copied onto the rung and **Started from** names it. Change any of them as usual. For Geo-locked and Rights-managed, choose the countries under **Geo access**.
3. Choose **Save publishing rule**. **Forget the preset** keeps the fields and drops the name.

### Before you save: conflicts and impact

![Before you save, under the account default with DRM ticked: the titles it governs, how many are published and how many the save changes, and the conflict that blocks the save](/img/screens/publishing-policy-check.png)

As you change a rung, **Before you save** checks it:

- **Governs** the titles this rung decides for, how many of them are **published**, and how many the save **changes**. When DRM changes, it also counts the published titles **to be packaged again**.
- When the save changes published titles, a line says how many **take this up within a minute**, and in amber how many **become unavailable now** because their window would end before today or open later (see [What a change does to published titles](#what-a-change-does-to-published-titles)).
- A red line is a **conflict that blocks the save**, for example DRM with MP4 download allowed. The rows it names are outlined, **Save publishing rule** is greyed out and **Fix the conflicts marked above to save.** appears beside it.
- An amber line is a **warning**: the rule can be saved, and it is worth a look, for example a country restriction without a WAF profile.
- A line that starts with a number of titles is about those titles in particular, with up to five of them named, for example a rights-managed rule on a title that has no rights window.

### Turn DRM on or off for published titles

Turning DRM on or off changes the files, so published titles must be packaged again.

1. Change **DRM** and choose **Save publishing rule**.
2. A box says how many published titles will be packaged again. Choose **Package again and save**, or **Cancel** to leave the rule as it was.

Titles keep their current protection until they have been packaged again.

### What a change does to published titles

A saved rule reaches the titles that are already published within about a minute, with nothing to publish again:

- **Available from**, **Expires**, **Geo access**, **Access**, **Paywall** and the access rules take effect on the published titles the rule governs.
- **Expires** counts from when each title was published, not from when the rule changed. A title published three days ago under a new rule of **After a number of days**: 1 ends at once, which is why **Before you save** counts it as **unavailable now**. Play links already handed out stop working too.
- **Publish to** is not changed for titles already published: where a title went is kept, and nothing is posted to a social account again. The new publishing points apply the next time a title is published.
- **Playback token lifetime**, **Allowed referrer domains**, **MP4 download** and **Share links** take effect on the published titles too: a share link made before sharing was turned off stops opening.
- **DRM** changes the files, so it waits for the titles to be packaged again (see above).
- Withdrawn and draft titles are not touched; they take the rule when they are published.
- Removing a content type's or a stream's rule hands its published titles to the rungs above, the same way.

### What the protection and distribution fields do

| Field | Where it applies | What a viewer or colleague sees |
|---|---|---|
| **Playback token lifetime** | Every play link handed out for a title | The link stops working after that many minutes (or at the end of the title's window, if sooner), and the player asks for a new one. Up to 24 hours; empty for the platform default |
| **Allowed referrer domains** | The play check every player makes before it plays | A player on a page of a listed site plays the title. On any other site the title does not play and the player is told **Not available on this site**. `*.example.com` covers `example.com` and every site under it. Phone, TV and server apps are not embedded in a page, so they still play; a web app must be on a listed site |
| **MP4 download** | **Downloads** in the Media Library, and the hi-res download on a share link | Off: the MP4 is refused with **This title's publishing rule does not allow MP4 download.**, even on a share link that allowed downloads. The sound files (MP3 and AAC) and the metadata file are not affected |
| **Share links** | Making a share link, and opening one | Off: **Share** is refused with **This title's publishing rule does not allow share links.**, and a link made before shows **Sharing has been turned off for this title.** |

A title that is not published yet is judged by its rule as it stands: you cannot share or download the MP4 of a draft whose rule turns them off.

### See every override

1. On **Publishing Rules**, **By content type** lists the types that have their own rule and **By channel, event or station** lists the streams that do. Each row shows what it **sets** and its version.
2. Choose a row to open its rule underneath (**Rule for** and the name). Change it as above, or choose **Close**.
3. To give a content type its own rule, choose the type under **Choose a content type...** below the list (only types without a rule are offered) and choose **Set a rule for this type**. Its rule opens underneath; tick the fields to set and choose **Save publishing rule**, and the type joins the list. You can do the same in Content Types: choose **Open Content Types**. New stream rules are made in each stream's settings.

### Add access rules

Access rules give different access to viewers in different places, for example free at home and premium abroad.

1. Under **Access rules** (tick it first on a rung other than the account default), choose **+ Add rule**.
2. Under **For**, choose what the rule covers: the channel, event or station itself (or **This item** on an asset), **Linked live content (live streams carried by it)**, and **Linked on-demand content (VOD / AOD made from its recordings)**. **+ Add content type** limits it to content of chosen types.
3. Under **If**, choose **Viewer is located in** or **Viewer is not located in**, and type country codes. **WORLD** means everywhere.
4. Under **Then**, choose **Access is free**, **Access for members only** or **Access is premium**. For members and premium, list the user groups who get access. For premium, set the **Terms**: **Period** or **Published dates**, the length, price, tax and product key. **+ Add term** adds another.
5. **↑** and **↓** change the order of the rules; **✕** removes one. Save the publishing rule.

Rules are read from the top: the first rule that covers the content and matches the viewer's location decides. If rules cover the content but none matches where the viewer is, the viewer is told it is not available in their region. **Access for members only** means the viewer must be signed in to your app (and in one of the listed groups, if you name any).

Each premium term is kept in step with your products for payments when the rule is saved.

### Copy originals to your own storage

With the **Mirror and Archive** add-on, every rung has an **Archive copies** field, shown to account administrators. It copies an item's original file to the storage targets at your sites (made on the [Storage](storage.md#keep-copies-at-your-own-sites-mirror-and-archive) page), without anyone asking.

![The Archive copies field of the account default: a NAS copied to when files land and with every recording, an object store copied to when they are published, only between 22:00 and 06:00 in Sydney time](/img/screens/publishing-archive-copies.png)

1. Under **Archive copies** (tick it first on a rung other than the account default), each storage target is listed. Tick **When it lands** to copy the original as soon as an upload or watch folder file has landed, **When it is published** to copy it on publishing, or both.
   Tick **Nightly** to copy, once a day, anything the rule covers that the target does not hold yet: items that came in before the rule existed, and any copy that was missed. Nightly copies wait for the off-peak window like any other.
   Once a target is ticked for items, **Copy** says what goes there: **Original** (ticked unless you untick it), **Sidecars**, **Clips**, **HLS/DASH package**, or any mix. Sidecars are a metadata file (`<name>.json`), the caption files as they were delivered (`<name>.en.srt`), any other files that came with the item, and its poster, each named after the original so they sort beside it. Clips are for items cut from a recording (clips, full-event replays and exports), which have no original of their own: the clip's file exactly as Volt made it (the MP4, or the M4A or MP3 of an audio clip) with a metadata file beside it, named like recordings, `Title-Channel-YYYYMMDD-HHMM` from where the clip starts in the channel's time zone. With **When it lands** a clip is copied as soon as its file has been made. The HLS/DASH package is every rendition and segment as one folder that plays as it is; ticking it shows beside the box what that costs in room (on our test library about 1.7 times the original, from 0.1 to 6 times, a few hundred files). It is offered for every target: a folder target gets it as a folder, an S3-compatible store as one folder of objects under the target's folder in the bucket. At least one stays ticked.
   On the account default and on a channel's, station's or event's own rung there is also **Recordings**: tick it to archive the recording itself. Each programme becomes one file when it ends (each clock hour, in the channel's time zone, when the channel has no guide), taken from the top rendition and joined without re-encoding, with a metadata file of the same name beside it. See [Recordings in the archive](../workflows/mirror-and-archive.md#recordings-in-the-archive).
2. Optionally tick **Copy only between** and set a start and end time and a time zone, for example 22:00 to 06:00 in `Australia/Sydney`. A copy asked for outside the window waits for it to open.
3. Choose **Save publishing rule**.

Each original, each sidecar, each clip, each package, and each programme or hour of recording, is copied once per target; a sidecar already copied is not copied again when the item's details later change. Ticking **Recordings** starts from the next programme or hour that ends: recordings already kept are not copied. A rung that ticks no target switches copies off for everything beneath it. A disabled target is shown greyed and gets no new copies; a target that no longer exists is pointed out with **Drop now**. Without the add-on the field is not shown, and copies a rung already holds are kept when it is saved.

## How it connects

| Section | How it relates |
|---|---|
| [Media Library](media-library.md) | Publishing an asset follows its rule; each asset can override it for itself |
| [Content Types](content-types.md) | Each type can have its own rung of the rule |
| [Channels](channels.md), [Radio](radio.md), [Events](events.md) | Each stream can have its own rung, on the **Access** tab of its settings; it applies to what is recorded or cut from it |
| [Review](review.md) | **Require an approved review before publishing** waits for an approval there |
| [API Keys & Apps](api-keys-and-apps.md) | Registered apps are the publishing points you can choose |
| [Storage](storage.md) | Copy rules name the Mirror and Archive storage targets made there, and its copies show what the rules did |
| [Copies of your media at your own sites](../workflows/mirror-and-archive.md) | The Mirror and Archive flow end to end, from a site to a verified copy |

See [How Volt fits together](../getting-started/how-volt-fits-together.md) for the whole map.

## Who can do it

| Task | Access needed |
|---|---|
| See Publishing Rules and every override | Account settings: View |
| Change the account default or a content type's rule | Account settings: Manage |
| See a channel, event or station's rule (its **Access** tab) | View on that kind of stream (TV channels, Radio stations, Events or FAST channels), or Account settings: View |
| Change a channel, event or station's rule | Manage on that kind of stream (an Event Manager sets their events' rules, a Radio Manager their stations'), or Account settings: Manage |
| Change a single asset's rule | Media library & publishing: Manage |
| Lock a field, or start from a preset | The same as changing that rung |
| See and set **Archive copies** | Account administrator (owner or admin), with the Mirror and Archive add-on |

Roles and levels are explained in [Roles and access](../getting-started/roles-and-access.md).

## Troubleshooting

| You see | What it means | What to do |
|---|---|---|
| **Couldn't load publishing rules.** | The page could not read the rules | Choose **Retry** |
| **Publish to** reads **nowhere (publishing is a no-op)** | No publishing point is ticked on the rung that decides | Tick **Catalogue (portal)** or an app, and save |
| **No registered apps yet. Register one under API Keys & Apps to publish to it.** | There are no apps to publish to | Register an app in API Keys & Apps, or publish to the catalogue only |
| **No social accounts configured for this account.** | No social account has been added | Add one under Social accounts |
| An X account marked **off: X is not on for this account** | X is off for your account, so it cannot be published to; the account is kept | Untick it, or have X switched on (see [Social accounts](social-accounts.md#turn-on-x-with-your-own-x-developer-app)). A rule that still names it publishes everywhere else and skips X |
| A post to Instagram failed with **... has used ... of its ... posts in the last 24 hours, Instagram's publishing limit.** | Instagram's 24 hour limit for the account was used up when the rule published | Retry the post from the clip once older posts fall out of the 24 hours |
| An app shows **disabled** | The app is switched off in API Keys & Apps | Switch it on there if it should receive content |
| A stream's **Access** tab says to create the event (or station) first | Rules belong to a stream that exists | Create it, then open its settings again |
| A stream's **Access** tab shows a message about your role instead of the rule | Your role cannot see that kind of stream's rule | Ask an administrator for View (to read) or Manage (to change) on that kind of stream |
| A country you typed disappears from **Geo access** | Only two-letter codes are kept | Use codes such as `AU`, `NZ`, `GB` |
| Viewers are told "Not available in your region." | Access rules cover the content, but none matches the viewer's country | Add a rule for that country, or a last rule for **WORLD** |
| **Archive copies** says **No storage targets yet.** | No storage target has been made | Add one on the [Storage](storage.md#keep-copies-at-your-own-sites-mirror-and-archive) page |
| Publishing an asset is refused because of the publish gate | **Publish gate** requires an approved review, or QC has failed | See [Review](review.md), or change the gate |
| **Save publishing rule** is greyed out and **Fix the conflicts marked above to save.** | A red line under **Before you save** blocks the save | Change one of the fields it names; the check runs again as you do |
| **... is locked by the account default: it cannot be changed here.** | This rung sets a field a rung beneath locked | Choose **Clear it** on that row, or unlock the field where it was locked |
| A field shows **Locked by** and cannot be ticked | A rung beneath this one locked it | Change it on that rung, or unlock it there |
| A box asks to package titles again | The change turns DRM on or off for published titles | Choose **Package again and save**, or **Cancel** |
| A player on your site shows **Not available on this site** | The title's rule lists **Allowed referrer domains** and your site is not one of them | Add the site's domain to the rule (`*.example.com` for every site under it) |
| **This title's publishing rule does not allow MP4 download.** | The rule that governs the title turns **MP4 download** off (Premium and Rights-managed do) | Turn **MP4 download** on in that rule if the title may leave as a file, or download the sound file instead |
| **This title's publishing rule does not allow share links.** | The rule that governs the title turns **Share links** off | Turn **Share links** on in that rule |
| An item does not get the metadata rule you expect | It meets an earlier rule first, the rule is off, or the item's own settings set that field | Paste its id into **Test a title**: it names the rule that applies and every rule it meets. Move the rule up, switch it on, or clear the item's own value |
| A metadata rule's field is ignored on an item | The account default locked that field | Unlock it on the account default, or leave it to the account default |
| A published title stopped being available after a rule was saved | Its window under the new rule ended before today, or opens later; **Before you save** counted it as **unavailable now** | Change **Expires** or **Available from** on the rule, or give the title its own dates in the Media Library |

## Through the API

| Request | Does |
|---|---|
| `GET /api/publishing-rules` | Every rung that has been set, with its name |
| `GET /api/publishing-rules/points` | The catalogue, apps and social accounts you can publish to |
| `GET /api/publishing-rules/resolve` | What an item would get: pass `assetId`, or `schemaId` with `channelId` or `eventId`. Every field comes with the rung it came from, the locks and which rung set them, and for an item its conflicts |
| `GET /api/publishing-rules/presets` | The five starting policies: Open, Members, Geo-locked, Premium and Rights-managed |
| `GET /api/publishing-rules/fields` | The five sections of a policy, the fields a rung can lock, and their names |
| `GET /api/publishing-rules/{scopeKind}/{scopeId}` | One rung: `account` (no id), `schema` (a content type) or `owner` (a channel, event or station) |
| `PUT /api/publishing-rules/{scopeKind}/{scopeId}` | Sets a rung (`{"settings": {...}}`, and optionally `lockedFields`, `name` and `presetKey`). Add `?dryRun=1` to see what the save would do without saving it |
| `DELETE /api/publishing-rules/{scopeKind}/{scopeId}` | Removes a content type or stream rung; the account default cannot be removed |
| `GET /api/vod/{id}/availability`, `PATCH /api/vod/{id}/availability` | A single asset's own rung |
| `GET /api/publishing-rules/metadata-rules` | The metadata rules in order (`position` 0 is checked first), each with `titles`: how many items it governs now |
| `GET /api/publishing-rules/metadata-rules/fields` | The fields and tests a rule's conditions can use, with the choices for lists, content types, channels, events and collections |
| `POST /api/publishing-rules/metadata-rules` | Adds a rule at the end: `{"name": "...", "conditions": {"match": "all", "conditions": [{"field": "tags", "op": "has_any", "value": ["premier-league"]}]}}`, optionally with `settings`, `lockedFields`, `presetKey` and `enabled`. `?dryRun=1` answers what it would do |
| `PUT /api/publishing-rules/metadata-rules/{id}` | Changes a rule; send only what changes. Refused like any rung (`422 policy_conflict`, `409 confirm_repackage`); `?dryRun=1` as above |
| `PUT /api/publishing-rules/metadata-rules/order` | Sets the order: `{"ids": [...]}`, every rule once |
| `POST /api/publishing-rules/metadata-rules/test` | `{"assetId": "..."}`: the rule the item meets first (`matched`), every rule with whether it matches, and what the item resolves to |
| `DELETE /api/publishing-rules/metadata-rules/{id}` | Removes a rule; its items go to the next rule they meet |

In `resolve`, a metadata rule is the rung `metadata`, between `owner` and `asset`, with its `name`; fields it sets have `metadata` as their source.

With the Mirror and Archive add-on a rung can also hold **copy rules** (`archive`): which storage targets an item's original is copied to on ingest, on publish or nightly (`schedule`), what is copied (`what`: any of `source`, `sidecars`, `clips` and `packages`; the original alone when left out), whether recordings are archived (`recording`), and an optional off-peak window. See [Copy by rule](../workflows/mirror-and-archive.md#copy-by-rule). Saving one without the add-on answers `403` with the code `licence_required`.

### Policy sections, locks and presets

A rung can also say how content is protected, what else may be done with it and how long it is kept. Each field is optional; one left out comes from the rung beneath, field by field, so a content type can set DRM and leave everything else to the account default.

| Section | Fields |
|---|---|
| `protection` | `drm` (on or off), `tokenLifetimeSec` (how long a playback token lasts; left out, the platform default), `waf` (`off`, `standard`: VPN and proxy flagged, or `rights_managed`), `referrers` (domains a player may be embedded on), `concurrentStreams` |
| `distribution` | `mp4Download`, `shareLinks`, `fastEligible`, `sitemap` (listed in the sitemap and schema.org data) |
| `retention` | `keep` (`forever` or `days`), `days`, `anchor` (counted from `ingest`, `available_from` or `available_until`), `legalHoldAllowed`, `archiveTier` |

`tokenLifetimeSec`, `referrers`, `mp4Download` and `shareLinks` apply where titles are played and handed out: the edge token's lifetime, a `403` with `code: "referrer"` from the [play gate](../api/play-gate.md) for a page on another site, a `403` with `code: "mp4_off"` from `POST /api/downloads/vod/{id}/link` and the share link hi-res download, and a `403` with `code: "sharing_off"` from `POST /api/share-links` (a link made before answers `410` with `reason: "sharing_off"`). The rest are stored and resolved now and apply in later steps: concurrent streams, FAST eligibility, the sitemap and schema.org, DRM packaging when a title is encoded, the WAF profiles, and the retention sweep.

**Locks.** `lockedFields` lists the fields the rungs beneath may not change, by name (`geo`, or a section field such as `protection.drm`; a whole section locks all its fields). A rung that tries to change a locked field is refused with the lock and its rung named, and what an item says about a locked field is ignored; `resolve` lists it under `ignored`.

**Presets.** Copy a preset's `settings` into a rung and send its key as `presetKey`. Geo-locked and Rights-managed leave the countries for you to choose.

**Conflicts.** A save is checked before anything is stored, against the rule itself and against every item the rung governs:

| Combination | Answer |
|---|---|
| DRM on and MP4 download allowed | Refused: MP4 export is not possible for DRM content |
| DRM on and a social account to publish to | Refused: social platforms need a clear MP4 |
| Expires before it becomes available | Refused: the window is empty |
| Retention shorter than the time an item is available, or retention on items that never expire | Refused: content would be deleted while live |
| Rights-managed on an item whose rights have no window | Refused, with the items named |
| A field locked by a rung above | Refused, naming the lock |
| DRM turned on or off for published items | `409` with the code `confirm_repackage` and the count; send it again with `"confirm": true` |
| Geo restriction without a WAF profile; geo or limited rights with a social account; **Only in these countries** with none chosen; a publish window reaching outside the rights window | Saved, with a warning in `warnings` |

A refusal answers `422` with the code `policy_conflict`; `details` holds the conflicts and the impact. The impact, also what a dry run returns, counts the items the rung governs (`assets`), how many are published (`published`), how many change (`changed`), how many would need packaging again (`repackage`), how many published items take the change up (`publishedChanged`) and how many of those stop being playable at once (`unavailableNow`). A save that changes published items marks them, and the answer's `restamp.marked` says how many; they take the new rules up within about a minute, keeping where they were published and their DRM until packaged again. Removing a rung does the same for its items.

```bash
curl -X PUT -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"settings": {"access": "paid", "protection": {"drm": true}, "distribution": {"mp4Download": false}}, "presetKey": "premium", "lockedFields": ["protection.drm"]}' \
  "https://your-volt-host/api/publishing-rules/schema/$CONTENT_TYPE_ID?dryRun=1"
```

```bash
curl -X PUT -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"settings": {"targets": [{"kind": "portal"}], "expire": {"mode": "days", "days": 30}}}' \
  "https://your-volt-host/api/publishing-rules/account"
```

Every route is in the [API reference](/api-reference).
