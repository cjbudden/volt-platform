---
title: Social accounts
sidebar_position: 10.5
description: Link the YouTube channels, Facebook Pages and TikTok, Dailymotion and X accounts your clips are published to, and how X is switched on.
guide: section
---

# Social accounts

**Social accounts** links Volt to the YouTube channels, Facebook Pages and TikTok, Dailymotion and X accounts your clips and programmes are published to. Each is linked by signing in on the platform itself: Volt never sees the password and keeps only an access token, encrypted. Most people come here once per platform, to link the account, and again when a platform asks for it to be reconnected.

![The Social accounts page: one card per platform, with a linked sandbox account under YouTube, and X off at the bottom with Use your own X app](/img/screens/social-accounts.png)

## What it is for

- **Linking accounts.** **Connect** sends you to the platform's sign-in; when you allow Volt, you come back here with the account linked. One platform sign-in can link several channels or Pages.
- **Sandbox accounts.** An account that behaves like the platform (progress, a post page, views) without sending anything to it, so you can try publishing before linking a real account.
- **Looking after them.** See how many posts went to each account and when, turn one off without unlinking it, reconnect one whose access expired, or disconnect it.

Each card also says the platform's limits, for example the longest title and description.

**X is off until it is switched on for your account.** X charges for its API by the post and by the read, so a Volt does not offer it to every account. Until X is on there is no X card to connect, and the **X** panel at the bottom says **Off**. There are two ways to turn it on:

- **Your Volt provider switches it on** for your account. Posts then go through their X app, and the panel says **On for this account**.
- **You add your own X developer app.** X then bills you directly, and you do not need your provider to switch anything on. The panel says **On, with your own X app** and names your app's client id.

## Before you start

- For a real account, the platform must be set up for your Volt: its card says **Ready to connect**. A card marked **Not set up**, with **Your Volt provider sets this up.**, needs an app registered with that platform first, which whoever runs your Volt does. On a Volt you run yourself, the account owner also sees **How to set up**, with the redirect address, the two server settings and the permissions to register.
- You must be able to sign in to the platform account with the right to post (for a Facebook Page, a Page admin).
- Access: see [Who can do it](#who-can-do-it).

## Step by step

### Link an account

1. Open **Admin** and choose **Social accounts**.
2. On the platform's card, choose **Connect** followed by the platform's name, for example **Connect YouTube**.
3. Sign in on the platform and allow Volt to post.
4. You come back to this page with a message such as **Linked ... on youtube.**, and the account is listed under the platform with **Connected**.

### Try publishing with a sandbox account

1. On any platform's card, choose **Add sandbox account**.
2. An account marked **Sandbox** appears under the card. Publishing to it goes through every step, with progress and a post page, and sends nothing to the platform.
3. Put "[fail]" in a post's title to see how a rejected post looks.

### Turn an account off, reconnect or disconnect it

1. Under the platform, each linked account shows how many posts were **published**, when it was linked and by whom.
2. Use the switch to turn it off: it stays linked but nothing can be published to it. It is shown as **Disabled**.
3. When it says **Reconnect needed**, the platform's access has expired: choose **Reconnect** and sign in again.
4. **Disconnect** asks you to confirm. Posts already published stay on the platform; Volt stops publishing to the account and forgets its token.

### Turn on X with your own X developer app

1. In the X developer portal, create an app with OAuth 2.0 turned on.
2. On the **X** panel at the bottom of Social accounts, choose **Use your own X app**.
3. Add the **Callback URL** shown there to your X app, and give it the permissions listed.
4. Enter the app's client id and client secret and choose **Save X app**. The secret is stored encrypted and never shown again.
5. The X card appears with **Ready to connect**: choose **Connect X** and sign in as the X account to post as.

To change the app, choose **Change X app**. **Remove X app** forgets it: your linked X accounts are kept, but X turns off again unless your Volt provider has switched it on.

### When X is switched off

X accounts you linked are kept, not removed. They are listed under the X panel with **Off**, and while X is off Volt posts nothing to them and reads nothing from them (no view counts). They are not offered when you publish, a publishing rule cannot be saved with one ticked, and a rule that still names one publishes everywhere else and skips it. Turn X on again and they carry on as before.

Publishing itself is done from the [Media Library](media-library.md) and [Recordings](recordings.md), or automatically by [Publishing Rules](publishing-rules.md).

## How it connects

| Section | How it relates |
|---|---|
| [Media Library](media-library.md), [Recordings](recordings.md) | Where a clip or programme is published to these accounts |
| [Publishing Rules](publishing-rules.md) | Can publish to them automatically |
| [Formats & reframing](formats-and-reframing.md) | The vertical and square versions social platforms want |
| [Notifications](notifications.md) | Tells you when a post cannot be published |

See [How Volt fits together](../getting-started/how-volt-fits-together.md) for the whole map.

## Who can do it

| Task | Access needed |
|---|---|
| See the platforms and linked accounts | Account settings: View and Media library & publishing: View (the menu shows **Social accounts** only with both) |
| Link an account, add a sandbox account | Media library & publishing: Manage |
| Turn an account on or off, disconnect it | Account settings: Manage |
| Add, change or remove your own X app | Account settings: Manage |
| Switch X on or off for an account | Your Volt provider (a system administrator); on a Volt you run yourself, the account owner |
| Publish to a linked account | Media library & publishing: Operate |

Roles and levels are explained in [Roles and access](../getting-started/roles-and-access.md).

## Troubleshooting

| You see | What it means | What to do |
|---|---|---|
| **Not set up** on a card | The platform has not been registered for your Volt | Ask your Volt provider to set it up (on a Volt you run yourself, **How to set up** has the details); use a sandbox account meanwhile |
| **Reconnect needed** | The platform's access expired or was withdrawn | Choose **Reconnect** and sign in again |
| **Problem** with a note under the account | The platform refused the last request | Read the note; reconnect if it asks you to |
| **This sign-in link has already been used or was not started here. Start again from Social accounts.** | The platform sent you back with an old or unknown sign-in | Choose **Connect** again |
| **The sign-in took longer than ten minutes. Start again.** | The sign-in on the platform was left too long | Choose **Connect** again and finish within ten minutes |
| **... said: ...** | The platform refused, for example you chose not to allow Volt | Connect again and allow it |
| **Couldn't load social accounts.** | The page could not reach Volt | Choose **Retry** |
| No X card, and the **X** panel says **Off** | X is not switched on for your account | Ask your Volt provider to switch it on, or add your own X app |
| An X account marked **Off** | X was switched off, or your own X app removed | Turn X on again; the account is kept |
| **X is not switched on for this account. ...** when publishing | The post was going to an X account while X is off | Untick the X account, or turn X on |

## Through the API

| Request | Does |
|---|---|
| `GET /api/social/platforms` | Each platform, whether it is ready to connect, and its limits |
| `GET /api/social/accounts` | The linked accounts |
| `POST /api/social/connect/{platform}` | Starts a link; answers with the address to send the browser to |
| `POST /api/social/sandbox/{platform}` | Adds a sandbox account |
| `PATCH /api/publish-targets/{id}` | Turns an account on or off (`{"enabled": false}`) |
| `DELETE /api/publish-targets/{id}` | Disconnects it |
| `GET /api/social/x` | Whether X is on for your account, and how (never the secret) |
| `PUT /api/social/x/app` | Saves your own X app (`{"clientId": "...", "clientSecret": "..."}`) |
| `DELETE /api/social/x/app` | Forgets your own X app |
| `PATCH /api/social/x` | Switches X on or off (`{"enabled": true}`); system administrators |

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" "https://your-volt-host/api/social/sandbox/youtube"
```

Every route is in the [API reference](/api-reference).
