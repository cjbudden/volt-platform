---
title: Account settings
sidebar_position: 6
description: Your account's logo and colours, and the account-wide rule for where content can be watched.
---

# Account settings

**Admin > Account settings** holds your account's own look, used on the pages Volt shows to people outside your account, and the one geo rule that applies to everything you have.

![The Account settings page: branding on the left, a preview of a share page on the right, and the account-wide geo rule below](/img/screens/account-settings.png)

## Logo and colours

| Setting | Used for | Default |
|---|---|---|
| **Logo** | The top of share pages, in place of your account name, and the PIN and email-code screens | Your account name |
| **Primary colour** | Buttons, the play control, avatars. Players can use it too ("Use account branding"). | `#2563eb` |
| **Secondary colour** | The information band and the "Your access" card on share pages | `#eef2ff` |

- Pick the logo from the image library, or paste an https address.
- Text on each colour is black or white, whichever reads better. The form warns you when a primary colour is a mid-tone that is hard to read whatever the text.
- The form shows a live preview of the share page header.
- Saving applies at once, including to share links you have already sent.
- Choosing the default colour means "no custom colour", so you automatically get any later change to the Volt default.

## Where content can be watched

One rule above every other, for everything in your account: channels, events, radio stations, on-demand assets and share links.

| Setting | Means |
|---|---|
| **Anywhere** | No account-wide restriction (the default) |
| **Everywhere except these countries** | A block list |
| **Only in these countries** | An allow list. A viewer whose country cannot be determined is not let in. |

Nothing lower down can undo it. A channel's own geo setting, an access rule or a programme's geo rule can narrow it further, but never open it up.

When a viewer asks to play, Volt checks the layers in this order and reports the first one that says no:

1. **Account** geo (this setting)
2. The **channel's** own geo (Channel settings > Source geo rules)
3. **Access rules**
4. The **programme** on air (see [programme guide](epg.md#control-a-slot))

The rule applies in the app play gate, on the public live URL (HLS, DASH and radio MP3) and on share links, where viewers are told the content is not available in their region. Every change is recorded in the [audit log](audit-log.md).

### Check it as a viewer

The **Output** player on a channel page has **View as a viewer in [country]**. Choose a country, and whether the viewer is signed out, signed in or has paid, to see exactly what that viewer would get.
