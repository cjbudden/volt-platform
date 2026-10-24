---
title: Account settings
sidebar_position: 10.1
description: Your account's logo and colours, and the account-wide rule for where content can be watched.
guide: section
---

# Account settings

**Account settings** holds your account's own look, used on the pages Volt shows to people outside your account, and the one geo rule that applies to everything you have. Most people come here once, to put their logo and colours on share pages, or to keep all their content to the countries they hold rights in.

![The Account settings page: branding on the left, a preview of a share page on the right, and the account-wide geo rule below](/img/screens/account-settings.png)

## What it is for

- **Branding.** A logo and two colours for the pages Volt shows outside your account: share pages and their PIN and email-code screens. Players can use the colours too.
- **Where content can be watched.** One geo rule above every other, for channels, events, radio stations, on-demand items and share links.

Account owners and administrators set these when the account is set up. Everyone else with access to the page can see them.

## Before you start

- For a logo, either an image in the [Image Library](images-and-thumbnails.md) or an https address for one. A wide logo on a transparent background works best.
- Changing anything here needs an Owner or Administrator (see [Who can do it](#who-can-do-it)).

## Step by step

### Put your logo and colours on share pages

1. Open **Admin** and choose **Account settings**.
2. Under **Branding**, choose the **Logo** field to pick an image from the Image Library or upload one, or paste an https address.
3. Set the **Primary colour** (buttons, the play control, avatars) and the **Secondary colour** (the information band and the access card) with the colour picker or by typing a hex value such as `#2563eb`. **Use the default** puts a colour back.
4. Watch the **Share page preview** on the right: it is the top of a share page as a recipient sees it. Text on each colour is set to black or white, whichever reads better. If the primary colour is a mid-tone, the form warns that text on it will be hard to read whatever its colour.
5. Choose **Save branding**. The page confirms **Branding saved.** Share pages use it from then on, including links already sent. **Discard** goes back to what was saved.

Choosing the default colour means "no custom colour", so you automatically get any later change to the Volt default.

| Setting | Used for | Default |
|---|---|---|
| **Logo** | The top of share pages, in place of your account name, and the PIN and email-code screens | Your account name |
| **Primary colour** | Buttons, the play control, avatars. Players can use it too ("Use account branding"). | `#2563eb` |
| **Secondary colour** | The information band and the "Your access" card on share pages | `#eef2ff` |

### Keep content to some countries

1. Under **Where content can be watched**, open **Account-wide** and choose:

   | Choice | Means |
   |---|---|
   | **Anywhere (no account-wide restriction)** | The default |
   | **Everywhere except these countries** | A block list |
   | **Only in these countries** | An allow list. A viewer whose country cannot be told is not let in |

2. Type a country or its two-letter code and press Enter, or pick it from the list. Each country appears as a chip; **✕** on a chip removes it.
3. Choose **Save**. The page confirms what now applies, for example **Nothing of this account plays in ...**.

Nothing lower down can undo it. A channel's own geo setting, an access rule or a programme's geo rule can narrow it further, but never open it up. When a viewer asks to play, Volt checks the layers in this order and reports the first one that says no:

1. **Account** geo (this setting)
2. The **channel's** own geo (Channel settings > Source geo rules)
3. **Access rules**
4. The **programme** on air (see [EPG](epg.md#control-a-slot))

The rule applies in the app play gate, on the public live address (HLS, DASH and radio MP3) and on share links, where viewers are told the content is not available in their region.

### Check it as a viewer

The **Output** player on a channel page has **View as a viewer in [country]**. Choose a country, and whether the viewer is signed out, signed in or has paid, to see exactly what that viewer would get.

## How it connects

| Section | How it relates |
|---|---|
| [Share links](share-links.md) | Share pages carry the logo and colours, and obey the account-wide geo rule |
| [Image Library](images-and-thumbnails.md) | Where the logo is picked from |
| [Channels](channels.md), [Events](events.md), [Radio](radio.md) | Their own geo settings narrow the account rule further |
| [Publishing Rules](publishing-rules.md), [EPG](epg.md) | Access rules and programme geo rules sit below the account rule |
| [Plan & limits](plan-and-limits.md) | **Plan & limits** at the top of the page opens the plan |
| [Audit log](audit-log.md) | Every change here is recorded |

See [How Volt fits together](../getting-started/how-volt-fits-together.md) for the whole map.

## Who can do it

| Task | Access needed |
|---|---|
| See the branding and the geo rule | Account settings: View |
| Change the logo, colours or geo rule | Owner or Administrator |

Users who can only see the page are told **Account administrators and owners change these settings.** and the fields are read-only.

Roles and levels are explained in [Roles and access](../getting-started/roles-and-access.md).

## Troubleshooting

| You see | What it means | What to do |
|---|---|---|
| **Use #RRGGBB, for example #2563eb** | The colour typed is not a six-digit hex value | Type a value like `#1d4ed8`, or use the picker |
| **This colour is mid-tone: text on it will be hard to read whatever its colour.** | Neither black nor white text reads well on it | Choose a lighter or darker shade |
| **Add at least one country, or choose Anywhere.** | A block or allow list with no countries | Add a country, or choose **Anywhere** |
| **"..." is not a country: pick one from the list or type its two-letter code** | The text typed does not match a country | Pick from the list, or type a code such as `NZ` |
| Viewers told the content is not available in their region | The account rule (or a lower one) blocks their country | Check this rule first, then the channel's own geo setting and access rules |
| **Couldn't load the account settings.** | The page could not reach Volt | Choose **Retry** |

## Through the API

| Request | Does |
|---|---|
| `GET /api/account-settings` | The logo, colours, geo rule and defaults |
| `PATCH /api/account-settings` | Changes them (`logo`, `primary`, `secondary`, `geoAccess`). `null` puts a colour back to the default |

```bash
curl -X PATCH -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"geoAccess": {"mode": "allow", "countries": ["AU", "NZ"]}}' \
  "https://your-volt-host/api/account-settings"
```

Every route is in the [API reference](/api-reference).
