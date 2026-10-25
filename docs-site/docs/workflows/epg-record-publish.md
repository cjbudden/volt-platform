---
title: The guide drives recording and publishing
sidebar_position: 1
description: A channel whose programme guide turns each programme into its own on-demand asset after it airs, and publishes it to your catalogue, apps and social accounts by rule.
guide: workflow
---

# The guide drives recording and publishing

Your channel already has a programme guide saying what is on and when. This workflow lets that guide do the work after broadcast: each programme you mark becomes its own on-demand asset when it finishes airing, named and described from the guide, and your publishing rules send it to the catalogue, your apps and your social accounts without anyone cutting or uploading it by hand.

## What it is for

Catch-up and social teams on a channel with a regular schedule: news bulletins, magazine shows, a daily sport wrap. Without it, someone watches the recording, marks the start and end of each programme, types its title and description, and publishes it to each place one by one. With it, the guide supplies the times and the details, the recording supplies the media, and the publishing rules decide where it goes, for how long and whether someone must approve it first.

## Before you start

- A channel that records: in its settings, under **Recording**, **Recording and clipping** is on, with **Keep recordings for** long enough for you to cut anything the automation misses ([Channels](../guides/channels.md), [Recordings](../guides/recordings.md)). It applies from the next start.
- The channel running from a real source. Volt can only cut what it actually recorded: a programme that aired while the channel was stopped, or recording was off, shows **Not recorded**.
- For social posting, the social accounts linked, or a sandbox account to try it with first ([Social accounts](../guides/social-accounts.md)). A real account needs the platform set up for your Volt (its card says **Ready to connect**); this is usually done by your Volt provider.
- Optionally, content types whose fields the guide fills ([Content Types](../guides/content-types.md)).
- The access listed under [Who can do it](#who-can-do-it). Setting the publishing rules needs an Owner or Administrator.

## The flow

![The EPG gives each programme its times and details; Recordings holds what aired; Auto VOD makes one Media Library asset per programme; if the rule asks for it, Review approves it; Publishing Rules decide where it goes; Social accounts receive the posts](/img/flows/epg-record-publish.svg)

The guide gives each programme its times, title, description, genre, tags and the **Auto VOD** flag. The channel records everything it sends out. When a flagged programme finishes, Volt cuts exactly that period from the recording into a Media Library asset carrying the programme's details. Once the asset is built, its publishing rule decides what happens: published at once to every publishing point it names, held for an approval in Review, or left for a person to publish. A social account named in the rule receives the asset as a post.

| Step | Section | What happens |
|---|---|---|
| 1 | [Social accounts](../guides/social-accounts.md) | The YouTube channel, Facebook Page or other account is linked once, and becomes a publishing point |
| 2 | [Publishing Rules](../guides/publishing-rules.md) | The rule for the account, a content type or the channel names where programmes go (**Publish to**), turns on **Auto-publish** and sets any **Publish gate** |
| 3 | [EPG](../guides/epg.md) | Each programme gets its details and **Auto VOD**; repeats and copied days keep the flag |
| 4 | [Recordings](../guides/recordings.md) | The channel records what aired; anything not flagged, or only part of a programme, is cut here by hand |
| 5 | [Media Library](../guides/media-library.md) | Each flagged programme becomes an asset named from the guide, with its genre, tags and rating |
| 6 | [Review](../guides/review.md) | Only if the rule requires an approved review: the asset waits here for a decision |
| 7 | [Publishing Rules](../guides/publishing-rules.md), [Social accounts](../guides/social-accounts.md) | The asset is published to the catalogue, apps and social accounts the rule names, and each post's progress is listed on the asset |

## Step by step

### 1. Link the social accounts

1. Open **Admin** and choose **Social accounts**.
2. On the platform's card, choose **Connect** followed by its name (for example **Connect YouTube**), sign in on the platform and allow Volt to post. You come back with the account listed as **Connected**.
3. A card marked **Not set up** has no **Connect** yet: **How to set up** shows what your Volt provider needs to register. To try the whole flow before posting anywhere real, choose **Add sandbox account** instead. It goes through every step, with progress and a post page, and sends nothing to the platform.

Details, including reconnecting and turning an account off: [Social accounts](../guides/social-accounts.md).

### 2. Decide where programmes go

1. Open **Admin** and choose **Publishing Rules**. **Publishing points** lists the **Catalogue**, each registered app and each social account you linked.
2. Choose the rung to set it on: **Account default** (here) for everything, a content type's rule in [Content Types](../guides/content-types.md), or just this channel's rule (open the channel's **Settings** and choose the **Access** tab, then tick each field you want to set there).
3. Under **Publish to**, tick **Catalogue (portal)**, the apps and the social accounts the programmes should go to.
4. Under **Auto-publish**, tick **Publish automatically once built and gated**. Without it, every asset waits for someone to choose **Publish**.
5. Set **Available from** and **Expires** (for example **After a number of days** for catch-up that comes down after a week), and **Geo access** and **Access** if they differ from the account.
6. Under **Publish gate**, tick **Require an approved review before publishing** if a person must sign each programme off, or **Block publishing while QC has failed** to hold back assets with a failed quality check.
7. Choose **Save publishing rule**.

Field by field, and how the rungs inherit: [Publishing Rules](../guides/publishing-rules.md).

### 3. Mark the programmes in the guide

1. Open **EPG** in the sidebar and choose **Open** on the channel's guide (or **Build** if it has no programmes yet).
2. Move to the day, choose **Add programme** and fill in **Title**, **Description**, **Genre**, **Rating** and **Tags**: they become the asset's name, description and keywords. Set **Start** and, if you like, **End**.
3. Under **Post-broadcast VOD**, turn on **Auto VOD**.
4. For a programme that airs every day or every week, set **Repeat** to **Daily**, **Weekdays** or **Weekly**. To repeat a whole day, use **Copy or repeat day…**. The copies keep **Auto VOD**.
5. Choose **Add programme**. The **VOD** column shows **Auto VOD** for the slot until it airs.

Details: [EPG](../guides/epg.md).

### 4. Let it air, and cut anything else by hand

1. While the channel runs, its recording appears in **Recordings** under the channel's name. The **On air** lane of its **Timeline** shows the guide's programmes over the recorded media.
2. When a flagged programme ends, its **VOD** column in the guide shows **Converting**, then **VOD** once the asset exists. Choose it to open the asset.
3. A programme that aired without **Auto VOD** shows **REC** with the days until its recording is removed. Open it in the guide and choose **Convert now**.
4. For only part of a programme (a highlight, one story), open the channel in **Recordings**, open the recording and click the programme in the metadata lane: the marks snap to it and its title fills **Clip title**. Move the marks, choose an **Output** and choose **Create clip**.

The status of every slot is explained in [EPG](../guides/epg.md#turn-programmes-into-on-demand-assets); clipping by hand in [Recordings](../guides/recordings.md#cut-a-clip).

### 5. Check the asset and its publishing

1. Open **Media Library**. The new asset is listed with the programme's title. The **Created as** and **Source** chips (for example **Clip** and **Channel**) narrow the list to them.
2. Open it. On the **Metadata** tab, choose **Fill from EPG** to copy the programme's details into its content type's fields, tick the fields to **Use** and choose **Apply**. Fields filled this way are marked **EPG**.
3. Open the **Availability** tab. **What a publish does for this item** shows the rule it follows. Once it has been published, **Publishing points** lists where it went and the state at each.
4. If the rule has **Auto-publish** and no gate held it, it is already **Available** (or **Scheduled**, if its **Available from** is later). Otherwise choose **Publish**.
5. Open the **History** tab to see each social post under **Social**: **Publishing**, **Published** or **Failed**. **Retry** a failed one. To post to an account the rule does not name, choose **Publish to social**, tick the accounts, write the post and choose **Publish to**.

Details: [Media Library](../guides/media-library.md#publish-it-or-take-it-off-availability).

### 6. Approve it first, if the rule asks

When the rule has **Require an approved review before publishing**, an automatic publish is held back and the asset waits, unpublished, for a person.

1. Send the asset for review. The console has no button for this yet: send it with the API (see [Through the API](#through-the-api)). It then appears in **Review**.
2. In **Review**, open it, read **What was measured**, type a note and choose **Approve** (or **Request changes** or **Reject**).
3. Approving does not publish it. Open the asset in **Media Library**, go to **Availability** and choose **Publish**: it goes to every point the rule names, social accounts included.

Details: [Review](../guides/review.md).

## Who can do it

The setup is done once by an Owner or Administrator; the daily work can be split between a scheduler and a catch-up producer.

| Stage | Access needed |
|---|---|
| Link a social account or add a sandbox account | Media library & publishing: Manage |
| Set the account, content type or channel publishing rule | Account settings: Manage |
| Mark programmes with **Auto VOD**, **Convert now** | EPG & schedules: Manage |
| Turn recording on for the channel | TV channels: Manage |
| Cut a clip in Recordings | Recordings & clips: Manage |
| **Publish**, **Publish to social**, retry a post | Media library & publishing: Operate |
| **Fill from EPG**, change one asset's rule, approve in Review | Media library & publishing: Manage |

Of the default roles, Owners and Administrators can do all of it. An Event Manager can mark programmes, cut clips and publish, but cannot change rules or approve in Review. An EPG Administrator template gives the guide only. Roles are explained in [Roles and access](../getting-started/roles-and-access.md).

## Troubleshooting

| You see | What it means | What to do |
|---|---|---|
| **Not recorded** in the guide's **VOD** column | Nothing was recorded while the programme aired: recording was off, or the channel was down | Turn on **Recording and clipping** for the channel; nothing can be cut for that slot |
| **Expired** in the **VOD** column | The recording was removed at the end of **Keep recordings for** | Keep recordings longer, or convert sooner |
| **VOD failed** | The asset could not be built from the recording | Open the programme and choose **Retry conversion** |
| **REC** instead of **VOD** after it aired | **Auto VOD** was off for that slot | Open it and choose **Convert now** before the days shown run out |
| The asset is **Not published** although the rule has **Auto-publish** | The publish gate held it (a review is required, or QC failed), or **Auto-publish** is not set on the rung that decides | Check **What a publish does for this item** on **Availability**; approve it in Review and choose **Publish** |
| **Publish to** reads **nowhere (publishing is a no-op)** | No publishing point is ticked on the rung that decides | Tick **Catalogue (portal)** or an account in the rule, and save |
| A social post shows **Failed** | The platform refused it | Read its message in **History**, fix the post or reconnect the account in [Social accounts](../guides/social-accounts.md), then **Retry** |
| The account cannot be picked in **Publish to social** | It says **reconnect needed** | Choose **Reconnect** in Social accounts and sign in again |
| The asset's fields are empty | It was cut by hand, or the guide had no details | Choose **Fill from EPG** on the **Metadata** tab, or fill them in |

## Through the API

| Request | Does |
|---|---|
| `GET /api/social/accounts` | The linked social accounts, with the id to name in a rule |
| `PUT /api/publishing-rules/{scopeKind}/{scopeId}` | Sets a rung: `account`, `schema` (a content type) or `owner` (a channel), with `targets`, `autoPublish`, `expire` and `gate` |
| `POST /api/epg` | Adds a programme (`title`, `startsAt`, `endsAt`, `metadata`); `autoVod: true` makes it an asset after it airs |
| `PATCH /api/epg/{id}` | Turns **Auto VOD** on for an existing programme |
| `POST /api/epg/{id}/convert` | Converts an aired programme now (the console's **Convert now**) |
| `POST /api/recordings/{id}/clip` | Cuts part of a programme by hand |
| `GET /api/vod` | Lists assets, for example `availability_state=draft` for those not yet published |
| `POST /api/vod/{id}/review` | Sends an asset for review (`{"to": "in_review"}`) or decides on it |
| `POST /api/vod/{id}/publish` | Publishes an asset through its rule |
| `POST /api/social/publish/{assetId}` | Posts it to social accounts the rule does not name |

This adds tonight's bulletin with **Auto VOD** on:

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"channelId": "CHANNEL_ID", "title": "Evening News", "metadata": {"genre": "News"}, "startsAt": "2026-11-02T08:00:00Z", "endsAt": "2026-11-02T09:00:00Z", "autoVod": true}' \
  "https://your-volt-host/api/epg"
```

Every route is in the [API reference](/api-reference).
