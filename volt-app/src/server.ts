import { accountSettingsRouter } from './modules/accountSettings';
import { sourcePreviewRouter } from './modules/sourcePreview';
import express from 'express';
import cors from 'cors';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { config, staleConsoleWarning } from './config';
import { currentRunId } from './services/liveOrigin';
import { errorHandler } from './util/http';
import { authRouter } from './auth/routes';
import { channelsRouter } from './modules/channels';
import { searchRouter } from './modules/search';
import { sourcesRouter } from './modules/sources';
import { groupsRouter } from './modules/groups';
import { eventsRouter } from './modules/events';
import { profilesRouter } from './modules/outputProfiles';
import { statusRouter, ingestRouter } from './modules/status';
import { monitoringRouter } from './modules/monitoring';
import { fleetRouter } from './modules/fleet';
import { playerRouter, playerAdminRouter } from './modules/player';
import { mediaIngestRouter } from './modules/mediaIngest';
import { recordingsRouter } from './modules/recordings';
import { jobsRouter } from './modules/jobs';
import { timelineRouter, daypartPresetsRouter } from './modules/timeline';
import { timelineGridRouter } from './modules/timelineGrid';
import { storageRouter } from './modules/storage';
import { vodRouter } from './modules/vod';
import { metadataSchemasRouter } from './modules/metadataSchemas';
import { fillerAssetsRouter } from './modules/fillerAssets';
import { uploadsRouter, uploadChunksRouter } from './modules/uploads';
import { scheduledClipsRouter } from './modules/scheduledClips';
import { publishTargetsRouter, publicationsRouter } from './modules/publishing';
import { socialRouter, socialPublicRouter } from './modules/social';
import { publishingRulesRouter } from './modules/publishingRules';
import { ingestRouter as ingestRulesRouter, ingestCallbacksRouter } from './modules/ingestRules';
import { tusRouter } from './modules/tus';
import { paymentsRouter, paymentsAppRouter, paymentsWebhookRouter } from './modules/payments';
import { epgRouter } from './modules/epg';
import { fastRouter, fastPlayoutRouter, fastPublicRouter } from './modules/fast';
import { xmltvAdminRouter, xmltvPublicRouter } from './modules/xmltv';
import { xmltvImportRouter } from './modules/xmltvImport';
import { appsRouter, availabilityRouter, accessRouter } from './modules/apps';
import { usersRouter } from './modules/users';
import { userGroupsRouter } from './modules/userGroups';
import { radioRouter } from './modules/radio';
import { attachMp3Listener } from './services/radio/pipeline';
import { icecastAuthRouter } from './modules/icecastAuth';
import { analyticsRouter, analyticsBeaconRouter } from './modules/analytics';
import { platformRouter } from './modules/platform';
import { fleetPlanRouter } from './modules/fleetPlan';
import { platformAuthRouter } from './modules/platformAuth';
import { ticketsRouter, platformTicketsRouter } from './modules/tickets';
import { docsSessionRouter } from './modules/docsSession';
import { notificationsRouter, notificationTemplatesRouter } from './modules/notifications';
import { shareLinksRouter, publicShareRouter } from './modules/shareLinks';
import { publicLiveRouter } from './modules/publicLive';
import { hypermediaRouter } from './modules/hypermedia';
import { liveStreamsRouter } from './modules/liveStreams';
import { hypermediaNegotiation } from './middleware/hypermedia';
import { heartbeat } from './services/statusHub';
import { INGEST_PROTOCOLS } from './services/ingestProtocols';
import { mediaFilesRouter } from './modules/mediaFiles';
import { watchfoldersRouter } from './modules/watchfolders';
import { encodeProfilesRouter } from './modules/encodeProfiles';
import { enginesRouter, engineHooksRouter } from './modules/engines';
import { workflowsRouter, addonsRouter, addonCallbacksRouter } from './modules/workflows';
import { imageStore } from './services/imageStore';
import { imagesPublicRouter, imagesApiRouter, imageService } from './modules/images';
import { thumbnailsRouter } from './modules/thumbnails';
import { auditDeletes } from './services/deleteAudit';
import { auditRouter } from './modules/audit';
import { graphicsRouter, graphicsFilesRouter, graphicsPlayerRouter } from './modules/graphics';
import { reportsRouter } from './modules/reports';
import { planRouter } from './modules/plan';
import { isBootReconciled } from './services/orchestrator';
import { mountHealth, publicOnlyGuard } from './scale/health';
import { publicAuthRouter, publicMeRouter } from './modules/publicApi';
import { viewersAdminRouter } from './modules/viewersAdmin';
import { scaleConfig } from './scale/config';

export function createServer() {
  const app = express();
  app.set('trust proxy', true); // correct protocol/host behind the ALB for absolute link IRIs
  // Scale: /health/live + /health/ready (scale/health.ts), and on the viewer
  // tier (ROLE=api-public) a 404 for anything that is not a public path.
  mountHealth(app);
  if (scaleConfig.role === 'api-public') app.use(publicOnlyGuard());
  app.use(cors({ origin: config.corsOrigin, credentials: true }));
  // EVERY DELETE IS LOGGED (services/deleteAudit.ts): done, or refused and why.
  app.use('/api', auditDeletes());
  // Image uploads arrive base64 in JSON (base64 inflates ~33%), so the library route
  // needs a larger body limit than the 1mb default. This parser runs first for
  // /api/files and consumes the stream, so the global 1mb parser below skips it.
  app.use('/api/files', express.json({ limit: '30mb' }));
  // Graphics: pasted template HTML and fonts added in the style editor arrive in JSON.
  app.use('/api/graphics/templates', express.json({ limit: '12mb' }));
  // Provider webhooks verify a signature over the exact bytes: mounted before the JSON parser.
  app.use('/api/payments/webhooks', paymentsWebhookRouter);
  // tus resumable uploads: PATCH bodies are raw octets, so this too sits before
  // the JSON parser. Any tus client (iOS, Android, Uppy, tus-py) uploads here.
  app.use('/api/tus', tusRouter);
  // Vendor encode-engine webhooks: the adapter verifies a signature over the raw bytes.
  app.use('/api/engine-hooks', engineHooksRouter);
  app.use(express.json({ limit: '1mb' }));
  // Add-on callbacks: public, authenticated by the per-run bearer token.
  app.use('/api/addon-callbacks', addonCallbacksRouter);

  // ok = the process is up and can answer. reconciled = boot reconciliation has
  // settled, so stream statuses and instance rows are no longer going to be
  // rewritten underneath a reader. Two different questions: a process that is
  // up but still reconciling should keep serving, and should not yet be trusted
  // for a decision that turns on what is running.
  app.get('/health', (_req, res) =>
    res.json({ ok: true, service: 'volt-control-plane', reconciled: isBootReconciled() }));

  // Local test console (same-origin, no CORS): visit /console
  app.use(express.static('public'));
  // ON-DEMAND PLAYLISTS, WITH THEIR SKIP MARKERS (services/vodMarkers.ts).
  //
  // Intro and credits markers can be moved at any time, so they are written into
  // the playlists when a player asks rather than baked in at build time: HLS
  // media playlists get EXT-X-DATERANGE (and the PROGRAM-DATE-TIME it needs),
  // MPDs an EventStream. That is also why playlists here are no longer cached
  // for a year like the segments are: a marker edit has to reach a viewer who
  // already loaded the asset once. Segments keep the long cache below.
  //
  // FAILS OPEN: anything unexpected falls through to the plain file.
  app.get(/^\/clips\/.+\.(m3u8|mpd)$/, async (req, res, next) => {
    try {
      const { assetIdFromClipsPath, playlistContext, annotateHls, annotateMpd } = await import('./services/vodMarkers');
      const rel = decodeURIComponent(req.path.slice('/clips'.length));
      const file = join(config.clips.dir, rel);
      if (!file.startsWith(config.clips.dir) || rel.includes('..')) return next();
      const id = assetIdFromClipsPath(rel);
      const { readFile } = await import('node:fs/promises');
      const text = await readFile(file, 'utf8');
      const ctx = id ? await playlistContext(id) : null;
      const isMpd = req.path.endsWith('.mpd');
      const out = !ctx || !ctx.markers.length ? text
        : isMpd ? annotateMpd(text, ctx.markers, id!) : annotateHls(text, ctx.markers, ctx.anchorMs, id!);
      res.setHeader('Content-Type', isMpd ? 'application/dash+xml' : 'application/vnd.apple.mpegurl');
      res.setHeader('Cache-Control', 'public, max-age=10');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.end(out);
    } catch { next(); }
  });
  // Generated clips and their renditions, served like origin. Segments are
  // immutable once written, so unlike origin they may be cached hard.
  app.use('/clips', express.static(config.clips.dir, {
    setHeaders: (res) => res.setHeader('Cache-Control', 'public, max-age=31536000, immutable'),
  }));
  // /console WAS a 205-line single-file test console in public/, built before
  // volt-web existed. It is retired to volt-app/dev/console.html: it is not the
  // product's console, it looked like one, and somebody finding it reasonably
  // concluded the app had a second, older front end. The real console is the
  // volt-web bundle served at / (see resolveWebDist).
  app.get('/console', (_req, res) => res.redirect('/'));

  // TEST BUILD origin: serve the locally-generated HLS/DASH/WebVTT so the app player
  // can play back a real live test stream.
  //
  // CACHE: the packager REUSES the same segment filenames every run (seg_1.m4s,
  // init.mp4, sub_N.vtt), so a segment URL does NOT identify unique content across runs.
  // Marking segments `immutable` therefore poisons the browser cache: after a restart the
  // player replays the PREVIOUS run's segment-1 (old footage) and old caption segments
  // until it walks past the cached range, then "jumps to live". So we must NOT cache
  // segments immutably here — `no-cache` keeps a copy but forces revalidation (cheap 304
  // when unchanged within a run, a fresh fetch when the same filename holds new content
  // after a restart). Playlists are never stored.
  app.use('/origin', (req, res, next) => {
    // PER-RUN NAMESPACE: /origin/<id>/live/* is the stable player/share URL; rewrite it
    // to the CURRENT run dir (runs/<runId>/*) named by the channel's pointer file. Falls
    // back to the channel root when no pointer exists (test stub / legacy layout), so
    // both producers keep working. Segment URIs inside manifests are relative, so they
    // resolve under /live/ and get rewritten here too.
    const live = req.url.match(/^\/([A-Za-z0-9-]+)\/live(\/.*)?$/);
    if (live) {
      const rest = live[2] ?? '/master.m3u8';
      const run = currentRunId(live[1]);
      req.url = run ? `/${live[1]}/runs/${run}${rest}` : `/${live[1]}${rest}`;
    }
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (/\.(m3u8|mpd)$/.test(req.path)) res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    else if (/\.(m4s|mp4|ts|vtt)$/.test(req.path)) res.setHeader('Cache-Control', 'no-cache');
    next();
  },
  /* ------------------------------------------------------------------------
   *  TIMED IN-STREAM METADATA — VIDEO. `EXT-X-DATERANGE` for the programmes a
   *  media playlist's window covers, added HERE rather than by the encoder.
   *
   *  The schedule lives in Postgres and keeps changing after the segment was
   *  written: a programme is renamed, an override lands, an ad break moves.
   *  Baking tags in at encode time would freeze a decision still being made and
   *  would push the EPG across a boundary the encoder has no business knowing
   *  about. The control plane already rewrites these URLs, so it annotates on
   *  the way out.
   *
   *  ONLY MEDIA PLAYLISTS, and that is structural rather than a filename check:
   *  `annotatePlaylist` returns the input untouched when there is no
   *  PROGRAM-DATE-TIME, and a multivariant master has none. So a master cannot
   *  accidentally receive tags that are illegal in it.
   *
   *  FAILS OPEN, ALWAYS. Anything that goes wrong here — unreadable file,
   *  database down, a schedule query that throws — falls through to the plain
   *  static handler. Metadata is an enhancement; playback is the product, and no
   *  viewer should lose a stream because an EPG lookup timed out.
   * --------------------------------------------------------------------- */
  async (req, res, next) => {
    if (!req.path.endsWith('.m3u8')) return next();
    const m = /^\/([A-Za-z0-9-]+)\//.exec(req.path);
    if (!m) return next();
    try {
      const { join } = await import('node:path');
      const { readFile } = await import('node:fs/promises');
      const file = join(config.testStream.originDir, decodeURIComponent(req.path));
      // Never let a crafted path climb out of the origin directory.
      if (!file.startsWith(config.testStream.originDir)) return next();
      const text = await readFile(file, 'utf8');
      const { playlistWindow, injectDateRanges } = await import('./services/timedMetadata');
      const win = playlistWindow(text);
      if (!win) return next();                       // master, or no wall clock
      // The same triggers the encoder writes (programme boundaries and graphics
      // such as Up next), from the cached schedule: no query per request.
      const { triggersForStream, hlsTag } = await import('./services/graphicTriggers');
      let trig = await triggersForStream('channel', m[1], win.from, win.to);
      if (!trig.length) trig = await triggersForStream('event', m[1], win.from, win.to);
      if (!trig.length) return next();               // nothing to say
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      return res.end(injectDateRanges(text, trig.map(hlsTag)));
    } catch { return next(); }
  },
  express.static(config.testStream.originDir, {
    cacheControl: false,   // don't let express.static re-add its own Cache-Control
    setHeaders: (res, p) => {
      if (p.endsWith('.m3u8')) res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      else if (p.endsWith('.mpd')) res.setHeader('Content-Type', 'application/dash+xml');
      else if (p.endsWith('.m4s') || p.endsWith('.mp4')) res.setHeader('Content-Type', 'video/mp4');
      else if (p.endsWith('.vtt')) res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
    },
  }));

  // Public LIVE MP3 listeners (NO admin auth) — the radio equivalent of /origin.
  // One encoder, N listeners: the control plane fans the station's MP3 out and
  // injects ICY now-playing titles for clients that send Icy-MetaData: 1.
  app.get('/radio/:id/stream.mp3', async (req, res) => {
    try {
      const ch = await (await import('./db')).one<any>(
        `SELECT id, name, kind FROM channels WHERE id=$1 AND kind='radio'`, [req.params.id]);
      if (!ch) return res.status(404).end();
      // CONTAINER MODE: there is no local pipeline to attach to. The preview
      // and the public URL resolve to the same relay mount, which is a real
      // change in meaning worth stating: with the station in a container there
      // is ONE stream, and "preview before going on air" is enforced by
      // Icecast's listener auth rather than by which endpoint you called.
      const { radioIsContainerised, radioRunState } = await import('./services/radio/state');
      if (radioIsContainerised()) {
        if (!(await radioRunState(ch.id)).running) {
          return res.status(404).json({ error: 'station is not live' });
        }
        const { publicMp3Url } = await import('./services/radio/jobConfig');
        return res.redirect(302, publicMp3Url(ch.id));
      }
      const ok = attachMp3Listener(ch.id, req as any, res as any, ch.name);
      if (!ok) return res.status(404).json({ error: 'station is not live' });
    } catch { res.status(400).end(); }
  });

  // Public share surface (NO admin auth): the standalone /share/:token page and its
  // resolve/download endpoints. Mounted before the authed /api routers; it only ever
  // exposes the single shared resource.
  app.use(publicShareRouter);

  // Public XMLTV partner feeds (NO admin auth): /xmltv/<token>.xml[.gz]. The
  // token is the credential and carries the scope; see modules/xmltv.ts.
  app.use(xmltvPublicRouter);
  // Social: the OAuth return (the browser arrives without our bearer token)
  // and the sandbox post page. Everything else under /api/social is authed.
  app.use(socialPublicRouter);

  // Public live delivery (NO admin auth): /live/:id/master.m3u8|manifest.mpd. Only
  // serves when the channel is on air with valid content; off air returns 404.
  app.use(publicLiveRouter);
  // Graphics template files: public by version id, sandboxed, immutable once published.
  app.use(graphicsFilesRouter);
  // Source preview relay: token-addressed, so it is mounted before any requireAuth (modules/sourcePreview.ts).
  app.use('/api/source-preview', sourcePreviewRouter);

  // Content-negotiated JSON-LD + Hydra (Accept: application/ld+json). No-op for
  // plain-JSON clients, so the default contract is unchanged.
  app.use(hypermediaNegotiation);
  app.use('/api', hypermediaRouter); // GET /api (entrypoint), /api/context.jsonld, /api/doc

  app.use('/api/auth', authRouter);
  app.use('/api/channels', channelsRouter);
  app.use('/api/search', searchRouter);
  app.use('/api/sources', sourcesRouter);
  app.use('/api/groups', groupsRouter);
  app.use('/api/plan', planRouter);
  app.use('/api/account-settings', accountSettingsRouter);  // logo and colours (docs/ACCOUNT_SETTINGS.md)  // the account's plan and how groups share it (docs/PLAN_AND_GROUPS.md)
  app.use('/api/events', eventsRouter);
  app.use('/api/output-profiles', profilesRouter);
  app.get('/api/ingest-protocols', (_req, res) => res.json({ protocols: INGEST_PROTOCOLS }));
  // Caption OUTPUT languages the pipeline can actually DELIVER. Single source of truth
  // for the language pickers in the creation and settings forms. Must stay in step with
  // the encoder's translation capability: whisper transcribes ~100 languages and
  // natively translates X->English; every non-English target below is served by the
  // NLLB MT stage and needs a FLORES mapping in volt-encoder/bin/captions.py.
  app.get('/api/caption-languages', (_req, res) => res.json({
    languages: [
      { code: 'en', label: 'English' },
      { code: 'ms', label: 'Malay' },
      { code: 'id', label: 'Indonesian' },
      { code: 'zh', label: 'Chinese (Simplified)' },
      { code: 'zh-Hant', label: 'Chinese (Traditional)' },
      { code: 'ta', label: 'Tamil' },
      { code: 'hi', label: 'Hindi' },
      { code: 'es', label: 'Spanish' },
      { code: 'fr', label: 'French' },
      { code: 'ar', label: 'Arabic' },
    ],
  }));
  app.use('/api/files', mediaFilesRouter);   // image library (file manager)
  app.use('/api/watchfolders', watchfoldersRouter);  // ingest folders, rules, review queue
  app.use('/api/encode-profiles', encodeProfilesRouter);  // renditions + ladder groups
  app.use('/api/engines', enginesRouter);           // encode engines: builtin + vendor adapters (ENGINES.md)
  app.use('/api/workflows', workflowsRouter);       // base workflow map, add-on runs, traces (WORKFLOWS.md)
  app.use('/api/addons', addonsRouter);             // add-on services + triggers (admin)

  // On-the-fly image service: signed URLs only, immutable responses, S3 +
  // CloudFront derivative cache (modules/images.ts, docs/IMAGES.md).
  //   /img/{sig}/{W}x{H},{fit}[,token...]/library/{acct}/{path}
  imageService();   // fail at boot, not on the first request, when misconfigured
  app.use('/img', imagesPublicRouter());
  app.use('/api/images', imagesApiRouter);  // sign, signing-key, config, stats
  app.use('/api/audit', auditRouter);  // the account's audit log: who did what, deletes included (admins)
  // HTML graphics: templates, setups, assignments, live state, rundowns (docs/REQ_graphics_overlays.md)
  app.use('/api/graphics', graphicsRouter);
  app.use('/api/thumbnails', thumbnailsRouter);  // encoder stills, sprite sheets, hover + clip VTTs

  // Serve image-library bytes from the store (local dir or S3). Public read so <img>
  // tags + the resize service can fetch by path (keys carry the opaque account id;
  // production gates with the image service's signed URLs). This is the resize origin.
  app.get('/library/*', async (req, res) => {
    try {
      const key = decodeURIComponent(req.path.replace(/^\//, '')); // 'library/<account>/<path>'
      const stream = await imageStore().getStream(key);
      if (!stream) return res.status(404).end();
      const ext = (key.split('.').pop() || '').toLowerCase();
      const ct: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif' };
      if (ct[ext]) res.setHeader('Content-Type', ct[ext]);
      res.setHeader('Cache-Control', 'public, max-age=300');
      // Originals may be SVG: never let one run script on this origin.
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
      res.setHeader('Access-Control-Allow-Origin', '*');
      (stream as any).pipe(res);
    } catch { res.status(400).end(); }
  });
  app.use('/api/status', statusRouter);   // admin: polling REST + SSE live push
  // The fleet, computed server-side: one request draws the live board or the
  // alert list, rather than the page fanning out per channel.
  app.use('/api/monitoring', monitoringRouter);
  app.use('/api/fleet', fleetRouter);
  // The console's own player configuration. Session auth.
  app.use('/api/player-config', playerAdminRouter);
  app.use('/api/live-streams', liveStreamsRouter);  // the stream aggregate: planes, preset, provider tiers (services/streamModel.ts)
  app.use('/api/streams', ingestRouter);  // encoder -> POST /api/streams/:id/report
  app.use('/api/media', mediaIngestRouter); // thumbnailer -> POST /api/media/thumbnails
  app.use('/api/recordings', recordingsRouter);         // recordings library (+ publish/clip)
  app.use('/api/jobs', jobsRouter);                     // long-running work: progress, reasons, retry
  // Timeline, coverage and dayparts hang off a channel, so they mount UNDER the
  // channels prefix and after it — the channels router owns /:id itself.
  app.use('/api/channels', timelineRouter);
  app.use('/api/daypart-presets', daypartPresetsRouter);
  // The Live Streams page's Timeline view: every visible stream on one clock,
  // in one call (TIMELINE_MODE.md). Gated as monitoring, like /api/monitoring/live.
  app.use('/api/timeline', timelineGridRouter);
  // Media lifecycle: what exists, where it lives, whether it can be read now,
  // and what retention will do to it next. NOT /api/media — that prefix is the
  // thumbnailer's ingest callback and belongs to a different concern entirely.
  app.use('/api/storage', storageRouter);
  app.use('/api/vod', vodRouter);                        // derived VOD assets + metadata
  app.use('/api/metadata-schemas', metadataSchemasRouter); // named metadata schemas
  app.use('/api/filler-assets', fillerAssetsRouter);     // slates & loops
  // Resumable uploads. Chunk bodies are raw octets carrying their own capability
  // token, so they mount BEFORE the JSON parser's reach and without requireAuth;
  // session management is an ordinary tenant operation and sits behind both.
  // Finished filler bytes, served so a loop can be previewed in the browser.
  // Immutable once written: the asset id IS the filename, so a new upload is a
  // new id rather than a new version of the same URL.
  app.use('/filler', express.static(config.uploads.fillerDir, {
    setHeaders: (res) => { res.setHeader('Cache-Control', 'public, max-age=31536000, immutable') },
  }));
  app.use('/api/uploads', uploadChunksRouter);
  app.use('/api/uploads', uploadsRouter);
  app.use('/api/scheduled-clips', scheduledClipsRouter); // timeline clip scheduling
  app.use('/api/epg/import', xmltvImportRouter);          // XMLTV import: sources, channel mapping, runs
  app.use('/api/epg', xmltvAdminRouter);                  // XMLTV export, guide channels, partner feeds (per-route auth)
  app.use('/api/epg', epgRouter);                        // EPG / programme scheduling
  // FAST / VOD-to-live channels (docs/DESIGN_fast_channels.md): lineups, ads,
  // breaks for the console; the timeline for the playout (ingest token); and
  // the per-viewer ad stitcher, public like the origin it sits beside.
  app.use('/api/fast-playout', fastPlayoutRouter);
  app.use('/api/fast', fastRouter);
  app.use('/fast', fastPublicRouter);
  // Icecast asks this before admitting a listener; it is the on-air gate now
  // that the control plane is not the one holding the socket. Mounted BEFORE
  // the authed radio router because the caller is the relay, not a user.
  app.use('/api/radio/icecast', icecastAuthRouter);
  app.use('/api/radio', radioRouter);                    // radio (audio-only) stations
  app.use('/api/apps', appsRouter);                      // app registration + API keys
  app.use('/api/users', usersRouter);                    // tenant user management (admin+)
  app.use('/api/user-groups', userGroupsRouter);         // access roles (original path)
  app.use('/api/access-roles', userGroupsRouter);        // access roles (ACCESS_CONTROL.md)
  // THE PLAYER'S PUBLIC SURFACE. Publishable-key + origin allow-list, never a
  // JWT: this is called from a browser on somebody else's website. Mounted
  // beside the other publishable-key routes rather than under the authed /api
  // tree, because a stray requireAuth here would break every embed silently.
  // Graphics drawn by viewers' players: feed + impressions (modules/graphics.ts), before the player router.
  app.use('/api/player/graphics', graphicsPlayerRouter);
  app.use('/api/player', playerRouter);
  // ---- THE PUBLIC API (/api/public/*): viewers and anonymous visitors only.
  // See modules/publicApi.ts and ACCESS_CONTROL.md. The older public paths
  // below stay as aliases of the same handlers.
  app.use('/api/public/auth', publicAuthRouter);
  app.use('/api/public/me', publicMeRouter);
  app.use('/api/public/availability', availabilityRouter);
  app.use('/api/public/access', accessRouter);
  app.use('/api/public/player', playerRouter);
  app.use('/api/public/analytics/beacon', analyticsBeaconRouter);
  app.use('/api/public/payments', paymentsAppRouter);
  // Admin view of public users (feature `viewers`).
  app.use('/api/viewers', viewersAdminRouter);
  app.use('/api/availability', availabilityRouter);      // public play-gate → mints playback token (publishable key)
  app.use('/api/access', accessRouter);                  // public check-access → booleans, no token (publishable key)
  app.use('/api/analytics/beacon', analyticsBeaconRouter); // public session beacon (playback-token)
  app.use('/api/reports', reportsRouter);              // per-stream operating reports + CSV (docs/REQ_stream_reporting.md)
  app.use('/api/analytics', analyticsRouter);            // tenant reports (realtime/audience/usage)
  app.use('/api/tickets', ticketsRouter);                // client support tickets
  app.use('/api/docs', docsSessionRouter);              // signed pass to the customer docs site (modules/docsSession.ts)
  app.use('/api/notifications', notificationsRouter);    // notifications (send/inbox/retry)
  app.use('/api/notification-templates', notificationTemplatesRouter);
  app.use('/api/share-links', shareLinksRouter);         // admin: create/list/revoke share links
  app.use('/api/platform/auth', platformAuthRouter);     // SaaS-admin 2-step login (password → TOTP)
  app.use('/api/platform/fleet-plan', fleetPlanRouter);   // placement + consolidation advice (read-only)
  app.use('/api/platform', platformRouter);              // SaaS-admin cross-tenant dashboard
  app.use('/api/platform/tickets', platformTicketsRouter); // SaaS-admin ticket triage
  app.use('/api/publish-targets', publishTargetsRouter); // social account config
  app.use('/api/publications', publicationsRouter);      // publish + view tracking
  app.use('/api/social', socialRouter);                   // linked accounts, publish to social, progress, views
  app.use('/api/publishing-rules', publishingRulesRouter); // the ladder + publishing points
  app.use('/api/ingest', ingestCallbacksRouter);             // provider callbacks, no Volt session
  app.use('/api/ingest', ingestRulesRouter);                 // ingest rules ladder, preview, webhooks
  app.use('/api/payments', paymentsAppRouter);           // the app verifies a receipt (publishable key)
  app.use('/api/payments', paymentsRouter);              // providers, products, viewers, grants (admin)
  // TODO: /api/groups, /api/accounts, /api/instances

  // An unmatched API route answers as an API, in JSON. Express's default 404 is
  // an HTML page, which was merely odd before and is actively misleading now
  // that this server also serves an HTML app: a client with a typo'd endpoint
  // got a page back and had to guess why its parser failed.
  app.use(['/api', '/origin', '/clips', '/filler', '/live'], (req, res) => {
    res.status(404).json({ error: 'not found', path: req.originalUrl });
  });

  // ---- the console --------------------------------------------------------
  //
  // Served by the control plane, same origin, so there is one thing to deploy
  // and no CORS to configure. The router in volt-web has always SAID this is
  // how production works; until now nothing implemented it, so a built bundle
  // had nowhere to be served from and `docker compose up` gave you an API and
  // no interface.
  //
  // MOUNTED LAST, and after every /api router, which is the part that matters.
  // A catch-all placed earlier would swallow unmatched /api requests and answer
  // them with HTML, so a typo'd endpoint would return 200 and an index page
  // instead of a 404 the caller could act on.
  // THE PLAYER BUNDLE, served from the same origin as the API.
  //
  // Cached hard and served with permissive CORS, because by definition it is
  // fetched by a <script> tag on a domain that is not ours. Mounted before the
  // console's catch-all so the SPA fallback cannot swallow it and return an
  // HTML page with a javascript content type, which fails in a way that reads
  // as "the player is broken" rather than "the path is wrong".
  if (config.player.bundleDir && existsSync(join(config.player.bundleDir, 'volt-player.js'))) {
    console.log(`[player] serving the embed bundle from ${config.player.bundleDir}`);
    app.use('/player', (_req, res, next) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      next();
    }, express.static(config.player.bundleDir, {
      index: false,
      setHeaders: (res, p) => {
        if (/\.js$/.test(p)) res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
        // Not immutable: the filename is unhashed, so a customer's page holds
        // whatever it cached. Ten minutes keeps it fast without making a fix
        // take a day to reach the sites carrying it.
        res.setHeader('Cache-Control', 'public, max-age=600');
      },
    }));
  }

  const webDist = config.webDistDir;
  if (webDist && existsSync(join(webDist, 'index.html'))) {
    console.log(`[console] serving the built console from ${webDist}`);
    // LOUD, because the alternative is silent. A stale copy serves an old
    // version of the app with no error anywhere: every page loads, every page
    // works, and the work you just did is simply not there. Nothing else in
    // the system can tell you that, so the boot log has to.
    const stale = staleConsoleWarning(webDist);
    if (stale) console.warn(stale);
    // Hashed assets are immutable; index.html must never be cached or a deploy
    // leaves browsers holding a page that references assets that no longer
    // exist.
    app.use(express.static(webDist, {
      index: false,
      setHeaders: (res, p) => {
        if (p.endsWith('index.html')) res.setHeader('Cache-Control', 'no-store');
        else if (/\/assets\//.test(p)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      },
    }));
    // SPA fallback: the console uses history routing, so /channels/<id> is a
    // real URL a person can reload or share and the server has to answer it
    // with the app rather than a 404.
    app.get('*', (req, res, next) => {
      // Anything that belongs to a real backend surface is NOT the app, even
      // when it did not match: those must keep their own 404s and their own
      // content types.
      if (/^\/(api|origin|clips|filler|live|radio|share|img|library|health)\b/.test(req.path)) return next();
      if (req.method !== 'GET' && req.method !== 'HEAD') return next();
      // A request that wants JSON is a client, not a browser navigating.
      if (req.accepts(['html', 'json']) !== 'html') return next();
      res.setHeader('Cache-Control', 'no-store');
      res.sendFile(join(webDist, 'index.html'));
    });
  } else if (config.env !== 'test') {
    console.warn(`[web] no console bundle at ${webDist || '(unset)'}; serving the API only. ` +
      'Run `npm run build` in volt-web, or build the image, which does it for you.');
  }

  // SSE keep-alive so proxies don't drop idle status streams.
  const hb = setInterval(heartbeat, 25_000);
  hb.unref?.();

  app.use(errorHandler);
  return app;
}
