# Volt changelog

Every release, every change: product, SaaS platform and internal. The customer-facing subset is published as the release notes in the docs.

## 0.128.2 (2026-11-12)

### Product (in customer release notes)

- fixed · Media Library: On a phone or a tablet, an asset opened from the Media Library list now opens in a panel that fits the screen (the whole screen on a phone), so its tabs, the Metadata form and Find details no longer sit off to the side of the list. The Preview tab's facts now sit under the player on a phone.

### Internal

- added: library-phone browser check: the Media Library list's open asset at 390, 768 and 1440 px, every tab at 390 and 768, the grid and a deep link at 390.

## 0.128.1 (2026-11-12)

### Product (in customer release notes)

- fixed · Watchfolders: On a phone or a tablet the Watchfolders page no longer runs off the side of the screen: rules, the add-rule fields, the queue and the folder list stack into cards, and long folder paths wrap.

### Internal

- added · Tests: watchfolders-phone browser check at 390, 768 and 1440 px.

## 0.128.0 (2026-11-12)

### Product (in customer release notes)

- added · Media Library: An archived title whose publishing policy sets Archive storage tier now has its media moved to Infrequent access or Archive storage, which costs less to keep. Restoring it from Archive storage says first that it takes about 5 hours and by when; the title stays archived until its media is back, then becomes a draft or is published as you chose.
- fixed · Storage: Moving a file larger than 5 GB to a cheaper storage tier no longer fails.
- added · Media Library: The Availability tab now shows when a title's publishing policy deletes it, its legal hold with the reason, and where an archived title's media is kept. A legal hold can be placed, with a reason, and released right there.

### Internal

- added · Tests: vod-archive-tier check suite (moto and Postgres) and the asset-retention browser check.

## 0.127.0 (2026-11-12)

### Product (in customer release notes)

- fixed · Storage: A title kept for a number of days by its own setting or by a metadata rule is now deleted when its days are up; before, only titles governed by a publishing rule were.
- added · Storage: Storage lists the titles their publishing policy deletes in the next 7, 30 or 90 days, says why a due title is kept, and is where a legal hold is placed with its reason and released.

## 0.126.0 (2026-11-12)

### Product (in customer release notes)

- added · Storage: Put a legal hold on a title with POST /api/storage/vod/{id}/hold, and see the titles retention deletes soon with GET /api/storage/vod-retention and what it did with GET /api/storage/vod-retention/log.
- added · Storage: Retention in a publishing policy now deletes titles: a title is listed seven days before its days are up and then moved to the restore bin, where it can still be restored. A legal hold, an open publish window, a FAST lineup or an archive copy that is not verified yet keeps it, and the list says which.

### Internal

- added · Storage: vod-retention check suite (56 assertions) for the title retention sweep, legal holds and the copy-before-delete rung.

## 0.125.0 (2026-11-12)

### Product (in customer release notes)

- added · Media Library: A Repackage pending filter lists the titles whose files do not yet carry what their publishing policy asks for (DRM on or off).
- fixed · Media Library: QC and frame stills of a DRM-protected title now read its original, so they no longer report a working title as unplayable; with no original on hand QC skips those checks and says why.

## 0.124.0 (2026-11-12)

### Product (in customer release notes)

- improved · Publishing Rules: Turning DRM on or off for published titles now works on cloud deployments too: the titles are packaged again under new addresses, so a CDN never mixes old and new files, and viewers already watching finish on the files they started with.

## 0.123.0 (2026-11-12)

### Product (in customer release notes)

- added · Publishing Rules: Confirming a DRM change on published titles now packages them again on their own, in the background and in batches: each title keeps playing with its current protection until its new files are complete, then switches. Before you save and the confirmation say about how long the jobs take.
- improved · Media Library: The Encode tab shows Repackage queued or Repackaging while a title is being packaged again after a DRM change.

### Internal

- added · Tests: publishing-repackage suite: repackage jobs on a confirmed DRM change, the swap, a failed repackage, batches and what waits.

## 0.122.0 (2026-11-12)

### Product (in customer release notes)

- changed · Media Library: A file whose policy asks for DRM is no longer packaged in the clear when your account has no DRM key service: its encode stops with the reason, and the upload band warns you first.
- added · Media Library: Uploaded files whose publishing policy asks for DRM are now encrypted when they are packaged (Widevine, PlayReady and FairPlay, with a key from your account's DRM key service) and get no MP4 download. The Encode tab names the DRM systems, and the upload band says before you add files whether they will be packaged with DRM.

### Internal

- added · Encoding: vod_encoder.py fetches SPEKE keys and passes Shaka the live encoder's cbcs flags for file encodes (dev/test_vod_drm.py); a FAST channel never reuses an encrypted main encode.

## 0.121.0 (2026-11-12)

### Product (in customer release notes)

- added · Media Library: A title's Encode tab now shows what its publishing policy asks of its files and marks it Repackage pending when the files do not match, for example a policy that asks for DRM over files packaged in the clear. Each new encode keeps the policy it was made under.
- added · Media Library: When you upload files, the upload band now shows the publishing policy they will get once you pick a content type: DRM on or off, access and whether they are published when ready, with the rule each comes from.

### Internal

- added · Tests: publishing-encode-policy check suite: the upload preview, the policy snapshot a real encode keeps, and Repackage pending on the Encode tab.

## 0.120.0 (2026-11-12)

### Product (in customer release notes)

- fixed · Collections: A collection row in your app left out a title a collection package locks, instead of listing it as premium. Removing a collection's access could also leave a title locked until the next background pass; it now changes at once.
- improved · Collections: A rule collection's row in your app leaves out a title another collection sells as a package in that app and country, as View as already showed; a title added by hand stays, listed as locked.
- added · Collections: Each app chooses how its collection rows treat a title a package locks: show it locked, with the package that unlocks it and what viewers can buy, or leave it out. Set it as Titles a package locks on the app in API Keys & Apps; rows follow the change at once.
- added · Loops & Fillers: Each QC finding on a slate or loop now shows stills from the preview at that moment (for a jump where a loop restarts, its last frame beside its first), plays that moment with one click, and can be accepted on its own, with a note. Accepted findings stay accepted when QC runs again, and once every error is accepted the item can be approved without a note.
- changed · Loops & Fillers: The actions on each row of the list are now icons, named when you hover: details (or review, for one awaiting approval), archive or make available, and delete.
- fixed · Loops & Fillers: Who approved, rejected or archived a slate or loop is shown by name or email, not as an id.

### Internal

- added · Tests: public-collections-locked suite: locked titles with their packages, upsell or hide per app, rule-collection exclusions and warm reads on the public collection answer.

## 0.119.0 (2026-11-12)

### Product (in customer release notes)

- added · Collections: Your apps can show a collection as a row or rail: GET /api/public/collections/{id} with the app's publishable key lists the collection's public titles in its order, each marked free, members or premium for that app and the viewer's country, and leaves out what the viewer's country or app may not see. Answers are cached by country group and update as soon as the collection or a title changes.

## 0.118.0 (2026-11-12)

### Product (in customer release notes)

- added · FAST: A FAST run order slot can now follow a collection: choose the collection in the library and Add as one slot. Each time the slot comes round it airs the collection's next title, in its order or shuffled without repeats, and titles you add to the collection join the guide without editing the run order. The slot says how many of the collection's titles can air on the channel and why the rest cannot.
- fixed · FAST: On a phone or narrow window, the FAST library no longer stays over the run order as you scroll down to it.

## 0.117.0 (2026-11-12)

### Product (in customer release notes)

- added · Collections: A rule collection now leaves out a title that another collection sells as a package, in the apps and countries where that package is asked, and View as says how many titles are left out and which package locks them. A collection you fill by hand keeps such a title and marks it with the package.
- added · API: GET /api/collections/asset-access/{assetId} answers what a viewer gets for one title from its collections. View as and a collection's items mark a title another collection sells as a package (lockedBy, leftOut), and the collection access routes are in the API reference.
- added · Media Library: The Rights tab of a title now shows Collection access: the collections it is in, what each asks where, what a viewer gets in any app and country, and a matrix of apps by regions.

## 0.116.0 (2026-11-12)

### Product (in customer release notes)

- improved · API: A play stopped by Concurrent streams can no longer carry on with its old addresses: within about a minute the CDN refuses its on-demand manifests and segments with 403 Playing on too many devices, while the viewer's other plays are untouched.
- added · Player: When a viewer's account starts more plays than a title's Concurrent streams allows, the Volt player on the oldest device now stops, says why and offers Play here to move the play back to it. Closing or hiding a player's page frees its stream at once.

### Internal

- added · Player: Tests: player-concurrent-stop-browser (the player's stop, Play here, the 409 and end on hide, in Chromium) and the edge stop cases in edge-tokens and publishing-concurrent-streams.

## 0.115.0 (2026-11-12)

### Product (in customer release notes)

- added · Publishing Rules: A publishing rule's Concurrent streams limit now applies to members-only and premium titles and channels: when a signed-in viewer starts more plays than it allows, their oldest play is stopped and the player is told why. Free content is never limited.
- added · Play gate: The play gate counts a signed-in viewer's plays where a Concurrent streams limit applies: the answer carries streams and sid, the viewer report of a stopped play answers stop with code concurrent_streams and the words to show, and a stopped play asking again gets 409.

### Internal

- added · Tests: New publishing-concurrent-streams check suite.

## 0.114.0 (2026-11-12)

### Product (in customer release notes)

- changed · Publishing Rules: A publishing rule's Sitemap and schema.org setting now applies: a title it turns off is left out of its schema.org data, so your portal, search engines and partners do not list it. A title whose MP4 download is off never has its MP4 file named in that data.

### Internal

- added · Tests: New publishing-sitemap check suite for the Sitemap and schema.org field and the MP4 in schema.org data.

## 0.113.0 (2026-11-12)

### Product (in customer release notes)

- added · FAST: A publishing rule's FAST eligible now applies: a title it turns off is not offered in the FAST library, a run order naming it is refused, and it leaves the guide of the channels it is in from the programme after the one on air.
- added · Media Library: Files can get subtitles made from their audio, by Whisper on the server or by an external add-on, and a short AI description when they have none. Turn them on for every file, for one watch folder or content type in Ingest Rules, or for one asset on its Files tab; AI descriptions is a new add-on with 500 a month.

## 0.112.0 (2026-11-12)

### Product (in customer release notes)

- added · API: POST /api/vod/bulk/availability applies a preset or a set of fields as many assets' own publishing rule, or clears it, checking each asset as PATCH /api/vod/{id}/availability does; refused assets are listed with why, and ?dryRun=1 shows the result without saving.
- added · Media Library: Set the publishing policy of many assets at once: tick them, choose Publishing policy, and apply a preset or clear their own settings. Before you save shows how many can take it and names any a locked rule keeps as they are; the rest are saved, and published ones take the change up within a minute.

### Internal

- added · Tests: publishing-asset-bulk suite (25 checks) and the publishing-bulk browser check (27 at 1440 and 390 px); the screenshot script can choose from a list (select).

## 0.111.0 (2026-11-12)

### Product (in customer release notes)

- fixed · Publishing Rules: A single item's own publishing rule can no longer set a field that the account, its content type, its channel, event or station, or a metadata rule has locked. Before, the value was saved and then ignored; now the save is refused and says which rule locked it.
- improved · Media Library: Before you save now checks a single item's own publishing rule too: whether it changes anything, conflicts such as DRM with MP4 download, and a confirmation before DRM changes on a published item.

### Internal

- added · Tests: publishing-asset-rung suite for the asset rung's lock refusal, dry run and confirmation.

## 0.110.0 (2026-11-12)

### Product (in customer release notes)

- added · Billing: AI Find details is a new add-on: 500 lookups a month for $15, with packs of 1,000, 5,000 and 20,000 more. When the month's lookups are used up, nothing more is sent to the AI model until a bigger pack is chosen or the month starts again.
- added · Media Library: Find details can read a page with an AI model: with the new AI Find details add-on on, Read with AI suggests values for a page that publishes no details for search engines, each with the sentence of the page it came from, for you to check and apply.

### Internal

- added · Tests: find-details-ai suite with a stand-in site and a stand-in Claude API; the add-on catalogue test looks its add-on up by key now that the catalogue ships with AI Find details.

## 0.109.0 (2026-11-11)

### Product (in customer release notes)

- added · Billing: Billing now lists your add-ons: turn one on, change its pack or turn it off, with what it costs shown before you confirm, and a meter of how much of this month's quantity is used and when it starts again.

### Internal

- added: System Admin > Billing gains the add-on catalogue (add and edit add-ons and packs, set one not offered) and each account's add-ons in its drawer; the docs seed has two add-ons.

## 0.108.0 (2026-11-11)

### Product (in customer release notes)

- added · Billing: Add-ons can be turned on, moved between packs and turned off through the API (GET, PUT and DELETE /api/billing/addons). Turning one on or moving to a bigger pack charges the full monthly price for the month; a smaller pack or off is at once with no refund; the included quantity starts again on the 1st. Add-on charges appear on your monthly invoice.

### Internal

- added: System Admin add-on catalogue API (add-ons with an included quantity, packs, licence link), monthly add-on renewals in the billing pass, allowance counting with a cached read, and the billing-addons check suite.

## 0.107.0 (2026-11-11)

### Product (in customer release notes)

- added · Billing: A new Billing page under Admin shows what Volt charges your account: this month so far, every invoice with its PDF and CSV, and how invoices are paid. Where invoices are charged to a card, Change card opens the payment provider's page to update it.
- added · API: POST /api/billing/portal answers a one-off link to change the card invoices are charged to, and GET /api/billing now says whether that is possible (paymentMethod).

### Internal

- added · Docs: Billing guide with screenshots, a staff guide for System Admin billing (volt-app/docs/BILLING.md), billing history in the docs seed, and billingOn shots in the screenshot script.
- added · System Admin: System Admin has a Billing tab: how each account pays and its tax rate, open invoices with Mark paid, charges and credits, the price list for server time, and closing a month by hand.

## 0.106.0 (2026-11-11)

### Product (in customer release notes)

- added · Billing: Where your invoices are charged to the card on file, each monthly invoice is now charged automatically; a failed payment is tried again and your owners and administrators are told, without your service being interrupted. Every invoice can also be downloaded as a PDF (GET /api/billing/invoices/{id}/pdf).

### Internal

- added · Billing: Automated invoices sent to Volt's Stripe account after the month closes, with idempotent keys and retries, paid and failed webhooks on the existing Stripe endpoint, a send-now route for the System Admin, and a small built-in PDF writer. New suite billing-stripe.

## 0.105.0 (2026-11-11)

### Product (in customer release notes)

- added · Billing: Where your Volt provider bills through Volt, your plan fee, server time and any agreed charges or credits are gathered into one invoice per calendar month, issued on the 1st. Read this month so far and your invoices, with their lines, through the API (GET /api/billing), and download any invoice as CSV.

### Internal

- added · Billing: System Admin billing API: billing mode per deployment (VOLT_BILLING), billing handling and tax per account, the append-only charges ledger, the customer price list, manual charges and credits, the monthly close and marking contract invoices paid. New suite billing-ledger.

## 0.104.0 (2026-11-11)

### Product (in customer release notes)

- changed · Media Library: schema.org data (GET /api/vod/{id}/schema.org) lists a title's plain video addresses only for a token-free title or, where play tokens are not enforced, a title with no country, rights, payment, sign-in, DRM, referrer or streams condition. Every other title lists only its watch page, so the data is no way round the play gate.

### Internal

- added · Tests: New schema-org-tokens suite: schema.org media addresses under enforce, issue and off for token-free, open and conditioned titles.

## 0.103.0 (2026-11-11)

### Product (in customer release notes)

- improved · FAST: Ads and house spots stitched into a viewer's FAST breaks now play where play tokens are enforced: they carry the channel's shared token, and a withdrawn ad stops within about a minute.
- improved · On-demand ads: Guided ads now play where play tokens are enforced at the CDN: the shared guided playlist names the title's segments through a shared token that outlasts the title, so a viewer who starts just before the token changes can still watch to the end. A withdrawn title's segments stop within about a minute.

### Internal

- added · Tests: New edge-shared-playlists suite: guided playlists and the FAST stitcher's pods under enforced play tokens, across a token rotation and a withdrawal.

## 0.102.0 (2026-11-11)

### Product (in customer release notes)

- fixed · FAST: FAST channels keep playing on deployments that enforce play tokens at the CDN: each channel's playlists carry a shared token that opens only the titles it airs, and a title withdrawn while in the guide stops within about a minute.

## 0.101.0 (2026-11-11)

### Internal

- added · API: Edge play tokens: a shared token that opens several titles for every viewer, rotating on a fixed clock, checked at CloudFront, the staging edge and the API (groundwork for FAST and guided ad playlists under enforce).

## 0.100.0 (2026-11-11)

### Product (in customer release notes)

- added · Media Library: Find details has a Search the web button: it opens a web search for the title in a new tab of your browser, so you can find the title's own page and paste its link back into Find details to read it.

### Internal

- added · Tests: New find-details-web check suite pins the web search address and that no search service, setting or key is added on the server.

## 0.99.0 (2026-11-11)

### Product (in customer release notes)

- added · Mirror and Archive: Copy rules can now mirror a storage target: when an item is deleted from Volt and leaves the restore bin, its copies at that target are deleted too, after a waiting period you set per target (7 days by default, 0 to 90). Volt never deletes a file someone changed at your site, recordings are always kept, a restore cancels anything waiting, and every delete is in the audit trail.
- added · Mirror and Archive: The Storage page shows each target's mirror waiting period and the deletes waiting there, and each copy says when it will be deleted or that it was removed. Publishing Rules has a Keep choice per target: Archive or Mirror.

### Internal

- added · Mirror and Archive: Site agent 0.13.0 runs archive.delete jobs (read back, then delete only what still matches). New suite mirror-archive-mirror; the Mirror and Archive console walk covers mirror mode.

## 0.98.0 (2026-11-11)

### Product (in customer release notes)

- improved · Mirror and Archive: Recordings of a channel, station or event whose copy rule archives recordings are no longer deleted by retention until the archive file covering them is verified at your storage target. The Storage retention list and the recording's page say why one is waiting.

### Internal

- added · Tests: retention-recordings-archive: the delete rung and a manual expiry wait for the recording's archive file with the reason, and go once it is verified.

## 0.97.0 (2026-11-11)

### Product (in customer release notes)

- improved · Mirror and Archive: When an encode or a FAST channel needs an original that a retention rule has taken out of the cloud, Volt now brings it back from the archive by itself and runs that work once it lands. The asset's page shows the original coming back and what waits for it.

### Internal

- added · Tests: retention-originals-reencode: a FAST Prepare (with and without a ladder), an encode handler and queueEncodeFor on an archived original start one restore and run once it lands.

## 0.96.0 (2026-11-11)

### Product (in customer release notes)

- added · Storage: An original taken out of the cloud can now be brought back from its archive copy with Restore under Originals out of the cloud: a server at your site uploads the copy and Volt checks it against the archived checksum before the asset uses it again. Needs site agent 0.12.0 or later.

### Internal

- added: retention-originals-restore suite (31 assertions) with the real site agent code; site agent 0.12.0 runs archive.restore jobs.

## 0.95.0 (2026-11-11)

### Product (in customer release notes)

- fixed · Storage: Saving the retention ladder no longer changes an asset or both rule back into a recordings-only rule.
- added · Storage: The account's retention rule can now cover uploads and watch folder files (Include uploads and watch folder files). New rules include them; rules you already have keep covering what they did until you tick the option.
- added · Storage: With Mirror and Archive, a retention rule can now take each original out of the cloud a number of days after it lands, once a verified copy of that very file is held at one of your storage targets. The renditions stay, so the title keeps playing; until the copy is verified the original stays and Storage says why and what to do.

### Internal

- added: retention-originals suite (51 assertions): the copy-before-delete verdict, the rung's API, the pass, reach and the console routes.

## 0.94.0 (2026-11-11)

### Product (in customer release notes)

- improved · On-demand ads: Stitched ads now play where play tokens are enforced at the CDN. A viewer's stream with ads carries that viewer's own tokens for the title and for each ad, so a copied address does not play in another country, and the stream stops when the title is withdrawn.
- added · FAST: FAST channels report who saw what, and replace for DASH too: Build > Brand & filler > Rights delivery lists every scheduled programme with the viewers who saw it, saw the geo replacement, or were refused, in total and per country, for today, the last 7 or the last 31 days (also GET /api/fast/channels/{id}/rights-report). Viewers are counted in memory as they play and written once a minute without slowing playback or locking the database. DASH viewers outside a title's rights now get the geo replacement as HLS viewers do.

### Internal

- added · Tests: New check suite vod-ads-enforce: stitched HLS and DASH sessions under enforce end to end, tokens per folder and country, the withdrawn refusal, guided ads, issue and off.

## 0.93.0 (2026-11-11)

### Product (in customer release notes)

- added · Loops & Fillers: Every new slate and loop gets a house preview: it is built by the same encoder and packager your streams use, in your house format, and plays continuously in the console so you can see whether its join is seamless. QC checks the preview (black, silence, loudness, the cut to whole segments, a jump or click where the loop restarts, upscaling, bars, frame rate and interlacing), and each finding jumps to its place in the loop.
- added · Loops & Fillers: Search, pages of 25, tags and an Active or Archived filter on Loops & Fillers. Archive keeps a slate or loop but takes it off every picker, and is refused while a stream uses it.
- added · Loops & Fillers: Slates and loops are approved or rejected before use. Channels, radio stations, events and FAST channels can only be given approved, active ones; a stream keeps the one it already has. Existing slates and loops count as approved.
- fixed · Loops & Fillers: The hover preview of a loop no longer flashes black or jumps where it wraps: its sprite sheets claimed one frame more than they held, and moving between sheets could blank the picture. Older loops' previews are made again automatically.
- added · Publishing Rules: Token-free playback: a publishing rule can let titles anyone may watch play by their plain address, without a play token, even where play tokens are enforced. It cannot be turned on where geo, rights, DRM, a paywall, sign-in, allowed referrer domains or a concurrent streams limit apply, and a title that gains one of these plays with tokens again.
- changed · Publishing: Where play tokens are enforced, clips cut from recordings are protected like other on-demand titles: their files are refused by plain address and play only through the address the play gate, the console or a share page hands out. Recording download links now carry a token too, valid for four hours.

### Internal

- added · Testing: New edge-clip-outputs suite: clip output folders under enforce at the API, the staging edge and CloudFront, the recording export's links, token-free clips; the staging nginx plain-path location is quoted so its regex loads.
- added · Testing: New edge-token-free suite and token-free browser check; the edge-tokens-enforce window-end check no longer fails on rounding.

## 0.92.0 (2026-11-11)

### Product (in customer release notes)

- added · Playback: Operators can now enforce play tokens: with VOLT_EDGE_TOKENS=enforce (edge_tokens = "enforce" on AWS), a plain on-demand address with no token is refused at the CDN, the staging edge and the API, so the play gate's address is the only one that plays.
- improved · Media Library: Previews in the Media Library and Skip markers, and share pages, play through play tokens, so they keep working when tokens are enforced. A share page's video stops when the link expires or the title's window ends, whichever is first, and plays in the country where it was opened.
- improved · API: The API reference now describes the play gate's 451 answer (code, message, notify), Notify me (POST /api/public/availability/notify), the rights demand report (GET /api/analytics/rights-demand) and the preview addresses on GET /api/vod/{id}.

### Internal

- added: edge-tokens-enforce suite and the edge_tokens Terraform test; the staging nginx passes checked token requests on to the API.

## 0.91.0 (2026-11-11)

### Product (in customer release notes)

- added · API: New on-demand routes: PUT /api/vod/{id}/availability (Listed from, Unlisted), POST /api/vod/{id}/archive and /unarchive, and POST /api/vod/{id}/evaluate (who can watch). GET /api/vod and GET /api/vod/{id} carry the public status, and the list filters on public_status and expires_within_days.
- added · Media Library: The Availability tab now shows what viewers get: the public status and why, a timeline of the title's life with today marked, Listed from and Unlisted, Archive and Restore, and Who can watch, which tests a country, a kind of viewer and a date against the real play decision.
- added · Media Library: The library has a Public status column and filter, including Expires in 7 days for titles about to stop being available.
- fixed · Guides: The links from the FAST from the library workflow to the FAST guide's run order and ads sections open those sections again.

### Internal

- fixed · Tests: vod-library-pure expects the eight on-demand content types, including Trailer, Music video and Bug.
- added: vod-lifecycle-api suite: the status in the admin API, listing, archive and restore, and the who-can-watch tester held to the play gate for every status.

## 0.90.0 (2026-11-11)

### Product (in customer release notes)

- added · Media Library: Titles from an Encode at site watchfolder show At site beside Building in the Media Library and on their page, with Queued at site or Encoding at site and the site's name. A title that fell back to the cloud shows Sending to cloud or In the cloud, and its Facts and Encode tab say why it was encoded in the cloud.

### Internal

- added · Tests: New encode-place check suite: the VOD API's encode_place answer for site-kept assets, driven by the real site agent.

## 0.89.0 (2026-11-11)

### Product (in customer release notes)

- added · Media Library: Find details now reads a page you paste as well as searching Wikidata: paste the link to a title's own page (a studio's film page, a broadcaster's episode page, a news article, a podcast episode) and Volt reads the details it publishes, maps them to the content type's fields and shows them to tick, each applied field remembering the page it came from.

### Internal

- added · Docs: The screenshot script can type into a field between clicks and start a shot from a fresh page; new find-details-page suite and browser check.

## 0.88.0 (2026-11-11)

### Product (in customer release notes)

- improved · EPG: A guide now shows the image of its channel, station or event at the top and beside every programme in the List and Timeline views, unless the programme has its own image. Events show the image from their details in the EPG list too, and a station's guide is called a station guide.
- added · Media Library: Read from file name now splits the file name into its parts and lets you choose a field for each one, for names the reading misses: 21_josh-woodward_saboteurs_1080p.mp4 can fill Artist with Josh Woodward and Title with Saboteurs. For songs and music videos Volt suggests the artist and title for you to check.
- fixed · Captions: Whisper captions now appear on servers that cannot add a GPU server, such as a single on-site server: a profile set to small or larger, the default, runs as base in the encoder instead of waiting for a GPU server that never starts. The Captions settings say which models run where.
- improved · Media Library: Better automatic images for videos: Volt now looks at about three times as many frames, keeps the best twelve from different shots, and prefers clear, well-lit faces over close-ups of hands or empty rooms. Dark, moody frames with lit highlights are no longer thrown away as black. Use Rebuild from source to redo an existing asset.
- added · FAST channels: FAST channel idents can now play after every few programmes instead of after every one: on the channel's Brand tab, choose Idents between programmes and set "Play an ident after every N programmes". The titles in between run back to back as a group and the ident closes it, which suits short titles. The ident lands in the same place on every re-plan, and the count starts again at the daily restart. Apply the lineup after changing it so the guide makes room.
- improved · Console: Numbers no longer shift as they change: every digit in the console and the player now takes the same width, so live clocks, counters and bitrates stay still and columns of figures line up.
- fixed · Media Library: Subtitle and metadata files dropped in the Media Library uploader are attached to their video by name, the way a watchfolder does it (Elephants_Dream_zh_tw.vtt goes with Elephants_Dream.mp4, in the same drop or already in the library), instead of each becoming a video queued to encode. A caption with no video named like it is shown as not attached, with the reason. Opening a VOD upload for a caption or sidecar file is now refused on every path, the API included. Lower case language names keep their region or script, so zh_tw, zh-hant and pt_br become Chinese (Taiwan), Chinese (Traditional) and Portuguese (Brazil) rather than plain Chinese or Portuguese.
- added · Media Library: Use this frame as the image: pause the preview on any frame and make it the asset's image. The exact frame is saved to the Image Library and is not replaced by an automatic pick.
- added · Media Library: Remove several assets at once from the Media Library bulk bar. The dialog lists what goes and what cannot (an asset in an active FAST lineup), you type the number to confirm, and everything goes to Storage > Recently removed with Undo. Library deletes, single or bulk, are now kept for 2 days before the hourly cleanup deletes them for good (VOLT_LIBRARY_TRASH_DAYS). A new account setting, off by default, sends bulk actions by people below administrator to an administrator or owner to approve first. In production storage the packaged HLS and DASH in the origin bucket now go into the bin too: before this they stayed in the bucket, still playable, and were never cleaned up.
- added · Media Library: Find details on any asset: on the Metadata tab, Find details looks the title up and shows what it found beside what the asset has. Films, episodes and every other content type search Wikidata, matched to your fields by their schema.org names; songs and music videos use Find song details. Only the fields you tick change, and each remembers where it came from.
- improved · Media Library: Find song details now works on music videos too. A music video keeps its type and its picture; the album cover is offered, not chosen for you.

### Internal

- fixed · Mac run: run-on-mac.sh repairs a captions virtual environment that lost its bin folder, using the matching Python and keeping the installed packages, and tells the native encoder it can run captions.

## 0.87.0 (2026-11-11)

### Internal

- added · Deploy: HTTPS, certificates and DNS from one input: set domain_name (and route53_zone_id when Route 53 hosts it) and Terraform makes api., cdn., img. and origin.<domain>, DNS-validated certificates for CloudFront and the ALB, an HTTPS listener with port 80 redirecting, HTTPS from CloudFront and the encoders to the ALB, and the DNS records (or lists them to create by hand). With no domain the stack is unchanged (deploy/terraform/dns_https.tf, APPLY.md step 3).

## 0.86.0 (2026-11-11)

### Product (in customer release notes)

- added · API: GET /api/collections/{id}/access now gives each app a ruledOut count: how many of the collection's titles its rights keep out of that app, with a few of their titles.
- added · Collections: Set who can watch a collection from its page: choose the apps and territories it applies to, then region by region whether viewers need nothing, to sign in, or a package, with the package's products and an app's own store prices. A sub-collection shows what it inherits, and apps the rights of every title keep out are greyed with the reason.
- added · Collections: View as on a collection shows what a viewer gets for each title in an app and a country (not signed in, signed in or holding a package): plays, sign in, locked with the packages and prices that unlock it, or blocked by rights, and which collections decided; below it, a matrix of your apps by regions.

## 0.85.0 (2026-11-10)

### Product (in customer release notes)

- added · Publishing Rules: Metadata rules: give a policy to every title whose metadata, tags, collections or source meet a set of conditions, for example every title tagged premier-league. The first rule a title meets applies, so you set the order by dragging; it wins over the content type and the channel, event or station the title came from, and Test a title shows which rule a title meets and what it then gets. Published titles take up a change within a minute.

### Internal

- added · Publishing Rules: publishing-metadata-rules check suite (54 assertions) and the docs seed's two metadata rules for the guide screenshots.

## 0.84.0 (2026-11-10)

### Product (in customer release notes)

- added · Collections: A collection can now be sold as a package, or limited by app and region: choose the apps and countries it applies to and, region by region, whether its titles are free, need viewers to sign in, or need a package bought, priced per app. The strictest collection a title is in wins in each app and country, buying any of the packages that lock it unlocks it, a sub-collection can only tighten its parent's access, and a title whose rights rule out the collection's access is refused with the reason. Set through the API for now, with View as to check what a viewer gets.
- improved · Play gate: A title locked by a collection package answers 402 with the packages that unlock it and the products the viewer's app sells, and a members-only collection answers 403 to sign in.
- added · FAST: FAST channels apply each title's rights where viewers are: while a channel airs, a viewer outside a title's territories, FAST rights or rights window (or the geo of its publishing plan) sees the channel's geo replacement for that programme, then the channel again. Choose the replacement, a loop or slate from Loops & Fillers, under Build > Brand & filler, where the programmes restricted in the next two days are listed. Settings has a new Where it can be watched for the whole channel. The FAST guide is rewritten to cover every tab and option, with examples of what each does on air.

## 0.83.0 (2026-11-10)

### Product (in customer release notes)

- added · Publishing Rules: A publishing rule's playback token lifetime and allowed referrer domains now apply when titles are played: a player on a site the rule does not list is told the title is not available on this site, and play links last as long as the rule says.
- added · Publishing Rules: Turning off MP4 download or share links in a publishing rule now stops the MP4 being downloaded (in Downloads and from share links) and stops share links being made or opened for the titles it governs, including titles already published.
- improved · Media library: Episodes show their series and season, and the title you save is the asset's title: library cards and rows show what an item belongs to above its own title ("Caminandes (S1)" over "Episode 2"), the asset drawer's header reads "Caminandes (S1) · Episode 2", and changing the Title in the metadata now renames the asset everywhere instead of leaving the name the file arrived with. Assets saved before this are brought into line once.
- fixed · Loops & Fillers: Loops & Fillers shows the FAST channels that play an item: a loop or slate chosen as a FAST channel's brand loop, slate or ident is listed under Used by (on the list and on its details page) with what the channel uses it for and whether the channel's copy is ready, instead of reading "Not used".
- fixed · Recordings: A channel with recording off no longer collects empty recordings: starting it and the daily roll-over no longer open a day's recording when recording is off, and the empty ones already made (nothing recorded, nothing cut from them) are removed. Days recorded before recording was turned off are kept as they were.

### Internal

- added · Tests: New check suite publishing-delivery (47 checks): the protection and distribution fields applied at the play gate, downloads and share links, taken up after a rule change, with no database read on a warm gate.

## 0.82.0 (2026-11-10)

### Product (in customer release notes)

- changed · Publishing Rules: A saved publishing rule now reaches titles that are already published within about a minute, without publishing them again: dates, geo access, access and paywall change on them, and Before you save says how many published titles take the change up and how many become unavailable now. Where a title was published and its DRM are kept, and nothing is posted to social accounts again.
- improved · Player: Clearer skip buttons and a documentation icon: the player's 10-second back and forward buttons now show the "10" inside the arrow with space around it, so it no longer looks cut off, and the documentation button in the console's top bar is now an open book instead of a question mark.

### Internal

- added · Publishing Rules: publishing-restamp check suite (39 checks) and P3-4 steps in the publishing policies browser check.

## 0.81.0 (2026-11-10)

### Product (in customer release notes)

- fixed · Publishing Rules: A dry run of a publishing rule no longer counts every title as changed when the rule is saved again unchanged.
- added · Publishing Rules: Before you save, a publishing rule is checked as you change it: how many titles it governs and changes, conflicts that stop the save (such as DRM with MP4 download) and warnings that do not. Turning DRM on or off for published titles asks first, with the number of titles to package again.
- added · Publishing Rules: Publishing Rules are laid out as the five sections of a policy (Lifecycle, Access, Protection, Distribution and Retention), with DRM, playback token lifetime, WAF profile, referrer domains, concurrent streams, MP4 download, share links, FAST, sitemap and retention fields. Each field has a padlock: a locked field cannot be changed by the content types, streams or items beneath it, and they show who locked it. Start a rule from a preset (Open, Members, Geo-locked, Premium, Rights-managed).

### Internal

- added: Browser check volt-web/test/publishing-policies.browser.mjs (with its seed) for the publishing policy editor: sections, locks, presets, conflicts, impact and the repackage confirmation at 1440 and 390 px.

## 0.80.0 (2026-11-10)

### Product (in customer release notes)

- added · Publishing Rules: Publishing rules now have protection, distribution and retention sections (DRM, WAF profile, token lifetime, MP4 download, share links, retention and more), each resolved field by field. A rule can lock fields so the rules beneath it cannot change them, start from one of five presets (Open, Members, Geo-locked, Premium, Rights-managed), and is checked for conflicts before it is saved, with a dry run that shows how many titles it governs and changes. Available through the API; the console screens follow.

### Internal

- added · Publishing Rules: test/publishing-policies.check.ts: sections, precedence, locks, presets, every conflict rule built, dry run counts, the repackage confirmation, tenancy and a dry run over 5,000 titles (73 checks).

## 0.79.0 (2026-11-10)

### Product (in customer release notes)

- added · Analytics: A new Rights demand view in Analytics shows who was turned away for a region or the rights: a world map and ranked tables of blocked viewers by country and title, the daily trend beside the plays where each title is licensed, and a CSV download. Choose a title to see its window, where it is licensed and where it is wanted.

### Internal

- added · Analytics: Browser check for the Rights demand view (volt-web/scripts/check-rights-demand.mjs, 36 checks at 1440 and 390 px) and thirty days of refusals in the docs seed.

## 0.78.0 (2026-11-09)

### Product (in customer release notes)

- added · Analytics: Volt now counts every viewer turned away for a region or for the rights, per title and country, beside the plays where the title is licensed, and titles asked for after their window closed. Read it with GET /api/analytics/rights-demand, as JSON or CSV; the report in the console follows.

### Internal

- added · Analytics: rights-demand suite (40 checks): refusals counted with no write until the minute's flush, the edge's country refusals, unique viewers by hash, the report and CSV, tenancy. cdn-logs now expects five logged CDN behaviours (P2's tokenised /t/*).

## 0.77.0 (2026-11-09)

### Product (in customer release notes)

- improved · Delivery: A refused on-demand address at the CDN now says why in plain words: This link has expired, Not available in your region, No longer available.
- fixed · Play gate: A title whose own access is paid now answers 402 with its offers instead of 451 not available, and members-only and group refusals from the POST gate now carry their mode and words instead of a bare error. Refusals carry a message to show, and Scheduled titles carry until.
- added · Rights: Choose what viewers see where a title cannot play: set your own block message on the Rights page (Not available in your region by default), and offer Notify me if it becomes available. Every player gets the same words from the play gate's 451 answer, and the Rights page shows who is waiting, per title.

### Internal

- added · Tests: block-message suite (39 checks): every refusal code and body, the block message on the Rights page, Notify me stored and refused where it should be, the Volt player showing the gate's words, a warm 451 with no database read; edge-tokens checks the refusal words at both edges.

## 0.76.0 (2026-11-09)

### Product (in customer release notes)

- added · Playback: On-demand play addresses now carry a signed token that the CDN checks on every request. A copied link stops working in another country, at the end of the title's window, and within about a minute of the title being withdrawn or archived. Players need no change: play the addresses the play gate returns as they are.

### Internal

- added · Playback: edge-tokens suite (60 checks): the token library, the CloudFront Function and the staging njs edge on the same cases, the play gate with tokens off and on, revocation and the edge store sync. Staging nginx loads njs and checks /t/ paths; Terraform edge_tokens variable and /t/* behaviours.

## 0.75.1 (2026-11-09)

### Internal

- improved · Playback: The play gate keeps an on-demand title's ad rule and asset row in the viewer-path cache, so a warm start reads nothing from the database; a saved or removed rule is announced by a new trigger (migration 0150) and dropped at once.

## 0.75.0 (2026-11-09)

### Product (in customer release notes)

- added · Media Library: Every title now has a public status worked out by Volt, with the reason and when it changes next: draft, in review, processing, scheduled, available, restricted by its rights, expired or archived. It follows publishing, withdrawing and the end of a window within a minute, and is ready for the Availability tab coming next.
- changed · Play gate: Only published titles that are available now are public. The play gate and the access check answer a draft, a title in review, still processing, outside its rights, expired or archived exactly as an id that does not exist (404), so nothing about unpublished content can be learned from them. A title announced ahead of its release answers 403 with mode scheduled and when it opens.

### Internal

- added · Tests: public-status.check.ts: every public status, the public visibility rule on every public route, the sweep and a warm play gate with no database reads.

## 0.74.0 (2026-11-09)

### Product (in customer release notes)

- added · Documentation: New guide, Copies of your media at your own sites: Mirror and Archive from end to end, from a site and a storage target through copy rules to verified copies, with object-store keys, recordings in the archive, re-checks, troubleshooting and the API in one place. The Sites guide now points to it.
- added · Documentation: New page, Running a site, for whoever runs the servers at a site: installing and enrolling the agent, running it as a service, upgrading, credentials, shares and storage, reading its logs, and what to check when a site goes quiet.
- fixed · Documentation: The API reference no longer shows a raw storage address in the storage targets description, the Collections guide renders again, and a broken link in the on-demand ads guide is fixed.

### Internal

- added: Engineering guide docs/engineering/site-agent-api.md, the reference for every site agent route, held to the app by the new site-agent-api check suite (14 assertions); the route inventory now lists the two Encode at site fallback routes.

## 0.73.0 (2026-11-09)

### Product (in customer release notes)

- fixed · Workflows: Copies to your own storage were left out of the Workflows report altogether, and encodes at a site were listed only under Other background work; both now count on their stage, including days already reported.
- added · Workflows: Work done at your own sites now shows on the Workflows map and in its report, in a new Your sites lane: Encode at site for Hybrid Sites, and Archive copies for Mirror and Archive, each with its runs, error rate, times, retries and most common error. Each add-on brings only its own stage.

## 0.72.0 (2026-11-09)

### Product (in customer release notes)

- added · Hybrid Sites: An Encode at site watchfolder can now fall back to the cloud. Set If the site does not encode it to a time from 15 minutes to 1 day: when no server of the site has started an encode in that time, the site's agent sends the original and Volt encodes it in the cloud, recording why in the audit log. By default the item still waits for the site and the original never leaves your storage.

### Internal

- added · Hybrid Sites: Site agent 0.11.0 sends an original Volt asks for on the resumable upload (GET and POST /api/site-agent/watchfolders/:id/fallbacks); test/site-fallback.check.ts.

## 0.71.0 (2026-11-09)

### Product (in customer release notes)

- added · Hybrid Sites: Files encoded at a site now get their ingest sidecar too: when your ingest rules write a .json or .xml sidecar, the site agent writes it beside the original at the site, naming the file as it is there. The watchfolder does not take it in again, and a file of that name you already have is never replaced.

## 0.70.0 (2026-11-09)

### Product (in customer release notes)

- added · VOD: A video whose original stays at one of your sites can now go on a FAST channel that has its own ladder: the site packages it to that ladder, and the title keeps airing its current version until the site's copy has been checked.

### Internal

- added · VOD: New check suite site-ladder-variant: a FAST ladder variant made at a site, from Prepare to the verified package and its row.

## 0.69.0 (2026-11-08)

### Product (in customer release notes)

- improved · Hybrid Sites: When a FAST channel needs a video from an Encode at site folder encoded again, Prepare now sends the encode to the site that keeps the original instead of reporting that there is no source.
- fixed · Hybrid Sites: When a site re-encoded a video, the copies already packaged for a FAST channel's ladder were removed with the old version; they are now kept.

## 0.68.0 (2026-11-08)

### Product (in customer release notes)

- added · Hybrid Sites: Encode at site now works on Volt's cloud: a site's server sends the finished streams straight to Volt's storage, each file held to its checksum, and Volt checks the whole package before the video is ready. Previously this needed a single-server Volt.
- improved · Hybrid Sites: The site agent (0.9.0) sends large files from disk as it reads them, so a server no longer needs memory for the biggest file of an encode.

### Internal

- added · Tests: site-encode-bucket.check.ts: a site encode end to end into an S3 bucket (moto), with changed and missing files refused, streamed uploads and the staging clean-up.

## 0.67.0 (2026-11-08)

### Product (in customer release notes)

- added · Hybrid Sites: On-prem watchfolders can now be set to Encode at site: video and audio are registered in the Media Library and encoded by your site's servers, only the finished streams are uploaded, and the original stays on your storage. Images, captions, slates and loops in the same folder are still uploaded.

### Internal

- added · Hybrid Sites: site-encode-placement check suite: registration without upload, the ingest on the site's facts and the encode at the site, end to end with the real agent.

## 0.66.0 (2026-11-08)

### Product (in customer release notes)

- added · Sites: Site servers can now be made ready to encode at a Hybrid Site: started with the Volt encoder image, the agent runs the encoder in Docker on the server where the file sits and sends only the finished streams to Volt, which checks every file before the video plays. Encodes planned for an NVIDIA graphics card go only to servers that have one. Choosing Encode at site on an on-prem watchfolder follows in a later release.

### Internal

- added · Sites: Site encode jobs whose server stops reporting drop their half upload, and on the last attempt the asset says why; new site-encode-worker suite runs the real agent worker against the API.

## 0.65.0 (2026-11-08)

### Internal

- added · Hybrid Sites: Site encoding, the cloud side: vod.encode is split into a plan step and an execute step, and a site can probe and encode a file and hand back only the package, which the cloud verifies before the asset plays. The site worker and the Encode at site placement follow in H4-2.

## 0.64.0 (2026-11-08)

### Product (in customer release notes)

- improved · Mirror and Archive: Copy rules can now copy an item's HLS/DASH package into an S3-compatible store at your site, such as MinIO, as well as to a folder: every playlist and segment goes under one folder in the bucket, each object read back, and nothing already in the store is ever replaced. A package that cannot be finished leaves nothing behind.

### Internal

- added · Mirror and Archive: mirror-archive-packages now 69 checks: packages into a real S3 API (moto with signatures checked) by the real site agent, the whole folder to -2 when its name is in use, a 412 race, every object removed when a package is not whole, store re-checks; console walk 75 checks.

## 0.63.0 (2026-11-08)

### Product (in customer release notes)

- added · Mirror and Archive: Copy rules can now copy an item's HLS/DASH package to a folder at your site: tick HLS/DASH package on a storage target and every playlist and segment goes there as one folder that plays as it is, each file read back. The box says what it costs in room: usually about 1.7 times the original.

### Internal

- added · Mirror and Archive: mirror-archive-packages check suite (52 checks with the real site agent): a package copied as one folder job, every file read back, an incomplete or changed package never counted as archived, folder re-checks; console walk 72 checks.

## 0.62.0 (2026-11-07)

### Product (in customer release notes)

- added · Mirror and Archive: Copy rules can now copy clips cut from a recording (clips, full-event replays and exports): tick Clips on a storage target and each clip's file goes there exactly as Volt made it, with a metadata file beside it, named Title-Channel-date-time, when the clip is made, when it is published or nightly.
- added · Image Library: Rename an image from the Image Library: open it and choose Rename. Everything that uses it, such as channel slates and asset posters, follows the new name, and links to the old name keep working.
- fixed · API: Renaming or moving an image with PATCH /api/files/{id} now updates everything that uses it and keeps its old address working, and renames all files of a video item together.

### Internal

- added · Mirror and Archive: mirror-archive-clips check suite (37 checks with the real site agent); mirror-archive-console browser walk extended to 66.

## 0.61.0 (2026-11-07)

### Product (in customer release notes)

- added · Mirror and Archive: A new Nightly option on each storage target copies, once a day, anything the rule covers that the target does not hold yet, including items that came in before the rule existed. Nightly copies wait for the off-peak window.
- added · Mirror and Archive: Copy rules can now copy an item's sidecars beside its original: a metadata file, the caption files as they were delivered, other files that came with it, and its poster, each named after the original. Tick Sidecars under Copy for a storage target in the Archive copies field.

### Internal

- added · Tests: New mirror-archive-sidecars check suite (36 checks with the real site agent) and seven more steps in the Mirror and Archive console browser walk.

## 0.60.0 (2026-11-07)

### Product (in customer release notes)

- added · Recordings: With the Mirror and Archive add-on, copy rules can now archive your recordings to storage at your own sites: one file per programme (or per hour when a channel has no guide), picture and sound exactly as recorded, with a metadata file beside it. Tick Recordings under Archive copies in Publishing Rules.

### Internal

- added: Check suite mirror-archive-recordings and a longer Mirror and Archive console browser walk.

## 0.59.0 (2026-11-07)

### Product (in customer release notes)

- added · Collections: A rule collection keeps what people add by hand, and leaves out what people take out until someone lets it back in. Any collection can now be ordered by hand or by a field: title, newest or oldest, first aired, or length.
- added · Collections: Rule-based collections. Give a collection rules (for example: genre is Sport and first aired in the last two weeks) and it keeps itself up to date: new and changed media joins or leaves within seconds, and every rule collection is checked in full each night. Rules test title, genre, tags, length, content type, rights profile, provider, dates and your content types' own fields, with all or any and groups, and show how many titles match as you write them.

### Internal

- added · Tests: collection-rules suite: every operator of every field type, groups, manual and left-out media, re-matching on change, the nightly and stale re-checks, and a timed full match over 100,000 assets.

## 0.58.0 (2026-11-07)

### Product (in customer release notes)

- added · Account: Mirror and Archive is now in the console: the Storage page lists your storage targets at your sites and every copy with its state, why a copy is waiting and what to do, and you can add or change a target and check a copy again with one click.
- added · VOD: Publishing rules have an Archive copies field for accounts with Mirror and Archive: choose which storage targets an original is copied to, when it lands or when it is published, and an optional off-peak window.
- improved · Account: Sites is in the menu for accounts with Mirror and Archive alone, and Volt can switch the add-on on for an account in System Admin.

### Internal

- added · Tests: Browser walk of the Mirror and Archive console (volt-web/test/mirror-archive-console.browser.mjs) and Mirror and Archive data in the docs seed.

## 0.57.0 (2026-11-06)

### Product (in customer release notes)

- added · Mirror and Archive: Archive copies can now go to an S3-compatible object store at your site, such as MinIO or NetApp StorageGRID, as well as to a folder or NAS share. The store's keys stay on your site's server and are never sent to Volt; every copy is read back from the store and checked against the original before it counts, and nothing in the store is ever overwritten.

### Internal

- added · Site agent: Site agent 0.6.0 writes to S3-compatible stores with its own Signature V4 signer (checked against the AWS SDK), single PUT or multipart, If-None-Match on every write; new check suite mirror-archive-s3 runs against moto with IAM auth when ARCHIVE_S3_TEST_ENDPOINT is set.

## 0.56.0 (2026-11-06)

### Product (in customer release notes)

- added · VOD: With Mirror and Archive, publishing rules can now copy an item's original to your storage targets as soon as it is ingested or when it is published, optionally only inside an off-peak window. Each storage target also re-checks its copies on a schedule (every 30 days unless you choose otherwise), so a copy changed or removed at the site is found without anyone asking.

## 0.55.0 (2026-11-06)

### Product (in customer release notes)

- added · Sites: Mirror and Archive (add-on): keep a copy of an asset's original on a folder or NAS share at one of your sites. Each copy counts only once the checksum read back from your storage matches the original, and a check finds a copy that later changed or went missing. Set up through the API for now.
- changed · Sites: Sites and their servers are now available with either the Hybrid Sites or the Mirror and Archive add-on; on-prem watchfolders still need Hybrid Sites.

### Internal

- added · Tests: mirror-archive check suite: licences, targets, copies through the real site agent code, checksum refusal, re-checks, bandwidth cap, file names.

## 0.54.0 (2026-11-05)

### Product (in customer release notes)

- added · API Keys & Apps: An app can be registered as an embed player or as venue screens, so rights can allow or block those separately from your web, mobile and TV apps.
- added · Rights: Choose what new assets get: No restrictions (where every existing asset starts), All restricted, or one of your provider profiles. Uploads and watchfolders can name a profile, a title can narrow its profile but never widen it, and each profile keeps its agreement privately for rights admins.
- added · Rights: Rights profiles. Every asset now carries a rights profile that sets where it may be shown, on which apps, for which uses (on demand, FAST and linear, clips, social, downloads, ads), with which access types and inside which window. Publishing, the play gate and FAST lineups never go outside it. Find it under Admin, Media setup, Rights, and on each asset's new Rights tab.

### Internal

- added · Tests: rights-profiles suite: the rights cap on the play gate, publishing and FAST, narrowing, the insert trigger and backfill, agreements and permissions.

## 0.53.0 (2026-11-05)

### Product (in customer release notes)

- added · Sites: Hybrid Sites: servers at a site can now take work that Volt sends to that site. Each server fetches its own site's jobs over HTTPS, reports progress, and moves files through short-lived links made for one job and one file; if a server goes quiet, the job passes to another approved server of the site.

### Internal

- added · Tests: site-jobs suite (69 checks): job pools, the site lease and its expiry, wrong site and account refused, signed and presigned transfer URLs with an S3 round trip.

## 0.52.0 (2026-11-05)

### Product (in customer release notes)

- added · Channels: FAST channels can now round programmes up to the next 1 or 2 minutes, as well as 5, 15 or 30 minutes or the hour, with the gap filled by the channel's loop or slate.
- fixed · Player: On live and FAST channels the player now names the programme actually on air. When programme markers overlapped, it could keep showing the previous programme, with Up next and Starting soon for one that had already started.
- added · Watchfolders: On-prem watchfolders at a Hybrid Site now take in images, slates, audio, captions and metadata files, not only video. The site agent uploads each accepted file and Volt takes it in as from a local folder; a caption sent to review is moved into the review folder at the site. New site folders get every default rule, and Add default rules gives older ones the rest. Update site agents to 0.4.0.
- fixed · Channels: The Embed player preview now plays the channel it was opened from, with its own programme, details, Up next and watermark, exactly as the tag shows it to viewers. A channel that is not running shows its own name instead of a sample programme, and a private channel says that site visitors cannot play it until it is public.
- changed · Player: The programme card at the bottom left now shows Now playing for about three seconds when playback starts and when a new programme starts, then fades. It has a close button, still shows on pause, and never appears for ads, ad breaks or the channel's loop between programmes, where the countdown at the top right says what is coming.

## 0.51.0 (2026-11-05)

### Product (in customer release notes)

- added · Media Library: Audio files (MP3, WAV, M4A, AAC, FLAC) become audio assets: Volt encodes the sound alone to AAC, packaged as HLS and DASH, and the asset plays with the audio player. Uploads of audio files used to fail at the encode.
- added · Watchfolders: New watchfolders start with a fifth default rule, Audio to the Media Library, and a rule may send audio files to the Media Library. Older folders get it from Add default rules.

### Internal

- added · Tests: vod-audio-asset suite: an mp3 with cover art encoded as an audio asset through the real handler and vod_encoder.py, the API and library flags, a file with nothing to encode refused, and an mp3 dropped into a fresh watch folder.

## 0.50.0 (2026-11-05)

### Product (in customer release notes)

- added · Watchfolders: A rule can send images straight into Loops & Fillers as slates (target kind filler-slate), ready for a channel or event to show when its input drops.
- added · Watchfolders: Artwork finds its episode: an image dropped into a watchfolder with a type word at the end of its name, such as Scrubs-s1-e1_poster.png or Scrubs-s1-e1-thumbnail.jpg, becomes that video's Poster or Thumbnail, as if chosen on the asset page. A rule can also give every image it takes an image type.
- improved · Watchfolders: Try a filename now shows the image type a file would get, and the video an image or caption would be attached to.

### Internal

- added · Watchfolders: watchfolder-image-types suite, 69 assertions: type words, rule types, slates, attach after and before the video, 24 hour unmatched, dry run.

## 0.49.0 (2026-11-05)

### Product (in customer release notes)

- added · Watchfolders: Captions (SRT, WebVTT, TTML/DFXP) and metadata files (JSON, XML/NFO, CSV) dropped into a watchfolder are attached to the video they are named after: Scrubs-s1-e1_en.vtt gives Scrubs-s1-e1.mp4 an English subtitle track in HLS and DASH, with sdh and forced read from the name and the most specific name winning. A file that arrives before its video waits up to 24 hours for it, then goes to review.
- changed · Watchfolders: New watchfolders start with two more default rules, Captions to their video and Metadata files to their video, and Add default rules adds them to older folders. Metadata files are attached for someone to review and apply, never applied by themselves.

### Internal

- added · Tests: watchfolder-companions suite (67 assertions): matching by name, waiting and the 24 hour review, the 25 MB limit, sidecars, unreadable captions and tracks in HLS and DASH, against a real database and real files.

## 0.48.0 (2026-11-05)

### Product (in customer release notes)

- added · Watchfolders: A new watchfolder now starts with default rules by file type: images go to the Image Library and video to the Media Library from the first drop. They are ordinary rules you can edit, move or switch off, your own rules always come first, and Add default rules gives them to an existing folder without changing what it does today.
- improved · Watchfolders: A rule can only send a type of file somewhere that takes it in: the rule form offers the right places for a pattern such as *.png or *.mp4, and a rule that would send images to the Media Library is refused with the reason. Every rule now has an On and Off switch.

### Internal

- added · Watchfolders: watchfolder-defaults suite (81 assertions); extension rules take a list; migration 0129 adds watchfolder_rules.builtin; the docs seed shows the default rules.

## 0.47.0 (2026-11-05)

### Product (in customer release notes)

- added · API: GET /api/watchfolders/site-options, and on-prem watchfolders through POST /api/watchfolders with kind site, siteId, placement (upload_cloud) and the folder's path on the site's server.
- added · Sites: The site agent (0.3.0) watches the site's on-prem watchfolders beside its heartbeat, and Reprocess on a refused file asks it to move the file back into the folder.
- added · Watchfolders: With the Hybrid Sites add-on, a watchfolder can be on your own storage at a site. The site's agent sorts it with the folder's rules, keeps refused files in the review folder at the site, and uploads accepted video to Volt to be encoded; an interrupted upload carries on where it stopped.

### Internal

- added · Tests: site-watchfolders check suite: licence, credential scope, a real agent pass over a folder, the quiet-file rule, rules changed, a cut upload resumed by a fresh agent, Reprocess round trip, and the agent as a second process.

## 0.46.0 (2026-11-04)

### Product (in customer release notes)

- added · Sites: Hybrid Sites add-on: Admin, Sites lists your own locations running the Volt site agent, with each site's health, its servers (cores, memory, graphics cards and their encode sessions, free disk, versions, last contact) and a one-time enrolment token to add a server, which then waits for Approve or Reject. Offered only to accounts with the add-on.
- added · API: Sites API: GET and POST /api/sites, GET and PATCH /api/sites/{id}, enrolment tokens, and approve, reject and rotate-credential for a site's hosts. Without the Hybrid Sites add-on these answer 403 with the code licence_required.

### Internal

- added: Licensed add-ons: accounts.licences (empty by default), set by the system admin through PATCH /api/platform/accounts/:id. Site agent routes /api/site-agent/enrol, heartbeat and config with a narrow host credential; volt-agent 0.2.0 adds site enrol and site run. Suite sites.check.ts.

## 0.45.0 (2026-11-04)

### Product (in customer release notes)

- added · Workflows: A Report tab on Workflows shows how each stage has done over the last 24 hours, 7 or 30 days: runs, error rate, retries, how long the work took (p50 and p95) and the most common error codes, drawn on the workflow map, with add-on runs and runs and errors per lane over time. Also in the API as GET /api/workflows/report.

### Internal

- added · Workflows: Workflow report rollups (wf_minutes, wf_days in the analytics database, once a minute on the leader, idempotent), concurrent finished_at indexes (migration 0126), a short error code stored with every job failure, docs seed with a week of finished work, and the workflow-report check suite (43 assertions).

## 0.44.0 (2026-11-04)

### Internal

- added: Migration safety check: a migration the previous release could not run on (dropping, renaming or retyping a column or table, NOT NULL without a default, a blocking index) is refused before commit, release and deploy. Removals take two releases and a `-- volt:contract` line; concurrent indexes go in a `-- volt:no-transaction` migration, which the runner now supports. Shipped migrations are baselined in release/migrations-baseline.json and may not be edited.

## 0.43.0 (2026-11-04)

### Internal

- added · Deploy: Deploy and rollback script (scripts/deploy/deploy.mjs, build queue D1): release checks, images tagged v<version>-<sha> (never latest), migrations once as a one-off task before services move, rolling service moves with steady-state wait, a smoke test (ready, play gate, manifest) with automatic rollback, explicit --rollback, new encoder revisions for new streams only, and release/deployments.json as the record. Terraform image tags must name a release and services no longer have their revision moved by apply. The staging compose file takes the image tag from VOLT_IMAGE_TAG, mailpit is a service again (it sat inside depends_on, so compose refused the file), and IMAGE_SIGNING_SECRET is passed (the API would not start without it).
- added · Control plane: Migrate-only entry (dist/migrateOnly.js): applies the migrations and boot schema top-ups under the boot lock and exits, for the deploy's one-off migration task. The top-ups moved unchanged from index.ts to services/bootSchema.ts.

## 0.42.0 (2026-11-04)

### Product (in customer release notes)

- added · Trick-play: Viewers in a rights blackout keep trick-play in DASH too: fast-forwarding inside their blackout shows the replacement loop's pictures, never the programme they may not see. Applies from a stream's next start.

### Internal

- added · Tests: trickplay-variants-dash check (variant MPD trick sets decoded against real loop media, optional Shaka fast-forward run); loop keyframes for DASH trick-mode now keep the loop's own decode time.

## 0.41.0 (2026-11-04)

### Product (in customer release notes)

- added · Trick-play: Viewers in a rights blackout keep trick-play in HLS on streams that put a slate or loop on air: scrubbing inside their blackout shows the replacement loop, never the programme they may not see.

### Internal

- added · Tests: trickplay-variants check (variant I-frame playlists decoded against real loop media); a race in trickplay's queue assertion waited out.

## 0.40.0 (2026-11-04)

### Product (in customer release notes)

- improved · Live channels: Live streams that put their slate or loop on air now keep their DASH trick-mode track: fast-forwarding or scrubbing over the slate or loop shows the slate or loop, never the programme it covered.

### Internal

- added · Encoder: test_splice_trick_dash.py (32 checks) and splice_trick_dash_shaka.mjs (Shaka Player over the spliced MPD) guard the DASH trick-mode set under a playout splice.

## 0.39.0 (2026-11-03)

### Product (in customer release notes)

- improved · Channels: Live channels and events with trick-play on keep their I-frame playlists while the slate or loop is on air after the source drops (or when you force it). Scrubbing over that stretch shows the slate or loop, never the programme it covered.

### Internal

- added · Encoder: test_splice_trick_play.py: delivered I-frame playlists checked entry for entry against the spliced media playlists, with every byte range decoded against the media; edge-variant-manifests refuses the delivered I-frame playlist by name in a blackout.

## 0.38.0 (2026-11-03)

### Product (in customer release notes)

- fixed · FAST: A FAST channel airing titles whose DASH names its files by rendition id pointed DASH players at files that do not exist; those names are now resolved for each title.
- added · Trick-play: FAST channels with trick-play on now also offer a DASH trick-mode track, so DASH smart TVs show pictures while fast-forwarding. It is the keyframes of one smaller size of each title, made once per title and shared by every channel that airs it.

### Internal

- added · Tests: trickplay-fast-dash check (trick segments decoded against the media, playout MPD, Shaka in Chromium) and trick-play cases in fast-ladder.

## 0.37.0 (2026-11-03)

### Product (in customer release notes)

- added · Trick-play: FAST channels now get I-frame playlists in their HLS when their output profile has trick-play on, from their next start, so Apple devices and smart TVs show pictures while viewers scrub back, ad breaks and slates included. Nothing is re-encoded or stored.

### Internal

- added · Tests: test_fast_trick_play.py (keyframe ranges decoded against the media, splice, numbering, rolling window, ranged reads, playout on and off) and a session-master case in fast-beacons.

## 0.36.0 (2026-11-03)

### Product (in customer release notes)

- added · Trick-play: Live channels and events with trick-play on now also get a trick-mode track in their DASH from their next start, so smart TVs that fast-forward over DASH show pictures. It is made from one smaller rendition, so it adds little to storage and delivery, and viewers in a rights blackout never get it.

### Internal

- added · Trick-play: test_trick_play.py covers the packager's DASH trick-mode stream (one rendition, DASH only, the spliced MPD never lists it); trickplay-live and edge-variant-manifests cover the job key and the variant MPD dropping trick-mode sets.

## 0.35.0 (2026-11-03)

### Product (in customer release notes)

- added · Trick-play: Live channels and events now get I-frame playlists in their HLS when their output profile has trick-play on, from their next start, so Apple devices and smart TVs show pictures while scrubbing back through the live window. Nothing is re-encoded. Viewers in a rights blackout get the stream without trick-play, never pictures of the programme they may not see.

### Internal

- added · Tests: test_trick_play.py (packager command and delivered master), trickplay-live check, and trick-play cases in edge-variant-manifests.

## 0.34.0 (2026-11-03)

### Product (in customer release notes)

- fixed · Trick-play: Encodes with several video renditions listed the same keyframe list for every rendition in HLS, so Apple players could show the wrong size of picture while scrubbing. Each rendition now has its own.
- added · Trick-play: With trick-play on, on-demand media now also offers a DASH trick-mode track, so smart TVs and other DASH players show pictures while fast-forwarding and scrubbing. It is made from the files Volt already has, with nothing re-encoded or stored, and encrypted media keeps its protection.

### Internal

- added · Tests: trickplay-dash check suite (trick segments decoded and decrypted against the source, MPD, switch, ladders) and a Shaka-in-Chromium check of DASH trick-mode.

## 0.33.0 (2026-11-03)

### Product (in customer release notes)

- added · Radio: Each song is now listed in the station's HLS and DASH with its title, artist and, once found, album and cover, so a listener who goes back in time sees the song that was playing at that point, the songs before it and the next one.
- improved · Player: On a radio station the Volt player shows now playing, recently played and coming up for the point being listened to, read from the station's own stream, with no now-playing requests. At the live edge, coming up names the next programme from the guide.

### Internal

- fixed · Radio: The radio container image now includes logstamp.py, which radio.py imports (missing since 26 Oct). New check suite radio-songs; radio-id3 checks the songs in the delivered manifests.

## 0.32.0 (2026-11-03)

### Product (in customer release notes)

- changed · Radio: An MP3 stream for hardware receivers and older apps is available only where it has been turned on for your account; it is then made from the station's HLS when someone listens.
- changed · Radio: Stations now deliver HLS and DASH only; the Icecast relay that carried MP3 is gone. Icecast and SHOUTcast mounts still work as station sources, with their now-playing titles.

### Internal

- removed · Radio: Removed the relay tier (fleet/relays.ts, /api/platform/relays), the Icecast listener-auth callback, the ICECAST_* settings, the relay probe and MP3 push in radio.py, and the relay in run-on-mac.sh, compose and Terraform coverage. New accounts.mp3_feed_enabled (platform PATCH mp3FeedEnabled) and check suite mp3-feed; radio-container rewritten without a relay.

## 0.31.0 (2026-11-03)

### Product (in customer release notes)

- added · API: PATCH /api/output-profiles/{id} turns trick-play on or off (trickPlay); PATCH /api/account-settings takes trickPlayDefault, what new output profiles start with.
- added · Account settings: Trick-play for Apple and smart-TV players: an optional switch per output profile (off by default) that lists I-frame playlists for on-demand media, so Apple devices, Safari and many smart TVs show pictures while scrubbing and fast-forwarding. Made from the segments Volt already has, with no re-encode.

### Internal

- added · Player: The web player's Shaka engine ignores I-frame playlists (manifest.disableIFrames), so web viewers keep scrubbing with sprites and never load keyframe lists. New check suite trickplay.

## 0.30.0 (2026-11-03)

### Product (in customer release notes)

- added · Recordings: Step through a recording frame by frame: while paused the arrow keys move one frame and show that exact frame with its timecode, In and Out are set on it, and small pictures under the marks show the clip's exact first and last frames.
- added · Media Library: The video preview shows the timecode and frame number, and while paused the arrow keys step one frame at a time, showing the exact frame.

### Internal

- added · Docs: The docs seed adds a recording and a library asset with real media for the frame stepping screenshots; the screenshot script can press keys, and styles a shot hides or removes no longer carry into later shots.

## 0.29.0 (2026-11-03)

### Product (in customer release notes)

- improved · Recordings: Clips are cut faster: only the first and last few seconds are re-encoded and the middle is copied as recorded, so a long clip is ready about as fast as a short one at the recording's own quality.
- fixed · Recordings: On some sources a clip could repeat its first frame or lose its last. Clips now start and end on exactly the frames you mark.

### Internal

- added · Recordings: New check suite smart-render-frames: six clips decoded picture by picture against the source (25, 50 and 29.97 fps, B-frames, video only and with audio muxed in), the smart render matching the full render frame for frame.

## 0.28.0 (2026-11-02)

### Product (in customer release notes)

- changed · Storage: Exact-frame stills are now tracked by where they are kept (bucket and folder) and follow the retention ladder's Delete rung: they go when their recording is removed, when their asset is deleted or re-encoded, and 7 days after they were last made. Each folder of stills is listed on the Storage page.

## 0.27.0 (2026-11-02)

### Product (in customer release notes)

- added · Media Library: Exact frames through the API: ask for any frame of an on-demand asset by frame number, timecode or time, or any moment of a recording, and get that frame (not the nearest keyframe) as a signed image at the width you need. Each asset now has a frame index with its frame rate, frame count and timecode range.

### Internal

- added · Tests: frames check suite: frame index, exact frames against a ground-truth decode across segment boundaries (CMAF, MPEG-TS, 29.97 drop-frame with uneven segments), recordings, the API, the sweep and still upkeep.

## 0.26.1 (2026-11-02)

### Product (in customer release notes)

- fixed · VOD: On cloud deployments, caption files added to an encoded asset now show as subtitle tracks in the player (HLS and DASH), and switching a track off or deleting it takes it out within a minute.

### Internal

- added · Tests: bucket-tracks check suite: caption tracks written into the bucket copy of CDN-played encodes.

## 0.26.0 (2026-11-02)

### Product (in customer release notes)

- fixed · FAST: On a cloud deployment, a new ad creative and a slate or loop used on a FAST channel are prepared by whichever server picks up the work, so they no longer fail when that is not the server that downloaded or rendered them.
- fixed · VOD: On a cloud deployment, caption tracks of a clip or encode stay in time with the picture when the server answering does not hold the video files.

### Internal

- added: clips-off-disk check suite: ad creatives and FAST renders of slates and loops land in the bucket on S3, caption clocks read through the bucket, the Mac unchanged.

## 0.25.0 (2026-11-02)

### Product (in customer release notes)

- fixed · VOD: On a cloud deployment, clips and encoded files play and download from every server, and downloading an encoded MP4 no longer says the file is gone.
- security · VOD: The original file of an upload or watch folder drop can no longer be fetched through the media address by someone who knows the item's id.

### Internal

- added: clips-store check suite: clip and encode files and downloads served from another task through the bucket.

## 0.24.0 (2026-10-31)

### Product (in customer release notes)

- security · Uploads: On a cloud deployment, original upload files and upload parts in progress can no longer be fetched through the content delivery network.
- improved · Uploads: On a cloud deployment with several servers, an uploaded or watch folder video is encoded by whichever server takes the work, and replacing a server no longer loses the original files it received.

### Internal

- added · Deployment: Originals of uploads and watch folder drops live in the origin bucket on AWS (VOD_SOURCE_DRIVER=s3); encodes, ladders and frame grabs take a scratch copy per job; the origin bucket policy denies the CDN vod-src/ and upload-staging/; new vod-source-store check suite.

## 0.23.0 (2026-10-30)

### Product (in customer release notes)

- improved · Uploads: On a cloud deployment with several servers, a large upload's chunks or tus requests can reach any server and the upload still completes; two requests to finish the same upload give one file and the same answer.
- fixed · Uploads: Resumable uploads through the tus protocol at /api/tus work again: creating an upload no longer fails with a server error.

### Internal

- added · Deployment: Upload chunks and tus parts wait in the origin bucket on AWS (UPLOAD_STAGING_DRIVER=s3) with a lifecycle rule for forgotten parts; new upload-staging check suite with two API processes.

## 0.22.0 (2026-10-30)

### SaaS platform

- improved · Deployment: On AWS, uploaded slates and loops are kept in the origin bucket, so every control-plane task serves them and none is lost when a task is replaced.

## 0.21.1 (2026-10-29)

### Product (in customer release notes)

- fixed · API: An upload opened with POST /api/uploads is now titled with the name you give it, with or without a content type. A title or name sent in metadata is kept as the title too. When the name is only the file name, the title is still read from the file as before.
- fixed · API: GET /api/channels/{id} now answers the channel's kind (tv or radio), the same as the channel list, in plain JSON and in JSON-LD. It used to answer channel.

### Internal

- added · Tests: New check suite g6a-fixes (15 assertions: upload titles from the name and metadata, a channel's kind the same in list and item); docs-samples now expects the upload sample's title from its name, with the old step 4 rename gone.

## 0.21.0 (2026-10-29)

### Product (in customer release notes)

- added · Radio: An operator can correct a now-playing log entry that was put in the wrong class: choose Song, Ad or Content in its Class column on the station's page. Volt keeps what it had said and who corrected it, and the API has the same with PATCH /api/radio/{id}/log/{entryId}.
- fixed · Media Library: Set type and metadata for all is now offered beside What are you adding? before any file is added, so the type and fields can be set before Start as soon as added starts the upload.
- added · Radio: Stations can be deleted through the radio API too: DELETE /api/radio/{id}, with GET /api/radio/{id}/delete-impact to see what goes with it. Same rules as removing a station in the console: owners and administrators, and stop it first.
- improved · Docs: The Notifications, Monitoring and never-dark channel guides now list the stream alerts (encoder stopped, source unreadable, a minute on the slate, output timing) and the Media Library guides say the Ingest Queue button is in the top bar.
- improved · Recordings: The Recordings search now finds a channel, station or event by a programme or song that aired inside its recordings, not only by its name, and says what matched and when (for example Played: a song title and the time it aired).

### Internal

- added · Tests: New check suite g5b2-fixes (36 assertions: log class correction, recordings search by what aired, station delete through the radio API) and browser walk volt-web/test/g5b2-fixes.browser.mjs (11 checks at 1440x900).

## 0.20.0 (2026-10-29)

### Product (in customer release notes)

- fixed · Channels: A channel or event page whose guide has programmes, just none in the next few hours, now says Nothing in the guide around now and names the next (or last) programme, instead of No programme guide yet.
- fixed · Captions: A channel's Subtitles settings change every stream on its output profile, so they can no longer be saved while another stream on that profile is running; the message names the streams to stop, as Admin > Captions does.

### Internal

- added: New check suite g5b-fixes (24 assertions): watch folder asset delete, the guide strip's outside block, the shared subtitles lock.

## 0.19.0 (2026-10-29)

### Product (in customer release notes)

- fixed · Encoding Queue: An encode's page no longer shows customer accounts the name of the machine running it, and its packages read Stored rather than naming a storage bucket.
- added · Documentation: New guides for Collections, the Encoding Queue, Genres and Single sign-on: how to group and order library media, follow and retry encodes, keep the genre list tidy, and let your team sign in with your own identity provider.

### Internal

- added · Documentation: The docs seed adds collections, two finished encodes and a single sign-on provider, and the coverage check requires the four new guides (batch G8).

## 0.18.0 (2026-10-29)

### Product (in customer release notes)

- fixed · Encoding Profiles: Delete is no longer offered on a rendition a ladder uses, and users who can only view the page no longer see buttons that would be refused.
- added · Encoding Profiles: Edit a rendition's name, height and bitrate in place; every ladder containing it follows, and FAST channels on those ladders re-package on their own.
- added · Channel Groups: Move channels, radio stations, FAST channels and events to another group of the same workflow with Move streams on Channel Groups (also offered when a group in use cannot be removed). Volt checks the target group's share and running at once, and says when a running stream picks up the new group's output profile at its next start.
- added · API: POST /api/channels/{id}/group and POST /api/events/{id}/group move a stream to another group; PATCH /api/encode-profiles/{id} now checks its values and answers a taken name, a duplicate height in a ladder or an out-of-date version with a clear 409.
- improved · Channel Groups: View its streams on a group opens the Live Streams list filtered to that group, and the list has a group picker.

### Internal

- added · Tests: group-move-renditions check suite (43 assertions) for moving streams between groups and editing renditions.

## 0.17.0 (2026-10-29)

### Product (in customer release notes)

- fixed · Content Types: Choosing New type extending a second time for the same type now makes another copy (copy 2, copy 3) instead of failing because the name was taken.
- improved · Publishing Rules: Event, Radio, TV and FAST managers can now see and set the publishing rule of the streams they run, on each stream's Access tab, without Account settings access.
- added · Publishing Rules: Publishing Rules can now give a content type its own rule directly, and Add a social account opens Social accounts instead of API Keys.

### Internal

- added · Tests: publishing-stream-rules suite: stream rule access by stream kind, the rule editor's lookups and content type name conflicts.

## 0.16.0 (2026-10-29)

### Product (in customer release notes)

- changed · Recordings: Send to add-on on a recording needs Recordings: Operate (Account settings: Operate still works), so Recordings managers can use it. Try a filename on a watchfolder says when your role cannot use it.
- fixed · Account: Share links count one view per visit: a reload, Check again or a long session no longer counts as more views or uses up a one-view link. Revoking a link now asks first.
- added · VOD: Watchfolders can be renamed, switched off and on, and deleted from their page. Deleting asks you to type the folder's name and never deletes a file; deleting a rule asks first too.
- fixed · VOD: Watchfolders: Retry and Dismiss now work on files that failed, and Reprocess and Dismiss no longer show an error after they have done their job. A rule's target kind is picked from the kinds Volt takes in, and an older rule with any other kind is marked so it can be fixed.

## 0.15.0 (2026-10-29)

### Product (in customer release notes)

- fixed · Media Library: A role with Files, uploads & storage: Manage, such as the Media Librarian template, can now upload files, import a link and settle held files. Adding a file no longer needs Account settings: Manage.
- improved · Ingest Rules: Each ingest rule's summary now reads in words, for example "when the extension is mov or mp4: metadata: Before upload". Greyed cloud drive buttons, here and in the upload panel, say your Volt provider sets them up instead of naming server settings.
- changed · API: GET /api/workflows/map no longer returns each stage's impl field. The ingest lookups POST /api/ingest/preview, POST /api/ingest/sanitise, GET /api/ingest/baseline and GET /api/ingest/providers now need Files, uploads & storage: View or Account settings: View. Storage locations carry their uri only for whoever runs the Volt service.
- improved · Storage: Storage names each tier by what it does (Server disk, Standard, Infrequent access, Archive, Deep archive) and explains a refused retention ladder in the page's own words. The storage driver, its server setting and each copy's storage address are shown only to whoever runs your Volt service.
- added · Media Library: The Media Library guide now covers deleting an asset: what goes with it, typing the title to confirm, and getting it back from Storage > Recently removed.
- improved · Media Library: When an asset has no file to download, its Encode tab now says why and how to get one: cut the clip again with an Output that includes a downloadable file, or upload the file as H.264 video with AAC sound in MP4 or MOV.

### Internal

- added: New check suite media-internals (31 assertions): the ingest lookups' access, the workflow map without source file names, and storage answers without setting names, raw addresses or action keys. The screenshot banned list now covers console build settings, storage setting names, storage class names, raw s3:// addresses and the provider setup instruction.

## 0.14.0 (2026-10-29)

### Product (in customer release notes)

- security · Recordings: Downloading a whole recording now needs the Downloads permission (Operate), like every other download, instead of only being able to see the recording.
- fixed · Review: Review only offers decisions that can be made: a clip with changes requested is sent back for review before it can be approved, the note needed to reject or request changes is asked for up front, and Re-run QC now says whether it started.
- improved · Review: Send a clip for review from the Media Library: Send for review sits beside its Review state, an approved clip can be sent back, and a clip already waiting opens straight in the Review queue.

### Internal

- added · Tests: review-access suite: review moves and recording download access over real HTTP; the docs seed sends one clip for review for the Review guide.

## 0.13.0 (2026-10-29)

### Product (in customer release notes)

- fixed · Watch folders: A loop dropped into a watch folder now arrives in Loops & Fillers ready to use as a channel or event fallback, the same as an uploaded loop. Before, it was listed but could not be used.
- fixed · Watch folders: A programme or loop dropped into a watch folder is added once. Before, the same file could be added again, and encoded again, every ten minutes.
- added · Account: Admin > Formats & reframing: choose the formats Volt makes, what to keep in frame, how the framing may move, whether a person approves it, and which format each social platform receives. Sending each platform its own format is off until you turn it on.
- fixed · VOD: Saving an item's metadata, a skip marker or a QC re-run now confirms that it worked, or says why it did not. When song details are applied with a cover, the cover is copied into the Image Library first and the Artwork field is filled with it, including when the item is made a Song at the same time.
- added · Rights: Blackout and replacement windows from the guide can now differ by audience at the same moment: a viewer in Australia can be replaced from 20:00 to 21:00 while one in New Zealand is replaced from 21:00 to 22:00, each decided per viewer at the CDN on the same play address. Programmes can also exempt a rights class (for example a premium tier) from a window. On a single server the public live address makes the same decision, and outside production you can test it with ?as=AU, &rc= and &at= to see what a viewer elsewhere, or at another time, would get.
- added · VOD: Media files can be downloaded from the Encode tab, and downloading is now its own permission in Roles & access ("Downloads"). Owners and admins can download; other roles only once an admin grants Downloads. Every download is recorded in the audit log.
- changed · VOD: The Media Library now filters by asset type (Video, Audio, Song) and by source (Channel, Event, Radio, Upload, or No source for items whose channel or event is gone). Content type moves under More filters, and how an item was made is now labelled "Created as". The list's Source column says which kind of source each item came from.
- fixed · Monitoring: Multiview now plays the output viewers are actually given, at the live edge and with sound in step with the picture. Starting and stopping a tile no longer jumps back several minutes. Each tile shows source and output flags (NO SOURCE, failover, filler, dropped outputs, timing), and the wall pages itself to what fits your screen. "Viewer location" plays every tile as a viewer in a chosen country sees it, with the rights decision and its reason beside the picture.
- added · Encoder: Volt now checks the timing of every live output as it is written: audio and video out of step, a rendition that jumps in time, or a track that stops advancing. Each one shows on the Output gate as a timing fault, in plain words. A packaging channel now cuts its segments on the source's own keyframes, so every quality and the audio share the same boundaries. A stream that is running before anything has been pushed to it now says "awaiting source".
- added · Player: Debug mode on every player (right-click > Debug mode, Shift+D, or Cmd/Ctrl+D) now says where a problem is: this device or connection, access rules (region, sign-in), delivery, the stream itself, or the player. It also says whether the problem is worth reporting. A slow connection gets a short note on the picture, so viewers can tell it is their connection and not the stream.
- improved · Watch folders: Programmes dropped into a watch folder now go through your ingest rules, as uploads do: naming, duplicate check, metadata and webhooks. Scan reports how many went to the Media Library for encoding, how many were added to Loops & Fillers and how many the ingest rules held.
- added · VOD: Social formats: Volt follows the faces in a clip and frames a 9:16, 1:1 and 4:5 version of it. The new Formats tab on every asset shows the crop over the picture, a timeline of shots and keyframes and live previews of each format; drag the crop to correct it, choose who a shot follows, approve and render. Shots where two people are too far apart show the whole picture over a blurred fill and are flagged for a look.
- improved · Console: The console now works on a phone or tablet: under 900 px wide the menu opens as a drawer from the button at the top left, and pages no longer scroll sideways; wide tables scroll inside their card and the pipeline status wraps into rows.
- added · Channels: When a programme's rights replace it in some countries, viewers there now see the channel's loop in place of the programme for exactly the replace window, then the programme again, without changing the address they play. Viewers elsewhere keep watching the programme, and recordings are unchanged.
- added · Docs: A new page, How Volt fits together, maps every section of the console and the main ways work flows between them, with a diagram. The Account settings and Audit log guides now show the screens they describe.
- fixed · Account: Account settings now warns when a primary colour is a mid-tone that neither white nor dark text reads well on. The warning was described in the guide but could never appear.
- added · Analytics: Analytics has a new Playback view: what viewers actually saw, from the Volt player's own reports. Playback success (attempts, startup failures with the step and code, exits before the first frame, failures after the start), startup time at p50, p95 and p99 with its steps, buffering, quality and bitrate switching, engagement and the health of the reports themselves, all filtered by content, live or on demand, device, OS, browser, app and SDK version, CDN, country, region and network. A Worst segments table ranks any of these by any measure, so a bad device or app release stands out.
- fixed · Encoder: When a source drops and comes back, the stream now carries on from where it was instead of jumping back in time, so playback no longer breaks after a failover. A timing warning no longer shows as "encoder failed". Admins now get an inbox message (and an email and push where those are set up) when a stream's encoder stops unexpectedly, its source cannot be read, it has been on the slate for over a minute, or its output timing goes wrong. Each stream sends at most one alert per problem every half hour.
- improved · Workflows: Hovering over a stage on the Workflows map now shows only what the stage does, and the add-on contract points at the Workflows guide.
- added · Documentation: New guides for Analytics (Audience, Operating and Playback), Plan & limits, Fleet & Usage, Payments, Social accounts, Notifications, Users & Roles, Permissions map and API Keys & Apps, and the Account settings and Audit log guides rewritten in the same form. Each says what the section is for, how to use it step by step, how it connects to the rest of Volt, who can do it, what to do when something goes wrong and the API equivalent. Roles and access now lists the Graphics area and the Graphics Operator role.
- added · Documentation: New guides for EPG, Loops & Fillers, Graphics, Captions and Formats & reframing, each with what it is for, step by step instructions, who can do it, troubleshooting and the API equivalent. The EPG guide now covers repeats, copying a day, the timeline and XMLTV import and export; the Captions guide covers the account's captions engine and each output profile.
- added · Documentation: New guides for every live section: Dashboard, Live Streams, Monitoring, Multiview, Channels, Radio, Events and FAST, each with what it is for, step by step instructions, who can do it, troubleshooting and the API equivalent. The channel status and input failover guides now follow the same layout.
- added · Documentation: New guides for the media sections: Media Library, Recordings, Image Library, Review, Encoding Profiles, Watchfolders, Storage, Workflows, Content Types, Publishing Rules, Ingest Rules, Channel Groups and share links. Each says what the section is for, how to use it step by step, how it connects to the rest of Volt, who can do it, what to do when something goes wrong and the API equivalent.
- added · API: New playback experience routes under /api/analytics/qoe: overview, series, breakdown, dimensions and definitions, plus POST /api/analytics/qoe/replay to rebuild a period from the raw player reports.
- added · Player: New player options: drm (licence servers by key system, and headers for licence requests) and cmcd (the app's name and version for the reports, or false to turn reporting off). player.sessionId is the one session id the play gate, the Analytics beacons and the CMCD reports share.
- added · Channels: Rights preview on channel and event pages: pick a country, a rights class and a time (now or any time in the guide) to see what the CDN gives that viewer (normal, replaced or blocked), the rule behind it and until when, play exactly that version before it airs, and see the next 24 hours for every audience the rules name.
- fixed · Graphics: Save and assign on a new graphics setup now opens the Assign form. Before, it saved the setup and stopped there.
- fixed · Permissions map: The audit log row points at Admin > Audit log, where the audit log now lives.
- improved · Delivery: The CDN now lets players read its own request id (x-amz-cf-id) and request timings, so a player's report can be matched to the CDN's log line. CMCD on requests never changes what is cached: viewers still share one copy of each segment.
- fixed · Radio: The example address under an Icecast source, and the example name for a new channel group, no longer name a real station or customer.
- fixed · Users & Roles: The Public users tab shows how many public users the account has, instead of always 0.
- fixed · Share links: The Share window no longer says a preview ignores geo rules. A share link follows the countries your account allows, and the window now says so.
- added · Player: The Volt player now reports what each viewer sees, in the CMCD v2 standard. Every playlist and segment request carries CMCD, and the player sends its play states, errors, bitrate changes, a heartbeat every 30 seconds and a sample of response timings to POST /api/public/cmcd. A view starts when play is pressed, so a refused entitlement or a failed licence is still counted, with the step it failed at.
- fixed · Publishing: Approving a clip that was waiting for review now publishes it when its publishing rule has Auto-publish, and a full-event replay (Automatic VOD on end or Publish full VOD) is published under its rule as soon as it is made. Uploaded and watch folder files are still published by hand.
- added · Documentation: Eight new end-to-end guides show how the sections of Volt work together, each with a diagram: the guide driving recording and publishing, securing a live stream, a 24/7 channel that never goes dark, a live event from start to finish, a FAST channel from the library, a radio station with now playing, captions and graphics on a live stream, and from upload to published.
- fixed · Channels: Example names in the New channel and New station forms, the Icecast address example and the Radio empty state no longer name real broadcasters or stations.
- fixed · FAST: FAST now follows the TV channels level of each role: View to see FAST channels, run orders and previews, Operate to put a channel on or off air and activate a run order, Manage to create channels and edit run orders, ads and ad servers. A role without TV channels can no longer read or change FAST channels through the API. Ad breaks follow their stream: an event's breaks need Events and a station's need Radio stations.
- fixed · API: GET /api/jobs/{id} and the jobs list now include the encode job of an uploaded or watch folder file, for its own account.
- added · Docs: New developer guides: getting started with apps and keys, the play gate and playback tokens, playback reporting and the QoE API, notifications and webhooks, guide import and the EPG API, uploads, and recipes for common integrations. The authentication, lists and player SDK guides follow the same layout, and the player guide now covers DRM and playback reporting. Every code example in them is run against the Volt API before the documentation is published.
- fixed · Events: New event now starts on a workflow your account has a group for, and the Workflow cards say when a workflow has no group, with a note under them, instead of only after Create event fails. New channel also settles on the right type when it opens before your groups have loaded.
- fixed · FAST: On a run order that rounds programmes up to the half hour or hour, What this run order does to a week now counts each programme as the guide places it, so one pass, passes this week and when the next pass starts match the Week tab.
- fixed · Media Library: Publish and Remove access now work on files that were uploaded or dropped into a watch folder. Before, both answered Asset not found for any asset that did not come from a channel or event.
- fixed · Social accounts: Social accounts is in the menu only for people who can open it: it needs Account settings: View and Media library & publishing: View, so a role with settings alone no longer gets a page that cannot load.
- changed · Social accounts: Social accounts, Notifications and Fleet & Usage no longer show account users the server's setting names or cloud machine names. A channel or platform that is not set up says your Volt provider sets it up, and Fleet & Usage describes each server as shared, for one stream or on-premises. Whoever runs the Volt deployment still sees the full detail.
- fixed · FAST: Stitched ads can now be set up entirely in the console: choosing Stitched ads with no ad server opens the ad server form, and Add and use saves both. A FAST channel can be made Public only once a run order is active, so viewers are never given an empty channel.
- improved · Analytics: The Analytics page now says what it shows (who watched, for how long and where, by day) instead of how its figures are stored.
- fixed · Platform: The API no longer stops when the database drops an idle connection (a restart or failover): the connection is replaced and requests carry on.
- fixed · FAST: The FAST time zone list now has UTC, first, so a channel on UTC shows UTC instead of the first zone in the list. An empty run order no longer reports thousands of one-minute passes a week; it asks you to add titles or series.
- changed · Console: The sign-in form is empty in the shipped console; the demo login is filled in only when running the console in development.
- improved · Rights preview: When the replacement loop is not ready, the rights preview now says why: built from the stream's slate or loop video and not ready yet, no slate or loop set, or input failover off.
- fixed · VOD: Choosing an image for an asset now shows on its card in the Media Library straight away, and as the poster in its player, without refreshing. Before, the grid could keep showing the previous picture even after a refresh. Cards also update by themselves when Volt picks an image in the background or an asset changes, while the library is open.
- fixed · VOD: Choosing a new image for an asset now replaces the old one straight away, everywhere it is shown. Before, a new frame could keep showing the old picture, and an image set in the Metadata form was ignored if someone had chosen the image by hand earlier. The Metadata form now also shows clearly when it has unsaved changes, and asks before you switch tab, open another asset or close it with changes unsaved.
- added · Ads: Ad clicks are tracked. When a viewer clicks Learn more on an on-demand ad, or a player opens a FAST ad's click address, Volt records the click, tells the ad server and opens the advertiser's page. Clicks show in the on-demand ad report.
- added · Analytics: Analytics > Playback has four new reports: Rendering and devices (dropped frames, decoder errors, hardware decoding, DRM system), Access and DRM (why the play gate said no and how long it took, licence time and failures, tokens refused part way through), Live streams (how far behind live viewers are and how much that drifts, by device) and Advertising (breaks watched to the end, ad startup and buffering, time back to the programme, viewers who left during an ad).
- added · Analytics: Analytics > Playback has two new reports for apps that send their journey events: Journey to play (where viewers give up between opening the app and the first frame, including the paywall, and how long each step takes) and Where plays come from (plays, watch time, completion and playback quality by row, search, deep link, push notification and more, and titles whose page was opened but never played). Every playback report can now be filtered by where the viewer came from and by how many screens they saw before pressing play.
- improved · VOD: Images Volt saves for an asset are now named after the asset, like sintel-1080p-21fe57ffc0.jpg, in a folder named the same way and dated by the programme, the recording or the day it was added (no more 1970-01-01, and no .mkv in folder names). Existing images are renamed in the background, everything that uses them keeps working, and renaming an asset renames its images.
- improved · VOD: The asset panel in the Media Library can now be made wider: drag its left edge, or use the width button next to Close to switch between normal, wide and full width. Your choice is remembered next time you open an asset.
- added · VOD: Assets can now carry more than one image. Video keeps its Thumbnail and audio its Cover as the main image, and each asset also offers a Poster, Hero backdrop, Banner, Social share card and Title art for portals, apps and feeds, plus any image types your account adds (Image types… in the asset's image panel). A type without its own image is filled from the main image, cropped to the right shape, so a portal always gets a picture that fits; you can set the focus point that crops keep in frame.
- added · On-demand ads: Catch-up without the broadcast's ads: when on-demand ads are on with mid-rolls, a replay or programme recorded from a live channel or event leaves out the ad breaks that were on air (operator breaks and SCTE-35) and plays ads decided for each viewer in their place, with nothing to mark by hand.
- added · VOD: A new Companion files tab on each asset takes caption and metadata files that belong with it. SRT, WebVTT and TTML captions are checked (timing, overlaps, reading speed, files timed from a timecode) and appear as subtitle tracks in the player for HLS and DASH as soon as they are added, with the language read from the file name. Metadata sidecars (JSON, XML or NFO, CSV) are matched to the asset's fields for you to review and apply.
- added · VOD: You can now delete an asset from the bottom of its Metadata form. As when removing a channel, the dialog shows what goes with it and asks you to type the title. The asset then goes to Storage > Recently removed rather than being destroyed, and an Undo button puts it straight back with its metadata and media. Until the bin empties, you can also restore it from there.
- improved · On-demand ads: Every pause, resume, mute and unmute during an ad now reaches your ad server, not just the first of each.
- changed · Social accounts: Facebook publishing now uses version 25.0 of Meta's Graph API (version 21.0 stops working in January 2027). Nothing changes in how you publish.
- added · Channels: FAST channels can schedule ad breaks between programmes only, with break lengths earned by the content before them, breaks that wait until enough short titles have played, different ad rules by time of day, a cap on ad minutes per clock hour, grid pad sold as ad time, ad-free or "only after" rules per title or slot, and limits on ads per break with one ad per advertiser.
- added · VOD: Genres are now your own list. In Admin > Genres you can add, rename, reorder, retire and merge the genres your stations, channels, events and on-demand assets are tagged with; every Genre and Category field offers your list. Renaming or merging a genre updates everything already tagged with it, a retired genre stays on what has it but is no longer offered, and a genre in use cannot be removed by accident.
- improved · Account: The Image Library tidies itself. Folders that retention or an asset's removal leaves empty are removed, and folder counts now match what the grid shows. Song artwork has its own Cover type and filter. Duplicates… finds images stored more than once, keeps one and points everything that used a copy at it. Choosing an image for an asset now opens on that asset's own frames, uploads and stills first, and a video is no longer offered song covers.
- added · Social accounts: Instagram: link a Business or Creator account with Instagram Login or through the Facebook Page it is tied to, then publish clips as Reels and Image Library pictures as feed posts. Before you publish, each Instagram account shows how many of its posts for the last 24 hours are used; captions are checked against Instagram's 2,200 characters and 30 hashtags, and views, likes and follower counts are read back.
- improved · Formats & reframing: Instagram Reels get a clip's 9:16 version whenever one is already made and approved, even with Send each platform its own format off.
- improved · VOD: In the Media Library you can now see which asset you are working on: its card is ringed and labelled Open, stays marked Last opened after you close it, and keyboard focus returns to it. A card whose image, title or availability just changed pulses briefly and shows Updated. The list view marks the open row the same way.
- added · VOD: Media > Encoding Queue shows what is being encoded now, what is waiting and in which order, and what finished recently. Open a job to see each output as it is made (every rendition, HLS and DASH, the thumbnails and the sprite sheets), the encoder's log while it runs, and each attempt. Failed encodes can be retried from there, and a thumbnail or sprite step that fails is now reported rather than skipped silently.
- added · Account: In the Image Library you can now select images (tick them, or Shift-click a range) and move them to another folder, or drag them onto a folder in the tree. Everything that uses a moved image keeps working, including assets, channel slates and logos, metadata and links already shared. An empty folder can be deleted from its folder view; a folder that still holds images says how many and where.
- added · API: New GET /api/analytics/qoe/sessions and GET /api/analytics/qoe/sessions/{sid} list the views behind the playback reports and return one session's full timeline; the playback overview now also returns rendering, access, live and ads.
- added · API: New POST /api/public/journey (publishable key) takes an app's journey events, and GET /api/analytics/qoe/journeys and GET /api/analytics/qoe/discovery read the journey to play and discovery reports. Playback report filters take entry_point and session_depth.
- added · On-demand ads: On-demand titles can now carry ad breaks: a pre-roll, mid-rolls at a title's own cue points or every few minutes, and a post-roll, filled by your ad server and then your house spots. Set it up under Admin > On-demand ads for the account or per content type. Viewers who paid play without ads, Apple devices fetch the ads themselves, and every other player gets them stitched in.
- added · Analytics: Playback reports show how many ads were played and how many were watched to the end, and each session lists its ad count.
- fixed · On-demand ads: Stitched HLS of a protected title no longer marks its clear ads as encrypted: the key is closed before each break and stated again where the title resumes. Guided playlists now mark pre- and post-rolls with the CUE attribute players read, and a mid-roll plays once.
- added · Player SDK: The player shows on-demand ads with a countdown and Learn more, keeps viewers from seeking inside an ad, and plays a skipped mid-roll before landing where the viewer asked (snapback). Custom skins read state.ad and call commands.adClick().
- added · Player: The Volt player marks on-demand ad breaks on the progress bar, yellow for a break still ahead and grey once watched, and the ad's words (Ad 1 of 2, Learn more) follow your player translations.
- added · On-demand ads: The Volt player now plays on-demand ads the guided way in every browser, on Android and on TVs, not only on Apple devices: it fetches each break's ads when it gets there, shows them in the same picture with the ad count and Learn more, and carries on with the title where it stopped.
- improved · Player SDK: The Volt player now reports ad breaks (abs and abe) and the HTTP status of a refused request, so ads and playback tokens refused mid-view show in the playback reports.
- added · Player SDK: The Volt player SDK has VoltJourney: a small, fixed set of app events (app open, screens, the title picked and where from, search, paywall and purchase, play) that ties how a viewer reached the play button to what happened after it. Nothing is sent until the viewer's consent allows it, search words are never sent, and the same events can be passed on to Google Analytics 4.
- added · Social: Threads: link a Threads profile under Social accounts and publish clips and Image Library pictures to it as posts with their text (up to 500 characters and one hashtag). Views, likes and followers are read back, the publish window shows how many of Threads' 250 daily posts each profile has used, and a sandbox Threads profile lets you try it first.
- added · On-demand ads: Titles encoded with DASH now get their ads in DASH too: a viewer with stitched ads gets a DASH stream of their own with each ad in its own Period, captions continuing across the breaks and the title's protection kept.
- added · Analytics: Under Sessions in Analytics > Playback you can open any viewer's session and see everything that happened to it in order: what they saw second by second, every report their player sent, the play gate's answer and the ad beacons sent for them.
- changed · Social publishing: X is now off by default, because X charges for every post and every read. Your Volt provider can switch it on for your account, or you can add your own X developer app under Social accounts so X bills you directly. X accounts you already linked are kept and shown as off until X is on again.
- added · On-demand ads: Your ad server can now decide where the breaks go in on-demand titles (VMAP, as Google Ad Manager's ad rules and FreeWheel do): choose The ad server places them (VMAP) under Where the breaks go. Volt asks for each viewer's schedule, puts each break on the nearest point where the video can switch, plays each break's ads from the ad server, and falls back to your own break settings with house spots when the ad server is slow or down.
- fixed · VOD: A clip whose build failed no longer sits in the library looking normal: the failure is written to the asset. Automatic VOD from the guide and scheduled clips now accept up to 60 s of missing recording (QC flags the gap) instead of failing outright, and a clip that skips a gap no longer fails at the last step.
- added · EPG: Viewer apps can now read the programme guide with their app key: what is on now, what is next and what was just on, a channel's day, and a multi-channel grid, from `/api/public/epg`. A FAST channel's guide comes straight from its active lineup, and every schedule change shows in the guide at once.
- added · VOD: Choose what files are before they upload: the upload panel asks for the content type (or Let the rules decide) and holds files until you pick. Cutting a clip from a recording now offers its content type and fills the title and fields from the guide programme over the marks.
- added · VOD: Collections: group media your own way, nested as deep as you need (a collection per channel, a sub-collection for each week's playlist). Select media in the Media Library list or grid and add it to a collection, browse the library by collection from the new rail with every filter still working, and manage, order and remove collections on the new Collections page. In a FAST channel's run order, the library can add a whole collection in its order, and **Find media** opens the Media Library's full search and filters to add many titles at once.
- added · Channels: FAST channels can carry their own brand: idents that play between programmes (in the gaps, or between every programme like a broadcaster) and a brand loop that fills the rest of a gap. The On air tab now shows what is going to air next, to the second, under the preview: programmes, ad breaks, idents and the brand loop, with a countdown to the next item.
- added · FAST: A FAST channel now has a channel page like a live channel or an event: **Overview** (laid out like a live channel: the guide strip with what is on now and up next, then a split with the output preview on the left and **On air now** on the right: the asset playing with its poster, position in the asset, metadata, encode (resolution, codecs, bitrates, renditions, formats) and its source file in full; below, what goes to air next, viewers, the log, the playout and its media, graphics on the channel, and every URL: public HLS and DASH, console monitoring, per-viewer stitched sessions and the public guide API), **Build** (run order, week, repeats, ads, brand loop) and **Settings** (name, content type with title, description and genre, logo, guide icon, watermark and Up next graphics). The header has Share, Embed, live graphics control and **Go live** / **Take off air**; Go live activates the run order first when nothing is on air yet. A FAST channel's watermark is drawn by the player over the picture, because its programmes are copied to air without re-encoding: every Volt player, embed and share link shows it, and the play gate gives apps the mark (`meta.brandMark`) to draw themselves.
- added · FAST: FAST channels can use **Loops & Fillers** for filler: under Build > Brand & filler, pick the **slate** (plays in ad breaks nobody sold, and in gaps when there is no loop) and the **gap loop** (fills the gaps between programmes in the slate's place, with or without idents), and optionally play the loop in unsold breaks too. Each slate or loop is rendered once into a broadcast-shaped clip (1920×1080, 25 fps, stereo; a still slate becomes 10 s with silence, a loop up to 2 min, given silence if it has none), prepared for air like any FAST slate, and shared by every channel that uses it. These clips stay out of the Media Library.
- fixed · FAST: FAST channels now play when Volt runs with the Docker encoder launcher (run-on-mac.sh): the playout runs on the host, as it does with the local launcher, instead of never starting and leaving the channel at "Starting". The FAST channel page has a **Start** button (and Restart the playout) like a live channel, and a **QC** drawer that checks the run order, guide, media, playout, output manifest, what is on air, the public URL, watermark and ads. Deleting a media asset no longer fails with "operator does not exist: bigint = uuid" when something linked to it (review notes, QC runs, ad rows) is keyed by a number rather than a uuid.
- fixed · Watchfolders: Files that a watchfolder in a storage bucket accepted were never added to the library and stayed Waiting. They are now added like files from any other watchfolder, and the downloaded copy is removed once the library has it.
- added · VOD: Media Library status: every asset shows whether it can be used (Ready, Not checked, QC failed, Building, Build failed, Will not play, No media), with a Status filter and a Problems shortcut. A failed build says why on the asset and offers Build again, or Build accepting the gaps when the recording has holes. Only Ready assets are offered to FAST channels, planned onto air, or accepted as a blackout replacement.
- improved · Watchfolders: On AWS, a watchfolder in a storage bucket now takes a file in as soon as it finishes uploading, usually within seconds, instead of waiting for the next check of the folder. Put the folder under watch/ in Volt's own bucket; every bucket folder is still looked through once an hour in case a file was missed.
- added · Analytics: Playback reports now include Delivery, from the CDN's own logs of every request: errors, cache hits, time to first byte at the edge and at the origin, segment delivery speed and requests made with an empty buffer. Viewers whose player sends no reports, such as a stream address opened in another player, are now counted, and Telemetry health shows how many sessions report themselves.
- fixed · VOD: QC no longer passes an asset it could not measure. An asset with no media, or media that will not open or decode, now fails QC with the reason, and QC reads the HLS manifest a viewer plays rather than an MP4 that a streaming clip never has. The QC panel lists every check: what it found, that it was clean, or why it could not run. A picture with no audio track is reported.
- added · Account: Single sign-on for admin users: connect Microsoft Entra ID, Okta, Google Workspace or any OpenID Connect or SAML 2.0 provider in Admin > Single sign-on, verify your email domain with a DNS record, and your team signs in with "Continue with …". New people can be created on their first sign-in with roles from their provider groups, the provider's two-step sign-in can count as Volt's, and SSO can be made compulsory (account owners keep a password as the way back in).
- fixed · VOD: An upload whose content type has a required field left empty (a bug's Advertiser, for example) is now encoded straight away, with its renditions, thumbnails and preview sprites, instead of sitting at "No media" until the field is filled. Uploaded H.264 / AAC MP4 and MOV files also get an MP4 beside HLS and DASH, and the asset page shows the source file's full technical details: container, size, duration, overall and per-stream bitrates, codec with profile and level, resolution, aspect, frame rate, scan, bit depth, colour, and every audio and subtitle track.
- changed · VOD: **An asset's image is in its metadata.** The content type's main image field (Image, Thumbnail, Cover or Artwork) now shows the image the asset already uses, chosen frame or default, instead of an empty box, and follows it when a better image is picked. An image someone sets in that field still wins and is never overwritten. Existing assets are filled in once on upgrade.
- added · FAST: **Audio FAST channels are a clear choice.** New FAST channel now asks "Video channel" or "Audio channel (radio)", and each channel's library and Find media offer only its own media: video for a video channel, audio and songs for an audio channel (the filters can narrow inside that, never leave it). Audio channels get ad breaks too: house spots from audio in the library, and stitched ads where the ad server is told the inventory is audio (`[MEDIA_TYPE]`, `[AD_TYPE]`, `[INVENTORY_TYPE]` tag macros) and an audio creative is preferred.  **Key metadata in the manifests.** Every programme marker in HLS (`EXT-X-DATERANGE`) and DASH (`EventStream`) now carries the programme's description, genre, series, season, episode, rating, year, language, artist and album, the asset and its length, and what is next (title, start, subtitle, image), for players' now and next displays. Up next cards carry the next programme's key fields too. The Volt player exposes them as `programme.meta` and `nextProgramme`, even with stream graphics off.
- fixed · FAST: **FAST channels play one ladder.** A FAST channel now has a ladder (picked when it is made, the account default unless another is chosen, changeable on On air), and every title, house spot, slate and ident on it is packaged to exactly that ladder in the background. Before, the channel took its renditions from its first title, so a smaller source, or a film wider than 16:9 whose height dropped the 1080p rendition, put 720p pictures under the 1080p rendition and players stalled at the join. A title whose own encode already matches is used as it is; anything else gets a copy made for the ladder beside its own encode (letterboxed to 16:9, every rendition, the channel's frame rate), recorded against the title so other channels on the same ladder reuse it.  **The library offers what can fill the channel.** A channel's library lists sources at or above its top rendition, by picture size and bitrate (a scope film counts by its width), and says how many smaller titles it is leaving out, with a way to show them anyway. On air shows the ladder, how many titles are packaged to it and the progress of the rest.  **Ladder, slate and loop in a FAST channel's Settings.** Settings now has the channel's ladder beside its slate and gap loop (which moved there from Build > Brand). Pick a ladder or make one, and set its renditions (height and bitrate, or a standard HD, HD lite or UHD set), picture sizes, frame rate, encoder, formats and segment length right there. It is the same editor Encoding profiles now uses, and it says what else shares the ladder before you change it; channels on it re-package what they air on their own.  **Ingest straight into the channel's renditions.** A ladder can now make fixed sizes: every rendition at its 16:9 size, letterboxed where the picture's shape differs, none dropped. Make such a ladder the account default (or a watch folder's) and uploads are encoded to exactly the renditions a FAST channel on that ladder plays, so they go to air without a second encode.
- added · Access: **FAST channels have their own permission, and a FAST Manager role.** Building and running FAST channels is now its own area in roles ("FAST channels": view, operate, manage), separate from live TV channels, and covers a FAST channel's own pages too. Encoding profiles and ladders are their own area as well, out of Account settings, and handling the ingest queue (held uploads, metadata, duplicates) is part of Files, uploads & storage. Existing roles keep exactly the access they had. The new built-in **FAST Manager** role runs FAST channels, the titles they air, the Image Library, Loops & Fillers, uploads and the encode queue, and ladders, and sees reports, with no access to live TV, radio, events, users or account settings. `npm run seed:fast-user` adds a FAST test user to the local demo account.
- added · Sources: **Validating an HLS source shows what metadata it carries.** Besides checking the playlist and the newest segment, the check now reads now playing from the playlist (the title and artist many radio services put in each #EXTINF) and from the ID3 tags at the start of the segment (title, artist, album, artwork, custom text and Apple's timestamp), and reports subtitle tracks, closed captions, EXT-X-DATERANGE and SCTE-35 markers, and whether the stream carries program date-time.
- improved · Analytics: Live playback reports stay exact when Volt runs on several servers: each viewer session is now counted by one server, and yesterday is rebuilt from the raw player reports every night.
- added · Delivery: Live streams now guide players when the delivery path is nearly full: playlists suggest a fair highest bitrate (CMSD), so players step down before the link stalls everyone. A stream delivered over more than one path can steer each viewer's player to the path that works best where they are, measured from the players' own playback reports, without a stall when it moves.
- fixed · Account: Moving or renaming an image in the Image Library now updates every place that uses it, including an asset's candidate frames and chosen song covers, so nothing loses its picture. Links left behind by earlier moves are repaired automatically.
- added · Analytics: Playback reports keep up as your audience grows. Past about a million viewer hours a month, Volt moves them to a dedicated analytics store (ClickHouse) by itself: nothing to set up, no gap in the figures, and the history is rebuilt from the raw reports so every report reads exactly as it did.
- added · Account: In the Image Library you can replace an image with another (a duplicate, a better version, or a broken upload): everything that used it switches to the one you keep, and the old one goes to the restore bin. Duplicates show where each copy is used and can be merged one group at a time, and Delete now lists every place an image is used.
- changed · VOD: Content can be created and saved with required metadata fields still empty, through the console or the API, and filled in along the way. Publishing checks them instead: it is refused until every required field is filled, and says which ones are missing.
- improved · VOD: The Image Library no longer fills up with sprite sheets. The previews behind scrub bars, recording and clip timelines are now kept in their own store, out of sight, and sheets already in the library are moved there automatically.
- added · VOD: **Trailer and Music video content types.** Two new standard content types for on-demand assets. **Trailer / promo** (schema.org VideoObject): title, what it is a trailer for, kind (trailer, teaser, promo, featurette, clip), description, release date, genre, rating, language and image. **Music video** (schema.org MusicVideoObject): title, artist, album, director, genre, label, ISRC, release date, explicit and image, matching the Song type so a music channel reads both the same way. Every account gets them automatically, and the library's metadata completeness covers them.
- fixed · Account: Moving or renaming a video in the Image Library (an animated bug) now moves its video, its thumbnail and its original file together, so it keeps playing and its card shows a picture. Videos split by an earlier move are put back together automatically.
- improved · EPG: A programme's slate or loop replacement is now chosen from Loops & Fillers, the same place as a stream's fallback, so a loop uploaded there can be picked for a slot. Slots saved earlier with an Image Library image keep working and offer a one-step copy into Loops & Fillers.
- fixed · EPG: Closing the programme form while it shows an overlap warning no longer hides the new programme: the guide reloads and lists it straight away.
- fixed · EPG: Escape now closes the Copy or repeat day dialog and the library image picker.
- added · VOD: Uploads are read by their file names: S01E03 makes an episode with its series, season and number, "Official Trailer" makes a trailer, and the title is tidied (`7th-voyage-of-sinbad_1958_trailer_1080p.webm` becomes "7th Voyage Of Sinbad"). Only what is clear is applied, nothing you typed or chose is replaced, and **Read from file name** on an asset or a selection shows each reading and why. A trailer's **Trailer for** now links to the film itself: Volt links it when one record matches clearly and suggests the closest ones when it does not. Your own file-name rules live in Ingest Rules, and the API returns linked records with `?include=linkedContent`.

### Internal

- added · Rights: Edge rights variants: reducer (one variant per distinct replace timeline, key v+8 hex, audience map vm in the KeyValueStore value), signed rights-class claim (vrc, key published at k:rc), the CloudFront Function rewrites to /<kind>/<id>/v/<key>/ and refuses a variant asked for by a viewer it would not send there. New test/edge-variants.check.ts runs the function file beside edgeRights.ts over 8840 fixture cases; the _rp replacement playlists are gone from the edge.
- added: Reframe: reframe_analyse.py (YuNet faces, shots, tracker, subjects; vendored model), track store sidecar, framing paths, per-frame crop render, jobs reframe.analyse and reframe.render, migration 0079, /api/vod/:id/reframe and /api/account-settings/reframe, social publish hand-off; encoder image and run-on-mac install numpy and OpenCV. volt/REFRAME.md. test_reframe_analyse.py 28/28, reframe.check.ts 76/76.
- added · Channels: Variant manifest service for edge rights (services/variantManifest.ts): HLS and DASH variants built from the delivered playlists with the pre-built loop, the edge function routes them to a new variants origin with Origin Shield (Terraform), check suite edge-variant-manifests.
- added · Tests: watchfolder-video-landing.check.ts: a VOD and a loop dropped into a folder, scanned through the API, checked in the Media Library, Loops & Fillers and the job queue, then scanned again ten minutes on.
- added: CMCD checks: cmcd.check.ts (the SDK's reports against the SVTA library's CMCD v2 validator, the transport rules, the collector, the Terraform rules) and cmcd-browser.check.ts (the real player in Chromium through the gate, the collector and a stand-in CDN).
- added: Guides batch 1.14-G1: the docs seed adds a radio station; screenshots run in a fixed time zone; docs-coverage check requires G1 (58 assertions).
- added: Guides batch 1.14-G2: the docs seed adds a slate (used by News 24) and a loop to Loops & Fillers; five screenshots added; docs-coverage check requires G2 (82 assertions).
- added: Guides batch 1.14-G3: G3 required in the coverage map; 13 screenshots added; the docs seed adds two images, a ladder mirroring HD, a watchfolder with two rules and the demo add-on on Recording completed, and fits the Main group to the plan as the default group; docs-coverage check 151 assertions.
- added: Guides batch 1.14-G4: G4 required in the coverage map; 9 new screenshots plus audit-log and dashboard retaken; the docs seed adds a fortnight of audience figures with neutral app names, two colleagues (one on Event Manager, one invited on a custom News desk role), two public users, a web and an iOS app with keys, an alert with a delivered and a failed copy, a template, a sandbox YouTube account, a product with a viewer, the server News 24 runs on with a week of metered time, the default roles on a fresh database, and fits the Main group's running-at-once to the plan; the screenshot script can remove an element from the layout; docs-coverage check 208 assertions.
- added: Guides framework: docs-site/coverage.json maps every console section, workflow and developer topic to its guide, with a check (npm run coverage, also in the docs build and the docs-coverage suite) that fails when the console and the map disagree or a required batch has gaps; section, workflow and developer page templates; npm run screenshots retakes every guide screenshot from the app on a fresh docs seed (volt-app/scripts/seed-docs.ts) and refuses a picture that shows a banned term.
- added · Analytics: QoE collector live path (services/qoe): raw reports kept first (local folder, or gzipped objects on S3 every 10 s), view rows and DDSketch minute aggregates in a separate analytics database with its own pool, held and retried while that database is down, replay by day partition (src/tools/qoe-replay.ts). Terraform for the raw archive bucket (versioning, Object Lock governance, 30 d Glacier IR, 90 d Deep Archive, 760 d expiry). Check suite test/qoe-reports.check.ts.
- added · Channels: Rights preview checks: rights-preview.check.ts (parity of the preview's reason with the CloudFront Function, tenancy, the strip against the edge function, the signed admin-only play path) and rights-preview.browser.mjs with its seed (plays the loop and the programme in Chromium).
- fixed: A fresh database start on the Mac (or RESET_DB=1) boots again: the demo snapshot now carries its migration ledger and generated ids, and a new check suite loads it the way run-on-mac.sh does. The check runner sets one test signing secret for suites and control planes; README, DOCS.md and the docs-site screenshot steps name only what is in the tree and what the screenshot flow needs.
- added: Browser check for the 1.14-G1a console fixes (volt-web/test/console-fixes.browser.mjs, 18 assertions) and a pure check for the FAST time zone list (volt-web/test/time-zones.check.ts); fast-lineup covers the empty run order.
- added · Docs: Developer guide code samples live in docs-site/samples, are included into the pages at build time, and are run against the API by the docs-samples check suite; G6 is required in the guide coverage map.
- added: Engineering guides in docs/engineering (architecture and service map, running on the Mac, check suites, build queue, releasing, the docs site, deploying to AWS), checked against the tree by scripts/docs/check-engineering.mjs and the engineering-guides suite.
- added · Tests: fast-access.check.ts: every route on the FAST router is listed with the TV channels level it needs and called over HTTP by roles without TV channels and at view, operate and manage; breaks on events and stations follow Events and Radio.
- added: Guides batch 1.14-G5: workflow guides in docs-site/docs/workflows with diagrams in static/img/flows; G5 required in the coverage map; docs-coverage checks every workflow page, its diagram and its link from the map; vodOwnership covers publishing an uploaded asset.
- added · Tests: New check suite workflow-fixes (27 assertions) and a browser walk workflow-fixes.browser.mjs with its seed, for build queue 1.14-G5a.
- added · Docs: Screenshots marked customerView are taken only when the login sees a customer's view (the script reads seesServerSetup and skips them otherwise), and the docs banned-term check now refuses server setting names and EC2 or Fargate. New check suite server-setup.
- added · Docs: The docs seed has four short titles with real source files and a FAST channel with a draft run order, so the FAST guide shows a run order and a week; new check suite docs-seed-fast.
- added · Analytics: Journey to play (build queue 1.14g): services/qoe/journeys.ts (event check, builder shared by the live path and the replay, qoe_app_sessions and qoe_journeys in the analytics database, reports 28 and 29), the raw store's journey stream, QoE definitions version 3 (journey id, app session, entry point and depth on each view), new check suite journey.check.ts and docs-samples checks for the new samples.
- added · Tests: New social-x check suite (46 assertions) for X access: off by default, the system administrator's switch, the account's own X app used for sign-in and token renewal, and the secret never returned.
- added · Tests: New vod-ads check suite (91 assertions): break planning, the two clocks, stitched and guided playlists, server-side beacons from segment requests, player events, clicks for VOD and FAST, ad-free viewers, an ad server timeout, the report, the console API and the SDK's snapback.
- added · Tests: New vod-ads-sgai check suite (73 assertions): the stitched MPD, HLS keys across a pod, captions per Period, the play gate and MPD on the real API, and in Chromium the Volt player playing guided ads through Shaka and the stitched MPD across a break in Shaka and dash.js.
- added · Analytics: QoE reports 5, 7, 8, 9 and 11 (services/qoe: views.ts definitions version 2 with ad as its own state, gateLog.ts timed play gate decisions by sid in the analytics database, timeline.ts from the raw reports); a stitched FAST session is named <sid>_<random> so ad beacons join the player's reports. Check suite test/qoe-reports-more.check.ts.
- added: Social publishing checks: a sandbox Instagram account, and a test suite against a stand-in for the Instagram and Facebook Graph APIs (both sign-ins, the container flow, the publishing limit).
- added: Social publishing checks: a Threads suite against a local Threads stand-in that fetches every media link from the Volt under test, and the signed media link Threads fetches videos from.
- added · Tests: vod-ads-skins check suite: ad strings, repeated ad events, the ad count in the reports, and the video skin with a stitched session in Chromium.
- added · Deploy: Chaos and scaling harness for the Tier-2 AWS deployment: kill an encoder task, lose a source, lose a zone, interrupt a Spot server and scale out under viewer load, each with a dry run, time budgets from the code and a pass or fail verdict (deploy/loadtest/chaos.mjs, run sheet CHAOS.md, FIS templates in deploy/terraform/chaos.tf, off by default).
- added · Deploy: CloudFront real-time logs of the delivery distribution go to an on-demand Kinesis stream (cdn_logs.tf, on by default); the scheduler's leader reads them into the analytics database and keeps the sampling rate near 1,000 lines a second. Settings CDN_LOG_*.
- added · Fleet: Live captions can share a GPU server: with captions_gpu_sharing on, a Whisper task reserves no GPU and placement packs captions onto a running GPU server while GPU memory and GPU time fit (two small-model streams on one g4dn.xlarge), falling back to a whole GPU when ECS will not start the shared task. Off by default until checked on a real T4.
- added · Testing: Mac end-to-end run sheet: bash scripts/e2e-mac.sh walks the whole product path against the running Volt (start, captions, rights, failover, record, clip, VOD, publish, radio, event, FAST) and prints pass, fail or skip per step. The check suite e2e-runsheet keeps its API calls matched to the real routes.
- improved · Fleet: On AWS each encoder keeps only a short window of its run on its server's disk once the segments are in S3 (30 minutes by default, never less than the DVR window plus two minutes), the encoder servers get a sized gp3 root volume, and placement's disk check is on and counts that window instead of the whole run. The Mac keeps every run locally as before.
- added: services/assetReadiness.ts (usage status SQL + TS), migration 0110 media_state/media_error, POST /api/vod/:id/rebuild, POST /api/vod/qc-unchecked, GET /api/recordings/:id/clip-defaults, POST /api/recordings/:id/clip takes schemaId + metadata, usage_status list field and facet, FAST libraryFor usage filter (airable), EPG replacement guard. test/asset-readiness.check.ts 25/25.
- added · Fleet: Stream sizing learns from every run: a multiplier per component and instance family is fitted from servers' measurements (bounded, outliers set aside), storage is projected from the bitrates, projection against actual is reported per class in the platform fleet plan, and placement can refuse a server whose task disk would run short (FLEET_TASK_DISK_GIB).
- added · Deployment: Terraform adds the watch folder drop queue (SQS with a dead-letter queue), the origin bucket's ObjectCreated notification under watch_s3_prefix, and the control plane's permission to read it; new suite watchfolder-s3-events.
- added · Deployment: Terraform is ready for a first apply: deploy/terraform/APPLY.md is the runbook, every control-plane setting is either set by Terraform or listed with its reason in env-coverage.json (checked by scripts/deploy/check-terraform-env.mjs and the terraform-env suite), media and uploads go to the origin bucket on AWS, the operator's own settings go in app_env and app_secret_keys, and a prod destroy no longer empties the origin bucket.
- added · Deployment: Terraform now runs radio stations and the Whisper live captions add-on on AWS: their image repositories and task definitions, and a GPU server pool for captions that starts at zero servers. Radio's Icecast relay on AWS is still to come.
- added · Deploy: ClickHouse analytics store (build queue 2.11): HTTP client and schema, the Postgres report SQL translated, QOE_STORE=postgres|clickhouse|auto with the automatic move, Terraform for two replicas, three keepers and nightly S3 backups (off by default), the clickhouse-store check suite, the chDB stand-in server for checks, the 13-month dashboard bench, the 100 000 viewer collector load test and the replica drill.
- fixed: Three unused-code typecheck errors in the console (ChannelDetail, EncodeJobs, ImagePicker) fixed so tsc -b runs clean; new EPG browser check volt-web/test/epg-fixes.browser.mjs.

## 0.12.0 (2026-10-23)

### Product (in customer release notes)

- added · API: One list of every stream: `GET /api/live-streams` returns your channels, radio stations, events and FAST channels together, with search, filters (kind, medium, preset, status, on air, group, dates), sorting, paging and totals. Each row links to its stream summary, its own record and its console page; add `health=true` for the same state, uptime and viewers the Live Streams board shows.
- improved · Live: The List view on Live Streams now searches and filters by kind (TV, Radio, Events, FAST) on the server and pages 50 at a time, so large fleets load quickly. FAST channels are labelled FAST, and opening an event or a FAST channel from Live Streams goes to its own page.
- changed · API: The stream presets (`GET /api/live-streams/presets`) no longer include Loop: a loop is a filler video in Loops & Fillers, used to cover a dropped source or a rights window, not a kind of stream.

### Internal

- added: Check suite live-streams-list (55 assertions): the one stream list across both tables, paging, visibility by role, health matching the board, hypermedia.

## 0.11.0 (2026-10-23)

### Product (in customer release notes)

- added · Player: Every Volt player now has a Playback stats panel: right-click the picture (or press Shift+D) to see the resolution, dropped frames, codecs, bitrate, connection speed, buffer, live latency and the CDN edge that served the stream, and copy it all for a support ticket. In the console it is on the channel output monitor (a Stats button beside HLS / DASH), the source and output previews, and every recording and media preview.
- added · FAST: Stitched ad breaks now report to your ad server: Volt sends each ad's impression, start, quartile, progress and complete trackers itself as each viewer's player reaches them, so a viewer who leaves halfway counts no complete. The channel's ad report shows impressions, completion and any tracker that failed, and the API gives the same per break.

### Internal

- added: New check suite fast-beacons (51 checks): server-side ad beacons end to end with a local VAST stub and a stand-in playout.

## 0.10.0 (2026-10-23)

### Product (in customer release notes)

- added · Graphics: Graphics set to Burned into the video now appear in the picture itself on transcode channels and events, so every viewer, recording, clip and third-party player sees them. Take them on, change them and take them off in live control as usual; they reach the encoded picture in well under a second, and leave it during ad breaks that hide graphics. A graphic assigned to burn while the stream is running appears from its next start.

### Internal

- added: Encoder: graphics renderer (headless Chromium, volt-encoder/gfx) and a composite-once filter graph for burned graphics, the burn feed for it (GET /api/streams/:id/burn-graphics, ingest token), GRAPHICS_BURN build argument for the encoder image, and the graphics-burn and test_gfx_burn checks.

## 0.9.0 (2026-10-23)

### Product (in customer release notes)

- fixed · Player: A Volt player created in code without naming a skin now gets the standard video look. Before, it could show with no picture area.
- changed · Player: Graphics in viewers' players now only use published template versions. A setup that is trying out a draft still works in the console preview and live control, and appears in players once it is moved to a published version.

### Internal

- added · Player: Browser check of player graphics end to end: shows, updates and hides through the operator API, and the template stays sandboxed (test/player-overlay-browser.check.ts).

## 0.8.0 (2026-10-23)

### Product (in customer release notes)

- improved · Graphics: Graphics live control, the running event rundown and a channel's graphics tab now update the moment anything changes (another operator's take, an API or feed update, a rundown cue, a rule going on at a programme start) instead of checking every second.

### Internal

- added · Graphics: graphics-live-push check suite (32 assertions): every graphics state change reaches a status stream subscriber as a gfx frame within a second, tenancy and permissions, and the consoles no longer poll.

## 0.7.0 (2026-10-23)

### Product (in customer release notes)

- added · Radio: HLS and DASH listeners now see the song and artist change inside the stream itself, at the moment it is heard: each title change on a station is carried in the audio as standard ID3 timed metadata, which Safari, hls.js, Shaka and dash.js read with no extra code.

### Internal

- added · Radio: Check suites for now-playing ID3 in emsg: radio-id3 (end to end with a synthetic ICY source and the real radio container) and test_id3_emsg.py (bytes, placement, which segments carry a tag); Dockerfile.radio now ships id3_emsg.py and a test fails if a module radio.py imports is not copied.

## 0.6.0 (2026-10-22)

### Product (in customer release notes)

- added · Channels: Ad breaks on live channels and events now carry SCTE-35 in the delivered streams: an SCTE-35 cue on the break in HLS, cue out and cue in on the segments it covers, and an SCTE-35 event in DASH. Downstream ad insertion and distribution partners see every break you start, schedule or send through the API.

### Internal

- added · Encoder: New check suite live-scte35 (break row to encoder poll to the real encoder placement, cues decoded back) and SCTE-35 placement cases in test_timed_events.py.

## 0.5.1 (2026-10-22)

### Internal

- fixed: Clip smart render: the join no longer leaves a gap after the copied middle (23 ms at 25 fps, 30 ms at 50 fps). Each part's length is now taken from its picture, and every render is checked frame by frame for gaps or overlaps before it is used. Smart render stays off by default.

## 0.5.0 (2026-10-22)

### Product (in customer release notes)

- improved · Media Library: The Encode tab now shows what each asset actually carries, read from its own files: the video profile and level of every rendition, each audio track with its codec, channels, sample rate and language, and, for a package-only stream, the codec and audio the contributor sent. File encodes also say which of the source's audio tracks was used, that subtitle tracks in the file are not carried yet, and that the result is not DRM protected.

### Internal

- added: Media facts for VOD assets: vod_assets.media_facts (migration 0077) from ffprobe of the delivered init segments, written by vod.encode and read once for recording-derived assets; vod_encoder.py probe lists every audio and subtitle track. vod-library.check.ts grows to 79 assertions and vod-library-pure.check.ts to 154.

## 0.4.0 (2026-10-22)

### Product (in customer release notes)

- added · Account: A new Captions page under Admin turns live captions on for the account, picks the engine (self-hosted Whisper or the Gladia service), and sets each output profile's caption languages, the language spoken, the delay that keeps captions in step with the picture, and the Whisper model. A profile used by a running stream is shown locked until that stream stops.

### Internal

- added: Captions settings API (/api/account-settings/captions) with its check suite, captions-settings.check.sh (38 assertions); the caption language list now lives in one module the API validates against.

## 0.3.0 (2026-10-22)

### Product (in customer release notes)

- added · API: New event routes matching the channel ones: `GET /api/events/{id}/access-check`, `GET /api/events/{id}/inputs/{inputId}/preview` and `POST /api/events/{id}/health/reset`.
- fixed · Events: On the event page, 'View as a viewer in' now answers for the event instead of showing Could not check, and an HLS source that blocks playback from other sites now previews through Volt.
- fixed · Events: The event page no longer goes blank once a live event's output starts playing.
- added · Events: The event page now has Clear QC, like the channel page: it resets the event's health after an earlier fault, and the fault stays in the event log.

### Internal

- added: Check suite event-routes.check.sh for the three event routes (tenancy, shape parity with channels, token binding, Clear QC effects, role).

## 0.2.1 (2026-10-22)

### Product (in customer release notes)

- fixed · FAST: Taking a FAST channel on or off air now counts towards its on-air hours and as-run reports, the same as any other channel. Before, those hours were missing from the totals.
- fixed · Radio: The Now playing column in the station list now shows the same line as the station page. A station on an HLS source, which cannot send titles, shows a dash instead of Untitled break, and Untitled break is kept for an Icecast station between two titles.

### Internal

- fixed · Tests: Baseline of all 179 check suites, each on its own database: 178 pass. Suites that drifted from the product were brought up to date (10 character passwords, roles model, platform sign-in with an authenticator code, plan allocation, kept metadata keys, smart render, the audio_radio skin). Fixture faults fixed: a docs test user and clashing fixture ids in the check seed, invited test users, and test media that suites now make themselves (smart render, ingest extract). New helpers test/lib/platform-session.sh and test/lib/react-global.ts.

## 0.2.0 (2026-10-22)

### Product (in customer release notes)

- fixed · EPG: Add EPG on a channel page now opens that channel's programme guide. It previously showed an error.
- improved · Monitoring: The channel event log no longer repeats a harmless packager timing warning every few seconds. It is summarised once a minute, and real audio gaps are still reported in full.
- fixed · Encoder: Transcoded audio is now always delivered at 48 kHz, which removes a recurring audio timing warning from the channel log when the source is 44.1 kHz.
- improved · EPG: When a guide can't be shown because its channel, event or station no longer exists, the page now says why and offers to choose another guide or create a new one.
- improved · API: Each service in the API reference now opens with what it is for, its key tasks and the access it needs.
- added · API: Every list in the API (VOD, recordings, jobs, channels, events, programme guide, users and more) now searches, filters, sorts and pages the same way: q, field=value, field[op]=value, sort=-field, limit and cursor. The API reference lists each list's fields and operators.
- fixed · API: Filtering VOD by recordingId now works (it was ignored), and an invalid limit on a stream's event history is refused with a clear message instead of an error.
- fixed · VOD: Uploaded and watch-folder assets can now be published, shared, found in search and counted in review and QC, like recorded assets. Assets recorded from events can now be shared too.
- added · Analytics: Operating reports for every channel, station and event: each run with its start, end, time on air and why it stopped, plus availability, faults, time to recover and audience peak, for any period and as a CSV download. Find them under Analytics, Operating.
- added · API: The hypermedia view of the API (send `Accept: application/ld+json` or add `?format=jsonld`) now covers every list and record. Every list is a Hydra collection with the full match count, first, previous, next and last page links, and its filters as a search template. Every record carries a breadcrumb from the entry point, links to its siblings, and one link per sub-resource. `GET /api` links every collection, and `GET /api/doc` declares each resource's operations (method, input and output) and properties. Plain JSON responses are unchanged and point at the hypermedia view with a `Link: rel="alternate"` header.
- fixed · Encoder: Channels using the Whisper captions add-on no longer also start a second transcription inside the encoder, which failed on every run with an import error.
- added · Encoder: FairPlay: DRM channels now carry the FairPlay key tag (SAMPLE-AES, com.apple.streamingkeydelivery) in their HLS playlists, using the key URI from your key service, alongside Widevine and PlayReady. The first seconds of each stream are now encrypted too (they were left in the clear).
- added · API: Lists now page both ways: the Link header carries rel="prev", "first" and "last" alongside "next" (with an X-Prev-Cursor header). Filler assets, scheduled clips, publish targets, publications and programmes can now be read by id (`GET /api/<resource>/{id}`), so every record's link opens it.
- added · Encoder: Live captions with Gladia: the Gladia engine now transcribes and translates live through one streaming session per run, written as WebVTT subtitle tracks like the Whisper engine.
- added · VOD: The Media Library has a grid view beside the list, with keyscreens, content type, availability, how complete each asset's metadata is and its top rendition. Filter by content type, availability, source, missing required metadata, resolution, codec, date and duration, and share the filtered view by its link. Each asset shows the metadata its type needs (an episode's series, season and episode number, a match's teams) and can fill it from the programme guide, never replacing what you typed. A new Encode tab shows the renditions, audio, captions, packaging and DRM.
- fixed · Recordings: On cloud (S3) storage, retention rules now really delete, cool and archive clip media in the bucket. Before, a deleted clip was marked deleted but its files stayed in storage.
- fixed · API: Paging through a list sorted by a time (for example sort=created_at) no longer repeats the last record of each page or skips records created in the same millisecond.
- added · EPG: Plan against as-run: the guide now records what actually aired (actual start and end, live while airing, aired when done) from the channel's own runs, and GET /api/epg/as-run compares plan and as-run per programme with on-air, source and filler time and whether it aired, partly aired or was missed.
- fixed · Encoder: Programme start and end markers in the stream now reach viewers on every channel. Before, they were only present on channels with subtitles or a backup source.
- added · Monitoring: QC shows a Captions lane for channels with live captions: starting, healthy, degraded (windows skipped) or failed with the reason and how to fix it. A captions problem never turns the channel red.
- added · API: Stream aggregate API: `GET /api/live-streams/{channel|event}/{id}` shows a stream as its production plane (origin, processing profile, placement) and distribution plane (schema.org VideoObject published by a BroadcastEvent, metadata, availability), its preset (live channel, live event, FAST channel) and its source-provider contract per tier (delivery, descriptive, guide, timed, rights, control). /schema.org serves the JSON-LD, with the sports fixture as broadcastOfEvent for sports events.
- fixed · Channels: Switch source and force slate or loop from the Failover panel now reach the encoder on cloud deployments (it runs on another server). Each choice is recorded in the channel's log with who made it, and a restart always returns to automatic.
- added · Player: Channels with a programme guide now carry an Up next notice in the stream itself, towards the end of each programme. The Volt player shows it with the next title, image and a countdown, and you can set when it appears per channel or turn it off in Player setup.
- fixed · Channels: A loop video chosen as a channel's fallback is now played as a loop. It was being treated as a still image.
- added · Monitoring: An On air button in the top bar shows how many streams are on air, degraded or failed, from any page, and opens a list with a link to each.
- added · Channels: Channel and event pages list every output address, private monitoring and public playback, each with its own preview, Copy button and live status.
- added · Channels: Channel and station pages can be arranged: move panels, minimise them or hide them, and reset to the default. Each person's layout is kept in their browser.
- added · Events: Each event now has its own page: the schedule with its server, event and public windows, source and output players, output addresses, viewers, status, event log and the recordings it made.
- fixed · Channels: Long pages no longer show a lighter band partway down the background when scrolled.
- fixed · EPG: Plan against as-run is recorded for television channels again. A database error stopped it on every pass.
- changed · Channels: Slates and loops for channels, stations and events are now chosen from Loops & Fillers, which shows which streams use each one. A slate picked from the Image Library before this keeps working and can be copied into Loops & Fillers in one step. Deleting a slate or loop that a stream uses now asks first and names the streams.
- changed · Account: The main menu now holds the pages you use every day. Setup, account and access pages have moved into an Admin area, with a link back to the page you left, and Ctrl K (⌘K on a Mac) jumps to any page or stream.

### SaaS platform

- added: Customer documentation site with guides, an interactive API reference and release notes, available to signed-in users from Volt.

### Internal

- added: Release tooling: change notes, scope rules, pre-commit check and a single release command. OpenAPI spec generated from the route inventory and captured requests.
- added: API list standard helper (listQuery), generic list test across all list endpoints, VOD ownership regression test, API_STANDARDS.md.
- added: Edge rights: a CloudFront Function on manifests enforces account and channel geo and programme blackouts from a KeyValueStore the control plane keeps current (off until EDGE_RIGHTS_KVS_ARN is set and the KeyValueStore SDK is installed). Move to a core note when it is switched on.
- added: Encoder health endpoint on HEALTH_PORT: /healthz (liveness, used by the ECS health check), /readyz, /metrics (Prometheus) and /status.
- changed: Baseline includes Media Library work in progress from a parallel session (asset images, music providers, song details) and a type fix in the FAST page.
- fixed: The API reference builds again: four services (FAST, Graphics, Live Streams, graphics delivery) were missing their usage statements. Two new Loops & Fillers routes documented; dev proxy passes /live/<id>/ to the API.

