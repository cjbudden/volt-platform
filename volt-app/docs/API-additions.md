> **Superseded (Oct 2026).** These August notes are kept for history. The current
> reference is `API_GUIDE.md` (how to use the API), `API_ROUTES.md` (every route and the
> access it needs) and `API.md` + the Postman collection (request by request).

# Volt Streaming — API additions (2 Aug build)

New endpoint groups added this build. These are **not yet in the Postman capture**
(which still covers the original 34); they're documented here and covered by
`test/*.check.sh`. Regenerating the full Postman/playground over these is a
follow-up. Auth is Bearer JWT unless noted.

## Hypermedia / JSON-LD + Hydra  (content-negotiated)
Send `Accept: application/ld+json` on any existing GET to receive the hypermedia
representation (typed links, Hydra collections). Plain JSON is unchanged otherwise.

| Method | Path | Notes |
|---|---|---|
| GET | `/api` | Hydra **EntryPoint** — links to every collection (the service document). Public. |
| GET | `/api/context.jsonld` | JSON-LD `@context`. Public. |
| GET | `/api/doc` | Hydra **ApiDocumentation** (supported classes). Public. |

A collection response carries `hydra:member[]`, `hydra:totalItems`, `hydra:view`;
each entity carries `@id`, `@type`, `self`/`up`/`collection`/related links, and
inline `operation[]` affordances.

## EPG / scheduling  (`/api/epg`)
| Method | Path | Body / query |
|---|---|---|
| GET | `/api/epg?channelId=&from=&to=` | guide window (programmes overlapping the range) |
| GET | `/api/epg/now-next?channelId=` | `{now, next}` |
| GET | `/api/epg/conflicts?channelId=` | overlapping programme pairs (soft, non-blocking) |
| POST | `/api/epg` | `{channelId,title,startsAt,endsAt?,autoVod?,geoMode?,geoCountries?,metadata?,sourceRef?}` — `endsAt` omitted → resolved to next entry's start |
| DELETE | `/api/epg/:id` | |
| POST | `/api/epg/series` | `{channelId,title,rrule,dtstart,durationMs,template?,horizonDays?}` — materializes RRULE instances |

## Apps & API keys  (`/api/apps`)  +  play gate (`/api/availability`)
| Method | Path | Notes |
|---|---|---|
| POST | `/api/apps` | register an app → returns a **publishable key** (`pk_live_…`, shown once) |
| GET | `/api/apps` · `/api/apps/:id` | list / detail (with keys) |
| PUT | `/api/apps/:id` | name / restrictions / enabled |
| POST | `/api/apps/:id/keys` | rotate → new publishable key |
| DELETE | `/api/apps/keys/:keyId` | revoke a key |
| POST | `/api/apps/secret-keys` | issue an account **secret key** (`sk_live_…`, management scope) |
| POST | `/api/availability` | **public**, publishable-key auth: `{appKey,assetId,geo?}` → validates key + app restriction (referrer/origin/IP) → mints a short-lived **playback token**. Wrong origin → 403, bad key → 401. |

## Metadata schemas — new fields + endpoint
Schemas gained `targetKind` (`vod`|`event`|`channel`|`any`), `domain`, `extendsId`
(composition), and a `reference` field type. Channels and events now accept
`schemaId` + `metadata` (validated against the effective, extends-merged fields).

| Method | Path | Notes |
|---|---|---|
| GET | `/api/metadata-schemas/:id/effective-fields` | the merged (extends-resolved) field set a form should render |
