---
title: Securing a live stream
sidebar_position: 2
description: Keep a live channel to the countries and times you hold rights for, let only your own apps play it, and let only signed-in or paying viewers watch.
guide: workflow
---

# Securing a live stream

A live channel usually comes with conditions: where it may be shown, which programmes are blacked out or replaced in which countries, and who has to sign in or pay to watch. This workflow sets each of those up, from the account down to a single programme, and shows you how to check what any viewer would be given before it airs.

## What it is for

Rights managers, product owners and the developers of your apps. Without it, anyone with the address can watch from anywhere. With it, Volt applies your geo rules and rights windows to every viewer, only your registered apps can ask to play, and members-only or premium content is checked against the viewer's sign-in and purchases.

Each layer protects something different:

| Layer | Where it is set | What it stops |
|---|---|---|
| Account-wide geo | [Account settings](../guides/account-settings.md) | Anything of the account playing outside the countries you hold rights in |
| The channel's own geo and access rules | The channel's settings | This channel playing outside its countries; viewers who are not signed in or have not paid |
| Rights windows | [EPG](../guides/epg.md), per programme | One programme playing in countries that do not hold it, by blocking it or showing a replacement there |
| Registered apps | [API Keys & Apps](../guides/api-keys-and-apps.md) | Players on sites or apps that are not yours |
| Products and providers | [Payments](../guides/payments.md) | Premium access without a verified payment |
| Public users | [Users & Roles](../guides/users-and-roles.md) | Viewers you have disabled or signed out |

Geo rules and rights windows apply wherever the stream is delivered: through the play gate your apps use and on the channel's public live address. Share links obey the account-wide geo rule too. Sign-in and payment are checked by the play gate, which is how the Volt player and your apps get the stream. The channel's public live address is not tied to a viewer, so for members-only or premium content give viewers the stream through your apps and the player rather than publishing that address.

**DRM.** Volt can encrypt a stream's output with DRM, but it is not switched on from the console. It needs an account with a DRM key service, which whoever runs your Volt deployment sets up and attaches to the output profile your channel group uses. Ask your Volt provider.

## Before you start

- The channel to protect ([Channels](../guides/channels.md)), with a programme guide if some programmes have their own rights ([EPG](../guides/epg.md)).
- For a programme replaced in some countries, a slate or loop set as the channel's filler: **Settings > Filler on total loss**, **Slate image** or **Loop video** ([Loops & Fillers](../guides/loops-and-fillers.md)). Where a programme is replaced, viewers are shown the channel's own filler.
- For paid access, an account with each payment provider you will use. Its secret values are kept in your Volt deployment's secrets store; your Volt provider can help ([Payments](../guides/payments.md)).
- The addresses (origins) your web player is served from, for example `https://watch.example.com`.
- The access listed under [Who can do it](#who-can-do-it). Account-wide geo needs an Owner or Administrator.

## The flow

![Account settings and the channel's own geo set where it can be watched; the guide adds rights windows per programme; access rules and Payments decide who may watch; API Keys & Apps decides which apps may ask; the play gate applies all of it and hands the player a short-lived playback token, while the rights preview shows what any viewer would get](/img/flows/secure-live-stream.svg)

Where the channel can be watched passes from the account to the channel to each programme, and each level can only narrow what the one above allows. The access rules' premium terms become products in Payments. Your registered app asks the play gate, which applies all of it to the viewer's country, sign-in and purchases, and answers with a short-lived playback token and the stream's addresses, or the reason it cannot play.

| Step | Section | What happens |
|---|---|---|
| 1 | [Account settings](../guides/account-settings.md) | One geo rule above everything in the account |
| 2 | [Channels](../guides/channels.md) | The channel's own geo narrows it further; its access rules say who may watch: free, members only or premium |
| 3 | [EPG](../guides/epg.md) | A programme's slot controls block it, or replace it, in some countries for its length |
| 4 | [Channels](../guides/channels.md) | **View as a viewer in** and the **Rights preview** show what a viewer would get, and why |
| 5 | [Payments](../guides/payments.md) | Each premium term is a product; it is matched to the provider's id so payments grant access |
| 6 | [API Keys & Apps](../guides/api-keys-and-apps.md) | Your app is registered and its key limited to your own sites, so only it can ask to play |
| 7 | [Users & Roles](../guides/users-and-roles.md) | The viewers who sign in through your apps, their groups and what they hold |

## Step by step

### 1. Keep the account to its countries

1. Open **Admin** and choose **Account settings**.
2. Under **Where content can be watched**, open **Account-wide** and choose **Only in these countries** or **Everywhere except these countries**.
3. Add each country (type it or its two-letter code and press Enter) and choose **Save**. The page confirms what now applies.

Nothing lower down can open up what this rule closes. Details: [Account settings](../guides/account-settings.md).

### 2. Narrow it for the channel and say who may watch

1. Open the channel and choose **Settings** (the gear in the header).
2. Under **Source geo rules**, set **Access** to **Allow only listed countries** or **Block listed countries**, type the two-letter codes separated by commas, and choose **Save changes**.
3. Choose the **Access** tab. Tick **Access rules**, choose **+ Add rule**, and set **For** (the channel itself), **If** (**Viewer is located in** or **Viewer is not located in**, with country codes or **WORLD**) and **Then**: **Access is free**, **Access for members only** or **Access is premium**.
4. For members only, list the user groups who may watch, or leave it empty for any signed-in viewer. For premium, set the **Terms**: the period, the price, the currency, the tax and a product key.
5. Choose **Save publishing rule**. Rules are read from the top, and the first that matches the viewer decides.

How the rules combine with the account default: [Publishing Rules](../guides/publishing-rules.md#add-access-rules).

### 3. Set rights windows on programmes

1. Open **EPG** and choose **Open** on the channel's guide, or **Build** if it has no programmes yet.
2. Choose **Add programme** (or **Edit** on one), and fill in its **Title**, **Start** and **End**.
3. Under **Slot controls**, set **Geo access for this period** to **Allow only listed countries** or **Block listed countries** and type the codes (for example `AU, NZ`).
4. To show something instead of the programme where it is not allowed, rather than block it, set **Replacement for this period** to **Slate image**, **Loop video** or **VOD asset** and pick it with **Browse…**.
5. Save the programme.

A slot changes what viewers get only when it has a country list: viewers the list leaves out are blocked for the length of the programme or, with a replacement, shown the replacement. Where a programme is replaced, viewers are shown the channel's own filler (the slate or loop under **Filler on total loss**, played as a loop), whatever replacement the slot names. Details: [EPG](../guides/epg.md#control-a-slot).

### 4. Check what a viewer would get

1. Open the channel's page.
2. Under the **Output** player (shown once the channel is producing output), choose a country in **View as a viewer in**, then **Not signed in**, **Signed in** or **Has paid for it**. The answer is **Can watch**, **Sees a replacement** or **Blocked:** with the layer that refused (the account-wide geo rule, the channel's own geo setting, an access rule or the programme on air).
3. In the **Rights preview** panel, type a **Country** (or pick one under **Countries with rules**) and choose **Check**. To check a programme before it airs, set **Time**, or pick one under **Guide times**.
4. Read the answer: **Normal**, **Replaced** or **Blocked**, with the reason underneath (for example which programme blacks out which countries, and until when). For a programme, it lists its times, its countries and its replacement, marked **(plays the stream's own loop)**.
5. The strip under it shows the next 24 hours for each audience the rules name, with replaced and blocked periods marked. Choose a period to check it.
6. **Play as this viewer** plays exactly the version that viewer would be given. This needs the channel running with its real source: with nothing being produced there is nothing to play.

**View as a viewer in** answers what the play gate allows; the **Rights preview** answers what the delivery network sends for the same viewer. Leave **Rights class** empty: every viewer is in the default class today, and Volt does not yet give viewers any other class.

If the preview says **The loop for this stream is not built yet**, set a **Slate image** or **Loop video** under the channel's **Filler on total loss**: until it is built, viewers in a replaced window would get an error instead of the replacement.

### 5. Connect payments for premium access

1. Open **Admin** and choose **Payments**.
2. Under **Providers**, fill in the provider's settings and its **Secret reference**, tick **enabled**, copy the **webhook** address into the provider's own settings, and choose **Connect**.
3. Under **Products**, find the term you set in step 2 (by its name and key). Type the provider's own id for it in **Stripe price**, **App Store id** or **Play SKU**, and choose **Save ids**.
4. To let a viewer in without paying (a guest, a complaint), look them up under **Viewers** and use **Grant a product by hand…**.

A purchase grants access only once the provider has confirmed it. Details: [Payments](../guides/payments.md).

### 6. Let only your apps play it

1. Open **Admin** and choose **API Keys & Apps**, then **Register app**.
2. Type the **App name** and choose the **Platform**. For a **Web player**, under **Where the key works**, choose **Only my origins** and type each address your player is served from, one per line.
3. Read **What will be created**, choose **Register and show me the key**, copy the key and choose **Done, I saved it**.
4. Put the key in your player or app. The [Volt player](../guides/player-sdk.md) asks the play gate before it plays, and is given a playback token that lasts a few minutes, and the stream's addresses, only when every rule allows it.

To stop an app at once, open it and turn off **App enabled**. Details: [API Keys & Apps](../guides/api-keys-and-apps.md), and [the play gate](../api/authentication.md#the-play-gate) for developers.

### 7. Look after the viewers

1. Viewers sign in through your apps, with a Volt account or through your own sign-in system. They appear in **Admin > Users & Roles**, on the **Public users** tab.
2. Search for one and choose **Open** to see their groups, sessions, access and purchases.
3. **Sign out everywhere** ends their sessions; **Disable** stops them signing in. Either takes effect at once.

Details: [Users & Roles](../guides/users-and-roles.md#help-a-public-user).

## Who can do it

| Stage | Access needed |
|---|---|
| Account-wide geo rule | Owner or Administrator |
| The channel's geo setting | TV channels: Manage |
| The channel's access rules | Account settings: Manage |
| Rights windows in the guide | EPG & schedules: Manage |
| **View as a viewer in** and the **Rights preview** | TV channels: View |
| Connect providers, set product ids, grant a product | Payments & products: Manage |
| Register apps and rotate their keys | Apps, API keys & players: Manage |
| Find and help public users | Public users: View, Operate or Manage |

Owners and Administrators can do all of it. A rights manager with EPG & schedules: Manage can keep the rights windows up to date on their own. Roles and levels are in [Roles and access](../getting-started/roles-and-access.md).

## Troubleshooting

| You see | What it means | What to do |
|---|---|---|
| Viewers told the content is not available in their region | A geo rule or a rights window keeps them out | Check with **View as a viewer in**: it names the layer. Change that layer, starting with the account rule |
| **Blocked: an access rule** for a viewer who should get in | The access rules cover the channel but none matches where the viewer is | Add a rule for their country, or one for **WORLD** at the bottom |
| The **Rights preview** says **Normal** in a country the programme should not reach | The programme has no country list, or the time checked is outside it | Set **Geo access for this period** on the programme; check the time with **Guide times** |
| **The loop for this stream is not built yet** in the preview | A programme is replaced but the channel has no filler ready to show | Set a **Slate image** or **Loop video** under **Filler on total loss** in the channel's settings |
| **The variant service is off for this deployment** in the preview | Your deployment blocks replaced viewers instead of replacing | Expected until your Volt provider turns it on; viewers in that window are blocked |
| **Enter a two-letter country code, or XX for a country the CDN cannot tell** | The country typed is not a code | Type a code such as `AU`, or `XX` for a viewer whose country is unknown |
| A paying viewer cannot watch | The product's provider id does not match, or the webhook is not set up | Check **Products** and the webhook in Payments; grant the product by hand meanwhile |
| A player stops after you change the app | Its origin is not listed, the app is disabled, or its key was revoked | Check **Where the key works**, **App enabled** and the keys |

## Through the API

| Request | Does |
|---|---|
| `PATCH /api/account-settings` | Sets the account-wide geo rule (`geoAccess`) |
| `PATCH /api/channels/{id}` | Sets the channel's own geo (`geoMode`, `geoCountries`) |
| `PUT /api/publishing-rules/owner/{id}` | Sets the channel's access rules |
| `POST /api/epg` | Adds a programme with its rights window (`geoMode`, `geoCountries`, `replacementKind`, `replacementRef`) |
| `GET /api/channels/{id}/access-check` | What the play gate allows a viewer (`country`, `viewer`: `anonymous`, `member` or `entitled`) |
| `GET /api/channels/{id}/rights-preview` | What the delivery network sends a viewer (`country`, optional `rightsClass` and `at`) |
| `PUT /api/payments/providers/{provider}` and `PATCH /api/payments/products/{id}` | Connects a provider and matches a product's ids |
| `POST /api/apps` | Registers an app with its `restrictions` |
| `POST /api/public/availability` | The play gate, as your app calls it with its publishable key |
| `GET /api/viewers` | Finds public users |

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "https://your-volt-host/api/channels/$CHANNEL_ID/rights-preview?country=AU&at=2026-11-01T09:30:00Z"
```

Every route, with its fields, is in the [API reference](/api-reference).
