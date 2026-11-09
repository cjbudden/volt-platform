---
title: Rights
sidebar_position: 9.66
description: Give every asset a rights profile that sets where it may be shown, on which apps, for what and until when. Nothing else can go wider.
guide: section
---

# Rights

Every asset in Volt carries one rights profile. The profile says where the asset may be shown (territories), on which apps, for which uses (on demand, FAST and linear, clips, social, downloads, ads), with which access types (free, members, subscription, pay per view) and inside which window. Rights are the cap: collection access and the publishing rules only ever decide inside them, and nothing overrides them.

![The Rights page: summary tiles, the default for new assets, and the list of profiles with their territories, app icons, uses, access, window, asset count, agreement and status](/img/screens/rights.png)

## What it is for

- **One place for what you are allowed to do** with each provider's content, written down once and applied to every title from that provider.
- **A cap nobody can work around.** A publishing rule set to free, a collection made public or a FAST lineup cannot show an asset outside its rights. The play gate refuses, and the asset is not published.
- **Per-title exceptions that only take away.** A single title can have fewer territories, apps or uses, or a shorter window, than its profile. It can never have more.
- **The agreement beside the rights**, private to rights admins, so a takedown can be answered from the contract.

## Before you start

- Every account has two built-in profiles. **No restrictions** allows everything and is where every asset starts. **All restricted** allows nothing: an asset on it is not published, not used in FAST and not posted to social.
- Existing assets were given **No restrictions** when rights arrived, so nothing that played before stopped.
- Registered apps come from [API Keys and Apps](api-keys-and-apps.md). The rights see each app by its type (web, mobile, smart TV, partner) or, for an embed player or venue screens, by what it is used for.
- **Rights: Manage** to create and change profiles, set an asset's rights and open agreements (see [Who can do it](#who-can-do-it)).

## Step by step

### Choose what new assets get

1. Open **Admin**, then **Rights** under Media setup.
2. Under **Default for new assets**, choose **No restrictions**, **All restricted** or one of your provider profiles.

New uploads, watchfolder files and API calls that name no profile get it from now on. Assets already in the library keep the profile they have.

### Create a profile for a provider

1. On **Rights**, choose **New profile**.
2. Under **Owner**, give it a name and the provider, a takedown contact and the agreement's reference.
3. Under **Territories**, choose **Worldwide**, **Allow only these** or **Worldwide except these**, and add the countries.
4. Under **Apps**, choose **All apps**, or allow or block app types by their icon (Web, Mobile, Smart TV, Embeds, Partner apps, In-venue). You can also name registered apps, such as the provider's own app.
5. Under **Permitted uses** and **Access types allowed**, tick what the agreement allows.
6. Under **Window**, choose fixed dates, a window relative to first air or ingest (for example 12 months from first air), or open. Set when rights admins are warned before it ends.
7. Choose **Create profile**, then **Attach agreement** to store the contract with it.

![A rights profile: owner, territories as chips, app types as cards with icons and named apps, uses, access types, the window and the agreement, with where it plays and how assets got it beside them](/img/screens/rights-profile.png)

Saving a profile applies to every asset on it at once. The play gate, publishing and FAST read the change straight away.

### Set or narrow one asset's rights

1. Open the asset in the **Media Library** and choose the **Rights** tab.
2. Pick its **Rights profile**. Every asset must have one.
3. To make this title narrower, turn on **Narrow for this title** and untick territories, apps or uses, or set an earlier end date. Only choices inside the profile are offered.
4. Choose **Save rights**.

**Where the rights allow it** shows, for each of your apps in each territory, whether the rights alone allow it and with which access types. Collection access and the publishing rules then decide inside that.

### Give a watchfolder or an upload a profile

- A watchfolder can name the profile everything it brings in gets. Without one, the account default applies.
- In the upload panel, **Rights** sets the profile for the files you add. Leave it on the account default to use that.

### Choose what viewers see where a title cannot play

A viewer outside a title's territories, or outside its rights, sees the title locked with a message, not a missing title or a broken player. Below the profiles, **Where a title cannot play** sets that message for the whole account:

![Where a title cannot play: the block message, the Notify me option, a preview of the locked player, and the viewers waiting per title](/img/screens/rights-block-message.png)

1. Type the **Message**, up to 200 characters, and select **Save message**. Leave it empty, or select **Use the default**, for *Not available in your region*.
2. Tick **Offer "Notify me if it becomes available"** to show a **Notify me** button with the message. A viewer leaves their email address (or is known by their sign-in) and is kept once per title. The same button shows on a title announced ahead of its release.
3. **Waiting to be told** counts the viewers who asked, per title, so you can see where people want something you have not licensed.

Every Volt player and your own apps get the same words from the [play gate](../api/play-gate.md), so viewers see them the same way on every platform. A link copied to another country is refused by the CDN with *Not available in your region*. Volt keeps the requests; sending the emails when a title opens is not built yet. Publishing policies will later set a message per policy; until then this one applies to every title.

### Move many assets at once

Use the API's bulk assignment (below) to put up to 1,000 assets on one profile in one call. Their per-title narrowing is cleared unless you ask to keep it.

## How it connects

- **[Publishing Rules](publishing-rules.md).** Publishing is refused when the rights do not allow on demand or the rights window has ended. The window a rule sets is cut to the rights window. Social accounts the rights do not allow are left out, and an app the rights do not allow is not published to.
- **The play gate.** A viewer outside the territories or on an app the rights leave out gets your block message and a 451, and the refusal is recorded as a rights refusal in the playback reports in [Analytics](analytics.md). A rule that would let a viewer in for free when the rights allow only a subscription is refused, and a paywall only offers what the rights allow to be sold. An on-demand title outside its rights window, or whose rights do not allow on demand at all, is **restricted**: no public route returns it, and the [play gate](../api/play-gate.md) answers as for an id that does not exist (404), until the window opens.
- **[FAST](fast.md).** An asset whose rights leave out FAST and linear is not offered to lineups, and its window on a channel is cut to its rights window.
- **[Collections](collections.md).** Collection access works inside the rights, per app and region.
- **[Audit log](audit-log.md).** Every profile change, assignment and agreement read is recorded.

## Who can do it

| Task | Needs |
| --- | --- |
| See the profiles (pickers in forms list them) | Any signed-in user |
| Create, change and delete profiles, set the default, set an asset's rights, assign in bulk, set the block message and Notify me | Rights: Manage |
| Check what the rights answer for a country and app | Rights: View |
| Open an agreement | Rights: Manage (every read is audited) |

Roles saved before rights arrived have no Rights level. Admins and owners have it. Give it to others in [Users & Roles](users-and-roles.md).

## Troubleshooting

- **"The rights (…) do not allow this asset on demand."** The asset is on a profile without On demand, such as **All restricted**. Choose another profile on its **Rights** tab.
- **"A title can narrow its rights, never widen them."** The narrowing names something the profile does not allow. Untick it, or change the profile.
- **A built-in profile cannot be changed.** Create your own profile and make it the default instead.
- **A profile cannot be deleted.** Assets still use it, or it is the default for new assets. Move the assets with bulk assignment, or choose another default first.
- **Viewers still see the old message.** Players that asked the gate in the last few seconds keep its answer briefly; the next play shows the new words.
- **Viewers with no known country are refused.** An allow list cannot let in a viewer whose country cannot be told. That is intended.

## Through the API

All under `/api/rights`, with an account token:

| Call | What it does |
| --- | --- |
| `GET /profiles`, `POST /profiles` | List or create profiles |
| `GET`, `PUT`, `DELETE /profiles/{id}` | Read, change or delete one |
| `PUT /agreements/{id}`, `GET /agreements/{id}` | Upload the agreement (the file's bytes) or download it |
| `GET`, `PUT /settings` | Which profile new assets get (`defaultProfileId`), the block message (`blockMessage`, `null` for the default words) and Notify me (`notifyMe`); `GET` also answers `notifyRequests`, the viewers waiting per title |
| `GET`, `PUT /assets/{assetId}` | An asset's profile, narrowing and effective rights |
| `POST /assign` | `{ "profileId", "assetIds": [...] }`, up to 1,000 assets |
| `POST /check` | `{ "assetId", "country", "appId", "use" }`: what the rights alone answer |

Uploads (`POST /api/uploads`), tus uploads (`rightsProfileId` metadata) and watchfolders (`rightsProfileId`) take a profile too. An app can be registered with `"surface": "embed"` or `"venue"` so the rights tell an embed player or venue screens apart.
