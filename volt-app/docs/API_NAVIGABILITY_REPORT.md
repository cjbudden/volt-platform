# Can a client navigate this API the way a WSDL client could?

**Run against your current working tree, 4 September 2026.** Postgres 16, all 22
migrations, `seed-demo.ts`, the control plane on `:8080`, launcher `mock`.
Every number below came out of a run, not out of the source.

**Verdict: the drill-down works, and it is better built than I expected, but it
covers 16 percent of the API and it is switched off by default.** The design is
sound. The coverage is not, and one header decides whether a client sees any of
it.

---

## How this was tested

I could not point Postman at your Mac from here, so I took your tree, stood the
stack up in this session and drove the real API.

The walk had one rule, which is the only honest way to test this claim:

> **The only URL typed by hand is `/api`. Every other request must come from a
> string found inside a previous response.**

Anything not reachable that way is, by definition, knowledge a client has to be
given out of band. That is exactly what a WSDL used to remove.

---

## Finding 1: the whole thing hangs on one request header

`Accept: application/ld+json`.

| | Collections carry ids and links | URLs reached by walking |
|---|---|---|
| Default `Accept` | **no** | **14**, and the walk dies at depth 1 |
| `Accept: application/ld+json` | yes | **39**, drilling three levels down |

Without the header, `/api/channels` is a bare JSON array. No `@id`, no `self`, no
links, nothing to follow. With it, the same URL is a `hydra:Collection` whose
members carry seven link relations each.

Keeping plain JSON unchanged for existing clients is a defensible decision and
`hypermedia.check.sh` asserts it deliberately. The problem is the seam it
creates: **`/api` returns JSON-LD whether you ask for it or not, and the first
link you follow from it does not.** A developer opening the API in Postman sees a
promising service document, clicks through to `channels`, gets a flat array, and
concludes the hypermedia is aspirational. It is not. They just crossed a boundary
nothing told them about.

The cheapest fix in this whole report: either make `/api` respect the same
negotiation as everything else, or have every decorated resource send
`Link: <…/api/context.jsonld>; rel="http://www.w3.org/ns/json-ld#context"` so a
plain-JSON client is at least told the richer representation exists.

---

## Finding 2: where the drill-down works, it is properly done

With the header set, following links only, the walk reached 39 URLs and three
levels of depth. A channel in a collection looks like this:

```
@id            -> /api/channels/<id>
self           -> /api/channels/<id>
collection     -> /api/channels
up             -> /api
status         -> /api/status/channel/<id>
recordings     -> /api/recordings?channelId=<id>
scheduledClips -> /api/scheduled-clips?channelId=<id>
```

`self`, `collection` and `up` are the right three relations and they are the ones
that make a generic client possible. The collection envelope carries
`hydra:totalItems` and a `hydra:PartialCollectionView`. Nine classes are
declared: Channel, Event, Recording, VideoObject, MetadataSchema, FillerAsset,
ScheduledClip, PublishTarget, Publication.

**The best thing in the API is the schema.org projection**, and it deserves
saying plainly. `/api/vod/:id/schema.org` returns:

```json
{ "@context": "https://schema.org", "@type": "Clip",
  "name": "Goal of the Month", "duration": "PT1M",
  "startOffset": 1, "endOffset": 61,
  "associatedMedia": [ { "encodingFormat": "application/vnd.apple.mpegurl", … },
                       { "encodingFormat": "application/dash+xml", … } ],
  "potentialAction": { "@type": "WatchAction", "target": "…" } }
```

That is correct schema.org, not a gesture at it: `Clip` rather than
`VideoObject` because it is a cut from a larger work, offsets into the parent,
both delivery formats declared, and a `WatchAction`. That markup is what gets a
VoD asset indexed properly. Nothing else in the API is at that standard yet.

---

## Finding 3: the coverage number

| | |
|---|---|
| Routes registered under `/api` | **223** |
| GET route patterns | **113** |
| **Reachable by following links from `/api`** | **18 (16%)** |
| Never reachable | **95** |

The entry point advertises ten collections. These subsystems are not among them,
are not linked from anything, and are not JSON-LD decorated even when
`ld+json` is requested. All of them return 200 when you already know the URL:

| Area | Unreachable GET patterns | Example |
|---|---|---|
| Recordings sub-resources | 11 | `/api/recordings/:id/timeline` |
| Channels sub-resources | 8 | `/api/channels/:id/history` |
| **Radio** | 7 | `/api/radio` |
| Analytics | 6 | `/api/analytics/retention` |
| Platform admin | 6 | `/api/platform/overview` |
| Storage | 5 | `/api/storage/capabilities` |
| **EPG** | 5 | `/api/epg/owners` |
| Fleet | 4 | `/api/fleet/hosts` |
| Media library, apps, uploads, monitoring | 3 each | `/api/files` |

Radio and EPG are the ones that stand out. A whole product area and the entire
programme guide are invisible to a client that starts where the API tells it to
start.

There is also no way in from the front: **the entry point does not link to
`/api/auth/login`**, so the very first call any client makes is one it cannot
discover.

---

## Finding 4: six links the API emits that do not work

These all came out of the API's own responses during the walk.

| Emitted by | URL | Result |
|---|---|---|
| The entry point | `/api/publications` | **400** `assetId required`. An advertised collection that cannot be fetched. |
| `context.jsonld` | `/api/vocab#` | **404**. The `volt:` namespace is declared at a URL that serves nothing, so every `volt:` term in the API is undereferenceable. |
| Every channel | `/api/channels/:id/start` | **404 on GET.** It is POST-only, and nothing in the representation says so. |
| Every VoD asset | `/api/publications/vod/:id/publish` | **404 on GET**, same cause. |
| Every channel | `/api/status/channel/:id` | **404** when the channel has never run, rather than an empty status document. Also never JSON-LD decorated, though the entry point lists `status` as a collection. |
| Every collection | `hydra:view` | Present, but with no `first`, `next` or `last`, so **pagination is declared in the context and not implemented**. A client cannot page. |

The two `404 on GET` rows are the single most important line in this report, and
they lead straight to the WSDL question.

---

## Finding 5: the honest WSDL comparison

`/api/doc` is a `hydra:ApiDocumentation` listing nine `supportedClass` entries.
Measured, in the running system:

```
classes described    : 9
operations described : 0
properties described : 0
```

That is the gap. A WSDL was never valuable because it listed endpoints. It was
valuable because it described, machine-readably, **which operations exist, what
they take and what they return.** That is what let a tool generate a client and
let a developer drill down without a manual.

What this API has today is the **navigation** half of that and none of the
**description** half:

| WSDL gave you | Here |
|---|---|
| A list of services and their addresses | ✅ the entry point, for 9 of ~20 areas |
| Follow a reference to a related object | ✅ `self` / `collection` / `up` / typed links |
| **Which operations exist on a resource** | ❌ zero `supportedOperation` |
| **Which method a link takes** | ❌ this is why `/start` 404s on GET |
| **What a request body must contain** | ❌ zero `supportedProperty` |
| **What comes back, typed** | ❌ a member is 65 raw database columns |

That last row matters more than it looks. A channel member returns **65 fields**,
which is the table row, so the API's response shape is coupled to the schema and
a client cannot tell which fields are contractual and which are internal.

Hydra has the vocabulary for all of the missing rows. `supportedOperation` with a
`method`, `expects` and `returns` is exactly the WSDL equivalent, and populating
it is filling in a structure that is already there and already served.

---

## What to fix, in order of value per hour

1. **Populate `supportedOperation` on the nine classes.** Method, expects,
   returns. This is the WSDL-equivalent gap and the structure already exists.
   Doing only this closes the largest gap in the report.
2. **Add the missing collections to the entry point**: radio, EPG, files, apps,
   users, jobs, share links, monitoring, analytics, fleet, storage. Coverage goes
   from 16 percent to most of the API for a few lines of the entry point builder.
3. **Fix the six broken links.** `/api/vocab` should serve the vocabulary,
   `/api/publications` should not be advertised as an unfetchable collection, and
   linked actions must declare their method rather than looking like GETs.
4. **Decide the negotiation seam.** Either `/api` follows the same rule as
   everything else, or every plain-JSON response carries the `Link:` context
   header pointing at the richer view.
5. **Implement `hydra:view` properly**, or stop emitting a `PartialCollectionView`
   that has no parts.
6. **Trim the member representation.** 65 columns is the row, not the contract.

None of these is large. Items 1 and 2 together would take this from a promising
demo to something a third party could genuinely write a client against.

---

## The Postman collection

`volt-api.postman_collection.json` plus `volt-local.postman_environment.json`.
Import both, or run it headless:

```bash
newman run volt-api.postman_collection.json -e volt-local.postman_environment.json
```

**Last run: 23 requests, 48 assertions, 0 failures.**

Four folders:

1. **Sign in.** Captures the token. Notes that the entry point does not advertise it.
2. **Discovery walk.** The drill-down chain in order: entry point, doc, context,
   channels collection, one channel, that channel's recordings, VoD, schema.org.
   Each request asserts the hypermedia contract and logs what it found, so
   running it prints the link relations rather than making you hunt for them.
3. **Works, but undiscoverable.** Ten endpoints that return 200 and cannot be
   found by walking. Each asserts the current, undecorated state.
4. **Broken links the API itself emits.** These assert the **defects as they are
   today**, on purpose. They pass now and will fail the moment you fix them,
   which is what you want from a defect record: it tells you when it is done.

The collection sets `Accept: application/ld+json` at the top level. Take it off
and folder 2 collapses, which is Finding 1 reproducible in one click.

---

## Two notes from standing the environment up

- **`volt_web_demo.sql` is effectively empty now**: 1 account, 2 groups, 0
  channels, 0 events, 0 recordings, and 37 tables against a schema that is now
  larger. It restores without error, which is why it does not look stale. I used
  `scripts/seed-demo.ts` instead, which produces a usable two-tenant dataset.
- **The orchestrator did the right thing on boot.** `seed-demo` writes two
  channels as `live`; the control plane came up, asked the launcher, found
  nothing running and reconciled both to `ended`, logging
  `boot reconcile corrected 2 stream status row(s)`. That is the "a claim is not
  evidence" rule working exactly as intended, and it is worth knowing it fires on
  a cold start and not just in tests.
