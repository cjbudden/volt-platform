---
title: Notifications
sidebar_position: 10.6
description: The alerts Volt sends to the people who run your account, where each copy went, and the wording of your own messages.
guide: section
---

# Notifications

**Notifications** shows how Volt can reach the people who run your account, every alert it has sent and what happened to each copy, and the templates for messages you send through the API. Volt alerts when a live channel or event needs someone (see [Stream alerts](#stream-alerts)), when auto connect gives up, when an EPG import fails and when a post cannot be published. Every message goes to the console inbox (the bell at the top of the console), and by email and device push where those are set up. Most people come here to check that alerts are reaching them, or to find out why one did not.

![The Notifications page: the three delivery channels with a test button each, the sent list with one alert, the templates and your devices](/img/screens/notifications.png)

## What it is for

- **Delivery channels.** **Console inbox**, **Email** and **Device push**, each **Ready** or **Not set up**, with **Send me a test**.
- **Sent.** Every message, newest first, with how many copies were **sent**, are **retrying** or **gave up**. Open one for each recipient and channel, and the reason a copy failed.
- **Templates.** The wording for messages sent through the API with a template key.
- **Your devices.** Phones and tablets signed in to the Volt management app with notifications allowed: your push alerts go to these.

The bell at the top of every page is your own inbox: it shows a count of unread alerts and opens them.

## Before you start

- The console inbox always works. Email and device push are set up for your Volt deployment; a channel marked **Not set up** says **Not set up yet. Your Volt provider sets this up.** Once email is on, its line names the address alerts are sent from. On a Volt you run yourself, the account owner sees the server settings behind each channel instead.
- For push to reach you, sign in to the Volt management app on your phone and allow notifications.
- Access: the page is open to every admin user; sending tests and retrying need an operator-tier role or above (see [Who can do it](#who-can-do-it)).

## Step by step

### Check alerts reach you

1. Open **Admin** and choose **Notifications**.
2. Under **Delivery channels**, choose **Send me a test** on a channel.
3. The line under it says **Sent to you. Check it arrived.**, or **Not delivered:** with the reason.
4. The test appears under **Sent**.

### Find out what happened to an alert

1. Under **Sent**, each row is one message: its subject, when and its topic, with counts of copies **sent**, **retrying** and **gave up**.
2. Choose a row to open it. Its text is shown, then one line per recipient and channel:

   | Status | Means |
   |---|---|
   | **Sent** | Delivered |
   | **Pending** | Not tried yet |
   | **Retrying** with a time | It failed and will be tried again at that time |
   | **Gave up** | Volt stopped trying; the reason is under it |

3. A failed copy is retried after 1, 5, 15 and 60 minutes, up to five attempts. A rejected address or a dead device is not retried, because trying again cannot fix it.
4. **Retry now** on a retrying copy tries it at once. **Retry everything now** (above the list, when anything is retrying) tries every one.

### Word your own messages

1. Under **Templates**, choose **New template**.
2. Type a **Key** such as `event.reminder`: your systems send a message with this key.
3. Type a **Subject** and **Body**. Use `{{name}}`-style placeholders; they are filled from the message's payload.
4. Choose **Save template**. **Edit** changes one later (the key stays); **Delete** removes it after you confirm.

### Remove a device

1. Under **Your devices**, each phone or tablet shows its platform and when it was last seen.
2. **Remove** stops push alerts going to it.

### Stream alerts

These go to the account's owners and administrators while a channel or event is meant to be live:

| Topic | Subject | Sent when |
|---|---|---|
| `stream.encoder_died` | **the encoder stopped** | The encoder stopped without anyone asking. Auto connect tries to start it again if it is on |
| `stream.input_error` | **the source cannot be read** | Volt could not open or read the source; the message gives the reason |
| `stream.on_filler` | **on the slate, every source lost** | Every source has been lost for over a minute and viewers see the slate or loop. A shorter loss that failover rides out sends nothing |
| `stream.output_timing` | **the output's timing is wrong** | The delivered output went back in time or sound and picture drifted apart, so viewers may see the picture jump or hear it out of sync |

Each subject starts with the stream's name, and the message links to its page. One alert per stream per topic is sent at most every 30 minutes, so a flapping source does not fill your inbox. Stopping a stream yourself sends nothing. Everything else that is wrong (a stream on its backup source, a stalled output) is listed in [Monitoring](monitoring.md) without an alert.

## How it connects

| Section | How it relates |
|---|---|
| [Channels](channels.md), [Events](events.md) | A stopped encoder, an unreadable source, a minute on the slate or a timing fault sends a [stream alert](#stream-alerts); auto connect giving up sends an alert |
| [Radio](radio.md) | Auto connect giving up sends an alert |
| [EPG](epg.md) | A failed import sends an alert |
| [Social accounts](social-accounts.md), [Publishing Rules](publishing-rules.md) | A post that cannot be published sends an alert |
| [Users & Roles](users-and-roles.md) | Who the alerts go to: the people who run the account |
| [Monitoring](monitoring.md) | The live list of alerts on the streams themselves |

See [How Volt fits together](../getting-started/how-volt-fits-together.md) for the whole map.

## Who can do it

| Task | Access needed |
|---|---|
| See the channels, the sent list and your devices; read your inbox | Any admin user |
| Send a test, retry a copy, remove a device, mark alerts read | An operator-tier role or above |
| See the templates | Account settings: View |
| Create, change or delete a template | Account settings: Manage |

Roles and levels are explained in [Roles and access](../getting-started/roles-and-access.md).

## Troubleshooting

| You see | What it means | What to do |
|---|---|---|
| **Not set up** on Email or Device push | That channel is not configured for your Volt | Ask your Volt provider; the console inbox still receives every alert |
| **Not delivered:** after a test | The channel tried and failed; the reason follows | Fix what the reason says, then test again |
| **Template "..." already exists** | A template with that key exists | Edit that one, or use another key |
| **Gave up** on a copy | The address was rejected, the device is gone, or five attempts failed | Check the address or device; the reason is under the status |
| **Nothing sent yet.** | No alert has been sent in this account | Use **Send me a test** to try a channel |
| **No devices registered.** | You have not allowed notifications in the Volt management app | Sign in to the app on your phone and allow notifications |
| **Couldn't load notifications.** | The page could not reach Volt | Choose **Retry** |

## Through the API

| Request | Does |
|---|---|
| `GET /api/notifications` | The sent list with counts per message |
| `GET /api/notifications/{id}` | One message and each copy |
| `POST /api/notifications` | Sends a message (`topic`, `recipients`, `channels`, and a `templateKey` with a `payload`, or a `subject` and `body`) |
| `POST /api/notifications/test` | Sends a test to yourself on one channel |
| `POST /api/notifications/deliveries/{id}/retry` | Retries one copy now |
| `GET /api/notifications/inbox` | Your own inbox |
| `GET /api/notification-templates` | The templates; `POST`, `PATCH` and `DELETE` change them |

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"topic": "event.reminder", "recipients": ["ops@example.com"], "channels": ["email", "in_app"],
       "templateKey": "event.reminder", "payload": {"name": "Cup final", "time": "19:30"}}' \
  "https://your-volt-host/api/notifications"
```

Every route is in the [API reference](/api-reference).
