# Volt Streaming — API Reference

Control-plane REST API. All routes are **Bearer-auth (JWT)** and tenant-scoped by the token's `account_id`, except `/health` (none) and the encoder/thumbnailer ingest routes which use the **`X-Volt-Ingest-Token`** header.

A Postman collection (`api/Volt.postman_collection.json`) + environment mirror this file, each request carrying a **saved example response** captured from a live run. `docs/api-playground.html` is a searchable request/response scratch pad of the same data. Regenerate everything with `api/capture_api.sh`.

## Health

### `GET` `/health`
Liveness probe.  
*Auth: public*  

**Example response — `200`**
```json
{
  "ok": true,
  "service": "volt-control-plane"
}
```

## Metadata Schemas

### `GET` `/api/metadata-schemas`
Named, typed metadata field sets for VOD assets.  
*Auth: JWT*  

**Example response — `200`**
```json
[]
```

### `POST` `/api/metadata-schemas`
Create a metadata schema. Fields: string|text|number|boolean|date|enum|url|tags.  
*Auth: JWT*  

**Request body**
```json
{
  "name": "Match {{$timestamp}}",
  "fields": [
    {
      "key": "competition",
      "type": "string",
      "required": true
    },
    {
      "key": "sport",
      "type": "string"
    },
    {
      "key": "rating",
      "type": "enum",
      "options": [
        "G",
        "PG",
        "M"
      ]
    }
  ]
}
```

**Example response — `201`**
```json
{
  "id": "867623d9-fac2-4496-8c9d-7ed7193b06e0",
  "account_id": "00000000-0000-0000-0000-0000000000a1",
  "name": "Match 1730000000",
  "description": null,
  "fields": [
    {
      "key": "competition",
      "type": "string",
      "required": true
    },
    {
      "key": "sport",
      "type": "string"
    },
    {
      "key": "rating",
      "type": "enum",
      "options": [
        "G",
        "PG",
        "M"
      ]
    }
  ],
  "created_at": "2026-08-02T14:24:12.122Z",
  "updated_at": "2026-08-02T14:24:12.122Z"
}
```

## Channels

### `GET` `/api/channels`
Channels for the tenant.  
*Auth: JWT*  

**Example response — `200`**
```json
[
  {
    "id": "00000000-0000-0000-0000-0000000000c1",
    "group_id": "00000000-0000-0000-0000-0000000000b1",
    "name": "api-news",
    "status": "scheduled",
    "enabled": true,
    "purchasing_mode": "reserved",
    "resilience_tier": "standard",
    "input_failover_enabled": false,
    "auto_failback": true,
    "input_loss_behavior": "none",
    "filler_asset_id": null,
    "filler_slate_ref": null,
    "recording_retention_days": null,
    "created_at": "2026-08-02T14:24:09.856Z",
    "updated_at": "2026-08-02T14:24:09.856Z",
    "group_name": "g"
  }
]
```

### `GET` `/api/channels/{{channelId}}`
One channel + its inputs & instances.  
*Auth: JWT*  

**Example response — `200`**
```json
{
  "id": "00000000-0000-0000-0000-0000000000c1",
  "group_id": "00000000-0000-0000-0000-0000000000b1",
  "name": "api-news",
  "status": "scheduled",
  "enabled": true,
  "purchasing_mode": "reserved",
  "resilience_tier": "standard",
  "input_failover_enabled": false,
  "auto_failback": true,
  "input_loss_behavior": "none",
  "filler_asset_id": null,
  "filler_slate_ref": null,
  "recording_retention_days": null,
  "created_at": "2026-08-02T14:24:09.856Z",
  "updated_at": "2026-08-02T14:24:09.856Z",
  "inputs": [],
  "instances": []
}
```

### `POST` `/api/channels/{{channelId}}/start`
Orchestrator launches the encoder task + opens a recording.  
*Auth: JWT*  

**Request body**
```json
{}
```

**Example response — `200`**
```json
{
  "id": "00000000-0000-0000-0000-0000000000c1",
  "group_id": "00000000-0000-0000-0000-0000000000b1",
  "name": "api-news",
  "status": "live",
  "enabled": true,
  "purchasing_mode": "reserved",
  "resilience_tier": "standard",
  "input_failover_enabled": false,
  "auto_failback": true,
  "input_loss_behavior": "none",
  "filler_asset_id": null,
  "filler_slate_ref": null,
  "recording_retention_days": null,
  "created_at": "2026-08-02T14:24:09.856Z",
  "updated_at": "2026-08-02T14:24:12.151Z"
}
```

### `POST` `/api/channels/{{channelId}}/stop`
Terminates the task, closes the recording, fires the thumbnailer.  
*Auth: JWT*  

**Request body**
```json
{}
```

**Example response — `200`**
```json
{
  "id": "00000000-0000-0000-0000-0000000000c1",
  "group_id": "00000000-0000-0000-0000-0000000000b1",
  "name": "api-news",
  "status": "ended",
  "enabled": true,
  "purchasing_mode": "reserved",
  "resilience_tier": "standard",
  "input_failover_enabled": false,
  "auto_failback": true,
  "input_loss_behavior": "none",
  "filler_asset_id": null,
  "filler_slate_ref": null,
  "recording_retention_days": null,
  "created_at": "2026-08-02T14:24:09.856Z",
  "updated_at": "2026-08-02T14:24:12.167Z"
}
```

## Events

### `GET` `/api/events`
Events for the tenant.  
*Auth: JWT*  

**Example response — `200`**
```json
[]
```

### `POST` `/api/events`
Schedule an event; the orchestrator provisions it at server_start.  
*Auth: JWT*  

**Request body**
```json
{
  "groupId": "{{groupId}}",
  "name": "Test Event",
  "scheduledStart": "2027-01-01T10:00:00Z",
  "scheduledEnd": "2027-01-01T12:00:00Z",
  "recordingRetentionDays": 14
}
```

**Example response — `201`**
```json
{
  "id": "6d3c65d7-419c-4c56-876d-2f9aa0355c4c",
  "group_id": "00000000-0000-0000-0000-0000000000b1",
  "name": "Test Event",
  "status": "scheduled",
  "scheduled_start": "2027-01-01T10:00:00.000Z",
  "scheduled_end": "2027-01-01T12:00:00.000Z",
  "server_start": "2027-01-01T10:00:00.000Z",
  "server_stop": "2027-01-01T12:00:00.000Z",
  "public_start": "2027-01-01T10:00:00.000Z",
  "public_end": "2027-01-01T12:00:00.000Z",
  "actual_start": null,
  "actual_end": null,
  "purchasing_mode": "spot_fallback",
  "resilience_tier": "standard",
  "input_failover_enabled": false,
  "auto_failback": true,
  "input_loss_behavior": "none",
  "filler_asset_id": null,
  "filler_slate_ref": null,
  "recording_retention_days": 14,
  "created_at": "2026-08-02T14:24:12.179Z",
  "updated_at": "2026-08-02T14:24:12.179Z"
}
```

## Live Timeline

### `GET` `/api/scheduled-clips?channelId={{channelId}}`
Clipping windows on the live timeline.  
*Auth: JWT*  

**Example response — `200`**
```json
[]
```

### `POST` `/api/scheduled-clips`
When end_epoch_ms is reached the orchestrator cuts a VOD asset. outputKind: manifest|progressive|both.  
*Auth: JWT*  

**Request body**
```json
{
  "channelId": "{{channelId}}",
  "title": "Scheduled highlight",
  "startMs": 1000,
  "endMs": 6000,
  "outputKind": "both"
}
```

**Example response — `201`**
```json
{
  "id": "21ff386c-4715-4de0-88cd-2065a545917d",
  "channel_id": "00000000-0000-0000-0000-0000000000c1",
  "event_id": null,
  "title": "Scheduled highlight",
  "start_epoch_ms": "1000",
  "end_epoch_ms": "6000",
  "output_kind": "both",
  "status": "scheduled",
  "vod_asset_id": null,
  "created_at": "2026-08-02T14:24:12.190Z"
}
```

### `DELETE` `/api/scheduled-clips/{{scheduledClipId}}`
Cancel while still scheduled.  
*Auth: JWT*  

**Example response — `204`**
```json

```

## Recordings

### `GET` `/api/recordings`
Filter by ?kind=channel_day|event & ?channelId=.  
*Auth: JWT*  

**Example response — `200`**
```json
[
  {
    "id": "a95a6c38-08fb-4578-96fc-46696207884c",
    "kind": "channel_day",
    "event_id": null,
    "channel_id": "00000000-0000-0000-0000-0000000000c1",
    "title": null,
    "day_utc": "2026-08-02T00:00:00.000Z",
    "status": "complete",
    "hi_res_rendition": "source",
    "master_key": "channel/00000000-0000-0000-0000-0000000000c1/2026-08-02",
    "start_epoch_ms": "1785680652151",
    "end_epoch_ms": "1785680652164",
    "duration_ms": "13",
    "retention_days": null,
    "expires_at": null,
    "poster_key": null,
    "storyboard_key": null,
    "thumbs_vtt_key": null,
    "thumb_status": "processing",
    "created_at": "2026-08-02T14:24:12.151Z",
    "source_name": "api-news",
    "vod_count": 0
  },
  {
    "id": "00000000-0000-0000-0000-0000000000e1",
    "kind": "channel_day",
    "event_id": null,
    "channel_id": "00000000-0000-0000-0000-0000000000c1",
    "title": null,
    "day_utc": "2026-07-30T00:00:00.000Z",
    "status": "complete",
    "hi_res_rendition": "1080p",
    "master_key": "channel/00000000-0000-0000-0000-0000000000c1",
    "start_epoch_ms": "0",
    "end_epoch_ms": "1785680652164",
    "duration_ms": "1785680652164",
    "retention_days": null,
    "expires_at": null,
    "poster_key": null,
    "storyboard_key": null,
    "thumbs_vtt_key": null,
    "thumb_status": "processing",
    "created_at": "2026-08-02T14:24:09.859Z",
    "source_name": "api-news",
    "vod_count": 0
  }
]
```

### `GET` `/api/recordings/channels`
Channels with recording counts + next expiry.  
*Auth: JWT*  

**Example response — `200`**
```json
[
  {
    "channel_id": "00000000-0000-0000-0000-0000000000c1",
    "name": "api-news",
    "recording_retention_days": null,
    "recording_count": 2,
    "last_recording_ms": "1785680652151",
    "next_expiry": null
  }
]
```

### `GET` `/api/recordings/{{recordingId}}`
One recording + its derived VOD assets.  
*Auth: JWT*  

**Example response — `200`**
```json
{
  "id": "00000000-0000-0000-0000-0000000000e1",
  "kind": "channel_day",
  "event_id": null,
  "channel_id": "00000000-0000-0000-0000-0000000000c1",
  "title": null,
  "day_utc": "2026-07-30T00:00:00.000Z",
  "status": "complete",
  "hi_res_rendition": "1080p",
  "master_key": "channel/00000000-0000-0000-0000-0000000000c1",
  "start_epoch_ms": "0",
  "end_epoch_ms": "1785680652164",
  "duration_ms": "1785680652164",
  "retention_days": null,
  "expires_at": null,
  "poster_key": null,
  "storyboard_key": null,
  "thumbs_vtt_key": null,
  "thumb_status": "processing",
  "created_at": "2026-08-02T14:24:09.859Z",
  "vod_assets": []
}
```

### `POST` `/api/recordings/{{recordingId}}/clip`
Create a VOD from a time range. outputKind sets HLS/DASH and/or progressive MP4.  
*Auth: JWT*  

**Request body**
```json
{
  "title": "Manual clip",
  "startMs": 1000,
  "endMs": 9000,
  "outputKind": "both"
}
```

**Example response — `201`**
```json
{
  "id": "23360d6a-32a0-494d-a2ed-14e9e34fba41",
  "event_id": null,
  "channel_id": "00000000-0000-0000-0000-0000000000c1",
  "recording_id": "00000000-0000-0000-0000-0000000000e1",
  "kind": "clip",
  "title": "Manual clip",
  "master_key": "channel/00000000-0000-0000-0000-0000000000c1/clip-1000-9000/master.m3u8",
  "start_epoch_ms": "1000",
  "end_epoch_ms": "9000",
  "duration_ms": "8000",
  "export_mp4_key": null,
  "output_kind": "both",
  "progressive_key": "channel/00000000-0000-0000-0000-0000000000c1/clip-1000-9000/progressive.mp4",
  "formats": {
    "hls": true,
    "dash": true,
    "progressive": true
  },
  "portal_visible": false,
  "clip_spec": null,
  "schema_id": null,
  "metadata": {},
  "poster_key": null,
  "storyboard_key": null,
  "thumbs_vtt_key": null,
  "thumb_status": "processing",
  "published": false,
  "created_at": "2026-08-02T14:24:12.217Z",
  "updated_at": "2026-08-02T14:24:12.217Z"
}
```

### `GET` `/api/recordings/{{recordingId}}/download`
Presigned MP4 URL (202 while exporting).  
*Auth: JWT*  

**Example response — `202`**
```json
{
  "status": "exporting",
  "message": "MP4 export queued; poll this endpoint until a url is returned."
}
```

## VOD

### `GET` `/api/vod`
Derived assets. ?published=true|false.  
*Auth: JWT*  

**Example response — `200`**
```json
[
  {
    "id": "23360d6a-32a0-494d-a2ed-14e9e34fba41",
    "event_id": null,
    "channel_id": "00000000-0000-0000-0000-0000000000c1",
    "recording_id": "00000000-0000-0000-0000-0000000000e1",
    "kind": "clip",
    "title": "Manual clip",
    "master_key": "channel/00000000-0000-0000-0000-0000000000c1/clip-1000-9000/master.m3u8",
    "start_epoch_ms": "1000",
    "end_epoch_ms": "9000",
    "duration_ms": "8000",
    "export_mp4_key": null,
    "output_kind": "both",
    "progressive_key": "channel/00000000-0000-0000-0000-0000000000c1/clip-1000-9000/progressive.mp4",
    "formats": {
      "hls": true,
      "dash": true,
      "progressive": true
    },
    "portal_visible": false,
    "clip_spec": null,
    "schema_id": null,
    "metadata": {},
    "poster_key": null,
    "storyboard_key": null,
    "thumbs_vtt_key": null,
    "thumb_status": "processing",
    "published": false,
    "created_at": "2026-08-02T14:24:12.217Z",
    "updated_at": "2026-08-02T14:24:12.217Z",
    "schema_name": null,
    "source_name": "api-news"
  }
]
```

### `GET` `/api/vod/{{vodId}}`
Asset + assigned schema + publications + schema.org JSON-LD.  
*Auth: JWT*  

**Example response — `200`**
```json
{
  "id": "23360d6a-32a0-494d-a2ed-14e9e34fba41",
  "event_id": null,
  "channel_id": "00000000-0000-0000-0000-0000000000c1",
  "recording_id": "00000000-0000-0000-0000-0000000000e1",
  "kind": "clip",
  "title": "Manual clip",
  "master_key": "channel/00000000-0000-0000-0000-0000000000c1/clip-1000-9000/master.m3u8",
  "start_epoch_ms": "1000",
  "end_epoch_ms": "9000",
  "duration_ms": "8000",
  "export_mp4_key": null,
  "output_kind": "both",
  "progressive_key": "channel/00000000-0000-0000-0000-0000000000c1/clip-1000-9000/progressive.mp4",
  "formats": {
    "hls": true,
    "dash": true,
    "progressive": true
  },
  "portal_visible": false,
  "clip_spec": null,
  "schema_id": null,
  "metadata": {},
  "poster_key": null,
  "storyboard_key": null,
  "thumbs_vtt_key": null,
  "thumb_status": "processing",
  "published": false,
  "created_at": "2026-08-02T14:24:12.217Z",
  "updated_at": "2026-08-02T14:24:12.217Z",
  "schema": null,
  "publications": [],
  "jsonld": {
    "@context": "https://schema.org",
    "@type": "Clip",
    "@id": "http://localhost:8080/api/vod/23360d6a-32a0-494d-a2ed-14e9e34fba41",
    "name": "Manual clip",
    "uploadDate": "2026-08-02T14:24:12.217Z",
    "duration": "PT8S",
    "contentUrl": "https://cdn.example.com/channel/00000000-0000-0000-0000-0000000000c1/clip-1000-9000/progressive.mp4",
    "embedUrl": "https://cdn.example.com/portal/watch/23360d6a-32a0-494d-a2ed-14e9e34fba41",
    "isLiveBroadcast": false,
    "associatedMedia": [
      {
        "@type": "MediaObject",
        "encodingFormat": "application/vnd.apple.mpegurl",
        "c
… (truncated)
```

### `PUT` `/api/vod/{{vodId}}`
Set title/metadata (validated vs the assigned schema) & published.  
*Auth: JWT*  

**Request body**
```json
{
  "title": "Manual clip (tagged)",
  "schemaId": "{{schemaId}}",
  "metadata": {
    "competition": "Grand Final",
    "rating": "PG"
  }
}
```

**Example response — `200`**
```json
{
  "id": "23360d6a-32a0-494d-a2ed-14e9e34fba41",
  "event_id": null,
  "channel_id": "00000000-0000-0000-0000-0000000000c1",
  "recording_id": "00000000-0000-0000-0000-0000000000e1",
  "kind": "clip",
  "title": "Manual clip (tagged)",
  "master_key": "channel/00000000-0000-0000-0000-0000000000c1/clip-1000-9000/master.m3u8",
  "start_epoch_ms": "1000",
  "end_epoch_ms": "9000",
  "duration_ms": "8000",
  "export_mp4_key": null,
  "output_kind": "both",
  "progressive_key": "channel/00000000-0000-0000-0000-0000000000c1/clip-1000-9000/progressive.mp4",
  "formats": {
    "hls": true,
    "dash": true,
    "progressive": true
  },
  "portal_visible": false,
  "clip_spec": null,
  "schema_id": "867623d9-fac2-4496-8c9d-7ed7193b06e0",
  "metadata": {
    "rating": "PG",
    "competition": "Grand Final"
  },
  "poster_key": null,
  "storyboard_key": null,
  "thumbs_vtt_key": null,
  "thumb_status": "processing",
  "published": false,
  "created_at": "2026-08-02T14:24:12.217Z",
  "updated_at": "2026-08-02T14:24:12.236Z"
}
```

### `GET` `/api/vod/{{vodId}}/schema.org`
JSON-LD for the portal / SEO / social metadata.  
*Auth: JWT*  

**Example response — `200`**
```json
{
  "@context": "https://schema.org",
  "@type": "Clip",
  "@id": "http://localhost:8080/api/vod/23360d6a-32a0-494d-a2ed-14e9e34fba41",
  "name": "Manual clip (tagged)",
  "uploadDate": "2026-08-02T14:24:12.217Z",
  "duration": "PT8S",
  "contentUrl": "https://cdn.example.com/channel/00000000-0000-0000-0000-0000000000c1/clip-1000-9000/progressive.mp4",
  "embedUrl": "https://cdn.example.com/portal/watch/23360d6a-32a0-494d-a2ed-14e9e34fba41",
  "isLiveBroadcast": false,
  "associatedMedia": [
    {
      "@type": "MediaObject",
      "encodingFormat": "application/vnd.apple.mpegurl",
      "contentUrl": "https://cdn.example.com/channel/00000000-0000-0000-0000-0000000000c1/clip-1000-9000/master.m3u8"
    },
    {
      "@type": "MediaObject",
      "encodingFormat": "application/dash+xml",
      "contentUrl": "https://cdn.example.com/channel/00000000-0000-0000-0000-0000000000c1/clip-1000-9000/manifest.mpd"
    },
    {
      "@type": "MediaObject",
      "encodingFormat": "video/mp4",
      "contentUrl": "https://cdn.example.com/channel/00000000-0000-0000-0000-0000000000c1/clip-1000-9000/progressive.mp4"
    }
  ],
  "startOffset": 1,
  "endOffset": 9,
  "potentialAction": {
    "@type": "WatchAction",
    "target": "https://cdn.example.com/portal/watch/23360d6a-32a0-494d-a2ed-14e9e34fba41"
  }
}
```

## Slates & Loops

### `GET` `/api/filler-assets`
Uploaded slate/loop assets.  
*Auth: JWT*  

**Example response — `200`**
```json
[]
```

### `POST` `/api/filler-assets`
Register + get a presigned upload URL.  
*Auth: JWT*  

**Request body**
```json
{
  "kind": "slate",
  "name": "Test slate"
}
```

**Example response — `201`**
```json
{
  "id": "401a534d-1e68-4e26-ad85-24afdf1d0f3c",
  "account_id": "00000000-0000-0000-0000-0000000000a1",
  "kind": "slate",
  "name": "Test slate",
  "source_key": "filler/00000000-0000-0000-0000-0000000000a1/401a534d-1e68-4e26-ad85-24afdf1d0f3c",
  "width": null,
  "height": null,
  "duration_ms": null,
  "poster_key": null,
  "status": "uploading",
  "created_at": "2026-08-02T14:24:12.248Z",
  "updated_at": "2026-08-02T14:24:12.248Z",
  "upload": {
    "method": "PUT",
    "url": "https://volt-origin.s3.ap-southeast-1.amazonaws.com/filler/00000000-0000-0000-0000-0000000000a1/401a534d-1e68-4e26-ad85-24afdf1d0f3c"
  }
}
```

### `DELETE` `/api/filler-assets/{{fillerId}}`
Remove a filler asset.  
*Auth: JWT*  

**Example response — `204`**
```json

```

## Distribution

### `GET` `/api/publish-targets`
Configured social accounts.  
*Auth: JWT*  

**Example response — `200`**
```json
[]
```

### `POST` `/api/publish-targets`
platform: youtube|facebook|x|tiktok|dailymotion|portal.  
*Auth: JWT*  

**Request body**
```json
{
  "platform": "youtube",
  "name": "RTM YouTube",
  "externalAccount": "UC_rtm"
}
```

**Example response — `201`**
```json
{
  "id": "f23465cd-57d4-4a40-a0b7-85906c84fcd0",
  "platform": "youtube",
  "name": "RTM YouTube",
  "external_account": "UC_rtm",
  "enabled": true
}
```

### `POST` `/api/publications/vod/{{vodId}}/publish`
Make portal-visible + create a publication record.  
*Auth: JWT*  

**Request body**
```json
{
  "platform": "portal"
}
```

**Example response — `201`**
```json
{
  "id": "9b9f9245-090f-47d4-bb26-f914eca591a4",
  "vod_asset_id": "23360d6a-32a0-494d-a2ed-14e9e34fba41",
  "platform": "portal",
  "target_id": null,
  "external_id": null,
  "external_url": "/portal/watch/23360d6a-32a0-494d-a2ed-14e9e34fba41",
  "status": "published",
  "views": "0",
  "error": null,
  "published_at": "2026-08-02T14:24:12.275Z",
  "last_synced_at": null,
  "created_at": "2026-08-02T14:24:12.275Z"
}
```

### `POST` `/api/publications/vod/{{vodId}}/publish`
Push to a linked social account (adapter). Tracks external id/url + views.  
*Auth: JWT*  

**Request body**
```json
{
  "platform": "youtube",
  "targetId": "{{targetId}}"
}
```

**Example response — `201`**
```json
{
  "id": "3698c8ba-2212-48f8-8882-dc3ae8a31d47",
  "vod_asset_id": "23360d6a-32a0-494d-a2ed-14e9e34fba41",
  "platform": "youtube",
  "target_id": "f23465cd-57d4-4a40-a0b7-85906c84fcd0",
  "external_id": "stub-3698c8ba",
  "external_url": "https://youtube.example/watch/3698c8ba",
  "status": "published",
  "views": "0",
  "error": null,
  "published_at": "2026-08-02T14:24:12.288Z",
  "last_synced_at": null,
  "created_at": "2026-08-02T14:24:12.285Z"
}
```

### `GET` `/api/publications?assetId={{vodId}}`
Per-asset publications + synced view counts.  
*Auth: JWT*  

**Example response — `200`**
```json
[
  {
    "id": "3698c8ba-2212-48f8-8882-dc3ae8a31d47",
    "vod_asset_id": "23360d6a-32a0-494d-a2ed-14e9e34fba41",
    "platform": "youtube",
    "target_id": "f23465cd-57d4-4a40-a0b7-85906c84fcd0",
    "external_id": "stub-3698c8ba",
    "external_url": "https://youtube.example/watch/3698c8ba",
    "status": "published",
    "views": "0",
    "error": null,
    "published_at": "2026-08-02T14:24:12.288Z",
    "last_synced_at": null,
    "created_at": "2026-08-02T14:24:12.285Z",
    "target_name": "RTM YouTube"
  },
  {
    "id": "9b9f9245-090f-47d4-bb26-f914eca591a4",
    "vod_asset_id": "23360d6a-32a0-494d-a2ed-14e9e34fba41",
    "platform": "portal",
    "target_id": null,
    "external_id": null,
    "external_url": "/portal/watch/23360d6a-32a0-494d-a2ed-14e9e34fba41",
    "status": "published",
    "views": "0",
    "error": null,
    "published_at": "2026-08-02T14:24:12.275Z",
    "last_synced_at": null,
    "created_at": "2026-08-02T14:24:12.275Z",
    "target_name": null
  }
]
```

### `POST` `/api/publications/sync-views`
Pull latest view counts from platforms (adapter).  
*Auth: JWT*  

**Request body**
```json
{}
```

**Example response — `200`**
```json
{
  "synced": 2
}
```

## Status

### `POST` `/api/streams/{{channelId}}/report`
The encoder posts events + status snapshots (ingest-token auth).  
*Auth: Ingest-Token*  

**Request body**
```json
{
  "kind": "channel",
  "event": {
    "ts_ms": 1730000000000,
    "seq": 1,
    "type": "channel.start",
    "detail": {}
  },
  "status": {
    "output_available": true,
    "active_source": "primary",
    "fallback_in_use": false,
    "filler_in_use": false,
    "packager_ok": true,
    "sources": {
      "primary": {
        "state": "up"
      }
    },
    "seq": 1
  }
}
```

**Example response — `202`**
```json
{
  "ok": true
}
```

### `GET` `/api/status`
Latest status per stream (dashboard poll).  
*Auth: JWT*  

**Example response — `200`**
```json
[
  {
    "channel_id": "00000000-0000-0000-0000-0000000000c1",
    "event_id": null,
    "output_available": true,
    "active_source": "primary",
    "fallback_in_use": false,
    "filler_in_use": false,
    "packager_ok": true,
    "sources": {
      "primary": {
        "state": "up"
      }
    },
    "updated_at": "2026-08-02T14:24:12.307Z",
    "name": "api-news"
  }
]
```

### `GET` `/api/status/channel/{{channelId}}`
One stream snapshot.  
*Auth: JWT*  

**Example response — `200`**
```json
{
  "id": "df12fa1f-ad5c-4689-a498-72e68915cb58",
  "event_id": null,
  "channel_id": "00000000-0000-0000-0000-0000000000c1",
  "output_available": true,
  "active_source": "primary",
  "fallback_in_use": false,
  "filler_in_use": false,
  "packager_ok": true,
  "sources": {
    "primary": {
      "state": "up"
    }
  },
  "last_seq": "1",
  "updated_at": "2026-08-02T14:24:12.307Z"
}
```

### `GET` `/api/status/channel/{{channelId}}/events`
Per-stream event log.  
*Auth: JWT*  

**Example response — `200`**
```json
[
  {
    "id": "1",
    "seq": "1",
    "type": "channel.start",
    "detail": {},
    "ts": "2024-10-27T03:33:20.000Z"
  }
]
```
