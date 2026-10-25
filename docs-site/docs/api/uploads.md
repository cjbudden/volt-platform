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
  "title": "evening-news.mp4"
}
{"id":"a8a7a279-5773-4027-a60f-bb5a9721f90b","title":"Evening news, 24 October"}
```

**Opening** (`POST /api/uploads`) takes:

| Field | Means |
|---|---|
| `purpose` | `vod` for the Media Library, `filler` for Loops & Fillers |
| `fillerKind` | For `filler`: `loop` (the default) or `slate` |
| `name`, `filename` | The upload's label, and the file's own name |
| `totalBytes` | The exact size. Up to the limit `GET /api/uploads` reports as `maxBytes` |
| `contentType` | The media type, such as `video/mp4` |
| `schemaId` | The content type, when you know it up front |
| `metadata` | Values for the content type's fields. Values for fields the content type does not have are left out, and with no content type nothing is kept |
| `ladderGroupId` | The encoding profile for `vod`. Leave it out for the account's default at the time the file is encoded |

The asset starts with the file's name as its title (or the content type's title field, when it has one and you filled it). Set the real title afterwards with `PUT /api/vod/{id}`, as step 4 does.

The answer to opening has the session `id`, its `token`, `chunkSize`, `chunkCount`, what has been received and what is `missing`, and `expiresAt`. The session's `assetId` is already reserved, so you can store it straight away.

**The token** belongs to this upload only: it can send chunks and finish, nothing else, and it ends with the session. Hand it to whatever sends the bytes (a worker, a browser) without sharing your secret key.

**Chunks** are `PUT /api/uploads/{id}/chunks/{index}`, numbered from 0, each exactly `chunkSize` bytes except the last. Sending a chunk again is harmless.

**Finish** checks every chunk arrived, puts the file together and answers with its SHA-256 (compare it with your own) and what the ingest rules decided: `ingested`, or held as a `duplicate`, `awaiting_metadata` or `quarantined`. Finishing twice is harmless. A [webhook](webhooks.md) can tell your system the same thing.

### 2. Resume after a dropped connection

```bash file=uploads/resume.sh
```

```json
{ "state": "open", "chunkCount": 2, "missing": [0, 1] }
```

Send just the chunks in `missing`, then finish. `GET /api/uploads` lists your own sessions you can still resume, with their tokens, and `DELETE /api/uploads/{id}` abandons one.

Volt also accepts resumable uploads in the open tus protocol at `/api/tus`, for tools that already speak it.

## Troubleshooting

| Response | Means | Do |
|---|---|---|
| `401 That upload token is not valid.` | The session finished, expired or was abandoned, or the token was mistyped | Open a new session |
| `403 That token does not belong to this upload.` | The token is another upload's | Use the token that came with this session |
| `400` on a chunk | The chunk is empty, or not the size it should be | Send exactly `chunkSize` bytes (the last chunk is the rest) |
| `409` on finish, with `missing` | Some chunks never arrived | Send the chunks listed, then finish again |
| The asset is named after the file | That is where every upload starts | Set the title with `PUT /api/vod/{id}`, or in the Media Library |
| `ingest` is `awaiting_metadata` | Your content type requires fields that were not sent | Send them in `metadata`, or fill them in the Media Library |
