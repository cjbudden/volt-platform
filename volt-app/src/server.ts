import express from 'express';
import cors from 'cors';
import { config } from './config';
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
import { mediaIngestRouter } from './modules/mediaIngest';
import { recordingsRouter } from './modules/recordings';
import { vodRouter } from './modules/vod';
import { metadataSchemasRouter } from './modules/metadataSchemas';
import { fillerAssetsRouter } from './modules/fillerAssets';
import { scheduledClipsRouter } from './modules/scheduledClips';
import { publishTargetsRouter, publicationsRouter } from './modules/publishing';
import { epgRouter } from './modules/epg';
import { appsRouter, availabilityRouter, accessRouter } from './modules/apps';
import { usersRouter } from './modules/users';
import { userGroupsRouter } from './modules/userGroups';
import { analyticsRouter, analyticsBeaconRouter } from './modules/analytics';
import { platformRouter } from './modules/platform';
import { platformAuthRouter } from './modules/platformAuth';
import { ticketsRouter, platformTicketsRouter } from './modules/tickets';
import { notificationsRouter, notificationTemplatesRouter } from './modules/notifications';
import { shareLinksRouter, publicShareRouter } from './modules/shareLinks';
import { publicLiveRouter } from './modules/publicLive';
import { hypermediaRouter } from './modules/hypermedia';
import { hypermediaNegotiation } from './middleware/hypermedia';
import { heartbeat } from './services/statusHub';
import { INGEST_PROTOCOLS } from './services/ingestProtocols';
import { mediaFilesRouter } from './modules/mediaFiles';
import { imageStore } from './services/imageStore';
import { parseSpec, resizeFromStore } from './services/imageResize';

export function createServer() {
  const app = express();
  app.set('trust proxy', true); // correct protocol/host behind the ALB for absolute link IRIs
  app.use(cors({ origin: config.corsOrigin, credentials: true }));
  // Image uploads arrive base64 in JSON (base64 inflates ~33%), so the library route
  // needs a larger body limit than the 1mb default. This parser runs first for
  // /api/files and consumes the stream, so the global 1mb parser below skips it.
  app.use('/api/files', express.json({ limit: '30mb' }));
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_req, res) => res.json({ ok: true, service: 'volt-control-plane' }));

  // Local test console (same-origin, no CORS): visit /console
  app.use(express.static('public'));
  app.get('/console', (_req, res) => res.redirect('/console.html'));

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
  }, express.static(config.testStream.originDir, {
    cacheControl: false,   // don't let express.static re-add its own Cache-Control
    setHeaders: (res, p) => {
      if (p.endsWith('.m3u8')) res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      else if (p.endsWith('.mpd')) res.setHeader('Content-Type', 'application/dash+xml');
      else if (p.endsWith('.m4s') || p.endsWith('.mp4')) res.setHeader('Content-Type', 'video/mp4');
      else if (p.endsWith('.vtt')) res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
    },
  }));

  // Public share surface (NO admin auth): the standalone /share/:token page and its
  // resolve/download endpoints. Mounted before the authed /api routers; it only ever
  // exposes the single shared resource.
  app.use(publicShareRouter);

  // Public live delivery (NO admin auth): /live/:id/master.m3u8|manifest.mpd. Only
  // serves when the channel is on air with valid content; off air returns 404.
  app.use(publicLiveRouter);

  // Content-negotiated JSON-LD + Hydra (Accept: application/ld+json). No-op for
  // plain-JSON clients, so the default contract is unchanged.
  app.use(hypermediaNegotiation);
  app.use('/api', hypermediaRouter); // GET /api (entrypoint), /api/context.jsonld, /api/doc

  app.use('/api/auth', authRouter);
  app.use('/api/channels', channelsRouter);
  app.use('/api/search', searchRouter);
  app.use('/api/sources', sourcesRouter);
  app.use('/api/groups', groupsRouter);
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

  // Resized preview derivatives (WebP), cached under the store's derived/ prefix.
  //   /img/<WxH>[,fit]/<store-key>   e.g. /img/320x200/library/<acct>/slates/x.png
  app.get('/img/*', async (req, res) => {
    try {
      const rest = req.path.replace(/^\/img\//, '');
      const slash = rest.indexOf('/');
      if (slash < 0) return res.status(400).end();
      const spec = parseSpec(decodeURIComponent(rest.slice(0, slash)));
      const key = decodeURIComponent(rest.slice(slash + 1));
      if (!spec || !/^(library|derived)\//.test(key)) return res.status(400).end();
      const out = await resizeFromStore(key, spec);
      if (!out) return res.status(404).end();
      res.setHeader('Content-Type', out.contentType);
      res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.end(out.buffer);
    } catch { res.status(400).end(); }
  });

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
      res.setHeader('Access-Control-Allow-Origin', '*');
      (stream as any).pipe(res);
    } catch { res.status(400).end(); }
  });
  app.use('/api/status', statusRouter);   // admin: polling REST + SSE live push
  app.use('/api/streams', ingestRouter);  // encoder -> POST /api/streams/:id/report
  app.use('/api/media', mediaIngestRouter); // thumbnailer -> POST /api/media/thumbnails
  app.use('/api/recordings', recordingsRouter);         // recordings library (+ publish/clip)
  app.use('/api/vod', vodRouter);                        // derived VOD assets + metadata
  app.use('/api/metadata-schemas', metadataSchemasRouter); // named metadata schemas
  app.use('/api/filler-assets', fillerAssetsRouter);     // slates & loops
  app.use('/api/scheduled-clips', scheduledClipsRouter); // timeline clip scheduling
  app.use('/api/epg', epgRouter);                        // EPG / programme scheduling
  app.use('/api/apps', appsRouter);                      // app registration + API keys
  app.use('/api/users', usersRouter);                    // tenant user management (admin+)
  app.use('/api/user-groups', userGroupsRouter);         // per-feature access groups (admin+)
  app.use('/api/availability', availabilityRouter);      // public play-gate → mints playback token (publishable key)
  app.use('/api/access', accessRouter);                  // public check-access → booleans, no token (publishable key)
  app.use('/api/analytics/beacon', analyticsBeaconRouter); // public session beacon (playback-token)
  app.use('/api/analytics', analyticsRouter);            // tenant reports (realtime/audience/usage)
  app.use('/api/tickets', ticketsRouter);                // client support tickets
  app.use('/api/notifications', notificationsRouter);    // notifications (send/inbox/retry)
  app.use('/api/notification-templates', notificationTemplatesRouter);
  app.use('/api/share-links', shareLinksRouter);         // admin: create/list/revoke share links
  app.use('/api/platform/auth', platformAuthRouter);     // SaaS-admin 2-step login (password → TOTP)
  app.use('/api/platform', platformRouter);              // SaaS-admin cross-tenant dashboard
  app.use('/api/platform/tickets', platformTicketsRouter); // SaaS-admin ticket triage
  app.use('/api/publish-targets', publishTargetsRouter); // social account config
  app.use('/api/publications', publicationsRouter);      // publish + view tracking
  // TODO: /api/groups, /api/accounts, /api/instances

  // SSE keep-alive so proxies don't drop idle status streams.
  const hb = setInterval(heartbeat, 25_000);
  hb.unref?.();

  app.use(errorHandler);
  return app;
}
