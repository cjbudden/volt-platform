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

---

## Image Service

On-the-fly image rendering (resize / crop / format / filter) for account media: poster art,
thumbnails, channel logos, slate stills, portal artwork. One source image is stored once,
every derivative (size, crop, format) is produced on request from a URL and then cached, so
you never pre-generate or store variants. Built on `sharp` (libvips).

The service has two surfaces:

1. A **control-plane method** (`POST /api/images/sign`, JWT) that turns a set of transform
   options into a signed, ready-to-use URL. Backend and app callers use this so they never
   compute the HMAC themselves.
2. A **public render endpoint** (signed URL grammar, no JWT) that the browser / CDN hits to
   get the actual image bytes. In production this is served at the image host / CloudFront in
   front of an S3 derivative cache; in local dev it is the image service process.

> **Build status (12 Aug 2026): prototype, not yet mounted in the control plane at `:8080`.**
> The URL grammar, signing and render pipeline are proven in the `volt-image-proto` prototype
> (14/14 tests, cache HIT ~1.4ms vs ~150ms cold render). The endpoints below are the agreed
> contract. They are documented and shipped in the Postman collection now (folder **Image
> Service**, pointed at `{{imgBase}}`) so the interface can be reviewed and frozen. Mounting
> `src/modules/images.ts` into volt-app so `POST /api/images/sign` answers on `:8080` and the
> render endpoint runs locally is the next build step; the `api/verify.sh` assertions are added
> at that point.

### URL grammar (render endpoint)

```
{imgBase}/{sig}/{fit}/{WxH}/filter(<f1>,<f2>,...)/{path}
```

The `filter(...)` segment is optional. `{path}` is the source object key, scoped to the
caller's account prefix. Example (signed):

```
https://img.volt.example/Q3k9_2ba8Xr/fit-in/1280x720/filter(format:webp,quality:82,sharpen:60)/posters/grand-final.jpg
```

Example (dev only, signing disabled):

```
http://localhost:8090/unsafe/fill/640x360/filter(focus:smart,format:webp)/posters/grand-final.jpg
```

### Path parameters

| Segment | Required | Values | Purpose |
|---|---|---|---|
| `sig` | yes (prod) | base64url HMAC-SHA256 of the canonical path, or the literal `unsafe` in dev | Prevents callers requesting arbitrary size/filter combos (cost / DoS control). `unsafe` is rejected unless the service runs with `IMG_ALLOW_UNSAFE=1`. |
| `fit` | yes | `fit-in` \| `fill` \| `stretch` | `fit-in`: scale to fit inside WxH, keep aspect, no crop. `fill`: cover the box then crop, crop anchored by `focus`. `stretch`: force exact WxH, may distort. |
| `WxH` | yes | `1280x720` (exact), `1280x0` (width, auto height), `0x720` (height, auto width) | Target box. A `0` on one axis means "derive from aspect ratio". Both axes are bounded by the max-dimension guard. |
| `filter(...)` | no | comma-separated list, see below | Post-resize operations. Order is normalised into the cache key. |
| `path` | yes | source object key, e.g. `posters/grand-final.jpg` | Resolved against the account's S3 origin prefix. |

### Filters

| Filter | Argument | Notes |
|---|---|---|
| `format:` | `webp` \| `avif` \| `jpeg` \| `png` | Output encoding. Omitted: keep source format (or content-negotiate webp/avif if `Accept` allows). |
| `quality:` | `1`–`100` | Encoder quality. Default 82. Ignored for `png`. |
| `sharpen:` | `0`–`100` | Unsharp amount. |
| `blur:` | `0`–`100` | Gaussian blur sigma scaled to 0–100. |
| `grayscale` | (none) | Desaturate. |
| `background:` | `RRGGBB` | Flatten transparency onto this colour (e.g. jpeg output of a png). |
| `focus:` | `center` \| `top` \| `bottom` \| `left` \| `right` \| `top-left` \| `top-right` \| `bottom-left` \| `bottom-right` \| `smart` | Crop anchor for `fill`. `smart` uses libvips attention detection. Coordinate focus (`0.8x0.2`) is planned. |

### `POST` `/api/images/sign`
Turn transform options into a signed render URL. This is the method backend/app code calls.
*Auth: JWT*

**Request headers**

| Header | Value | Notes |
|---|---|---|
| `Authorization` | `Bearer <jwt>` | Tenant-scoped by the token `account_id`. |
| `Content-Type` | `application/json` | |

**Request body**

| Field | Type | Required | Default | Notes |
|---|---|---|---|---|
| `path` | string | yes | | Source object key within the account prefix. |
| `fit` | string | no | `fit-in` | `fit-in` \| `fill` \| `stretch`. |
| `width` | integer | one of width/height | | `0` / omitted = auto from aspect. |
| `height` | integer | one of width/height | | `0` / omitted = auto from aspect. |
| `filters` | object | no | `{}` | e.g. `{ "format": "webp", "quality": 82, "sharpen": 60, "focus": "smart" }`. |
| `expiresIn` | integer (seconds) | no | null (non-expiring) | If set, the signature carries an expiry and the URL 401s after it. |

```json
{
  "path": "posters/grand-final.jpg",
  "fit": "fit-in",
  "width": 1280,
  "height": 720,
  "filters": { "format": "webp", "quality": 82, "sharpen": 60 },
  "expiresIn": 3600
}
```

**Example response `200`**
```json
{
  "url": "https://img.volt.example/Q3k9_2ba8Xr/fit-in/1280x720/filter(format:webp,quality:82,sharpen:60)/posters/grand-final.jpg",
  "canonicalPath": "/fit-in/1280x720/filter(format:webp,quality:82,sharpen:60)/posters/grand-final.jpg",
  "expiresAt": "2026-08-12T05:33:20.000Z",
  "cacheKey": "sha256:5f2e...b91c",
  "_links": {
    "self": { "href": "/api/images/sign" },
    "render": { "href": "https://img.volt.example/Q3k9_2ba8Xr/fit-in/1280x720/filter(format:webp,quality:82,sharpen:60)/posters/grand-final.jpg", "type": "image/webp" },
    "source": { "href": "/api/files/posters%2Fgrand-final.jpg", "rel": "source" }
  }
}
```

**Error responses**

| Code | When | Body |
|---|---|---|
| `400` | Unknown `fit`/filter, or both width and height are 0 | `{ "error": "bad_request", "message": "..." }` |
| `401` | Missing/invalid JWT | `{ "error": "unauthorized" }` |
| `413` | Requested dimensions exceed the max-dimension guard | `{ "error": "dimensions_too_large", "maxPixels": 25000000 }` |

### `GET` `{imgBase}/{sig}/{fit}/{WxH}/filter(...)/{path}`
Render (or serve from cache) the derivative. Returns the image bytes, not JSON.
*Auth: signed URL (HMAC), public*

**Request headers**

| Header | Value | Notes |
|---|---|---|
| `Accept` | e.g. `image/avif,image/webp,*/*` | Used for content negotiation when no explicit `format:` filter is set. |
| `If-None-Match` | prior `ETag` | Returns `304` when the derivative is unchanged. |

**Example response `200`** (headers shown; body is the encoded image)
```
Content-Type: image/webp
Content-Length: 48210
Cache-Control: public, max-age=31536000, immutable
ETag: "5f2e...b91c"
X-Volt-Cache: MISS
X-Volt-Render-ms: 146
Vary: Accept
Link: </Q3k9_2ba8Xr/fit-in/1280x720/filter(format:webp,quality:82,sharpen:60)/posters/grand-final.jpg>; rel="self",
      </api/files/posters%2Fgrand-final.jpg>; rel="source"
```

On a subsequent hit the same request returns `X-Volt-Cache: HIT` and `X-Volt-Render-ms: 1`.

**Error responses**

| Code | When |
|---|---|
| `400` | Malformed geometry or filter segment. |
| `401` | Bad or expired signature (and `unsafe` not permitted). |
| `404` | Source `path` not found in the account origin. |
| `413` | Dimensions exceed the max-dimension guard. |

### Caching and delivery
Derivatives are immutable and keyed by `sha256(canonical path)`. In production the render host
sits behind CloudFront with an S3 derivative cache; the first request renders and stores, all
later requests are edge/cache hits. Purge a source by invalidating the cache tag for its `path`
when the underlying object is replaced.
