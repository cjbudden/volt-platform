---
title: Notifications and webhooks
sidebar_position: 7
description: Have Volt call your systems when files arrive, check that each call really came from Volt, and send your own alerts to your operators.
guide: developer
---

# Notifications and webhooks

Volt talks to your systems in two directions. **Webhooks** are Volt calling you: a signed `POST` to your address when something happens, such as a file being ingested. **Notifications** are you (or Volt) telling people: a message to your operators' console inbox, email or phones.

## What it is for

- **Your media asset manager or newsroom system learns about new media** the moment it is ingested, with its id, checksum, metadata and where it was stored.
- **Quarantine and duplicates reach a person**, through your own ticketing or chat tools.
- **Workflow add-ons** (an AI service, a transcription vendor) receive their jobs the same signed way: see [Workflows](../guides/workflows.md).
- **Your own alerts** in the console inbox, email and the Volt management app, with wording you keep in templates.

## Before you start

- An account secret key, or an admin user with **Account settings: Manage** for webhooks. Sending notifications needs an operator-tier role or above. See [Getting started with apps and keys](apps-and-keys.md).
- An HTTPS address on your side that Volt can reach, answering within 15 seconds.
- Node 18 or later for the receiver example; any language with HMAC-SHA256 works the same way.

## Step by step

### 1. Register a webhook

```bash file=webhooks/register-webhook.sh
```

```json
{
  "id": "c2956fe1-0e14-4152-87dc-5e169e26fc57",
  "url": "https://hooks.example.com/volt",
  "events": ["ingested", "quarantined"],
  "secret": "whsec_7TreGH..."
}
```

The `secret` signs every call to this webhook. It is shown once, now. `GET /api/ingest/webhooks` lists your webhooks with the result of each one's last call (`lastStatus`, `lastAt`, `lastError`), never the secret. `PATCH /api/ingest/webhooks/{id}` changes the address, the events or `enabled`; `DELETE` removes it. You can do the same under **Admin > Ingest Rules** (see [Ingest Rules](../guides/ingest-rules.md#send-a-webhook-when-files-arrive)).

| `events` | Sent when |
|---|---|
| `ingested` | A file is in, filed and ready for what comes next (the default) |
| `quarantined` | A file was held back by the rules |
| `duplicate` | A file looks like one already in the library and waits for someone to decide |
| `awaiting_metadata` | A file is held until required metadata is filled in. When it is, `ingested` follows |

Every enabled webhook is called for the events it lists, unless an ingest rule names particular webhooks, in which case files under that rule call only those.

### 2. Receive it, and check the signature

Each call is a `POST` with a JSON body and these headers:

| Header | Is |
|---|---|
| `X-Volt-Event` | The event, as in `events` |
| `X-Volt-Signature` | `t=<unix seconds>,v1=<signature>`: the hex HMAC-SHA256 of `t`, a full stop, and the exact body, keyed with the webhook's secret |

Check the signature against the bytes you received, before parsing them, and refuse anything older than five minutes so a recorded call cannot be replayed:

```js file=webhooks/receiver.mjs
```

The body says what arrived: `event`, `at`, `asset` (its `id`, kind, content type and title), `object` (where it was stored, `bytes`, `sha256`, the media type), `origin` (how it came in and the `originalName`), `naming`, the ingest `rules` that matched, `duplicate`, and the `metadata`, with where each value came from.

Answer with any `2xx` within 15 seconds; do the real work afterwards. Volt calls once and records the answer: a failed call is not repeated, so for files you must not miss, also look up recent assets with the [list API](lists.md) (`/api/vod?created_at[gte]=...`).

### 3. Send a notification to your operators

```bash file=webhooks/send-notification.sh
```

```json
{"key":"rights-closing","subject":"Rights close tonight: {{title}}"}
{"subject":"Rights close tonight: The match replay","deliveries":[{"recipient":"admin@example.com","channel":"email","status":"sent","last_error":null},{"recipient":"admin@example.com","channel":"in_app","status":"sent","last_error":null}]}
```

Where email is not set up for your deployment, its copy says so instead (`"status":"failed"`, with the reason in `last_error`), and the inbox copy is still delivered.

- `recipients` are your admin users' email addresses; for `push`, a user's email reaches every phone they signed in to the Volt management app on.
- `channels` are `in_app` (the bell in the console), `email` and `push`. Each recipient and channel is a separate delivery with its own status. A delivery that failed for a reason that might pass is retried after 1, 5, 15 and 60 minutes; one that cannot succeed (a rejected address, a channel not set up) is given up at once, with the reason.
- Instead of a template you can send `subject` and `body` directly. `{{name}}` in either is filled from `payload`.
- Templates live under `/api/notification-templates` (`GET`, `POST`, `PATCH /{id}`, `DELETE /{id}`) and in **Admin > Notifications**.

## Troubleshooting

| You see | Means | Do |
|---|---|---|
| Your receiver refuses every call (`401`) | The secret is wrong, or the body was changed before checking (parsed and re-serialised, or decoded) | Use the webhook's own secret and check the raw bytes |
| Signatures fail only sometimes | Your clock is more than five minutes out | Keep the server's time in sync |
| `lastError` says the call timed out | Your address took more than 15 seconds | Answer at once, then work |
| `lastStatus` is empty and `lastError` names the address | Volt could not reach it | Check the address is public and its certificate valid |
| No call for a file | The event is not in the webhook's `events`, the webhook is disabled, or the file's rule names other webhooks | Check all three on **Ingest Rules** |
| A notification's email copy says the channel is not set up | Email is not switched on for your Volt deployment | Ask your Volt provider; the inbox copy still works |
