import express from 'express';
import cors from 'cors';
import { config } from './config';
import { errorHandler } from './util/http';
import { authRouter } from './auth/routes';
import { channelsRouter } from './modules/channels';
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
import { analyticsRouter, analyticsBeaconRouter } from './modules/analytics';
import { platformRouter } from './modules/platform';
import { platformAuthRouter } from './modules/platformAuth';
import { ticketsRouter, platformTicketsRouter } from './modules/tickets';
import { notificationsRouter, notificationTemplatesRouter } from './modules/notifications';
import { shareLinksRouter, publicShareRouter } from './modules/shareLinks';
import { hypermediaRouter } from './modules/hypermedia';
import { hypermediaNegotiation } from './middleware/hypermedia';
import { heartbeat } from './services/statusHub';
import { INGEST_PROTOCOLS } from './services/ingestProtocols';

export function createServer() {
  const app = express();
  app.set('trust proxy', true); // correct protocol/host behind the ALB for absolute link IRIs
  app.use(cors({ origin: config.corsOrigin, credentials: true }));
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_req, res) => res.json({ ok: true, service: 'volt-control-plane' }));

  // Local test console (same-origin, no CORS): visit /console
  app.use(express.static('public'));
  app.get('/console', (_req, res) => res.redirect('/console.html'));

  // TEST BUILD origin: serve the locally-generated HLS/DASH/WebVTT so the app player
  // can play back a real live test stream. Playlists must not be cached; segments can.
  app.use('/origin', (req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (/\.(m3u8|mpd)$/.test(req.path)) res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    else if (/\.(m4s|mp4|ts|vtt)$/.test(req.path)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    next();
  }, express.static(config.testStream.originDir, {
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

  // Content-negotiated JSON-LD + Hydra (Accept: application/ld+json). No-op for
  // plain-JSON clients, so the default contract is unchanged.
  app.use(hypermediaNegotiation);
  app.use('/api', hypermediaRouter); // GET /api (entrypoint), /api/context.jsonld, /api/doc

  app.use('/api/auth', authRouter);
  app.use('/api/channels', channelsRouter);
  app.use('/api/groups', groupsRouter);
  app.use('/api/events', eventsRouter);
  app.use('/api/output-profiles', profilesRouter);
  app.get('/api/ingest-protocols', (_req, res) => res.json({ protocols: INGEST_PROTOCOLS }));
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
