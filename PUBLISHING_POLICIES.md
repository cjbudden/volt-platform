# Volt Publishing Policies: design

Nov 3, 2026 · @Christian Budden

> Saved from the design doc "Volt Publishing Policies: design" (design link `publishing-policies-design` in `design-links.local.md`) on 9 Nov 2026, for build queue P1. The doc stays the place to discuss it; this copy is what the build reads. The two diagrams are only in the doc.
>
> **Built so far (P1, 9 Nov 2026):** the editorial state (draft, published, archived) and the computed public status with its reason and next moment, in `volt-app/src/services/publicStatus.ts` (migrations 0148 and 0149); the public visibility rule on the play gate, the access check and the guided ad playlists. Still to come in P1-2: the admin API and the Availability tab timeline and tester.

## Summary

A publishing policy is one named bundle that decides when an asset can be seen, by whom, how it is protected, where it goes and when it is deleted. Users set intent (Draft, Published, Archived) and dates. Volt computes what a viewer actually gets right now, and shows the reason.

That split is the core of the design. Today the user has to reason across a publish flag, a publish window, access rules, geo, DRM and retention separately. In the new model they see one **Public status** per asset, such as *Scheduled: available 12 Nov 18:00 (from Sports match policy)* or *Restricted: rights window ended 1 Nov*, with every setting traced back to where it came from.

Policies attach at account, content type, metadata rule, owner (channel or event) and asset level. The most specific wins per field, and a higher level can lock a field so it cannot be loosened lower down. One evaluator answers every request: catalogue APIs, the play URL gate, the edge, DRM licences, FAST, share links and social.

## What exists today and what changes

Most of the engine is already in the Media Library build. This design reorganises it around a lifecycle and adds protection, metadata targeting and retention. It is written from the project notes; the repo was not reachable when this was drafted, so file names should be checked against the code.

| Area | Built today | Change |
| --- | --- | --- |
| Rule ladder | `publishing_rules`: account < content type < owner < asset, per-field inherit (`services/publishingRules.ts`) | Add a metadata-rule rung and field locks; rename to policies in the UI |
| Publish flow | `services/availability.ts`: publish, withdraw, republish, 1/min sweep, auto-publish on build | Becomes the lifecycle engine; existing review states (in review, changes requested, approved, rejected) and QC gate become the optional review step; sweep also pushes state to the edge and fires the planned publication.published hook |
| Access rules | FOR / IF / THEN / TERMS rows, first match wins (`services/accessRules.ts`) | Kept as is, becomes the Access section of a policy |
| Geo and rights | `services/rights.ts` in `/availability` and `/access/check`; CloudFront geo + KVS for live | Add a contract rights window per asset, separate from the publish window |
| Payments | Products, entitlements, 402 paywall | No change; entitlement expiry clamped to the window |
| DRM | Axinom via SPEKE at packaging; MP4 export off for DRM | Driven by policy at ingest; change triggers repackage |
| WAF | Designed, paid add-on, not enforced | Policy picks a WAF profile per class of content |
| Retention | Recordings only (`expires_at`) | Extended to VOD assets with grace period and legal hold |
| Metadata gate | Mandatory fields block publish | Kept; shown as a reason in Public status |

## Lifecycle model

The user sets one of three editorial states, with an optional review step before publishing. Everything else is computed, so there is no way to save a contradictory status.

*(Diagram in the design doc: the asset lifecycle, 3 editorial states and 5 computed statuses.)*

Expired assets can be set to auto-archive, and archived assets are deleted only by retention.

**Editorial state (set by a person or the API)**

- **Draft**: not ready. Mandatory fields can be empty. Never public, never in any public API.
- **Published**: the owner wants it out. Whether a viewer can see it now is decided by dates, rights and access.
- **Archived**: off the catalogue and not playable, media kept (can move to a cheaper storage tier). Can be restored to Draft or Published at any time until it is deleted.

**Review and approval (optional, off by default)**

For clients who need sign-off before anything goes out, review sits between Draft and Published. It is switched on per account, and a content type or policy can require it for some content only (for example news clips yes, promos no). With it off, Publish goes straight from Draft, as today.

- **In review**: submitted for approval. Not public. Editors see who it is waiting on.
- **Changes requested**: sent back with comments. Returns to Draft for editing, then is submitted again.
- **Approved**: ready to go. It publishes straight away, or on its Available from date if one is set, so approval can be given ahead of an embargo.
- **Rejected**: will not be published. Kept as a Draft with the reason, or archived.

These states already exist in Volt's review service, with the QC gate (soft: an approver can override a failed QC check and the override is recorded; hard: a failed QC check blocks approval). The policy adds who must approve and when:

- **Who approves**: a role or named user group. Optionally, the submitter cannot approve their own item, and some content needs two approvers.
- **What re-opens review**: a new cut or a media change always does. Metadata-only edits can be set to re-open review or not.
- **Deadlines**: an optional review deadline with a reminder, and an escalation to a second approver group.
- **Where it shows**: the asset's Public status reads *In review: waiting on News editors*, the Library has an *Awaiting my approval* filter, and approvals and rejections go to the audit log and fire the existing `review.decided` hook.

**Public status (computed for Published assets, shown everywhere with its reason)**

| Public status | When | Viewer sees | Example reason line |
| --- | --- | --- | --- |
| Processing | Published, but renditions, DRM packaging or cards not finished | Not visible in any public API; goes live on its own when ready | Packaging HLS/DASH, 2 of 4 renditions |
| Scheduled | Now is before Available from | Optional Coming soon card in the catalogue, no playback | Available 12 Nov 18:00 AEDT |
| Available | Inside the publish window and the rights window, and at least one access rule lets someone in | Plays, subject to geo, sign-in or payment | Premium, AU and NZ only |
| Restricted | Publish window is open but the rights window is not, or no territory is allowed | Not visible in any public API | Rights window ends 1 Nov |
| Expired | Now is after Available until | Not visible in any public API | Expired 30 Oct, archives in 7 days |

A Draft that cannot be published says why, for example *Not ready: 2 mandatory fields*. Withdraw moves a Published asset back to Draft and keeps its dates.

**Public visibility rule.** Draft, In review, Changes requested, Rejected, Processing, Restricted, Expired, Archived and Deleted assets are never returned by any public API: not search, not catalogue lists, not detail by id, not the play gate, not feeds or sitemaps. A public request for one by id gets the same `404` as an id that never existed, so nothing about unpublished content leaks. Only Available assets are public, plus Scheduled assets whose policy has an earlier *Listed from* date (a teaser with no playable URL). The one exception to hiding is a viewer in a blocked region: an Available asset is shown to them locked, with the block message. Everything else is visible only through the admin API and the console.

**Dates**

- **Available from / until**: the publish window. Both optional; empty from means as soon as published and ready.
- **Rights from / until (+ territories)**: the licence window from the contract. Effective window = publish window intersected with rights window, so an editor cannot publish past a licence.
- **Listed from**: when it appears in catalogues and search (for teasers), default equals Available from. **Unlisted** keeps it playable by link or API but out of browse and search.
- **On expiry**: stay Expired (reappears if the window is extended), auto-archive, or archive then delete.
- **Retention**: delete on a date, or after a period counted from upload, from Available until, or from archiving. A legal hold blocks deletion. Deletion gives a warning list 7 days ahead and is logged.

Policies can hold relative defaults, for example *until = from + 30 days* or *delete 90 days after expiry*, so most assets never need dates typed.

## What a policy contains

A policy has five sections, each optional. A section left empty inherits from the level above, so a content-type policy might set only DRM and geo and take everything else from the account default.

| Section | Fields | Applied when |
| --- | --- | --- |
| Lifecycle | Default state on ingest (Draft or auto-publish when ready), publish gate (approved review, QC passed, named add-on succeeded), relative window defaults, listed-from offset, unlisted, on-expiry action | Delivery time |
| Access | FOR / IF / THEN / TERMS rows (free, members, premium, user groups, products, geo in or not in) | Delivery time |
| Protection | DRM required, playback token lifetime, WAF profile (off, standard, rights-managed: VPN, proxy, hosting and Tor blocked or challenged), allowed referrer domains, concurrent stream limit | DRM at ingest; the rest at delivery |
| Distribution | Targets (portal, apps, social, FAST eligible), MP4 download allowed, share links allowed, schema.org and sitemap exposure | Delivery time, social at post time |
| Retention | Retain period and anchor, legal hold allowed, storage tier on archive | Sweep |

**Encode-time vs delivery-time fields.** This is what keeps ingest, encoding and security from fighting each other.

- **Encode-time** fields change the files: DRM on or off, and later rendition ladder, captions and I-frame trick-play. The policy is resolved when the asset is ingested and the result is snapshotted on the asset. Changing one later shows the impact (*Repackage 124 assets, about 3 h of jobs*) and queues repackage jobs on confirm. Until they finish, the asset keeps its current protection, never a weaker one.
- **Delivery-time** fields (windows, access, geo, WAF, token lifetime, listing) are evaluated on every request and take effect within about a minute, with no reprocessing.

**Presets.** Most users never open the section editor. New accounts get five starting policies they can copy and edit:

| Preset | What it does |
| --- | --- |
| Open | Published when ready, free worldwide, no DRM, MP4 and share links allowed |
| Members | Sign-in required, worldwide, no DRM |
| Geo-locked | Free, chosen countries only, VPN and proxy flagged |
| Premium | Paywall products, DRM, no MP4 download |
| Rights-managed | Rights window required, chosen territories, DRM, rights-managed WAF profile, no social or MP4 |

## Where policies apply and which wins

Policies attach at five levels. Each field is resolved separately, and the most specific level that sets it wins, unless a level above has locked it.

1. **Account default**: always exists (Open preset for a new account). Covers users who only ever want publish and nothing else.
2. **Content type**: for example Sports match, Episode, Clip, Worship service.
3. **Metadata rule**: an ordered list of conditions on metadata, tags, collection or source, for example *competition = EPL* or *tag = embargoed*. The first matching rule applies, and the asset shows which one matched.
4. **Owner**: the channel or event the asset came from (the existing owner rung).
5. **Asset**: an individual override, shown as a visible exception on the asset and in a filter on the library.

**Locks.** A level can lock a field so lower levels cannot change it. Typical use: the Premium content type locks DRM on; the account locks the rights-managed WAF profile for anything with a rights window. A locked field shows a padlock and its source.

**Rights always narrow.** The rights window is a constraint, not a setting, so no level can publish outside it.

**Effective policy trace** for one asset, as the asset page would show it:

| Field | Value | From |
| --- | --- | --- |
| State | Published | Asset |
| Available | 12 Nov 18:00 to 12 Dec 18:00 | Content type Sports match (+30 days) |
| Rights | 10 Nov to 30 Nov, AU NZ | Asset (contract) |
| Effective window | 12 Nov 18:00 to 30 Nov | Computed |
| Access | Premium, AU NZ | Metadata rule EPL |
| DRM | On (locked) | Content type Sports match |
| WAF | Rights-managed | Metadata rule EPL |
| Social | Off | Metadata rule EPL |
| Retention | Delete 90 days after expiry | Account default |

## Conflict rules

Conflicts are caught when a policy or asset is saved, never discovered by a viewer. Each check is either a block (cannot save) or a warning (can save, shown on the asset).

| Combination | Result | Why |
| --- | --- | --- |
| DRM on + MP4 download allowed | Block | MP4 export is disabled for DRM content |
| DRM on + social target | Block | Social platforms need a clear MP4 |
| Geo or rights restriction + social target | Warning | Once posted, the platform cannot enforce our territories; offer delete-on-expiry where the adapter supports it |
| Available until before Available from | Block | Empty window |
| Publish window outside rights window | Warning | Shows as Restricted for the gap, with the dates |
| Rights-managed policy without a rights window | Block | The preset depends on it |
| Geo restriction without WAF | Warning | VPN users can get around geo; suggest the WAF add-on |
| Retention shorter than Available until | Block | Content would be deleted while live |
| Encode-time field changed on a live asset | Confirm | Shows repackage count and time; protection never drops during the change |
| Token-free + geo, rights, DRM, paywall or sign-in | Block | Without a token the edge cannot enforce per-viewer conditions |
| Asset override on a locked field | Block | Names the lock and its level |
| Published with mandatory fields empty | Block | Existing metadata rule |

Every policy save also shows its **impact**: how many assets it affects and how many change Public status now, for example *342 assets, 12 become unavailable immediately*.

## Enforcement: every public path honours the policy

One evaluator, `evaluate(asset, viewer, now)`, returns allowed or not, the mode, a reason code and `until` (the next moment the answer can change). Every public path calls it or carries its result in a signed token. Nothing public reads the raw settings.

**The play URL is where it is enforced, not the catalogue.** Hiding an asset from a list does not stop a copied URL. So every VOD playback URL carries a short signed token minted by `/availability`, and the edge checks it on every manifest and segment request.

- **Token claims**: asset id, session id, viewer country, policy class, DRM flag, `nbf`, and `exp` = the earlier of now + token lifetime and the end of the effective window. Expiry at the edge is exact without the edge knowing any dates.
- **Edge check (CloudFront Function)**: signature, `exp`, asset match, viewer country matches the token (stops URL sharing across borders), then a small KVS revocation set for assets withdrawn or archived early. This keeps per-asset data out of KVS, so it scales past the 5 MB store limit.
- **Open content** gets a token minted without checks and with a long lifetime by default, which lets it expire on its exact date. A policy can instead make it token-free (Scale and caching, point 8).

| Path | What it does with the policy |
| --- | --- |
| Catalogue, search, detail APIs (publishable key) | Return only Available assets, and Scheduled assets past their Listed from date, filtered in SQL on the stored `public_status` and `status_until` so paging stays correct. Every other status is invisible, including to detail by id (404). An Available asset the viewer's region cannot play is returned locked (`playable: false`, reason and block message). Scheduled items carry no playable URL |
| `/availability` play gate | Evaluates, mints the token, returns the same canonical URL. Refusals: 402 paywall, 403 sign-in or not yet available (with `until`), 451 geo or rights, 404 for anything not public (draft, in review, processing, restricted, expired, archived, deleted), the same as an unknown id |
| `/access/check` | Same evaluator, booleans only |
| Edge | Token check and revocation set as above |
| WAF | Rules keyed on the signed policy class in the URL, so only rights-managed content gets VPN and proxy blocking and other content is not slowed or charged |
| DRM licence (Axinom) | Entitlement token expiry clamped to the effective window; no persistent licence for rights-managed content |
| Live channels and events | Unchanged design (stable URL, edge switching); per-programme rights come from the same evaluator |
| FAST lineups | Only schedule assets whose effective window covers the slot; re-checked at each playlist build; branded copies inherit the original's policy |
| Share links | Expiry clamped to the window; off if the policy disallows sharing; internal reviewer links may bypass geo, never rights |
| Social | Posting allowed only by policy; delete-on-expiry where the platform adapter supports it |
| schema.org, sitemaps, feeds, oEmbed | Available and listed only |

**Timing.** Token expiry handles window ends to the second. The existing 1/min sweep updates `public_status`, fires notifications and webhooks, pushes revocations and invalidates cached manifests. Every refusal is logged with its reason code for reporting.

**Block message.** A viewer outside the allowed territories sees the asset with a clear message rather than a missing title or a broken player. Each policy sets the message (default *Not available in your region*), with an optional *Notify me if it becomes available* button. The player gets the same message from the `/availability` 451 response, so apps on any platform show it the same way.

## Blocked demand reporting

Every refusal is counted by asset, country and reason, so customers can see where people want content they have not licensed and judge whether buying rights for that region would pay off.

**What is counted, strongest signal first**

| Signal | Captured at | What it tells you |
| --- | --- | --- |
| Notify me requests | Catalogue button, signed-in viewers | Named intent, and a list to tell when rights are bought |
| Blocked play attempts | `/availability` 451 refusals | A viewer pressed play; one count per attempt |
| Unique blocked viewers | Same, deduplicated per asset per day by hashed viewer or device id | Real demand, not one person retrying |
| Locked impressions | Catalogue and detail API serving a locked asset | Interest that did not reach play |
| Edge refusals | CDN logs, 403 on a token whose country does not match | Shared URLs and evasion, kept separate from demand |
| VPN or proxy flagged | WAF or IP intelligence on a blocked attempt | Kept as its own column so it does not inflate demand |

Refusals for other reasons (not yet available, expired, paywall, sign-in) are recorded with their own reason codes. Only geo and rights refusals count as regional demand. Paywall refusals feed a separate conversion report.

**The report** (Analytics, Rights demand):

- Blocked unique viewers by country on a map and ranked table, over a chosen period, with the trend.
- Drill down by series, content type, channel or event, and rights holder, to the single asset.
- Side by side with plays in licensed territories, so a customer can compare like with like: *Japan: 4,200 blocked viewers last 30 days; New Zealand, licensed: 3,100 plays*.
- Upcoming and expired windows overlaid, so demand after a licence ends is visible.
- CSV export and an API endpoint, for use in rights negotiations.

**Privacy and cost.** Only country, reason, asset, timestamp and a hashed viewer or device id are kept; no IP addresses. Events go to the existing analytics store as `availability_events` and roll up daily, so the report never reads raw request logs. The same counts already designed for live blackouts (blocked count per channel and programme by country) use this pipeline, so live and on demand report together.

## Scale and caching

The rules are worked out when they change, not when a viewer presses play. On the request path nothing walks the policy levels or joins tables: each check is a key lookup of a small precomputed record, or a signature check at the edge.

**1. Decision records, computed on write.** For every asset Volt keeps one flat decision record: effective window, rights window, allowed and blocked territories, access class and products, DRM flag, policy class, token lifetime, block message, and a version number. It is rebuilt by a background job whenever a policy, metadata rule, content type, owner or the asset itself changes, batched so a policy change affecting 50,000 assets is one queued job, not 50,000 request-time lookups. Time does not trigger rebuilds: the record holds its dates and the check compares them with the current time.

**2. Three tiers on the request path.**

| Tier | Requests it takes | How it decides | Touches the database |
| --- | --- | --- | --- |
| CDN edge | Every manifest and segment, the vast majority of all traffic | Token signature, expiry and country check in a CloudFront Function, plus the small revocation set in KVS | Never |
| Play gate (`/availability`, token renewal) | One per play start and per renewal | Decision record from in-process memory, then Redis; viewer entitlements cached per session; then a pure function of record, country, viewer and time | Never on the hot path; only on a cache miss with Redis down |
| Catalogue APIs | Browse, search, detail | Responses cached at the CDN by app, territory group and access tier, not per viewer | Only on a cache miss |

**3. Catalogue caching that respects time.** Territories with the same outcome for a catalogue share one cache entry (a territory group), which keeps the number of cached variants small. Each response's cache lifetime is the shorter of its normal lifetime and the time until the next status change of any item in it, so a title scheduled for 20:00 appears at 20:00 without a purge. Anything personal (what this viewer has bought) comes from a separate small call, so the big lists stay shared.

**4. Invalidation.** A rebuilt decision record bumps its version and is published over Redis pub/sub, so every API node drops its copy within a second. Catalogue entries are tagged by asset and purged by tag (surrogate keys on Fastly or Cloudflare; grouped invalidation paths on CloudFront). Short cache lifetimes are the safety net if a purge is missed. Early withdrawal also adds the asset to the edge revocation set, which stops tokens already issued.

**5. Major events: FIFA, Olympics, breaking news.** Demand arrives as a spike at kick-off or as a story breaks, mostly for a handful of assets.

- **Event mode, pre-warmed.** The schedule already knows the event, so ahead of it Volt loads its decision records into every node and into Redis, warms the catalogue cache for each territory group, and puts the event's assets into a hot set at the edge.
- **Edge-issued tokens for the hot set.** For hot assets the edge can issue the play token itself from the record held in KVS, so play starts at kick-off never reach the API. KVS's 5 MB limit is fine for a hot set of tens or hundreds of assets.
- **Longer tokens during events.** Token lifetime for live events is set so renewals don't arrive in a burst, still capped by the rights window.
- **No stampedes.** A cache miss is fetched once per node while other requests wait for it (single flight), and stale entries are served while one refresh runs.
- **Breaking news, not scheduled.** The same hot set fills on demand: an asset crossing a request-rate threshold is promoted to the edge automatically.

**6. When something fails.** The edge keeps working on its own, because tokens are self-contained. If Redis or the API is slow, the play gate uses the last known record. What happens without any record is set by policy class: Open content fails open, rights-managed, DRM and paid content fails closed with a *Try again shortly* message rather than a geo block.

**7. Counting without load.** Refusals and plays are never written to the database one by one. They go onto a stream (edge real-time logs and the play gate's event log), are counted per minute in Redis and rolled up into the analytics store, which is separate from the operational database.

**8. Token-free access.** A policy can switch tokens off for content that has no per-viewer condition: free, worldwide, no DRM. Typical uses are podcast and RSS feeds, third-party embeds, FAST channels and the largest free events, where token-free is the lightest path of all. Expiry is enforced by the sweep, which withdraws the public manifest and purges it from the CDN within about a minute. Plays are still counted from CDN logs. Volt blocks token-free when a policy has geo, rights, DRM, paywall or sign-in conditions, because without a token the edge cannot enforce them per viewer.

**9. Proving it.** A kick-off scenario is added to the Tier 3 load and chaos tests: a cold start to peak play starts in under a minute, with Redis restarted mid-test, measuring play gate latency, cache hit rate and database queries per second (the target being close to zero during the spike). Target figures are to be set from the first customer's expected peak.

## User workflow and screens

The order users meet things matches how often they need them: most only see a status and a date, a few build policies.

1. **Day to day (editor)**: the asset's Availability tab shows a single timeline bar (Draft, Scheduled, Available, Expired, Archived, Delete) with today marked, the Public status and reason, three date fields and a Publish button. The policy name sits beside it with *Override* for exceptions.
2. **Who can watch now (tester)**: on the same tab, pick a country, viewer type (anonymous, member, entitled) and a date. Volt runs the real evaluator and answers *Plays* or *Refused: 451, AU only*. This is the main tool for building trust in the rules.
3. **Library**: Public status is a column and a filter. Extra filters: *Has override*, *Restricted*, *Expires in 7 days*, *Deletes in 7 days*, *Repackage pending*.
4. **Admin, Publishing policies**: a list of policies with where each applies (chips: account, content types, metadata rules, owners) and asset counts. Editing a policy shows its five sections, inherited values greyed with their source, locks, and the impact preview before save.
5. **Admin, Metadata rules**: ordered list of conditions to policy, drag to reorder, with a test box (paste an asset id, see which rule matches).
6. **Bulk**: select assets, then set state, set dates, apply a policy or clear overrides, with the same impact preview.

**Upload and ingest.** The upload dialog shows the policy the new asset will get (resolved from content type and any metadata given) because DRM is decided at packaging. It can be changed there before encoding starts.

## Data model and API changes

Changes extend the existing tables rather than replacing them; names to be checked against the repo.

| Change | Detail |
| --- | --- |
| `publishing_rules` | Add `level` value `metadata_rule`, `priority`, `condition` (JSONB: field, operator, value), `locked_fields` (text array), `name`, `preset_key`; settings gain `protection`, `distribution`, `retention`, `lifecycle` sections |
| `vod_assets` | `editorial_state` (draft, published, archived), `available_from/until`, `listed_from`, `unlisted`, `rights_from/until`, `rights_territories`, `retain_until`, `legal_hold`, `public_status`, `status_reason`, `status_until`, `policy_snapshot` (encode-time fields), `effective_policy_hash` |
| `policy_resolutions` | Flat decision record per asset (windows, territories, access class, DRM, policy class, version) plus field sources for the trace. Rebuilt by a queued job on any rule, metadata or asset change; the only thing the request path reads, through memory and Redis |
| `availability_events` | Log of every status change and refusal reason code, feeding reports and the audit trail |
| `revocations` | Asset or session id, reason, expires (mirrored to KVS) |

| API | Purpose |
| --- | --- |
| `GET/POST/PUT /api/publishing-policies` | Policies and metadata rules, with `?dryRun=1` returning the impact |
| `GET /api/vod/:id/policy` | Effective policy with sources and locks |
| `POST /api/vod/:id/evaluate` | The tester: country, viewer, time in; decision out |
| `POST /api/vod/bulk/policy` | Bulk state, dates, policy |
| `PUT /api/vod/:id/availability` | Extended with the new dates and state |
| Webhooks | `asset.status_changed`, `asset.expiring`, `asset.deleting` |

The existing `published` boolean is kept as a derived read-only field for backward compatibility.

## Rights: the ceiling nothing overrides

Rights say what the account is allowed to do with an asset. Publishing policies and collections choose what to do inside that, and can never go past it (decided 6 Nov).

*(Diagram in the design doc: how rights, access and publishing apply, 3 inputs, 1 decision, 5 enforcement points.)*

Rights are applied first and can only take away. Collection access then sets the access type and packages per app and region, the most restrictive collection winning. The publishing policy decides state, dates and protection inside both. The result is one cached decision per asset that every public path reads.

- **Rights profiles** are set up by account admins: provider or content owner, allowed and blocked territories, permitted uses (on demand, FAST and linear, clips, social, downloads, ads), allowed access types (free, members, subscription, pay per view), the window (fixed dates or relative, such as 12 months from first air), the attached agreement and a takedown contact.
- **Apps** are part of the rights. A profile allows all apps, only listed app types, or all except listed ones (Web, Mobile, Smart TV, Embeds, Partner apps, In-venue), and can name specific registered apps. A blocked app never lists or plays the asset. Collection and asset access rules set per-app access (free, members, subscription, pay per view, packages) only for apps the rights allow; other apps are greyed out with the reason. An asset can drop apps for itself, never add one.
- **Two built-in profiles**: *No restrictions* and *All restricted* (nothing can be published or used in FAST). Each account chooses its default. Existing assets are given *No restrictions*.
- **Mandatory on every asset**, with the account default applied. Set at web upload, by watchfolder and filename rules, ingest rules, the API and in bulk.
- **Per-title narrowing**: an asset can take its own dates or fewer territories inside its profile, never wider.
- **Rights set the defaults and the choices** in access and policy screens: anything outside the rights is greyed out with the reason. FAST lineups, social posting, clips and downloads check them too.
- **Agreements** are stored privately for rights admins, with an audit trail. Takedown notices are drafted from them for a person to review and send.

## Collections, packages and apps

Collections are the one editorial grouping, replacing playlists: manual, rule-based, or both (rule results plus manual additions, minus manual exclusions). Rules use the same condition builder as policy metadata rules, with operators that fit each field type: text, numbers (=, <, >, between), dates (before, after, between, within the last N days), lists, tags, content type, rights profile and provider. Rules run when an asset is added or changed, with a nightly full re-check.

**Access on a collection, by region and by app.** A collection can carry access rules: which apps (All apps by default, or chosen apps), which territories, and the access type and prices for each. A collection with premium access in a region is a **package** for that region, and its prices can differ by app (web, iOS, Android, TV) because each app has its own products and store pricing. New collections are All apps, Global, All access. A child collection inherits its parent's access and can only tighten it.

**Most restrictive wins, per app and region** (decided 6 Nov). If an asset is in a collection that is premium for an app in a region, the asset is premium for that app in that region everywhere in the system:

- **Public collection APIs, search and detail** show it locked with the packages that unlock it. Play is refused with 402 and the package's products. A viewer who has bought any of those packages can watch.
- **Rule-based collections** with looser access leave it out for that app and region, and show a count of what was excluded and why.
- **Manual collections** keep it in the admin list, marked with the package that now governs it. Publicly it appears locked, as above.
- **Each app chooses** whether locked items are shown as an upsell or hidden from its catalogue.
- **Rights still cap everything**: an access type the rights exclude cannot be granted by any collection, and a manual add that rights rule out is refused with the reason.

**Seeing the effect.** Because apps, regions, rights and several collections combine, each collection has a **View as** panel: choose an app, a country and a viewer (anonymous, member, or holding a chosen package) and every item shows what that viewer gets (plays, locked by a named package, blocked by rights, hidden) and which rule decided it. A matrix view shows the same for every app and region at once. The asset page shows the same breakdown for one asset.

**Scale.** Membership is stored, not worked out per request. The decision record per asset becomes a small matrix by app and territory group, holding the access type and the packages that unlock it in each cell. It is rebuilt in batches when rights, collections, rules or policies change. The play gate reads one cell from cache and compares it with the viewer's cached entitlements, so request cost does not grow with the number of collections. Catalogue caching keys already include the app and territory group.

## Build phases and open questions

1. **Lifecycle and status**: editorial state, dates, computed `public_status` with reasons, precomputed decision records cached in memory and Redis, time-aware catalogue caching, Availability tab timeline and tester. Lowest risk, biggest clarity gain.
2. **Tokenised VOD playback**: token claims with window-clamped `exp`, edge check, revocation set, refusal codes, block message, and logging every refusal to availability_events so the Rights demand report has history from day one. This is what makes the rules hold on public play URLs. *Built 9 Nov 2026 (P2, v0.76.0): the token in the play URL's path, the CloudFront and staging edge checks and the revocation set (`volt-app/src/services/edgeTokens.ts`). Built 9 Nov 2026 (P2-2, v0.77.0): the refusal answers with the account's block message, `code`, `notify` and `until`, Notify me requests, and the edge's refusal words (`volt-app/src/services/blockMessage.ts`). Enforcing and token-free are P2-2b; counting and the report P2-3.*
3. **Policy sections and precedence**: protection, distribution and retention sections, metadata-rule rung, locks, presets, impact preview, conflict checks.
4. **Encode-time handling**: policy shown at upload, snapshot, repackage on change.
5. **Retention and archive**: sweep, warnings, legal hold, storage tier move.
6. **WAF profiles**: once the WAF add-on is enforced.

**Added 6 Nov.** **R1 Rights profiles** comes before phase 1, so lifecycle and status are built on rights from the start. After phase 3 come **C1 Rule-based collections**, **C2 Collection access, packages and apps** (per-app and per-region access, most restrictive wins, the View as panel and matrix), and **C3 Collections as FAST pools and app catalogue rows**.

**Open questions**

- [x] Decided 3 Nov: token-free access is an option for content with no per-viewer conditions (see Scale and caching, point 8).
- [x] Decided 3 Nov: viewers in a blocked region see the asset locked with a block message, and blocked requests are counted for the Rights demand report.
- [ ] Does a metadata rule sit above or below the owner rung? This draft puts owner (channel or event) as more specific.
- [ ] Where do rights windows come from: typed per asset, inherited from the owner or series, or an import from a rights system?
- [ ] Should archive move media to a colder S3 tier automatically, and is restore time acceptable?
