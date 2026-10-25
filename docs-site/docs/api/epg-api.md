---
title: Guide import (XMLTV) and the EPG API
sidebar_position: 8
description: Push programmes from your scheduling system, import XMLTV guides, map their channels, and export your guide as XMLTV.
guide: developer
---

# Guide import (XMLTV) and the EPG API

The programme guide (EPG) drives a lot of Volt: what viewers see in the player's schedule, when recordings start, what is published afterwards and where rights windows apply. You can fill it from your own scheduling system through the API, or import XMLTV files and feeds, and you can hand the finished guide to anyone who reads XMLTV.

## What it is for

- **Your scheduling or traffic system is the master.** Push each programme as it is planned or changed; Volt keeps one copy per programme.
- **A guide supplier or partner sends XMLTV.** Upload a file, or let Volt fetch a feed on a schedule.
- **Set-top boxes, guide partners and your website** read your guide as XMLTV, or as JSON for now and next.

The console side of all this is the [EPG guide](../guides/epg.md); [the guide drives recording and publishing](../workflows/epg-record-publish.md) shows what the guide sets in motion.

## Before you start

- An account secret key, or an admin user with **EPG: Manage** (imports and changes) or **EPG: View** (reading). See [Getting started with apps and keys](apps-and-keys.md).
- The ids of your channels (`GET /api/epg/channels` lists them with their XMLTV ids).
- Times are ISO 8601 in UTC (`2027-03-01T07:00:00Z`).

## Step by step

### 1. Push programmes from your own system

```bash file=epg/push-programmes.sh
```

```json
{"id":"02fece95-...","title":"Morning News","ends_at":"2027-03-01T08:00:00.000Z","conflicts":0}
{"id":"02fece95-...","title":"Morning News (extended)","ends_at":"2027-03-01T08:30:00.000Z","conflicts":0}
[{"title":"Morning News (extended)","starts_at":"2027-03-01T07:00:00.000Z","ends_at":"2027-03-01T08:30:00.000Z"}]
```

- **`sourceRef` is your own id** for the programme. Sending the same one again updates that programme (title, times, metadata) instead of adding a second, so you can re-send your whole schedule safely.
- Leave out `endsAt` and the programme runs until the next one starts (or for an hour).
- `conflicts` lists programmes it overlaps. Overlaps are allowed, so check this.
- Other fields: `metadata` (description, images, genre and the rest), `autoVod` (publish it on demand after it airs), `geoMode` and `geoCountries`, and `replacementKind` with `replacementRef` for a rights window. Use `eventId` instead of `channelId` for an event's guide.
- `PATCH /api/epg/{id}` changes one programme and `DELETE /api/epg/{id}` removes it.

### 2. Read now and next

```bash file=epg/now-next.sh
```

For a viewer-facing app, use the public guide with the publishable key instead: see [What is on now in your app](recipes.md#what-is-on-now-in-your-app).

### 3. Import an XMLTV file

```xml file=epg/guide.xml
```

```bash file=epg/import-xmltv.sh
```

```json
{"id":"0000000e-...","xmltvId":"news.example.com","xmltvIdSet":true}
{"status":"warnings","programmes":3,"inserted":2,"unmapped":1,"warnings":["1 channel(s) in the feed are waiting for you to choose: use them on a Volt channel or mark them not used (Channels in this source). Their 1 programme(s) were skipped: Example Radio"]}
[{"externalId":"news.example.com","state":"used","channelName":"Example News","mappedBy":"auto:xmltv_id"},{"externalId":"radio.example.com","state":"waiting","channelName":null,"mappedBy":null}]
```

A channel in the file whose id matches a Volt channel's XMLTV id is mapped by itself. Any other waits for you, and its programmes are skipped until you decide. The answer's `counts` also say how many programmes were updated, unchanged, removed, too old, too far ahead or had a bad time.

**A feed instead of a file:** create the source with `"kind":"url"`, its `url` and `refreshHours`; Volt fetches it on that schedule. `POST /api/epg/import/sources/{id}/test` tries the address without importing, `/run` imports now, and `/runs` lists past imports with their counts.

### 4. Map a channel by hand

```bash file=epg/map-channel.sh
```

```json
{"state":"used","channelId":"0000000e-..."}
{"status":"ok","inserted":1,"unmapped":0}
```

`{"ignored": true}` instead marks a channel in the file as not used, so it stops waiting. `POST /api/epg/import/sources/{id}/channels/bulk` decides many at once, including creating a Volt channel for each.

### 5. Export your guide as XMLTV

```bash file=epg/export-xmltv.sh
```

`channelId` takes one id or several (comma separated); leave it out for every channel. `from` and `to` set the window, `includeEvents=true` adds your events, and `download=0` returns the file inline instead of as a download. To give a partner a guide of their own without a Volt login, make an XMLTV feed in **EPG** (`/api/epg/xmltv/feeds`): it has its own address and key, which you can rotate.

## Troubleshooting

| You see | Means | Do |
|---|---|---|
| `400 channelId or eventId required` | The programme names neither | Send one of them |
| `404 Owner not found` | The channel or event is not in your account | Check the id |
| `400 endsAt must be after startsAt` | The times are the wrong way round, or equal | Fix the times |
| Programmes added twice | They were sent without `sourceRef`, or with a different one | Always send your own id as `sourceRef` |
| Import `warnings` with channels waiting | The file has channels Volt could not match | Set the XMLTV id on the channel, or map them (step 4) |
| `400 Send the XMLTV file itself as the request body` | The file was sent as a form or JSON | Send it with `--data-binary` and `Content-Type: application/xml` (or `application/gzip`) |
| `409 This source is already importing` | Another import of the same source is running | Wait for it, then try again |
| Times an hour or more out | The file has times without an offset | Give the source a `fallbackTz` such as `Australia/Sydney` |
