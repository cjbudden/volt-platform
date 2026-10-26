// ============================================================================
//  SOCIAL PUBLISHING: linking accounts, holding their tokens, posting clips,
//  syncing views. The per-platform API calls are in ./platforms.ts.
//
//  THE FLOW
//   1. Connect: the console asks for an authorize URL; the browser goes to the
//      platform; the platform redirects to /api/social/callback/<platform>;
//      we exchange the code, read who the account is (a YouTube channel, the
//      Facebook Pages the person manages, an X or TikTok or Dailymotion
//      account) and store one publish target per account, tokens encrypted.
//   2. Publish: a publication row per (asset, account) with the post as the
//      person wrote it (title, caption, tags, privacy), then a `social.publish`
//      job. The job renders an MP4 if the asset has none, uploads it, and
//      writes back the platform's id and URL, with progress on the row so the
//      console can show it.
//   3. Views: synced from each platform on the orchestrator tick, hourly per
//      publication, and on demand. Likes and follower counts too, where the
//      platform gives them (Instagram).
//
//  INSTAGRAM (build queue 1.14i) links two ways (Instagram Login, or Facebook
//  Login for an account tied to a Page; kept per target as `variant`), posts
//  a clip as a Reel and an Image Library picture as a feed post (a
//  publication of `image_key` instead of an asset), through the container
//  flow kept in `platform_state`, and holds to its 24 hour publishing limit.
//
//  THREADS (build queue 1.14j) is the same container flow on the Threads API,
//  with two differences that shape this file: Threads takes no upload, it
//  fetches the video (and the picture) from Volt's public address, so the job
//  places the file where /api/social/media/<publication>.mp4 serves it under a
//  signed, expiring link (fetchableVideo); and Threads allows one hashtag, its
//  topic tag, per post, so only the first tag goes.
//
//  A failure that retrying cannot fix (the platform rejected the video, the
//  account's access was revoked) fails the publication at once with the
//  platform's own words and tells the account's admins. Anything else is
//  retried by the job queue, and fails the publication only on the last try.
// ============================================================================
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, statSync, existsSync, mkdirSync, copyFileSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { query, one } from '../../db';
import { config } from '../../config';
import { seal, open, tokenKeyConfigured, signMedia, mediaSignatureOk } from './crypto';
import { PLATFORMS, PLATFORM_IDS, appCreds, SocialError, type PlatformId, type PostSpec, type Privacy, type LinkedAccount, type AppCreds } from './platforms';

export { PLATFORMS, PLATFORM_IDS, SocialError };
export type { PlatformId, PostSpec, Privacy };

export const SOCIAL_PUBLISH = 'social.publish';
const STATE_TTL_MIN = 10;

const publicBase = () => config.publicBaseUrl.replace(/\/$/, '');
export const callbackUrl = (p: PlatformId) => `${publicBase()}/api/social/callback/${p}`;

// ---------------------------------------------------------------- X access

/**
 * WHETHER AN ACCOUNT MAY USE X (build queue 1.14h). X bills its API per post
 * and per read, so X is off unless the platform's switch is on for the account
 * (a system administrator sets it: X then runs on the deployment's X app) or
 * the account brought its own X developer app (X bills the customer). With
 * neither, X is hidden and refused everywhere: linking, sandbox, publishing,
 * publishing rules, view syncing and take-downs. Linked X accounts are kept.
 */
export interface XAccess { switchOn: boolean; ownApp: { clientId: string; updatedAt: string | null } | null; allowed: boolean }

export async function xAccess(accountId: string | null | undefined): Promise<XAccess> {
  const r = accountId ? await one<any>(`SELECT x_enabled, x_client_id, x_client_secret_enc, x_app_updated_at FROM accounts WHERE id = $1`, [accountId]) : null;
  const switchOn = !!r?.x_enabled;
  const ownApp = r?.x_client_id && r?.x_client_secret_enc ? { clientId: r.x_client_id as string, updatedAt: r.x_app_updated_at ? new Date(r.x_app_updated_at).toISOString() : null } : null;
  return { switchOn, ownApp, allowed: switchOn || !!ownApp };
}

export const X_OFF = 'X is not switched on for this account. A system administrator switches it on, or the account adds its own X developer app under Social accounts.';

export async function assertPlatformAllowed(platform: string, accountId: string | null | undefined): Promise<void> {
  if (platform !== 'x') return;
  if (!(await xAccess(accountId)).allowed) throw new SocialError(X_OFF, { permanent: true });
}

/** The app credentials a sign-in or token refresh for this account uses: its own X app first, else the deployment's (the variant's, where the platform has several ways in). */
export async function appFor(platform: PlatformId, accountId: string | null | undefined, variant?: string | null): Promise<AppCreds | null> {
  if (platform === 'x' && accountId) {
    const r = await one<any>(`SELECT x_enabled, x_client_id, x_client_secret_enc FROM accounts WHERE id = $1`, [accountId]);
    if (r?.x_client_id && r?.x_client_secret_enc) return { id: r.x_client_id, secret: open(r.x_client_secret_enc)! };
    if (!r?.x_enabled) throw new SocialError(X_OFF, { permanent: true });
  }
  return appCreds(PLATFORMS[platform], variant);
}

/** The way in a sign-in takes: the one asked for, else the first the deployment has an app for, else the first. */
export function pickVariant(platform: PlatformId, wanted?: string | null): string | null {
  const vs = PLATFORMS[platform].variants;
  if (!vs?.length) return null;
  if (wanted) {
    if (!vs.some((v) => v.id === wanted)) throw new SocialError(`${PLATFORMS[platform].label} has no sign-in called "${wanted}" (${vs.map((v) => v.id).join(', ')}).`, { permanent: true });
    return wanted;
  }
  return (vs.find((v) => appCreds(PLATFORMS[platform], v.id)) ?? vs[0]).id;
}

/** Save (or clear, with null) the account's own X developer app. The secret is sealed and never read back out. */
export async function setOwnXApp(accountId: string, app: { clientId: string; clientSecret: string } | null): Promise<void> {
  await query(`UPDATE accounts SET x_client_id = $2, x_client_secret_enc = $3, x_app_updated_at = now(), updated_at = now() WHERE id = $1`,
    [accountId, app?.clientId ?? null, app ? seal(app.clientSecret) : null]);
}

/**
 * Which platforms can be linked here. `setup` adds what whoever runs the
 * deployment needs to set one up (the token key, each platform's two settings,
 * its redirect URL and permissions); an account user gets only whether each is
 * ready, because they cannot act on the rest (services/serverSetup.ts).
 */
export function platformStatus(setup = true, x?: XAccess) {
  return {
    ...(setup ? { tokenKeyConfigured: tokenKeyConfigured(), callbackBase: `${publicBase()}/api/social/callback/` } : {}),
    setupDetail: setup,
    // An account X is off for gets no X card at all (`x` given and not allowed).
    platforms: PLATFORM_IDS.filter((id) => id !== 'x' || !x || x.allowed).map((id) => {
      const p = PLATFORMS[id];
      // With its own X app the account is ready whatever the deployment has.
      const variants = p.variants?.map((v) => ({ id: v.id, label: v.label, configured: !!appCreds(p, v.id),
        ...(setup ? { env: [v.env.id, v.env.secret], scopes: v.scopes } : {}) }));
      const configured = id === 'x' && x?.ownApp ? true : id === 'x' && x && !x.switchOn ? false : variants ? variants.some((v) => v.configured) : !!appCreds(p);
      return {
        id, label: p.label, accountNoun: p.accountNoun, configured,
        ...(id === 'x' && x ? { ownApp: !!x.ownApp } : {}),
        ...(variants ? { variants } : {}),
        images: !!p.images, publishingLimit: !!p.publishingLimit,
        ...(setup ? { env: [p.env.id, p.env.secret], callbackUrl: callbackUrl(id), scopes: p.scopes } : {}),
        limits: p.limits, privacy: p.privacy,
      };
    }),
  };
}

// ---------------------------------------------------------------- connect

export async function startConnect(platform: PlatformId, accountId: string, userId: string | null, wantedVariant?: string | null): Promise<string> {
  const p = PLATFORMS[platform];
  const variant = pickVariant(platform, wantedVariant);
  const c = await appFor(platform, accountId, variant);
  const e = (variant && p.variants?.find((v) => v.id === variant)?.env) || p.env;
  if (!c) throw new SocialError(`${p.label} is not set up on this deployment: set ${e.id} and ${e.secret}.`, { permanent: true });
  const state = randomBytes(24).toString('base64url');
  const verifier = p.pkce ? randomBytes(48).toString('base64url') : null;
  const challenge = verifier ? createHash('sha256').update(verifier).digest('base64url') : null;
  await query(`DELETE FROM social_oauth_states WHERE created_at < now() - make_interval(mins => $1)`, [STATE_TTL_MIN]);
  await query(`INSERT INTO social_oauth_states(id, account_id, user_id, platform, code_verifier, variant) VALUES ($1,$2,$3,$4,$5,$6)`,
    [state, accountId, userId, platform, verifier, variant]);
  return p.authorizeUrl(c.id, callbackUrl(platform), state, challenge, variant);
}

/** Store (or refresh) one linked account as a publish target. */
async function upsertTarget(accountId: string, userId: string | null, platform: PlatformId, a: LinkedAccount, mode: 'live' | 'sandbox', variant: string | null = null): Promise<any> {
  const expires = a.expiresIn ? new Date(Date.now() + a.expiresIn * 1000).toISOString() : null;
  const existing = await one<any>(
    `SELECT id FROM publish_targets WHERE account_id=$1 AND platform=$2 AND external_account=$3 AND mode=$4`,
    [accountId, platform, a.externalId, mode]);
  if (existing) {
    return one(`UPDATE publish_targets SET access_token_enc=$2, refresh_token_enc=COALESCE($3, refresh_token_enc), token_expires_at=$4,
                       scopes=COALESCE($5, scopes), account_label=$6, avatar_url=$7, link_status='connected', link_detail=NULL,
                       linked_by=$8, linked_at=now(), enabled=true, updated_at=now(),
                       variant=$9, followers=COALESCE($10, followers), followers_synced_at=CASE WHEN $10::bigint IS NULL THEN followers_synced_at ELSE now() END
                 WHERE id=$1 RETURNING *`,
      [existing.id, seal(a.accessToken), seal(a.refreshToken ?? null), expires, a.scopes ?? null, a.label, a.avatar ?? null, userId, variant, a.followers ?? null]);
  }
  // `name` is unique per account and platform; two Pages can share a name.
  let name = mode === 'sandbox' ? `${a.label} (sandbox)` : a.label;
  for (let i = 2; await one(`SELECT 1 FROM publish_targets WHERE account_id=$1 AND platform=$2 AND name=$3`, [accountId, platform, name]); i++) {
    name = `${mode === 'sandbox' ? `${a.label} (sandbox)` : a.label} ${i}`;
  }
  return one(
    `INSERT INTO publish_targets(account_id, platform, name, external_account, enabled, mode, access_token_enc, refresh_token_enc,
                                 token_expires_at, scopes, account_label, avatar_url, link_status, linked_by, linked_at,
                                 variant, followers, followers_synced_at)
     VALUES ($1,$2,$3,$4,true,$5,$6,$7,$8,$9,$10,$11,'connected',$12, now(), $13, $14, CASE WHEN $14::bigint IS NULL THEN NULL ELSE now() END) RETURNING *`,
    [accountId, platform, name, a.externalId, mode, seal(a.accessToken), seal(a.refreshToken ?? null), expires, a.scopes ?? null,
     a.label, a.avatar ?? null, userId, variant, a.followers ?? null]);
}

export async function finishConnect(platform: PlatformId, state: string, code: string | null, error: string | null): Promise<{ accountId: string | null; linked: string[]; error?: string }> {
  const st = await one<any>(`DELETE FROM social_oauth_states WHERE id=$1 AND platform=$2 RETURNING *, (created_at > now() - make_interval(mins => $3)) AS fresh`, [state, platform, STATE_TTL_MIN]);
  if (!st) return { accountId: null, linked: [], error: 'This sign-in link has already been used or was not started here. Start again from Social accounts.' };
  if (!st.fresh) return { accountId: st.account_id, linked: [], error: 'The sign-in took longer than ten minutes. Start again.' };
  if (error || !code) return { accountId: st.account_id, linked: [], error: error ? `${PLATFORMS[platform].label} said: ${error}` : 'No authorization code came back.' };
  try {
    const p = PLATFORMS[platform];
    const variant: string | null = st.variant ?? null;
    const tokens = await p.exchange(code, callbackUrl(platform), st.code_verifier, await appFor(platform, st.account_id, variant), variant);
    const accounts = await p.accounts(tokens, variant);
    const linked: string[] = [];
    for (const a of accounts) { await upsertTarget(st.account_id, st.user_id, platform, a, 'live', variant); linked.push(a.label); }
    return { accountId: st.account_id, linked };
  } catch (e: any) {
    return { accountId: st.account_id, linked: [], error: e.message };
  }
}

/** A sandbox account: behaves like the platform without calling it. */
export async function addSandbox(accountId: string, userId: string | null, platform: PlatformId, label?: string) {
  await assertPlatformAllowed(platform, accountId);
  const p = PLATFORMS[platform];
  // "Volt test professional account" is a mouthful for a handle: Instagram's sandbox is plainly an account.
  const name = label?.trim() || `Volt test ${platform === 'instagram' ? 'account' : p.accountNoun}`;
  const handle = platform === 'x' || platform === 'tiktok' || platform === 'instagram' || platform === 'threads';
  return upsertTarget(accountId, userId, platform, {
    externalId: `sandbox-${randomBytes(6).toString('hex')}`, label: handle ? `@${name.replace(/\s+/g, '_').toLowerCase()}` : name,
    accessToken: 'sandbox', refreshToken: null, expiresIn: null, followers: platform === 'instagram' ? 1200 : platform === 'threads' ? 300 : null,
  }, 'sandbox');
}

// ---------------------------------------------------------------- tokens

/** A usable access token for a target, refreshed when it is about to expire. */
export async function validToken(target: any): Promise<string> {
  if (target.mode === 'sandbox') return 'sandbox';
  const p = PLATFORMS[target.platform as PlatformId];
  let token = open(target.access_token_enc);
  if (!token) throw new SocialError(`${target.account_label ?? target.name} is not linked: connect it again.`, { permanent: true });
  const exp = target.token_expires_at ? new Date(target.token_expires_at).getTime() : null;
  // An Instagram token lasts 60 days and renews only while it is still valid:
  // renew it in its last week, not in its last two minutes.
  // A Threads token is the same: 60 days, renewed with th_refresh_token while valid.
  const ahead = (target.platform === 'instagram' && target.variant !== 'facebook') || target.platform === 'threads' ? 7 * 86_400_000 : 120_000;
  if (exp && exp < Date.now() + ahead) {
    const rt = open(target.refresh_token_enc);
    if (!rt || !p.refresh) {
      await markLink(target.id, 'expired', 'The access token expired and the platform gave no way to renew it. Connect the account again.');
      throw new SocialError(`${target.account_label ?? target.name}: access expired. Connect the account again.`, { permanent: true });
    }
    try {
      const t = await p.refresh(rt, await appFor(target.platform, target.account_id, target.variant), target.variant);
      token = t.accessToken;
      await query(`UPDATE publish_targets SET access_token_enc=$2, refresh_token_enc=COALESCE($3, refresh_token_enc), token_expires_at=$4,
                          link_status='connected', link_detail=NULL, updated_at=now() WHERE id=$1`,
        [target.id, seal(t.accessToken), seal(t.refreshToken ?? null), t.expiresIn ? new Date(Date.now() + t.expiresIn * 1000).toISOString() : null]);
    } catch (e: any) {
      // Renewing early (Instagram's last week) and the token still works: use it, renew next time.
      if (exp > Date.now() + 120_000 && !(e instanceof SocialError && (e.auth || e.permanent))) {
        console.warn('[social] early token renewal failed, the current token is still valid', target.id, e?.message ?? e);
        return token;
      }
      if (e instanceof SocialError && e.permanent) await markLink(target.id, 'expired', `Renewing access failed: ${e.message}. Connect the account again.`);
      throw e;
    }
  }
  return token;
}

async function markLink(targetId: string, status: 'connected' | 'expired' | 'error', detail: string | null) {
  await query(`UPDATE publish_targets SET link_status=$2, link_detail=$3, updated_at=now() WHERE id=$1`, [targetId, status, detail]);
}

// ---------------------------------------------------------------- media

/** A local path to an asset's MP4, rendering one from its HLS if it has none. */
export async function mediaFile(asset: any): Promise<{ path: string; cleanup: () => void }> {
  const local = (key: string | null | undefined): string | null => {
    if (!key) return null;
    if (key.startsWith('/clips/')) return join(config.clips.dir, key.slice('/clips/'.length));
    if (key.startsWith('/') && existsSync(key)) return key;
    return null;
  };
  for (const k of [asset.export_mp4_key, asset.progressive_key]) {
    const p = local(k);
    if (p && existsSync(p)) return { path: p, cleanup: () => {} };
  }
  const master = asset.master_key as string | null;
  if (!master) throw new SocialError('This asset has no media to publish yet (it is still being built, or failed).', { permanent: true });
  let input = local(master) ?? (/^https?:\/\//.test(master) ? master : `http://127.0.0.1:${config.port}${master.startsWith('/') ? '' : '/'}${master}`);
  input = await bestVariant(input);
  const dir = mkdtempSync(join(tmpdir(), 'volt-social-'));
  const out = join(dir, 'upload.mp4');
  await new Promise<void>((resolve, reject) => {
    const ff = spawn('ffmpeg', ['-v', 'error', '-y', '-protocol_whitelist', 'file,http,https,tcp,tls,crypto,hls',
      '-i', input, '-map', '0:v:0?', '-map', '0:a:0?', '-c', 'copy', '-bsf:a', 'aac_adtstoasc', '-movflags', '+faststart', out]);
    let err = '';
    ff.stderr.on('data', (d) => { err += d; });
    ff.on('error', (e) => reject(new SocialError(`Could not prepare the video: ${e.message}`)));
    ff.on('close', (code) => code === 0 ? resolve() : reject(new SocialError(`Could not prepare the video: ${err.trim().slice(-300) || `ffmpeg exited ${code}`}`)));
  });
  return { path: out, cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ } } };
}

/**
 * A master playlist lists several renditions and ffmpeg would take whichever it
 * met first, often the smallest. Publish the best one: the variant with the
 * highest BANDWIDTH, resolved against the master's own location.
 */
async function bestVariant(input: string): Promise<string> {
  try {
    const text = /^https?:\/\//.test(input) ? await (await fetch(input)).text() : (await import('node:fs')).readFileSync(input, 'utf8');
    if (!text.includes('#EXT-X-STREAM-INF')) return input;
    const lines = text.split(/\r?\n/);
    let best: { bw: number; uri: string } | null = null;
    for (let i = 0; i < lines.length; i++) {
      const m = /^#EXT-X-STREAM-INF:.*?BANDWIDTH=(\d+)/.exec(lines[i]);
      const uri = lines[i + 1]?.trim();
      if (m && uri && !uri.startsWith('#') && (!best || +m[1] > best.bw)) best = { bw: +m[1], uri };
    }
    if (!best) return input;
    if (/^https?:\/\//.test(best.uri)) return best.uri;
    return /^https?:\/\//.test(input) ? new URL(best.uri, input).toString() : join(input, '..', best.uri);
  } catch { return input; }
}

// ---------------------------------------------------------------- posts

const asList = (v: any): string[] => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : []).map((s: any) => String(s).trim()).filter(Boolean);

/** The post an asset would get by default: its title, description and tags. */
export function defaultPost(asset: any, platform: PlatformId): PostSpec {
  const md = asset.metadata ?? {};
  const p = PLATFORMS[platform];
  const description = String(md.description ?? md.synopsis ?? '').trim();
  // Threads allows one hashtag per post (its topic tag): the asset's first tag.
  const tags = asList(md.tags ?? md.keywords).slice(0, p.limits.hashtags === 1 ? 1 : undefined);
  const title = String(asset.title ?? md.title ?? 'Untitled').trim();
  // For caption-only platforms (X, TikTok) the caption is the title and the description.
  const caption = p.limits.title == null ? [title, description].filter(Boolean).join('\n\n') : description;
  return { title, description: caption, tags, privacy: p.privacy[0] };
}

/** Bring a post inside the platform's limits, saying what was changed. */
export function fitPost(platform: PlatformId, post: Partial<PostSpec>): { post: PostSpec; problems: string[] } {
  const p = PLATFORMS[platform];
  const problems: string[] = [];
  const title = (post.title ?? '').trim();
  const description = (post.description ?? '').trim();
  const tags = (post.tags ?? []).map((t) => t.replace(/^#/, '').trim()).filter(Boolean);
  const privacy: Privacy = p.privacy.includes(post.privacy as Privacy) ? (post.privacy as Privacy) : p.privacy[0];
  if (p.limits.title != null && !title) problems.push(`${p.label} needs a title`);
  if (p.limits.title != null && title.length > p.limits.title) problems.push(`${p.label} titles are limited to ${p.limits.title} characters (this one is ${title.length})`);
  // On X and TikTok tags are hashtags in the caption, and they count against its length.
  const hashtags = !p.limits.tags || p.limits.title != null ? '' : tags.map((t) => `#${t.replace(/\s+/g, '')}`).join(' ');
  const full = hashtags && !description.includes(hashtags) ? `${description}${description ? ' ' : ''}${hashtags}` : description;
  if (full.length > p.limits.description) problems.push(`${p.label} ${p.limits.title == null ? 'captions' : 'descriptions'} are limited to ${p.limits.description} characters (this one is ${full.length})`);
  const hashtagCount = (full.match(/(^|\s)#[^\s#]+/g) ?? []).length;
  if (p.limits.hashtags != null && hashtagCount > p.limits.hashtags) {
    problems.push(p.limits.hashtags === 1
      ? `${p.label} allows one hashtag in a post, its topic (this one has ${hashtagCount})`
      : `${p.label} allows at most ${p.limits.hashtags} hashtags in a caption (this one has ${hashtagCount})`);
  }
  if (!full && p.limits.title == null) problems.push(`${p.label} needs a caption`);
  return { post: { title, description: full, tags: p.limits.tags ? tags : [], privacy }, problems };
}

// ---------------------------------------------------------------- publishing limit (Instagram, Threads)

/**
 * Posts a sandbox account may make in 24 hours: the platform's documented
 * number (Instagram 100, Threads 250), or SOCIAL_SANDBOX_IG_LIMIT /
 * SOCIAL_SANDBOX_TH_LIMIT for a test.
 */
const sandboxLimit = (platform: string) => platform === 'threads'
  ? Number(process.env.SOCIAL_SANDBOX_TH_LIMIT ?? 250)
  : Number(process.env.SOCIAL_SANDBOX_IG_LIMIT ?? 100);

/**
 * How much of the platform's publishing limit a target has used: Instagram
 * allows a set number of API posts in a moving 24 hours, read from
 * content_publishing_limit. A sandbox counts its own posts of the last 24 hours.
 * Null for a platform without such a limit.
 */
export async function publishingLimit(target: any): Promise<{ used: number; total: number; remaining: number; windowHours: number } | null> {
  const p = PLATFORMS[target.platform as PlatformId];
  if (!p?.publishingLimit) return null;
  let used: number, total: number;
  if (target.mode === 'sandbox') {
    used = (await one<any>(`SELECT count(*)::int AS n FROM publications WHERE target_id = $1 AND status = 'published' AND published_at > now() - interval '24 hours'`, [target.id]))!.n;
    total = sandboxLimit(target.platform);
  } else {
    ({ used, total } = await p.publishingLimit(await validToken(target), target.external_account, target.variant));
  }
  return { used, total, remaining: Math.max(0, total - used), windowHours: 24 };
}

export const limitReached = (label: string, l: { used: number; total: number }, platform: string = 'instagram') =>
  `${label} has used ${l.used} of its ${l.total} posts in the last 24 hours, ${possessive(PLATFORMS[platform as PlatformId]?.label ?? 'the platform')} publishing limit. Retry once older posts fall out of the 24 hours.`;
const possessive = (name: string) => name.endsWith('s') ? `${name}'` : `${name}'s`;

/** An Image Library picture, by its media file id, for this account. */
export async function ownedImage(fileId: string, accountId: string) {
  return one<any>(`SELECT id, name, path, tags, store_key, content_type, width, height FROM media_files WHERE id = $1 AND account_id = $2`, [fileId, accountId]);
}

/** The post a picture gets by default: its name (without the extension) and its tags as hashtags. */
export function defaultImagePost(img: any, platform: PlatformId): PostSpec {
  const title = String(img?.name ?? '').replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[_-]+/g, ' ').trim();
  return { title: '', description: title, tags: (img?.tags ?? []).map((t: any) => String(t)), privacy: PLATFORMS[platform].privacy[0] };
}

/** Insert and queue one image publication per target. Only platforms that post pictures. */
export async function publishImage(img: any, targets: any[], posts: Record<string, PostSpec>, by: string | null) {
  const out: any[] = [];
  for (const t of targets) {
    const post = posts[t.id] ?? fitPost(t.platform, defaultImagePost(img, t.platform)).post;
    const pub = await one<any>(
      `INSERT INTO publications(image_key, platform, target_id, status, post, progress, stage, published_by)
       VALUES ($1,$2::text,$3,'pending',$4::jsonb,0,'queued',$5) RETURNING id`, [img.store_key, t.platform, t.id, JSON.stringify(post), by]);
    await queueSocialPublication(pub!.id, null);
    out.push(await one(`SELECT * FROM publications WHERE id = $1`, [pub!.id]));
  }
  return out;
}

/** A local address cannot be fetched by Instagram: say so before Meta does, less clearly. */
const localAddress = (u: string) => /^https?:\/\/(localhost|127\.|10\.|192\.168\.|\[::1\]|[^/]*\.local(?::|\/|$))/i.test(u);

// ---------------------------------------------------------------- videos a platform fetches (Threads)

/** How long a fetch link works: long enough for Threads to fetch and process, short enough not to be a share link. */
const FETCH_HOURS = 6;
/** Where the files a platform fetches are placed: beside the clips, on the disk the API serves them from. */
const fetchDir = () => join(config.clips.dir, '.social-fetch');
const fetchFile = (pubId: string) => join(fetchDir(), `${pubId}.mp4`);

/**
 * Put a publication's video where GET /api/social/media/<id>.mp4 serves it,
 * and the signed, expiring link the platform is given. A hard link when the
 * file is on the same disk (no copy of a long video), else a copy. The API and
 * the job worker must share this disk: true on the Mac (one process); in the
 * cloud the workers and the API mount the same clips volume.
 */
export function fetchableVideo(pubId: string, path: string, now = Date.now()): { url: string; cleanup: () => void } {
  mkdirSync(fetchDir(), { recursive: true });
  const dest = fetchFile(pubId);
  try { rmSync(dest, { force: true }); } catch { /* replaced below */ }
  try { linkSync(path, dest); } catch { copyFileSync(path, dest); }
  const exp = Math.floor(now / 1000) + FETCH_HOURS * 3600;
  const sig = signMedia(`${pubId}.${exp}`);
  return { url: `${publicBase()}/api/social/media/${pubId}.mp4?exp=${exp}&sig=${encodeURIComponent(sig)}`, cleanup: () => dropFetchable(pubId) };
}

/** Remove a publication's fetchable copy (published, or failed for good). */
export function dropFetchable(pubId: string): void {
  try { rmSync(fetchFile(pubId), { force: true }); } catch { /* already gone */ }
}

/** The file behind a fetch link, or null when the signature is wrong, the link expired or the file is gone. */
export function fetchablePath(pubId: string, exp: number, sig: string): string | null {
  if (!/^[0-9a-f-]{36}$/i.test(pubId) || !Number.isFinite(exp) || !sig) return null;
  if (exp * 1000 < Date.now()) return null;
  if (!mediaSignatureOk(`${pubId}.${exp}`, sig)) return null;
  const f = fetchFile(pubId);
  return existsSync(f) ? resolve(f) : null;
}

// ---------------------------------------------------------------- publish job

async function setProgress(pubId: string, pct: number, stage: string) {
  await query(`UPDATE publications SET progress=$2, stage=$3 WHERE id=$1`, [pubId, Math.max(0, Math.min(100, Math.round(pct))), stage]);
}

export async function queueSocialPublication(pubId: string, createdBy: string | null = null): Promise<void> {
  const { enqueue } = await import('../jobs/queue');
  const job = await enqueue({ type: SOCIAL_PUBLISH, payload: { publicationId: pubId }, maxAttempts: 4, createdBy, dedupeKey: `social:${pubId}` });
  await query(`UPDATE publications SET job_id=$2, progress=0, stage='queued', status='pending', error=NULL WHERE id=$1`, [pubId, job.id]);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function sandboxUpload(pub: any, target: any, progress: (p: number, s: string) => Promise<void>) {
  const step = Number(process.env.SOCIAL_SANDBOX_STEP_MS ?? 400);
  const what = pub.image_key ? 'picture' : target.platform === 'instagram' ? 'Reel' : 'video';
  const steps = target.platform === 'threads'
    ? [[10, `creating the Threads post`], [40, `Threads is fetching the ${what}`], [85, `Threads is processing the ${what}`], [92, 'publishing']] as const
    : target.platform === 'instagram'
    ? [[10, `creating the Instagram ${what}`], [40, 'uploading'], [75, 'uploaded'], [85, `Instagram is processing the ${what}`], [92, 'publishing']] as const
    : [[10, 'uploading'], [40, 'uploading'], [75, 'uploading'], [90, `${PLATFORMS[target.platform as PlatformId].label} is processing the video`]] as const;
  for (const [pct, stage] of steps) {
    await progress(pct, stage); await sleep(step);
  }
  if (/\[fail\]/i.test(pub.post?.title ?? '') || /\[fail\]/i.test(pub.post?.description ?? '')) {
    throw new SocialError('Sandbox: the platform rejected the video ("[fail]" in the post makes the sandbox fail on purpose).', { permanent: true });
  }
  const id = `sbx${randomBytes(5).toString('hex')}`;
  return { externalId: id, url: `${publicBase()}/social-sandbox/${pub.id}` };
}

/** The `social.publish` job. */
export async function handleSocialPublish(ctx: { job: any; progress: (pct: number, note?: string) => Promise<void> }): Promise<Record<string, unknown>> {
  const { PermanentError } = await import('../jobs/worker');
  const pubId = ctx.job.payload?.publicationId;
  const pub = await one<any>(`SELECT * FROM publications WHERE id=$1`, [pubId]);
  if (!pub) throw new PermanentError('publication no longer exists', 'gone');
  if (pub.status === 'published') return { already: true };
  const target = await one<any>(`SELECT * FROM publish_targets WHERE id=$1`, [pub.target_id]);
  const asset = pub.vod_asset_id ? await one<any>(`SELECT v.*, COALESCE(g.account_id, v.account_id) AS account_id FROM vod_assets v LEFT JOIN channels c ON c.id=v.channel_id LEFT JOIN events e ON e.id=v.event_id
                                  LEFT JOIN groups g ON g.id=COALESCE(c.group_id, e.group_id) WHERE v.id=$1`, [pub.vod_asset_id]) : null;
  // A picture from the Image Library (Instagram feed posts), by its store key.
  const image = pub.image_key && target ? await one<any>(`SELECT id, name, store_key, account_id FROM media_files WHERE store_key = $1 AND account_id = $2`, [pub.image_key, target.account_id]) : null;
  const subject = asset ?? image;
  const ownerAccount = asset?.account_id ?? image?.account_id ?? target?.account_id ?? null;
  const lastTry = (ctx.job.attempts ?? 1) >= (ctx.job.max_attempts ?? 1);
  const progress = async (pct: number, stage: string) => { await setProgress(pub.id, pct, stage); await ctx.progress(pct, stage); };
  await query(`UPDATE publications SET attempts=attempts+1, error=NULL WHERE id=$1`, [pub.id]);
  let media: { path: string; cleanup: () => void } | null = null;
  // A copy Threads fetches from (fetchableVideo): kept while a retry may still need it.
  let fetchable: { url: string; cleanup: () => void } | null = null;
  try {
    if (!target || !target.enabled) throw new SocialError('The account this was going to is disconnected or disabled.', { permanent: true });
    if (!subject) throw new SocialError(pub.image_key ? 'The picture is no longer in the Image Library.' : 'The asset no longer exists.', { permanent: true });
    // X switched off after this was queued (or an old rule still names an X account).
    await assertPlatformAllowed(target.platform, target.account_id);
    const p = PLATFORMS[target.platform as PlatformId];
    if (image && !p.images) throw new SocialError(`${p.label} does not take pictures from Volt, only videos.`, { permanent: true });
    const post: PostSpec = pub.post ?? (asset ? defaultPost(asset, target.platform) : defaultImagePost(image, target.platform));
    // Instagram's 24 hour publishing limit, unless this try is finishing a post already made.
    if (p.publishingLimit && !pub.platform_state?.mediaId) {
      const l = await publishingLimit(target);
      if (l && l.remaining <= 0) throw new SocialError(limitReached(target.account_label ?? target.name, l, target.platform), { permanent: true });
    }
    let result: { externalId: string; url: string | null };
    const saveState = async (st: Record<string, any> | null) => { await query(`UPDATE publications SET platform_state = $2::jsonb WHERE id = $1`, [pub.id, st ? JSON.stringify(st) : null]); };
    if (target.mode === 'sandbox') {
      await progress(3, image ? 'preparing the picture' : 'preparing the video');
      result = await sandboxUpload(pub, target, progress);
    } else if (image) {
      const token = await validToken(target);
      await progress(2, 'preparing the picture');
      // Instagram and Threads fetch the picture themselves (Instagram takes JPEG only): a signed JPEG
      // from the image service, at most 1440 px wide, on Volt's public address.
      const { signedImageUrl } = await import('../../modules/images');
      const imageUrl = signedImageUrl(image.store_key, { width: 1440, fit: 'inside', format: 'jpeg', quality: 90 } as any);
      if (localAddress(imageUrl)) {
        throw new SocialError(`${p.label} fetches the picture from Volt's public address, and this Volt has none it can reach (${new URL(imageUrl).origin}). Set PUBLIC_BASE_URL (or IMAGE_PUBLIC_BASE_URL) to an address reachable from the internet.`, { permanent: true });
      }
      result = await p.upload({ token, externalAccount: target.external_account, accountLabel: target.account_label, file: '', size: 0, post, progress,
        variant: target.variant, kind: 'image', imageUrl, state: pub.platform_state, saveState });
    } else {
      const token = await validToken(target);
      await progress(2, 'preparing the video');
      // The platform's own shape when Admin > Formats and reframing maps it to one
      // (TikTok to 9:16 ...): that file, rendered now if needed. Otherwise the 16:9.
      const { formatMediaFor, ReframeNotReady } = await import('../reframe/publish');
      let shaped: string | null = null;
      try {
        shaped = await formatMediaFor(asset, target.platform, (pct, stage) => progress(pct, stage));
      } catch (e: any) {
        if (e instanceof ReframeNotReady) throw new SocialError(e.message, { permanent: true });
        throw e;
      }
      media = shaped ? { path: shaped, cleanup: () => {} } : await mediaFile(asset);
      const size = statSync(media.path).size;
      // Threads takes no upload: it fetches the file from Volt's public address.
      // Placed on every try that may still have to make a container (one that
      // errored is started again), and not once the post exists.
      if (p.fetchesVideo && !pub.platform_state?.mediaId) {
        fetchable = fetchableVideo(pub.id, media.path);
        if (localAddress(fetchable.url)) {
          throw new SocialError(`${p.label} fetches the video from Volt's public address, and this Volt has none it can reach (${new URL(fetchable.url).origin}). Set PUBLIC_BASE_URL to an address reachable from the internet.`, { permanent: true });
        }
      }
      result = await p.upload({ token, externalAccount: target.external_account, accountLabel: target.account_label, file: media.path, size, post, progress,
        variant: target.variant, kind: 'video', videoUrl: fetchable?.url ?? null, state: pub.platform_state, saveState });
    }
    await query(`UPDATE publications SET status='published', external_id=$2, external_url=$3, published_at=now(), progress=100, stage=NULL, error=NULL WHERE id=$1`,
      [pub.id, result.externalId, result.url]);
    fetchable?.cleanup();
    return { externalId: result.externalId, url: result.url };
  } catch (e: any) {
    const se = e instanceof SocialError ? e : new SocialError(String(e?.message ?? e));
    if (se.auth && target) await markLink(target.id, 'expired', `${se.message}. Connect the account again.`);
    const final = se.permanent || se.auth || lastTry;
    await query(`UPDATE publications SET status=$2, error=$3, stage=$4 WHERE id=$1`,
      [pub.id, final ? 'failed' : 'pending', se.message.slice(0, 500), final ? null : 'will retry']);
    if (final && ownerAccount && subject) {
      const { notifyAccountAdmins } = await import('../notifications');
      await notifyAccountAdmins(ownerAccount, 'publish.failed',
        `Could not publish "${asset ? asset.title ?? 'clip' : image.name}" to ${target ? PLATFORMS[target.platform as PlatformId]?.label ?? target.platform : 'social'}`,
        `${se.message}\n\n${asset ? 'Open the clip in the Media Library' : 'Open the picture in the Image Library'} to retry or change the post.`,
        { publicationId: pub.id, ...(asset ? { assetId: asset.id } : { imageKey: pub.image_key }) });
    }
    // Nothing more will fetch it once the publication has failed for good.
    if (final) { fetchable?.cleanup(); dropFetchable(pub.id); }
    if (final) throw new PermanentError(se.message, se.auth ? 'auth' : 'rejected');
    throw se;
  } finally {
    media?.cleanup();
  }
}

export async function registerSocialHandlers() {
  const { registerHandler } = await import('../jobs/worker');
  registerHandler(SOCIAL_PUBLISH, handleSocialPublish as any);
}

// ---------------------------------------------------------------- views

/** Pull view counts for published social posts. `force` ignores the hourly spacing. */
export async function syncViews(opts: { accountId?: string; force?: boolean; limit?: number } = {}): Promise<number> {
  const rows = await query<any>(
    `SELECT p.id, p.external_id, p.published_at, p.views, p.likes AS pub_likes, t.*, p.id AS pub_id
       FROM publications p JOIN publish_targets t ON t.id = p.target_id JOIN accounts a ON a.id = t.account_id
      WHERE p.status = 'published' AND p.external_id IS NOT NULL AND t.enabled
        -- X bills every read: no view syncing for an account X is off for.
        AND (t.platform <> 'x' OR a.x_enabled OR (a.x_client_id IS NOT NULL AND a.x_client_secret_enc IS NOT NULL))
        AND ($1::uuid IS NULL OR t.account_id = $1)
        AND ($2 OR p.last_synced_at IS NULL OR p.last_synced_at < now() - interval '1 hour')
      ORDER BY p.last_synced_at NULLS FIRST LIMIT $3`, [opts.accountId ?? null, !!opts.force, opts.limit ?? 50]);
  let n = 0;
  for (const r of rows) {
    try {
      let views: number | null;
      let likes: number | null = null;
      const p = PLATFORMS[r.platform as PlatformId];
      if (r.mode === 'sandbox') {
        const mins = Math.floor((Date.now() - new Date(r.published_at).getTime()) / 60000);
        views = mins * 3 + 1;
        if (p?.stats) likes = Math.floor(views / 4);
      } else if (p.stats) {
        ({ views, likes = null } = await p.stats(await validToken(r), r.external_account, r.external_id, r.variant));
      } else {
        if (!p.views) continue;
        views = await p.views(await validToken(r), r.external_account, r.external_id);
      }
      await query(`UPDATE publications SET views = COALESCE($2, views), likes = COALESCE($3, likes), last_synced_at = now() WHERE id = $1`, [r.pub_id, views, likes]);
      n++;
    } catch (e: any) {
      await query(`UPDATE publications SET last_synced_at = now() WHERE id = $1`, [r.pub_id]);
      console.warn('[social] view sync failed', r.pub_id, e?.message ?? e);
    }
  }
  await syncFollowers(opts).catch((e) => console.warn('[social] follower sync failed', e?.message ?? e));
  return n;
}

/** Follower counts, for the platforms that give them (Instagram, Threads), hourly per account or on demand. */
export async function syncFollowers(opts: { accountId?: string; force?: boolean } = {}): Promise<number> {
  const ids = PLATFORM_IDS.filter((id) => PLATFORMS[id].followers);
  const rows = await query<any>(
    `SELECT * FROM publish_targets WHERE platform = ANY($1::text[]) AND enabled AND link_status = 'connected'
        AND ($2::uuid IS NULL OR account_id = $2) AND ($3 OR followers_synced_at IS NULL OR followers_synced_at < now() - interval '1 hour')
      ORDER BY followers_synced_at NULLS FIRST LIMIT 50`, [ids, opts.accountId ?? null, !!opts.force]);
  let n = 0;
  for (const t of rows) {
    try {
      // A sandbox account gains a follower every ten minutes, so the number visibly moves.
      const f = t.mode === 'sandbox' ? Number(t.followers ?? 1200) + Math.max(1, Math.floor((Date.now() - new Date(t.followers_synced_at ?? t.linked_at ?? Date.now()).getTime()) / 600_000))
        : await PLATFORMS[t.platform as PlatformId].followers!(await validToken(t), t.external_account, t.variant);
      await query(`UPDATE publish_targets SET followers = COALESCE($2, followers), followers_synced_at = now() WHERE id = $1`, [t.id, f]);
      n++;
    } catch (e: any) {
      await query(`UPDATE publish_targets SET followers_synced_at = now() WHERE id = $1`, [t.id]);
      console.warn('[social] follower sync failed', t.id, e?.message ?? e);
    }
  }
  return n;
}

/** Take a post down on the platform, where the platform allows it. */
export async function removeFromPlatform(pubId: string): Promise<void> {
  const r = await one<any>(`SELECT p.external_id, t.* FROM publications p JOIN publish_targets t ON t.id=p.target_id WHERE p.id=$1`, [pubId]);
  if (!r?.external_id) throw new SocialError('Nothing was published here to take down.', { permanent: true });
  await assertPlatformAllowed(r.platform, r.account_id);
  if (r.mode !== 'sandbox') {
    const p = PLATFORMS[r.platform as PlatformId];
    if (!p.remove) throw new SocialError(`${p.label} does not let apps delete posts: remove it in the ${p.label} app.`, { permanent: true });
    await p.remove(await validToken(r), r.external_account, r.external_id);
  }
  await query(`UPDATE publications SET status='removed' WHERE id=$1`, [pubId]);
}
