# Volt Hybrid Sites: on-prem ingest and VOD encoding

Nov 3, 2026 · @Christian Budden

> Saved from the Claude Doc "Volt Hybrid Sites: on-prem ingest and VOD encoding"
> (https://claude.ai/artifact/Jc8EBMbq4UQHGj3cUXV8EP) for build queue H1, 4 Nov 2026.
> Build status is at the end of this file ("Build status").

## Recommendation

Build it, as **Hybrid Sites**: a premium licensed add-on, built as part of Volt's core job and storage model rather than on the add-on runs framework. It fits Volt well because most of the parts exist: a folder agent, watchfolder rules, a durable job queue, the VOD encoder script, storage objects that can hold several copies, and the encode engine seam.

**Why not the add-on runs framework.** Add-ons are side branches by design: they never block or fail the base workflow. On-prem encoding *is* the base workflow for that asset, because nothing can play until it finishes. Putting it on the add-on runs path would mean either breaking that rule for everyone or building a second, weaker workflow beside the real one. So:

- **Build:** sites, worker pools and job placement as a core capability, off by default, switched on per account by licence.
- **Sell:** as a premium add-on in the Add-ons catalogue, licensed per site, plus a deployment and setup fee based on the number of workers, servers or VMs added. A companion add-on, Mirror and Archive, sells off-cloud copies on the same agent without any on-prem encoding.
- **Use the add-on contract where it does fit:** third-party encoders reached by API, and notifying a customer's own systems when a site encode finishes.

**Hybrid vs multi-zone.** "Hybrid" is the clearer word for customers: a cloud control plane with some processing and storage on their premises. Multi-zone suggests cloud regions. A fully on-prem multi-server Volt is a later step that reuses the same site and pool concepts, and is out of scope here.

## What already exists

Checked against the repo at v0.28.0. Most of the work is extending these, not new subsystems.

| Piece | Today | What Hybrid Sites needs from it |
| --- | --- | --- |
| `volt-agent` | 225-line Node agent: watches local folders, waits for files to go quiet, uploads with resumable tus, keeps state across restarts | Becomes the site agent: run watchfolder rules locally, register assets without uploading the source, run the worker, report health |
| Watchfolders (`services/watchfolder`) | Server-side, `local` and `s3` kinds; rules, quarantine, dry run; pure classifier in `rules.ts` | A third kind, `site`, whose scanning runs in the agent using the same `rules.ts` |
| Job queue (`services/jobs/queue.ts`) | Postgres, leased, retried, `SKIP LOCKED`; workers run in-process | A `pool` per job, and an HTTPS lease API so a site worker can claim jobs without database access |
| `vod.encode` handler | Probe, fit ladder, run `vod_encoder.py`, write outputs under `clips/vod/<id>` on the same box | Split into a plan step (cloud) and an execute step (cloud or site); outputs uploaded to primary storage |
| Storage objects (`services/media/objects.ts`) | One object, many locations, each with a tier; drivers `local` and `s3`; holds, retention ladder | A `site` location kind, so the local archive copy is a tracked copy with its own retention |
| Encode engines (`services/engines`) | Live only: builtin plus planned vendors, encode only vs full modes, capability check, canonical events | The same seam for VOD, for third-party on-prem encoders |
| Add-on framework (`services/workflows`) | Signed dispatch, callbacks, run states; side branches only; gate mode planned | API-driven third-party encoders, and notifying customer systems when a site encode finishes |
| `EDGE_CONTRIBUTION.md` | Designed: on-prem radio encoder, enrolment token, config pulled from Volt, outbound only | Same enrolment, config and update model. One site agent can later host both |

## The model

Five new ideas, each small, and each defaulting to today's behaviour.

- **Site**: a customer location enrolled with Volt, such as *Main broadcast centre*. It has a name, an enrolment, a health state, and the agents running there. The cloud is always site zero.
- **Worker pool**: the workers at a site that can take a kind of job, such as *On-prem encoders (3 workers, GPU)*. Every job has a pool. Today every job is implicitly in the cloud pool.
- **Placement**: which pool a step runs in, set by the encoding profile, ingest rule or watchfolder, for example *encode at site, fall back to cloud after 30 minutes offline*. It is decided by the control plane, never by the worker.
- **Storage location**: where a copy of the media lives. The cloud bucket stays the primary for delivery and playout. A site can hold additional copies, such as the mezzanine and the packaged output for archive, tracked as locations of the same storage object.
- **Host**: a physical server or VM at a site that runs workers, CPU only or with GPUs. A host registers itself when the agent is installed on it, reporting cores, memory, GPUs and their encode sessions, and free disk, and is approved in the console before it takes work. Jobs that need a GPU go only to GPU hosts. A later option lets a customer give Volt credentials for their hypervisor (for example vSphere, Proxmox or Nutanix) so Volt can create worker VMs from a template when more capacity is needed.

The control plane stays in the cloud and stays the only place that decides: ladders, publishing policy, DRM keys, retention. A site does the heavy work near the source and reports back.

*(Architecture diagram, site and cloud: in the Claude Doc this file was saved from.)*

The agent registers files and reports health. Workers lease jobs and DRM keys from the control plane, keep a local archive copy, and upload the packaged output to primary storage, which the cloud verifies before the asset can play.

**Customer-facing names:** *Hybrid Sites* for the add-on, *On-prem watchfolder*, *Site encoders*, *Local archive copy*.

## The on-prem flow, end to end

The source file never has to leave the customer's network unless a policy says so. Only the packaged output goes to the cloud for delivery.

Each on-prem watchfolder has one of two placements:

- **Encode at site**: the flow below. The source stays on the customer's network and only the packaged output goes to the cloud.
- **Upload and encode in the cloud**: for sites without encoders. The agent uploads the source with resumable upload and the cloud encodes it like any other upload. It is also what a site falls back to when its workers are offline.

1. **Drop.** A file lands in an on-prem watchfolder on the customer's storage. The site agent waits until it is quiet (same rule as today), then runs the folder's rules with the same `rules.ts` the cloud uses. Rejected files go to the local review folder and show in the console's queue as now.
2. **Register.** The agent sends the cloud the file's facts: name, size, checksum, relative path and the metadata the filename rules extracted. The cloud runs ingest rules (duplicates, holds, mandatory metadata), creates the media asset as *Processing at site*, and records the source as a site location. No bytes uploaded yet.
3. **Probe and plan.** The cloud queues a probe job in the site's pool. A site worker runs `ffprobe` and returns the result. The cloud fits the ladder to the source, exactly as `vod.encode` does today, so the upscale policy and ladder choice stay in one place.
4. **Encode.** The cloud queues the encode job in the site's pool with the resolved ladder. A site worker leases it over HTTPS and runs the same `volt-encoder` container image, so segment length, codecs and packaging match cloud encodes. Thumbnails, sprite sheets and the waveform are made in the same pass. If DRM applies, keys come through a cloud key proxy, so no DRM credentials live at the site.
5. **Store locally.** The source file is kept in the customer's archive storage (NAS or on-prem object store), registered as a site location of the asset with the site's local retention, for example *keep forever*.
6. **Deliver.** The worker uploads the packaged output to the primary cloud bucket using upload URLs scoped to that one asset. The site's working copy of the output is removed once the cloud has verified the upload. Only the source is kept on site.
7. **Verify and finish.** The worker reports completion. The cloud checks the uploaded master playlist, rendition count, segment count and checksums before marking the asset ready. Then the publishing policy takes over, `vod.encoded` fires, and the asset is in the Workflow report like any other.

**When the site is offline.** Jobs wait in the site's pool. After the placement's fallback time (for example 30 minutes) the agent uploads the source and the cloud encodes it instead. The asset page records that it was encoded in the cloud and why.

**Reprocessing later.** A re-encode or a new ladder runs at the site, where the source is. If the site has no workers available, the agent uploads the source for that job and the cloud does it. The asset page shows where each copy is, using the existing Storage view.

## Third-party on-prem encoders

Not in the first release: on-prem encoding uses Volt's encoder only. When a customer needs it, customers who want to keep using hardware or software they own plug in as a **VOD encode engine**, the same seam already built for live (`ENGINES.md`). The step in the flow above becomes *encode with engine X at site Y*. Everything before and after it is unchanged.

| Mode | How it works | Use when |
| --- | --- | --- |
| Volt encoder (default) | Our container on the customer's servers, as above | They have spare servers or GPUs and no encoder they want to keep |
| Hot folder, encode only (recommended for third party) | The agent copies the source into the vendor's watch folder with a job id in the name or a sidecar, watches the vendor's output folder, matches the result, then packages it locally with our packager | Most on-prem file encoders support watch folders; this needs no vendor API work |
| API adapter, encode only | An adapter submits jobs through the vendor's API, follows them through webhooks or polling, then packages as above | The vendor has a stable job API and the customer wants job-level status |
| Vendor packages (full) | We take the vendor's HLS or DASH as delivered | Only if the customer insists. The capability check warns what is lost |

**Why encode only is the default.** As with live, nearly everything Volt adds reads the CMAF our packager writes: DRM through our key path, captions on one clock, I-frame trick play, intro and outro cards, FAST reuse, thumbnails and QC. So the vendor makes the renditions and we package them. A capability check runs when the engine is chosen and again at each job, and refuses combinations that cannot work (for example a ladder above the vendor's maximum resolution).

**Hot folder adapters are configuration, not code**: input folder, output folder, how the job id is carried, the expected rendition naming, and a timeout. Vendor presets ship once tested against a real installation.

## Add-on: Mirror and Archive to external storage

A second premium add-on: copy source VOD files and recordings to storage the customer owns, starting with on-prem devices. It shares the site agent and job lease with Hybrid Sites but is sold and switched on separately, because many customers will want an off-cloud copy without moving any encoding.

**Storage targets.** A named destination the account owns:

| Target kind | Reached by | First release |
| --- | --- | --- |
| On-prem NAS or file share (SMB, NFS, local disk) | The site agent pulls from the cloud and writes locally | Yes |
| On-prem S3-compatible object store (MinIO, NetApp, Dell ECS and similar) | The site agent, through the target's S3 API | Yes |
| Another cloud bucket (customer's own S3, Wasabi, Backblaze, Azure Blob, GCS) | Cloud worker, cloud to cloud, no site needed | Next |
| LTO or a third-party archive or MAM | A NAS hot folder the archive system watches, or the add-on API contract | When a customer needs it |

**Copy rules.** What goes where and when, set per account, content type, channel or event, in the same rule ladder as publishing policies:

- **What:** uploaded source files, mezzanines, recordings (event runs and channel days), clips, and optionally packaged outputs and sidecars (captions, thumbnails, metadata as JSON).
- **When:** on ingest, when a recording closes, on publish, on a schedule, or as a retention ladder rung (*copy to archive at day 30*).
- **Mode:** **mirror** (keep the target in step, deletes included, after a grace period) or **archive** (copy and keep; never deleted by Volt).
- **Format for recordings:** consolidated files from the top-bitrate rendition only, joined without re-encoding, with a metadata sidecar. Where the channel has an EPG, one file per programme, cut at the programme's start and end. Without an EPG, one file per hour. File names are `Title-Channel-YYYYMMDD-HHMM` (no title for hourly files), with values separated by `-`, spaces removed and any character the target cannot store dropped, for example `MorningNews-Channel1-20261103-0600.mp4`. Times are in the channel's broadcast time zone, and a name that already exists gets `-2`, `-3` added.
- **Window and rate:** copy only in an off-peak window and within a bandwidth cap, so it never competes with live contribution.

**Safe archive.** Every copy is checksummed at the target and recorded as a storage location of the same object, so the Storage page shows each copy, where it is and when it was last confirmed. A retention rung can then say *delete from cloud only once an archive copy is confirmed*. If the copy is missing or fails its check, the delete waits and the console says why. Scheduled re-checks catch copies that later disappear or change.

**Restore.** From the Storage page, pull an archived copy back into the cloud: the site agent uploads it, the cloud verifies it, and the asset or recording is readable again. The same path lets an asset re-enter publishing.

**Same rules as the rest of this design:** outbound only from the site, downloads through short-lived URLs scoped to one object, nothing marked archived until verified, off unless licensed, and no change to cloud-only accounts.

## Not breaking anything

The same discipline used for the live engine seam: with the add-on off, the cloud path is byte for byte what it is today, and tests prove it.

- **Default pool is the cloud.** Jobs with no pool are cloud jobs. Cloud workers only claim cloud jobs, and site workers only claim their own pool. Existing rows need no backfill.
- **One handler, two halves.** `vod.encode` is split into plan (probe and ladder fit) and execute. In the cloud both halves still run in the same job, so its behaviour and output paths do not change. The existing VOD encode tests must pass unchanged before anything else lands.
- **Same encoder image everywhere.** Sites run the released `volt-encoder` image at a version the cloud pins. A site cannot run a newer or older encoder than the control plane expects.
- **Workers never touch the database.** Site workers use only the lease, progress, complete and upload-URL endpoints. A bug at a site cannot corrupt cloud state.
- **Nothing is ready until verified.** An asset only becomes playable after the cloud has checked what was uploaded, the same rule `vod.encode` already follows for its master playlist.
- **Off by licence.** No Sites page, no site watchfolder kind and no placement options appear unless the account holds the Hybrid Sites licence.
- **Live is untouched.** This covers file-based VOD only. On-prem live encoding is Volt Edge's job (`EDGE_CONTRIBUTION.md`).

## Security, operations and failures

**Security**

- **Outbound only.** The site agent calls the cloud over HTTPS. The customer opens no inbound ports.
- **Enrolment.** The console issues a one-time token per site. The agent exchanges it for its own credential, rotated from the console. Same model as Volt Edge.
- **Narrow credentials.** A site credential can lease only its own pool's jobs and get upload URLs only for the assets in those jobs. It cannot read other assets, other accounts or any admin API.
- **No DRM secrets on site.** Keys are fetched per job through a cloud key proxy and never written to disk.
- **Audit.** Enrolment, credential rotation, placement changes and fallbacks to the cloud are written to the audit log.

**Operations**

- **Sites page in Admin**: each site's health, agent and encoder versions, workers and their load, queue depth, local disk free, last contact, and recent failures.
- **Updates** are signed, pulled by the agent, staged and applied between jobs, never mid-encode. Rollback is one action.
- **Workflow report**: site stages appear on the map with their own success and error rates, so a slow or failing site is visible next to the cloud.

**Failures**

| Failure | What happens |
| --- | --- |
| Worker dies mid-encode | The lease expires (the queue's existing reaper), the job returns to the pool and another worker takes it |
| Upload interrupted | Resumable multipart upload carries on; the asset stays Processing until verified |
| Site offline | Jobs wait. After the fallback time, cloud encode if the policy allows, otherwise the asset says it is waiting for the site |
| Local disk full | The agent stops leasing, reports it, and the Sites page shows it |
| Verification fails | The upload is discarded, the job retries, and after its attempts it fails with the reason |

## Build plan and effort

About 10 to 14 build sessions of the size the recent FAST and SSAI builds took, covering Hybrid Sites and Mirror and Archive, plus a real test on a second machine. Third-party encoders are left out of the first release. The order delivers something sellable early and builds the riskiest part, the remote job lease, on the simplest job type first. Estimates are rough and assume no surprises in the encoder's portability.

| Phase | Delivers | Size |
| --- | --- | --- |
| 1. Sites, hosts and enrolment | Sites and hosts API, enrolment and credentials, host registration (CPU, GPU, disk) with approval, licence gate, Sites page, agent heartbeat and config pull | 2 sessions |
| 2. On-prem watchfolder, upload to cloud | `site` watchfolder kind, rules run in the agent, review queue in the console, the upload-and-encode-in-cloud placement. First sellable piece, for sites without encoders | 1 to 2 sessions |
| 3. Job lease, then Mirror and Archive | Job `pool`, HTTPS lease, progress and complete endpoints, scoped URLs; then storage targets (NAS, on-prem object store), copy rules, checksum verification, hourly consolidated recordings from the top rendition, copy-before-delete rung, restore | 4 to 5 sessions |
| 4. Site encoding | `vod.encode` split into plan and execute, site worker on the encoder image (CPU and GPU builds), source kept in the local archive, upload of the packaged output, cloud verification | 2 to 3 sessions |
| 5. Fallback, DRM and docs | Fail over to cloud encoding after the fallback time, cloud key proxy for site packaging, site stages in the Workflow report, guide pages, API reference, ops runbook | 1 to 2 sessions |
| Later | Third-party encoders (hot folder first), VM creation through the customer's hypervisor, cloud-to-cloud archive targets, signed auto-updates with rollback, Windows service, multi-server on-prem control plane | When a customer needs them |

**Testing without a second site.** The Mac setup can play both roles: the control plane as today, and the site agent and worker in Docker against a separate folder standing in for customer storage. The tests then add a kill-the-worker run, an offline-site run and a verification-failure run. After that, one run on a second physical machine on a different network, then the AWS staging stack as the cloud side.

**Why this order.** Phase 2 needs no remote workers, so on-prem watchfolders with cloud encoding can ship first. Phase 3 builds the job lease on copy jobs, which are simple to verify, before phase 4 puts encoding on it.

## Decisions (answered 3 Nov)

- [x] **Customer encoders:** do they want our encoder on their servers, or to keep a third-party encoder? If third party, which product and version, and does it support watch folders?for now let’s build option for our encode on prem
- [x] **Customer hardware:** Linux servers or VMs that can run containers? GPUs (NVENC) or CPU only? This sets throughput and whether phase 2 needs a GPU build of the worker. Support both cpu and gpu based vms or physical. We would need way to register the hw or give access to create VMs
- [x] **Local archive:** what storage (NAS path, on-prem object store, LTO behind a MAM), and should it keep the mezzanine, the packaged output, or both? I would we go with nas and on prem object for now as options and we only need to keep source file
- [x] **Mezzanine to cloud:** never, a proxy only, or the full file? This trades their bandwidth against the cloud being able to re-encode, clip and reframe without the site. What do you mean? They want to just create a simple action to upload local files to cloud for processing via cloud encoders if they don’t have local encoders
- [x] **Fallback:** if the site is offline, may Volt pull the source up and encode in the cloud, or must it wait? Fail over to cloud sound good
- [x] **DRM at site:** is a cloud key proxy acceptable to the customer's security team, or must keys come from an on-prem key service? Cloud key proxy
- [x] **Commercial model:** licence per site, per worker, or per encoded hour, plus a fixed deployment and configuration fee? Per site plus a deployment and setup Fee based on number of worker or hw / VMs required to be added.
- [x] **Mirror and Archive, first targets:** which on-prem storage do the first customers run (NAS share, MinIO or another S3-compatible store, an archive system's hot folder)? Nas and object store make sence
- [x] **Recordings in the archive:** segments as recorded, or one consolidated file per recording? Which container does their archive or MAM expect? Consolidated file with date time and channel details based on top bitrate source only based on time based segmentation
- [x] **Build order:** Mirror and Archive needs only the agent and lease parts of Hybrid Sites. Build it first if it is the easier first sale, or after the on-prem encoding flow? Don’t mind. You choose.

## Build status

| Phase | Queue | State |
| --- | --- | --- |
| 1. Sites, hosts and enrolment | H1 | Built (see below) |
| 2. On-prem watchfolder, upload to cloud | H2 | Built (see below) |
| 3. Job lease, then Mirror and Archive | H3 | Not started |
| 4. Site encoding | H4 | Not started |
| 5. Fallback, DRM proxy and docs | H5 | Not started |

**Phase 1 as built (H1).**

- **Licence.** `accounts.licences` (text array, empty by default) lists the add-ons an account holds: `hybrid_sites`, and `mirror_archive` for H3. Only the system admin sets it (`PATCH /api/platform/accounts/:id` with `licences`). Without `hybrid_sites`, `/api/sites` and `/api/site-agent` answer 403 `licence_required` and the console has no Sites entry. Withdrawing the licence deletes nothing.
- **Tables** (migration 0127): `sites`, `site_enrolment_tokens`, `site_hosts`, `site_credentials`. Tokens and credentials are stored as SHA-256 hashes only.
- **Enrolment.** The console makes a one-time token (`vsenrol_...`, 24 h by default, at most 7 days). The agent sends it with the host's facts to `POST /api/site-agent/enrol`; the host is registered as `pending` and the agent gets its own credential (`vsite_...`), shown once.
- **Approval.** A pending host may heartbeat and pull config but gets `work: waiting_for_approval`. Approve gives `ready`; reject revokes its credentials at once.
- **Heartbeat and config.** Every 30 s; stale after 90 s, offline after 10 min. Site health comes from approved hosts only (healthy, degraded, offline, no hosts, disabled). Each change an agent should pick up bumps `sites.config_version`; the heartbeat says when to pull `GET /api/site-agent/config`.
- **Credential scope.** A host credential opens only the three agent routes, for its own host. `requireAuth` refuses it, so no console or admin route can be reached with it.
- **Rotation.** `rotate-credential` makes a waiting credential; the next heartbeat hands it over (again on the next one if the agent missed it); the old one stops working the first time the new one is used.
- **Agent.** `volt-agent site enrol <server> <token> [state.json]` and `volt-agent site run [state.json]` (volt-agent/src/site.ts): cores, memory, NVIDIA GPUs through `nvidia-smi` (encode sessions from `VOLT_NVENC_SESSIONS`, otherwise unknown), free disk; state file mode 600.
- **Console.** Admin, Sites (volt-web/src/pages/Sites.tsx). Guide: docs-site/docs/guides/hybrid-sites.md.
- **Audit.** Sites, tokens issued and withdrawn, enrolment, approve and reject, rotation.
- **Not yet:** pools and work in the config (H3 onwards); signed agent updates; a hypervisor connection to create worker VMs.

**Phase 2 as built (H2).**

- **Folder kind `site`** (migration 0128): `watchfolders.site_id` and `placement` (`upload_cloud`; `encode_site` allowed by the schema for H4, refused by the API with 422 `placement_not_available`). Creating one needs the `hybrid_sites` licence and a site of the account; it bumps the site's config version. `GET /api/watchfolders/site-options` tells the console form what to offer. The server's own scan and ingest passes, and Scan now (409 `scanned_at_site`), leave site folders alone.
- **Rules run at the site, shared not copied.** The agent compiles volt-app's `services/watchfolder/scanner.ts` and `rules.ts` from their own files (volt-agent `tsconfig.json` rootDir is the repo), so the console's dry run and the decision at the site are the same code. `scanner.ts` gained an optional checksum hook so the agent hashes a file once while its size and mtime stay the same.
- **Agent routes** (approved host of the folder's own site only; a pending host gets 403 `waiting_for_approval`): `GET /api/site-agent/watchfolders` (folders with rules, as the scanner takes them), `/known`, `/quarantine-keys`, `/items` (one decision), `/uploads`, `/returns`, `/scanned` (`services/sites/siteWatchfolders.ts`, `modules/sites.ts`).
- **The cloud decides again.** A reported acceptance is classified with the cloud's copy of the rules; if they changed in between the report is refused (409 `rules_changed`) and the agent decides the file again next pass. A refusal is recorded as it happened (the file is already in the review folder at the site).
- **Review folder on site.** A refused file is moved into the folder's review folder at the site and never leaves the customer's network; the console queue lists it as for a local folder. A refusal whose report failed waits in the agent's outbox and is sent first next pass. Reprocess sets `watchfolder_items.site_action = 'return'`; the agent moves the file back and reports it, or the row returns to Needs review with why.
- **Upload and encode in the cloud.** `/api/site-agent/tus` (`modules/siteTus.ts`): the same tus server and upload sessions as `/api/tus`, opened only for an accepted item of the host's own site with the size it was accepted at, names and source taken from the item. The upload is kept on the item (`watchfolder_items.upload_session_id`), so a restarted agent, even with no state file, resumes from the cloud's offset. On the last byte the normal upload path runs (ingest rules with the folder as source, the VOD encode or Loops & Fillers), the asset is marked `source_kind = 'watchfolder'` and the item closes as In library with `vod_asset_id`.
- **Images, audio and companions from a site (H2b-5, v0.52.0).** Audio is a Media Library target, so it crosses as video does (uploaded as `audio/*`, an audio asset). Images, slates and companions are uploaded on the same tus path as a `site_file` upload (no asset of its own); on the last byte the SHA-256 is checked against the accepted file, the copy is put in the folder's staging root (`SITE_STAGING_DIR`, default `uploads-staging/site-watch/<folder>`) and taken in by the local-drop passes (`ingest.ts`, `slateIngest.ts`, `companionIngest.ts`, `imageAttach.ts`) over landed files only (`ingestSiteFolder`). That ingest runs again at every agent pass (`/scanned`), so a caption waiting for its video attaches when the video lands and goes to review after 24 hours with no scheduler of its own. A copy that is not on this server (another task, a replaced disk) is asked for again: the upload is taken off the item and the agent sends it next pass. A companion sent to review is moved into the review folder AT THE SITE (`site_action = 'review'`, migration 0131; `GET/POST /api/site-agent/watchfolders/:id/reviews`). Over its ceiling (images the folder's `max_ingest_bytes`, slates 64 MB, companions 25 MB) a file is not uploaded: failed, or review at the site. Site folders get all five default rules. Agent 0.4.0.
- **Agent 0.3.0** (0.4.0 from H2b-5: the review moves). `volt-agent site run` watches the site's folders beside the heartbeat (a pass every 15 s, never two at once), so a long upload does not make the host stale; its checksum memory and outbox live in the state file.
- **Console.** Watchfolders: New watchfolder offers On-prem, at a site (with the licence), the site and the path on the site's server; the folder page names the site, shows Where it is encoded and no Scan now; the queue shows Sent back rows waiting for the agent. Guides: `docs-site/docs/guides/watchfolders.md` (Create an on-prem watchfolder), `hybrid-sites.md` (Watch a folder at the site).

