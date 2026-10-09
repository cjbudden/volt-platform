// ============================================================================
//  ICECAST LISTENER AUTHENTICATION — where the on-air gate lives once the
//  control plane is out of the audio path.
//
//  THE PROBLEM THIS SOLVES. Today the control plane holds every listener's
//  connection, so "off air means 404, and taking a station off air drops the
//  listeners who are already connected" is enforced simply by not writing any
//  more bytes. Push MP3 to a relay and that stops being true for free: Icecast
//  knows nothing about `on_air`, so a mount that exists is a mount anyone can
//  play, and a redirect from here would gate precisely nothing because the
//  listener can skip the redirect and go straight to the mount.
//
//  THE MECHANISM. Icecast can be told to ask before admitting a listener:
//
//      <mount>
//        <mount-name>/<channel>.mp3</mount-name>
//        <authentication type="url">
//          <option name="listener_add" value="http://control-plane:8080/api/radio/icecast/listener-auth"/>
//          <option name="auth_header"  value="icecast-auth-user: 1"/>
//        </authentication>
//      </mount>
//
//  Icecast POSTs form-encoded fields on every listener connect and admits the
//  listener only if the response carries the auth header. So the gate stays
//  exactly where the knowledge is, which is here, and the audio still never
//  passes through us.
//
//  WHAT IT DOES NOT DO. `listener_add` fires on CONNECT. It cannot retract a
//  listener who is already playing, so taking a station off air stops new
//  listeners rather than dropping current ones. Closing the existing ones is a
//  second action against Icecast's admin API (`/admin/killclient`), and it is
//  deliberately kept separate: an operator taking a station off air for rights
//  reasons needs both, and an operator ending a show only needs this.
//
//  TRUST. This endpoint is unauthenticated in the ordinary sense because
//  Icecast is the caller, so it is protected two ways: a shared secret that the
//  relay is configured with, and the expectation that the relay reaches it on
//  an internal address. It answers about a public resource and reveals nothing
//  a listener could not learn by trying the mount, so the failure mode of a
//  leaked secret is a bypassed gate rather than a data leak.
// ============================================================================
import { Router } from 'express';
import express from 'express';
import { one } from '../db';
import { config } from '../config';
import { asyncHandler } from '../util/http';
import { radioHasValidContent } from '../services/radio/detail';

export const icecastAuthRouter = Router();

/** Icecast posts application/x-www-form-urlencoded, not JSON. */
icecastAuthRouter.use(express.urlencoded({ extended: false }));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `/<uuid>.mp3` -> the uuid. Anything else is not one of ours.
 *
 * Icecast may append a query string to the mount it reports, so it is stripped
 * before matching rather than being allowed to defeat the pattern.
 */
export function channelIdFromMount(mount: string | undefined): string | null {
  if (!mount) return null;
  const clean = String(mount).split('?')[0].replace(/^\/+/, '');
  const m = /^([0-9a-fA-F-]{36})\.mp3$/.exec(clean);
  if (!m || !UUID.test(m[1])) return null;
  return m[1].toLowerCase();
}

/**
 * Deny is the default for every path that is not an explicit allow, including
 * a malformed request. A gate that fails open is not a gate, and this one
 * stands in front of rights-restricted audio.
 */
icecastAuthRouter.post(
  '/listener-auth',
  asyncHandler(async (req, res) => {
    const secret = config.icecast.authSecret;
    if (secret) {
      const given = String(req.headers['x-volt-relay-secret'] ?? req.body?.volt_secret ?? '');
      if (given !== secret) { res.status(403).send('denied'); return; }
    }

    const id = channelIdFromMount(req.body?.mount);
    if (!id) { res.status(403).send('denied'); return; }

    const ch = await one<any>(
      `SELECT id, status, on_air FROM channels WHERE id = $1 AND kind = 'radio'`, [id]
    ).catch(() => null);
    if (!ch) { res.status(403).send('denied'); return; }

    // The same three conditions the control plane enforced when it held the
    // socket: the station exists, it has been taken on air deliberately, and it
    // is actually producing something worth connecting to.
    if (!ch.on_air || ch.status !== 'live' || !radioHasValidContent(id)) {
      res.status(403).send('denied');
      return;
    }

    // The header is what admits the listener; the body is only for humans
    // reading Icecast's log.
    res.setHeader('icecast-auth-user', '1');
    res.status(200).send('ok');
  })
);

/**
 * Icecast also calls this when a listener disconnects, if configured. We have
 * nothing to do with it, but it must answer 200 or Icecast logs an error for
 * every listener that ever leaves.
 */
icecastAuthRouter.post('/listener-remove', (_req, res) => { res.status(200).send('ok'); });
