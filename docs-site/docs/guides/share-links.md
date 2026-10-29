---
title: Share links
sidebar_position: 2.4
description: Send a client or reviewer a private, time-limited preview of a channel, radio station or event, and revoke it at any time.
guide: section
---

# Share links

A share link is a private preview of a channel, a radio station or an event, for a client or reviewer to watch and approve before go-live. It does not put anything on air or publish it: it opens one stream on a page of its own, for a set time or a set number of views, and you can revoke it at any moment.

![The Share window: how to send it, how long it lasts, who can open it and a label, with the links already made for this stream listed below](/img/screens/share-links.png)

## What it is for

- **Approvals before go-live.** A sponsor, client or producer watches the real output without an account and without the stream being public.
- **Sending it your way.** Copy a link into your own email, chat or ticket, or have Volt email it with your message and instructions.
- **Limits.** The link stops working on a date, or after it has been opened a number of times. A PIN, or a one-time code emailed to the recipient, keeps it to the people you meant.
- **Keeping track.** Every link made for a stream is listed with its expiry and views, and can be revoked.

Producers, channel and event managers and account managers use it.

## Before you start

- The channel, station or event must exist. Viewers see the stream only while it is being produced: a stopped stream shows **Preview not live right now**.
- **Share links: Manage**, and access to view the stream itself (see [Who can do it](#who-can-do-it)).

## Step by step

### Open the Share window

| From | Choose |
|---|---|
| A channel's page | The share icon at the top (its tooltip reads **Share a private preview link**) |
| An event's page | The same share icon at the top |
| A radio station's page | **Share** at the top |
| The **Events** list | The row's **More actions** menu, **View and edit settings**, then **Share** at the foot of the panel |

The window, **Share**, names the stream and reminds you that this does not put it on air.

### Create a link

1. Under **How to send it**, choose:
   - **Create a link** to get an address you send yourself, or
   - **Send by email** to have Volt email the link, your message and viewing instructions. Type the addresses, separated by commas.
2. Optionally type a **Message to recipient**. It appears on the preview page, and in the email if Volt sends one.
3. Under **How long it lasts**, choose:
   - **For a period**: **1 day**, **3 days**, **7 days** (the default), **14 days** or **30 days**. The window shows the actual date the link stops working.
   - **For a number of views**: the link stops working after it has been opened that many times, and after 30 days in any case.
4. Under **Who can open it**, choose:

   | Choice | The viewer |
   |---|---|
   | **Anyone with the link** | Watches straight away. Anyone the link is forwarded to can watch too |
   | **A PIN you set** | Enters the PIN you type here (at least 3 characters). Send the PIN separately from the link |
   | **Verified recipients only** | Types the email address the link was sent to and enters a one-time code Volt emails there. With **Create a link**, type those addresses in **Recipient emails** |

5. Optionally give it a **Label**. Only your team sees it; it is how you recognise the link in the list.
6. Choose **Create link** (or **Create and send email**).
7. The window shows **Link created** (or **Invitation emailed to** the number of recipients), the full address and **Copy**. **The full link is shown once here**: copy it now if you are sending it yourself. Choose **Create another** for a second link, or **Done**.

### What the viewer sees

The link opens a page branded with your account's logo and colours, marked **Private share**, that says when access expires and who shared it. It plays the stream (**LIVE PREVIEW**), shows your message, and lists **Details** and **Your access**.

- With a PIN, the page first asks them to **Enter PIN** and choose **Unlock**.
- For verified recipients, the page asks them to **Confirm your email** and choose **Email me a code**, then **Enter your access code** (6 digits, valid for 10 minutes) and choose **Unlock preview**.
- If the stream is not running, the page says **Preview not live right now** and offers **Check again**.
- Once the link has ended, the page says **Link no longer available** and why.

Each visit counts as one view. Reloading the page, choosing **Check again** or leaving it open for a long time is the same visit, for as long as that browser tab stays open; opening the link in a new tab, another browser or another device is a new visit. A viewer whose one allowed view was their own visit can reload it.

### See and revoke links

1. Open the **Share** window on the same stream. **Existing links for this** channel, station or event lists each link by its label (or the start of its address), with **expires** and the date, or **revoked**, and how many views it has had.
2. Choose **Revoke**. Volt asks **Stop this link for good?** on the row: choose **Revoke link** to stop it at once, or **Keep**. A revoked link cannot be turned back on: create a new one instead.

Lost the address? It cannot be shown again. Create another link and revoke the old one.

## How it connects

| Section | How it relates |
|---|---|
| [Channels](channels.md), [Radio](radio.md), [Events](events.md) | Each one's page opens the Share window for that stream |
| [Account settings](account-settings.md) | The preview page uses the account's logo and colours. If you limit [where content can be watched](account-settings.md#keep-content-to-some-countries), the preview follows that too |
| [Embedding](embedding.md) | For putting a stream on a public website rather than in front of one reviewer |

See [How Volt fits together](../getting-started/how-volt-fits-together.md) for the whole map.

## Who can do it

| Task | Access needed |
|---|---|
| Create links and revoke them | Share links: Manage |
| Open the stream the link is for | TV channels: View, Radio stations: View or Events: View |
| List links through the API | Share links: View |

Without Share links: Manage the share button is not shown. Watching a link needs no account.

Roles and levels are explained in [Roles and access](../getting-started/roles-and-access.md).

## Troubleshooting

| You see | What it means | What to do |
|---|---|---|
| **Add at least one recipient email address.** | **Send by email** or **Verified recipients only** needs at least one address | Type the addresses, separated by commas |
| **Set a PIN of at least 3 characters, or choose a different security option.** | The PIN is too short | Type a longer PIN |
| **Link created** although you chose **Send by email** | The email could not be sent | Copy the link and send it yourself |
| The viewer sees **Preview not live right now** | The stream is not being produced | Start it, then ask them to choose **Check again** |
| The viewer sees **This link has reached its view limit.** | It has been opened in as many visits as allowed (a new tab, browser or device is a new visit; a reload is not) | Create a new link, with more views if needed |
| The viewer sees **This link has expired.** or **This link has been revoked.** | Its time ran out, or someone revoked it | Create a new link |
| The viewer sees **This link is not valid.** | The address is incomplete, or the stream no longer exists | Check the address was copied in full; create a new link |
| The viewer sees **This preview is not available in your region.** | Your account limits where content can be watched | Adjust it in [Account settings](account-settings.md), or share with someone in an allowed region |
| **That PIN was not correct.** or **That code was not correct.** | The viewer typed it wrong | Send the PIN again; for a code, they can choose **Use a different email / send a new code** |
| **That code has expired.** | The emailed code is older than 10 minutes | They ask for a new one |

## Through the API

| Request | Does |
|---|---|
| `POST /api/share-links` | Creates a link and returns its address once |
| `GET /api/share-links` | Lists the account's links, with expiry, views and whether revoked |
| `GET /api/share-links/{id}` | One link |
| `POST /api/share-links/{id}/revoke` | Stops it at once |

`resourceKind` is `channel` (also for radio stations), `event` or `vod` (a Media Library item, which the console does not share yet). Set the length with `ttlSec`, and optionally `maxViews`, `label`, `message`, `recipients`, `authMode` (`none`, `pin` or `email_pin`) with `pin`, and `sendEmail`.

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"resourceKind": "channel", "resourceId": "CHANNEL_ID", "ttlSec": 604800, "label": "Sponsor approval"}' \
  "https://your-volt-host/api/share-links"
```

The response's `url` is the address to send; it is not returned again. Every route is in the [API reference](/api-reference).
