---
title: Uploads
sidebar_position: 9
description: Send video files to Volt from your own systems in chunks that survive a dropped connection, and know when they are in.
guide: developer
---

# Uploads

Large files do not travel well in one request. Volt takes uploads in chunks: you open an upload session, send the chunks (in any order, again if one failed), then finish. The finished file goes through your [ingest rules](../guides/ingest-rules.md) like any other upload, so it is named, filed, checked for duplicates and encoded the way your account says.

## What it is for

- **Your media asset manager, newsroom system or edit suite** sends finished programmes and clips straight into the Media Library.
- **Loops and slates** for channels, from wherever you make them.
- **Resuming after a dropped connection** without sending the whole file again.

## Before you start

- An account secret key, or an admin user with **Media: Manage**. See [Getting started with apps and keys](apps-and-keys.md).
- The file's exact size in bytes.
- `curl`, `jq` and `dd` for the example (every Mac and Linux machine has them).

## Step by step

### 1. Open, send, finish

```bash file=uploads/upload.sh
```

```json
{"index":0,"received":1,"chunkCount":2,"complete":false}
{"index":1,"received":2,"chunkCount":2,"complete":true}
{
  "assetId": "a8a7a279-5773-4027-a60f-bb5a9721f90b",
  "bytes": 8688608,
  "sha256": "5d0c4f...",
  "ingest": "ingested",
  "title": "Evening news"
}
```

**Opening** (`POST /api/uploads`) takes:

| Field | Means |
|---|---|
| `purpose` | `vod` for the Media Library, `filler` for Loops & Fillers |
| `fillerKind` | For `filler`: `loop` (the default) or `slate` |
| `name`, `filename` | The asset's title, and the file's own name |
| `totalBytes` | The exact size. Up to the limit `GET /api/uploads` reports as `maxBytes` |
| `contentType` | The media type, such as `video/mp4` |
| `schemaId` | The content type, when you know it up front |
| `metadata` | Values for the content type's fields. Values for fields the content type does not have are left out, and with no content type nothing is kept except `title` or `name`, which title the asset |
| `ladderGroupId` | The encoding profile for `vod`. Leave it out for the account's default at the time the file is encoded |

The asset is titled with the `name` you open the upload with, as "Evening news" above. Only the content type's title field, or a `title` or `name` in `metadata`, comes before it. When `name` is just the file name (with or without its extension), Volt reads a title from the file instead: a title inside the file first, then the file name, so `evening-news.mp4` becomes "Evening News" with tags such as `1080p`, `v2` or `Official Trailer` taken off (see Read from file name in the Media Library guide). To keep the file name as it is, set **Read the file name** to **Off** on an ingest rule (`"filenameMetadata": "off"`). You can change the title later with `PUT /api/vod/{id}`.

The answer to opening has the session `id`, its `token`, `chunkSize`, `chunkCount`, what has been received and what is `missing`, and `expiresAt`. The session's `assetId` is already reserved, so you can store it straight away.

**The token** belongs to this upload only: it can send chunks and finish, nothing else, and it ends with the session. Hand it to whatever sends the bytes (a worker, a browser) without sharing your secret key.

**Chunks** are `PUT /api/uploads/{id}/chunks/{index}`, numbered from 0, each exactly `chunkSize` bytes except the last. Sending a chunk again is harmless. Chunks can be sent in any order and several at once: a chunk that was answered `200` is kept, whichever Volt server took it.

**Finish** checks every chunk arrived, puts the file together and answers with its SHA-256 (compare it with your own) and what the ingest rules decided: `ingested`, or held as a `duplicate`, `awaiting_metadata` or `quarantined`. Finishing twice is harmless. A [webhook](webhooks.md) can tell your system the same thing.

An ingested file is then encoded as a job. The asset's `encode_job_id` (on `GET /api/vod/{assetId}`) can be followed with `GET /api/jobs/{id}`: its progress while it runs, and the reason if it fails.

### 2. Resume after a dropped connection

```bash file=uploads/resume.sh
```

```json
{ "state": "open", "chunkCount": 2, "missing": [0, 1] }
```

Send just the chunks in `missing`, then finish. `GET /api/uploads` lists your own sessions you can still resume, with their tokens, and `DELETE /api/uploads/{id}` abandons one.

Volt also accepts resumable uploads in the open tus protocol at `/api/tus`, for tools that already speak it (creation, creation-with-upload, expiration, termination and checksum). Authenticate each request as you do for the rest of the API. If two requests are sent at the same `Upload-Offset`, one is kept and the other answers `409` with the current `Upload-Offset`: ask `HEAD` and carry on from there.

## Troubleshooting

| Response | Means | Do |
|---|---|---|
| `401 That upload token is not valid.` | The session finished, expired or was abandoned, or the token was mistyped | Open a new session |
| `403 That token does not belong to this upload.` | The token is another upload's | Use the token that came with this session |
| `400` on a chunk | The chunk is empty, or not the size it should be | Send exactly `chunkSize` bytes (the last chunk is the rest) |
| `409` on finish, with `missing` | Some chunks never arrived | Send the chunks listed, then finish again |
| `409 This upload is being assembled.` on finish | Another finish for the same upload is still putting the file together | Finish again in a few seconds; you get the same answer |
| The asset's title is not the one you want | `name` was the file name, so the title was read from the file, or `metadata` carried a `title` | Open the upload with the title as `name`, or set it with `PUT /api/vod/{id}` or in the Media Library |
| `ingest` is `awaiting_metadata` | Your content type requires fields that were not sent | Send them in `metadata`, or fill them in the Media Library |
