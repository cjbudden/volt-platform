// ============================================================================
//  SOCIAL PLATFORMS: OAuth and upload, one adapter per platform.
//
//  Each adapter is written against the platform's documented public API:
//    YouTube      Data API v3, resumable upload
//    Facebook     Graph API, Page video upload (posts as the Page)
//    X            API v2, chunked media upload then a post with the media
//    TikTok       Content Posting API, direct post with FILE_UPLOAD
//    Dailymotion  REST API, upload URL then create the video
//    Instagram    Instagram API (Instagram Login or Facebook Login), the
//                 container flow: create, upload or point at the media, wait
//                 until it is finished, publish (build queue 1.14i)
//    Threads      Threads API (graph.threads.net), the same container flow;
//                 Threads fetches the video or picture from Volt's public
//                 address itself (build queue 1.14j)
//
//  Platform app credentials come from the environment (see PLATFORM.env*): the
//  account owner registers an app with each platform and sets them, and until
//  they do that platform says "not set up" and offers only a sandbox account.
//
//  SOCIAL_TEST_BASE points every platform host at a local fake, as
//  <base>/<platform>/<host key><path>, so the suite exercises the real request
//  sequences without the network. Never set it in production.
//
//  NOT VERIFIED AGAINST THE LIVE PLATFORMS from this environment: there are no
//  app credentials here. The request shapes follow each platform's
//  documentation; the first real run per platform is the acceptance test, and
//  any field a platform rejects comes back verbatim in the publication's error.
// ============================================================================
import { openAsBlob } from 'node:fs';

export type PlatformId = 'youtube' | 'facebook' | 'x' | 'tiktok' | 'dailymotion' | 'instagram' | 'threads';
export type Privacy = 'public' | 'unlisted' | 'private';

export interface PostSpec { title: string; description: string; tags: string[]; privacy: Privacy }
export interface Tokens { accessToken: string; refreshToken?: string | null; expiresIn?: number | null; scopes?: string[] }
export interface LinkedAccount extends Tokens { externalId: string; label: string; avatar?: string | null; followers?: number | null }
export interface UploadCtx {
  token: string; externalAccount: string; accountLabel: string | null;
  file: string; size: number; post: PostSpec;
  progress: (pct: number, stage: string) => Promise<void>;
  /** How the target was linked, where a platform has more than one way (Instagram: 'instagram' or 'facebook'). */
  variant?: string | null;
  /** A picture rather than a video (Instagram feed posts). The platform fetches it from `imageUrl`. */
  kind?: 'video' | 'image';
  imageUrl?: string | null;
  /** The video at an address the platform fetches it from, for a platform that takes no upload (Threads). */
  videoUrl?: string | null;
  /** What a multi-step upload has done so far, kept on the publication so a retry carries on (Instagram's container). */
  state?: Record<string, any> | null;
  saveState?: (s: Record<string, any> | null) => Promise<void>;
}
export interface UploadResult { externalId: string; url: string | null }

export class SocialError extends Error {
  permanent: boolean; auth: boolean; status: number | null;
  constructor(message: string, opts: { permanent?: boolean; auth?: boolean; status?: number | null } = {}) {
    super(message); this.permanent = !!opts.permanent; this.auth = !!opts.auth; this.status = opts.status ?? null;
  }
}

/** A second way to sign in to the same platform, with its own app and permissions (Instagram through Facebook). */
export interface Variant { id: string; label: string; env: { id: string; secret: string }; scopes: string[] }
export interface PostStats { views: number | null; likes?: number | null }

export interface Platform {
  id: PlatformId;
  label: string;
  /** Ways to link an account. The first is the default; without this, one way (the platform's own env and scopes). */
  variants?: Variant[];
  /** Posts pictures as well as videos. */
  images?: boolean;
  /** Takes no upload: the platform fetches the video from a public address (Threads). */
  fetchesVideo?: boolean;
  /** Environment variables holding the app's client id and secret. */
  env: { id: string; secret: string };
  scopes: string[];
  pkce: boolean;
  limits: { title: number | null; description: number; tags: boolean; hashtags?: number };
  privacy: Privacy[];
  /** What the platform calls the thing the account publishes as. */
  accountNoun: string;
  authorizeUrl(clientId: string, redirect: string, state: string, challenge: string | null, variant?: string | null): string;
  /** `app` is the account's own developer app when it has one (X only, so far); otherwise the deployment's. */
  exchange(code: string, redirect: string, verifier: string | null, app?: AppCreds | null, variant?: string | null): Promise<Tokens>;
  refresh?(refreshToken: string, app?: AppCreds | null, variant?: string | null): Promise<Tokens>;
  accounts(t: Tokens, variant?: string | null): Promise<LinkedAccount[]>;
  upload(c: UploadCtx): Promise<UploadResult>;
  views?(token: string, externalAccount: string, externalId: string): Promise<number | null>;
  /** Views and likes together, where the platform gives both (used instead of `views` when present). */
  stats?(token: string, externalAccount: string, externalId: string, variant?: string | null): Promise<PostStats>;
  followers?(token: string, externalAccount: string, variant?: string | null): Promise<number | null>;
  /** Posts used and allowed in the platform's moving window (Instagram: 24 hours). */
  publishingLimit?(token: string, externalAccount: string, variant?: string | null): Promise<{ used: number; total: number }>;
  remove?(token: string, externalAccount: string, externalId: string): Promise<void>;
}

// ---------------------------------------------------------------- plumbing

const HOSTS: Record<string, string> = {
  'youtube:auth': 'https://accounts.google.com', 'youtube:token': 'https://oauth2.googleapis.com',
  'youtube:api': 'https://www.googleapis.com', 'youtube:upload': 'https://www.googleapis.com',
  'facebook:auth': 'https://www.facebook.com', 'facebook:graph': 'https://graph.facebook.com', 'facebook:video': 'https://graph-video.facebook.com',
  'x:auth': 'https://x.com', 'x:api': 'https://api.x.com',
  'tiktok:auth': 'https://www.tiktok.com', 'tiktok:api': 'https://open.tiktokapis.com',
  'dailymotion:auth': 'https://www.dailymotion.com', 'dailymotion:api': 'https://api.dailymotion.com',
  'instagram:auth': 'https://www.instagram.com', 'instagram:api': 'https://api.instagram.com',
  'instagram:graph': 'https://graph.instagram.com', 'instagram:rupload': 'https://rupload.facebook.com',
  'threads:auth': 'https://threads.net', 'threads:graph': 'https://graph.threads.net',
};
export function host(platform: PlatformId, key: string): string {
  const test = process.env.SOCIAL_TEST_BASE;
  if (test) return `${test.replace(/\/$/, '')}/${platform}/${key}`;
  const h = HOSTS[`${platform}:${key}`];
  if (!h) throw new Error(`no host ${platform}:${key}`);
  return h;
}
// Meta Graph API version, for Facebook and Instagram alike. v21.0 expires on
// 21 Jan 2027; v25.0 (Feb 2026) is current. Every Facebook call here was
// checked against the v25.0 changelog: none of them changed. Its removed
// insights metrics are the *_unique video ones, not total_video_views.
export const FB = 'v25.0';
const env = (name: string) => process.env[name] ?? '';
export type AppCreds = { id: string; secret: string };
/** The env pair a sign-in uses: the variant's own where it has one. */
function envOf(p: Platform, variant?: string | null) {
  return (variant && p.variants?.find((v) => v.id === variant)?.env) || p.env;
}
export function appCreds(p: Platform, variant?: string | null): AppCreds | null {
  const e = envOf(p, variant);
  const id = env(e.id), secret = env(e.secret);
  return id && secret ? { id, secret } : null;
}
function creds(p: Platform, variant?: string | null) {
  const c = appCreds(p, variant);
  const e = envOf(p, variant);
  if (!c) throw new SocialError(`${p.label} is not set up on this deployment (${e.id}, ${e.secret}).`, { permanent: true });
  return c;
}

/** fetch + JSON, with the platform's error message surfaced and classified. */
async function call(label: string, url: string, init: RequestInit & { duplex?: string } = {}): Promise<any> {
  let r: Response;
  try { r = await fetch(url, init as any); }
  catch (e: any) { throw new SocialError(`${label}: could not reach the platform (${e?.message ?? e})`); }
  const text = await r.text();
  let j: any = null;
  try { j = text ? JSON.parse(text) : {}; } catch { j = { raw: text.slice(0, 300) }; }
  if (r.ok) return j;
  const msg = j?.error?.message ?? j?.error_description ?? j?.detail ?? j?.title ?? j?.error?.code ?? j?.message ??
    (typeof j?.error === 'string' ? j.error : null) ?? j?.raw ?? r.statusText;
  const auth = r.status === 401;
  const permanent = !auth && r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429;
  throw new SocialError(`${label}: ${r.status} ${String(msg).slice(0, 300)}`, { permanent, auth, status: r.status });
}
const form = (o: Record<string, string>) => new URLSearchParams(o).toString();
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };
const bearer = (t: string, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${t}`, ...extra });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pollMs = () => Number(process.env.SOCIAL_POLL_MS ?? 3000);

function tokenFrom(j: any): Tokens {
  if (!j?.access_token) throw new SocialError(`The platform did not return an access token: ${JSON.stringify(j).slice(0, 200)}`, { permanent: true });
  return {
    accessToken: j.access_token, refreshToken: j.refresh_token ?? null,
    expiresIn: j.expires_in != null ? Number(j.expires_in) : null,
    scopes: typeof j.scope === 'string' ? j.scope.split(/[ ,]+/).filter(Boolean) : undefined,
  };
}

// ---------------------------------------------------------------- YouTube

const youtube: Platform = {
  id: 'youtube', label: 'YouTube', accountNoun: 'channel',
  env: { id: 'YOUTUBE_CLIENT_ID', secret: 'YOUTUBE_CLIENT_SECRET' },
  scopes: ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube.readonly'],
  pkce: true,
  limits: { title: 100, description: 5000, tags: true },
  privacy: ['public', 'unlisted', 'private'],
  authorizeUrl(clientId, redirect, state, challenge) {
    const q = new URLSearchParams({ client_id: clientId, redirect_uri: redirect, response_type: 'code', scope: this.scopes.join(' '),
      access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state });
    if (challenge) { q.set('code_challenge', challenge); q.set('code_challenge_method', 'S256'); }
    return `${host('youtube', 'auth')}/o/oauth2/v2/auth?${q}`;
  },
  async exchange(code, redirect, verifier) {
    const c = creds(this);
    return tokenFrom(await call('YouTube sign-in', `${host('youtube', 'token')}/token`, { method: 'POST', headers: FORM,
      body: form({ code, client_id: c.id, client_secret: c.secret, redirect_uri: redirect, grant_type: 'authorization_code', ...(verifier ? { code_verifier: verifier } : {}) }) }));
  },
  async refresh(rt) {
    const c = creds(this);
    const t = tokenFrom(await call('YouTube token refresh', `${host('youtube', 'token')}/token`, { method: 'POST', headers: FORM,
      body: form({ refresh_token: rt, client_id: c.id, client_secret: c.secret, grant_type: 'refresh_token' }) }));
    return { ...t, refreshToken: t.refreshToken ?? rt };
  },
  async accounts(t) {
    const j = await call('YouTube channel', `${host('youtube', 'api')}/youtube/v3/channels?part=snippet&mine=true`, { headers: bearer(t.accessToken) });
    const items = j.items ?? [];
    if (!items.length) throw new SocialError('This Google account has no YouTube channel to publish to.', { permanent: true });
    return items.map((it: any) => ({ ...t, externalId: it.id, label: it.snippet?.title ?? it.id, avatar: it.snippet?.thumbnails?.default?.url ?? null }));
  },
  async upload(c) {
    await c.progress(5, 'starting the upload');
    const meta = {
      snippet: { title: c.post.title.slice(0, 100), description: c.post.description.slice(0, 5000), tags: c.post.tags, categoryId: '22' },
      status: { privacyStatus: c.post.privacy, selfDeclaredMadeForKids: false },
    };
    const r = await fetch(`${host('youtube', 'upload')}/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status`, {
      method: 'POST',
      headers: bearer(c.token, { 'content-type': 'application/json; charset=UTF-8', 'x-upload-content-length': String(c.size), 'x-upload-content-type': 'video/mp4' }),
      body: JSON.stringify(meta),
    }).catch((e) => { throw new SocialError(`YouTube upload: could not reach the platform (${e.message})`); });
    if (!r.ok) { const t = await r.text(); throw new SocialError(`YouTube upload: ${r.status} ${t.slice(0, 300)}`, { permanent: r.status >= 400 && r.status < 500 && r.status !== 401 && r.status !== 429, auth: r.status === 401, status: r.status }); }
    const session = r.headers.get('location');
    if (!session) throw new SocialError('YouTube did not return an upload session URL');
    await c.progress(15, 'uploading');
    const j = await call('YouTube upload', session, { method: 'PUT', headers: { 'content-type': 'video/mp4', 'content-length': String(c.size) }, body: await openAsBlob(c.file) as any });
    await c.progress(95, 'published');
    return { externalId: j.id, url: `https://www.youtube.com/watch?v=${j.id}` };
  },
  async views(token, _acct, id) {
    const j = await call('YouTube views', `${host('youtube', 'api')}/youtube/v3/videos?part=statistics&id=${encodeURIComponent(id)}`, { headers: bearer(token) });
    const v = j.items?.[0]?.statistics?.viewCount;
    return v != null ? Number(v) : null;
  },
  async remove(token, _acct, id) {
    await call('YouTube delete', `${host('youtube', 'api')}/youtube/v3/videos?id=${encodeURIComponent(id)}`, { method: 'DELETE', headers: bearer(token) });
  },
};

// ---------------------------------------------------------------- Facebook (Pages)

const facebook: Platform = {
  id: 'facebook', label: 'Facebook', accountNoun: 'Page',
  env: { id: 'FACEBOOK_APP_ID', secret: 'FACEBOOK_APP_SECRET' },
  scopes: ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts', 'publish_video'],
  pkce: false,
  limits: { title: 255, description: 5000, tags: false },
  privacy: ['public'],
  authorizeUrl(clientId, redirect, state) {
    const q = new URLSearchParams({ client_id: clientId, redirect_uri: redirect, state, scope: this.scopes.join(','), response_type: 'code' });
    return `${host('facebook', 'auth')}/${FB}/dialog/oauth?${q}`;
  },
  async exchange(code, redirect) {
    const c = creds(this);
    const short = tokenFrom(await call('Facebook sign-in', `${host('facebook', 'graph')}/${FB}/oauth/access_token?${form({ client_id: c.id, client_secret: c.secret, redirect_uri: redirect, code })}`));
    // Long-lived user token, so the Page tokens derived from it do not expire.
    const long = tokenFrom(await call('Facebook sign-in', `${host('facebook', 'graph')}/${FB}/oauth/access_token?${form({ grant_type: 'fb_exchange_token', client_id: c.id, client_secret: c.secret, fb_exchange_token: short.accessToken })}`));
    return long;
  },
  async accounts(t) {
    const j = await call('Facebook Pages', `${host('facebook', 'graph')}/${FB}/me/accounts?fields=id,name,access_token,picture&limit=100`, { headers: bearer(t.accessToken) });
    const pages = j.data ?? [];
    if (!pages.length) throw new SocialError('This Facebook account manages no Pages. Videos are posted as a Page.', { permanent: true });
    return pages.map((p: any) => ({ accessToken: p.access_token, refreshToken: null, expiresIn: null, externalId: p.id, label: p.name, avatar: p.picture?.data?.url ?? null }));
  },
  async upload(c) {
    await c.progress(5, 'uploading');
    const fd = new FormData();
    fd.set('title', c.post.title.slice(0, 255));
    fd.set('description', c.post.description);
    fd.set('published', 'true');
    fd.set('source', await openAsBlob(c.file, { type: 'video/mp4' }) as any, 'video.mp4');
    const j = await call('Facebook upload', `${host('facebook', 'video')}/${FB}/${encodeURIComponent(c.externalAccount)}/videos`, { method: 'POST', headers: bearer(c.token), body: fd });
    await c.progress(95, 'published');
    return { externalId: j.id, url: `https://www.facebook.com/${c.externalAccount}/videos/${j.id}` };
  },
  async views(token, _acct, id) {
    const j = await call('Facebook views', `${host('facebook', 'graph')}/${FB}/${encodeURIComponent(id)}/video_insights?metric=total_video_views`, { headers: bearer(token) });
    const v = j.data?.[0]?.values?.[0]?.value;
    return v != null ? Number(v) : null;
  },
  async remove(token, _acct, id) {
    await call('Facebook delete', `${host('facebook', 'graph')}/${FB}/${encodeURIComponent(id)}`, { method: 'DELETE', headers: bearer(token) });
  },
};

// ---------------------------------------------------------------- X

const X_CHUNK = 4 * 1024 * 1024;
const x: Platform = {
  id: 'x', label: 'X', accountNoun: 'account',
  env: { id: 'X_CLIENT_ID', secret: 'X_CLIENT_SECRET' },
  scopes: ['tweet.read', 'tweet.write', 'users.read', 'media.write', 'offline.access'],
  pkce: true,
  limits: { title: null, description: 280, tags: true },
  privacy: ['public'],
  authorizeUrl(clientId, redirect, state, challenge) {
    const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirect, scope: this.scopes.join(' '), state,
      code_challenge: challenge ?? '', code_challenge_method: 'S256' });
    return `${host('x', 'auth')}/i/oauth2/authorize?${q}`;
  },
  async exchange(code, redirect, verifier, app) {
    const c = app ?? creds(this);
    return tokenFrom(await call('X sign-in', `${host('x', 'api')}/2/oauth2/token`, { method: 'POST',
      headers: { ...FORM, authorization: `Basic ${Buffer.from(`${c.id}:${c.secret}`).toString('base64')}` },
      body: form({ code, grant_type: 'authorization_code', redirect_uri: redirect, code_verifier: verifier ?? '' }) }));
  },
  async refresh(rt, app) {
    const c = app ?? creds(this);
    return tokenFrom(await call('X token refresh', `${host('x', 'api')}/2/oauth2/token`, { method: 'POST',
      headers: { ...FORM, authorization: `Basic ${Buffer.from(`${c.id}:${c.secret}`).toString('base64')}` },
      body: form({ refresh_token: rt, grant_type: 'refresh_token' }) }));
  },
  async accounts(t) {
    const j = await call('X profile', `${host('x', 'api')}/2/users/me?user.fields=profile_image_url`, { headers: bearer(t.accessToken) });
    return [{ ...t, externalId: j.data.id, label: `@${j.data.username}`, avatar: j.data.profile_image_url ?? null }];
  },
  async upload(c) {
    await c.progress(5, 'starting the upload');
    const init = await call('X media upload', `${host('x', 'api')}/2/media/upload/initialize`, { method: 'POST', headers: bearer(c.token, { 'content-type': 'application/json' }),
      body: JSON.stringify({ media_type: 'video/mp4', total_bytes: c.size, media_category: 'tweet_video' }) });
    const mediaId = init.data?.id ?? init.data?.media_id_string ?? init.media_id_string;
    if (!mediaId) throw new SocialError('X did not return a media id');
    const blob = await openAsBlob(c.file, { type: 'video/mp4' });
    const parts = Math.max(1, Math.ceil(c.size / X_CHUNK));
    for (let i = 0; i < parts; i++) {
      const fd = new FormData();
      fd.set('segment_index', String(i));
      fd.set('media', blob.slice(i * X_CHUNK, Math.min(c.size, (i + 1) * X_CHUNK)) as any, 'chunk');
      await call('X media upload', `${host('x', 'api')}/2/media/upload/${encodeURIComponent(mediaId)}/append`, { method: 'POST', headers: bearer(c.token), body: fd });
      await c.progress(5 + Math.round(((i + 1) / parts) * 70), 'uploading');
    }
    let fin = await call('X media upload', `${host('x', 'api')}/2/media/upload/${encodeURIComponent(mediaId)}/finalize`, { method: 'POST', headers: bearer(c.token) });
    for (let n = 0; fin.data?.processing_info && fin.data.processing_info.state !== 'succeeded'; n++) {
      if (fin.data.processing_info.state === 'failed') throw new SocialError(`X could not process the video: ${fin.data.processing_info.error?.message ?? 'failed'}`, { permanent: true });
      if (n > 120) throw new SocialError('X is still processing the video after ten minutes');
      await c.progress(80, 'X is processing the video');
      await sleep(Math.max(pollMs(), (fin.data.processing_info.check_after_secs ?? 0) * 1000));
      fin = await call('X media status', `${host('x', 'api')}/2/media/upload?command=STATUS&media_id=${encodeURIComponent(mediaId)}`, { headers: bearer(c.token) });
    }
    const text = c.post.description.slice(0, 280);
    const post = await call('X post', `${host('x', 'api')}/2/tweets`, { method: 'POST', headers: bearer(c.token, { 'content-type': 'application/json' }),
      body: JSON.stringify({ text, media: { media_ids: [mediaId] } }) });
    const handle = (c.accountLabel ?? '').replace(/^@/, '') || 'i';
    return { externalId: post.data.id, url: `https://x.com/${handle}/status/${post.data.id}` };
  },
  async views(token, _acct, id) {
    const j = await call('X views', `${host('x', 'api')}/2/tweets/${encodeURIComponent(id)}?tweet.fields=public_metrics`, { headers: bearer(token) });
    const v = j.data?.public_metrics?.impression_count;
    return v != null ? Number(v) : null;
  },
  async remove(token, _acct, id) {
    await call('X delete', `${host('x', 'api')}/2/tweets/${encodeURIComponent(id)}`, { method: 'DELETE', headers: bearer(token) });
  },
};

// ---------------------------------------------------------------- TikTok

const TT_CHUNK = 10 * 1024 * 1024;
const TT_PRIVACY: Record<Privacy, string> = { public: 'PUBLIC_TO_EVERYONE', unlisted: 'MUTUAL_FOLLOW_FRIENDS', private: 'SELF_ONLY' };
const tiktok: Platform = {
  id: 'tiktok', label: 'TikTok', accountNoun: 'account',
  env: { id: 'TIKTOK_CLIENT_KEY', secret: 'TIKTOK_CLIENT_SECRET' },
  scopes: ['user.info.basic', 'user.info.profile', 'video.publish', 'video.list'],
  pkce: false,
  limits: { title: null, description: 2200, tags: true },
  privacy: ['public', 'unlisted', 'private'],
  authorizeUrl(clientId, redirect, state) {
    const q = new URLSearchParams({ client_key: clientId, scope: this.scopes.join(','), response_type: 'code', redirect_uri: redirect, state });
    return `${host('tiktok', 'auth')}/v2/auth/authorize/?${q}`;
  },
  async exchange(code, redirect) {
    const c = creds(this);
    const j = await call('TikTok sign-in', `${host('tiktok', 'api')}/v2/oauth/token/`, { method: 'POST', headers: FORM,
      body: form({ client_key: c.id, client_secret: c.secret, code, grant_type: 'authorization_code', redirect_uri: redirect }) });
    return tokenFrom(j);
  },
  async refresh(rt) {
    const c = creds(this);
    return tokenFrom(await call('TikTok token refresh', `${host('tiktok', 'api')}/v2/oauth/token/`, { method: 'POST', headers: FORM,
      body: form({ client_key: c.id, client_secret: c.secret, grant_type: 'refresh_token', refresh_token: rt }) }));
  },
  async accounts(t) {
    const j = await call('TikTok profile', `${host('tiktok', 'api')}/v2/user/info/?fields=open_id,display_name,username,avatar_url`, { headers: bearer(t.accessToken) });
    const u = j.data?.user ?? {};
    return [{ ...t, externalId: u.open_id, label: u.username ? `@${u.username}` : (u.display_name ?? u.open_id), avatar: u.avatar_url ?? null }];
  },
  async upload(c) {
    await c.progress(3, 'checking what this account may post');
    const info = await call('TikTok creator info', `${host('tiktok', 'api')}/v2/post/publish/creator_info/query/`, { method: 'POST', headers: bearer(c.token, { 'content-type': 'application/json; charset=UTF-8' }), body: '{}' });
    const allowed: string[] = info.data?.privacy_level_options ?? [];
    let privacy = TT_PRIVACY[c.post.privacy];
    // An app TikTok has not audited may only post privately: say so, then do it.
    if (allowed.length && !allowed.includes(privacy)) {
      if (!allowed.includes('SELF_ONLY')) throw new SocialError(`TikTok does not allow ${c.post.privacy} posts for this account (allowed: ${allowed.join(', ')})`, { permanent: true });
      privacy = 'SELF_ONLY';
    }
    const chunk = c.size <= 64 * 1024 * 1024 ? c.size : TT_CHUNK;
    const count = Math.max(1, Math.floor(c.size / chunk));
    const init = await call('TikTok upload', `${host('tiktok', 'api')}/v2/post/publish/video/init/`, { method: 'POST', headers: bearer(c.token, { 'content-type': 'application/json; charset=UTF-8' }),
      body: JSON.stringify({ post_info: { title: c.post.description.slice(0, 2200), privacy_level: privacy, disable_comment: false, disable_duet: false, disable_stitch: false },
        source_info: { source: 'FILE_UPLOAD', video_size: c.size, chunk_size: chunk, total_chunk_count: count } }) });
    const { publish_id: publishId, upload_url: uploadUrl } = init.data ?? {};
    if (!publishId || !uploadUrl) throw new SocialError('TikTok did not return an upload URL');
    const blob = await openAsBlob(c.file);
    for (let i = 0; i < count; i++) {
      const start = i * chunk;
      const end = i === count - 1 ? c.size : start + chunk;   // the last chunk takes the remainder
      const r = await fetch(uploadUrl, { method: 'PUT', headers: { 'content-type': 'video/mp4', 'content-length': String(end - start), 'content-range': `bytes ${start}-${end - 1}/${c.size}` },
        body: blob.slice(start, end) as any });
      if (!r.ok && r.status !== 206) throw new SocialError(`TikTok upload: ${r.status} ${(await r.text()).slice(0, 200)}`, { permanent: r.status >= 400 && r.status < 500 && r.status !== 429 });
      await c.progress(5 + Math.round(((i + 1) / count) * 70), 'uploading');
    }
    for (let n = 0; ; n++) {
      const st = await call('TikTok status', `${host('tiktok', 'api')}/v2/post/publish/status/fetch/`, { method: 'POST', headers: bearer(c.token, { 'content-type': 'application/json; charset=UTF-8' }), body: JSON.stringify({ publish_id: publishId }) });
      const s = st.data?.status;
      if (s === 'PUBLISH_COMPLETE') {
        const id = st.data?.publicaly_available_post_id?.[0] ?? st.data?.publicly_available_post_id?.[0] ?? null;
        const handle = (c.accountLabel ?? '').startsWith('@') ? c.accountLabel : null;
        return { externalId: id ? String(id) : publishId, url: id && handle ? `https://www.tiktok.com/${handle}/video/${id}` : null };
      }
      if (s === 'FAILED') throw new SocialError(`TikTok could not publish the video: ${st.data?.fail_reason ?? 'failed'}`, { permanent: true });
      if (n > 120) throw new SocialError('TikTok is still processing the video after ten minutes');
      await c.progress(85, privacy === 'SELF_ONLY' && c.post.privacy !== 'private' ? 'TikTok is processing (posting privately: the app is not audited for public posts yet)' : 'TikTok is processing the video');
      await sleep(pollMs());
    }
  },
  async views(token, _acct, id) {
    const j = await call('TikTok views', `${host('tiktok', 'api')}/v2/video/query/?fields=id,view_count`, { method: 'POST', headers: bearer(token, { 'content-type': 'application/json' }),
      body: JSON.stringify({ filters: { video_ids: [id] } }) });
    const v = j.data?.videos?.[0]?.view_count;
    return v != null ? Number(v) : null;
  },
};

// ---------------------------------------------------------------- Dailymotion

const dailymotion: Platform = {
  id: 'dailymotion', label: 'Dailymotion', accountNoun: 'channel',
  env: { id: 'DAILYMOTION_API_KEY', secret: 'DAILYMOTION_API_SECRET' },
  scopes: ['manage_videos'],
  pkce: false,
  limits: { title: 255, description: 3000, tags: true },
  privacy: ['public', 'private'],
  authorizeUrl(clientId, redirect, state) {
    const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirect, scope: this.scopes.join(' '), state });
    return `${host('dailymotion', 'auth')}/oauth/authorize?${q}`;
  },
  async exchange(code, redirect) {
    const c = creds(this);
    return tokenFrom(await call('Dailymotion sign-in', `${host('dailymotion', 'api')}/oauth/token`, { method: 'POST', headers: FORM,
      body: form({ grant_type: 'authorization_code', client_id: c.id, client_secret: c.secret, redirect_uri: redirect, code }) }));
  },
  async refresh(rt) {
    const c = creds(this);
    return tokenFrom(await call('Dailymotion token refresh', `${host('dailymotion', 'api')}/oauth/token`, { method: 'POST', headers: FORM,
      body: form({ grant_type: 'refresh_token', client_id: c.id, client_secret: c.secret, refresh_token: rt }) }));
  },
  async accounts(t) {
    const j = await call('Dailymotion profile', `${host('dailymotion', 'api')}/me?fields=id,screenname,avatar_120_url`, { headers: bearer(t.accessToken) });
    return [{ ...t, externalId: j.id, label: j.screenname ?? j.id, avatar: j.avatar_120_url ?? null }];
  },
  async upload(c) {
    await c.progress(5, 'starting the upload');
    const up = await call('Dailymotion upload', `${host('dailymotion', 'api')}/file/upload`, { headers: bearer(c.token) });
    const fd = new FormData();
    fd.set('file', await openAsBlob(c.file, { type: 'video/mp4' }) as any, 'video.mp4');
    const sent = await call('Dailymotion upload', up.upload_url, { method: 'POST', body: fd });
    await c.progress(75, 'creating the video');
    const v = await call('Dailymotion publish', `${host('dailymotion', 'api')}/me/videos`, { method: 'POST', headers: bearer(c.token, FORM),
      body: form({ url: sent.url, title: c.post.title.slice(0, 255), description: c.post.description.slice(0, 3000), tags: c.post.tags.join(','),
        channel: 'news', published: 'true', private: c.post.privacy === 'private' ? 'true' : 'false', is_created_for_kids: 'false' }) });
    return { externalId: v.id, url: `https://www.dailymotion.com/video/${v.id}` };
  },
  async views(token, _acct, id) {
    const j = await call('Dailymotion views', `${host('dailymotion', 'api')}/video/${encodeURIComponent(id)}?fields=views_total`, { headers: bearer(token) });
    return j.views_total != null ? Number(j.views_total) : null;
  },
  async remove(token, _acct, id) {
    await call('Dailymotion delete', `${host('dailymotion', 'api')}/video/${encodeURIComponent(id)}`, { method: 'DELETE', headers: bearer(token) });
  },
};

// ---------------------------------------------------------------- Instagram

// Instagram professional accounts (Business or Creator), two ways in:
//   instagram  Instagram Login: graph.instagram.com, the account's own
//              long-lived token (60 days, renewed with ig_refresh_token).
//   facebook   Facebook Login: an Instagram account tied to a Facebook Page,
//              on graph.facebook.com with the Page's token (does not expire).
// Publishing is the container flow: create a container (a Reel uploaded to
// Meta resumably, so the Mac needs no public address for video; a picture by
// its URL, which Meta fetches and which must be a JPEG), wait until its
// status_code is FINISHED, then media_publish. The container id is kept on the
// publication (UploadCtx.saveState) so a retry carries on with it.
const IG_POLL_MAX = 120;
const igGraph = (variant?: string | null) => variant === 'facebook' ? `${host('facebook', 'graph')}/${FB}` : `${host('instagram', 'graph')}/${FB}`;
const instagram: Platform = {
  id: 'instagram', label: 'Instagram', accountNoun: 'professional account',
  env: { id: 'INSTAGRAM_APP_ID', secret: 'INSTAGRAM_APP_SECRET' },
  scopes: ['instagram_business_basic', 'instagram_business_content_publish'],
  variants: [
    { id: 'instagram', label: 'Instagram Login', env: { id: 'INSTAGRAM_APP_ID', secret: 'INSTAGRAM_APP_SECRET' },
      scopes: ['instagram_business_basic', 'instagram_business_content_publish'] },
    { id: 'facebook', label: 'Facebook Login (account tied to a Page)', env: { id: 'FACEBOOK_APP_ID', secret: 'FACEBOOK_APP_SECRET' },
      scopes: ['instagram_basic', 'instagram_content_publish', 'pages_show_list', 'pages_read_engagement'] },
  ],
  images: true,
  pkce: false,
  // 2,200 characters and at most 30 hashtags per caption.
  limits: { title: null, description: 2200, tags: true, hashtags: 30 },
  privacy: ['public'],
  authorizeUrl(clientId, redirect, state, _challenge, variant) {
    if (variant === 'facebook') {
      const scope = this.variants![1].scopes.join(',');
      const q = new URLSearchParams({ client_id: clientId, redirect_uri: redirect, state, scope, response_type: 'code' });
      return `${host('facebook', 'auth')}/${FB}/dialog/oauth?${q}`;
    }
    const q = new URLSearchParams({ client_id: clientId, redirect_uri: redirect, response_type: 'code', scope: this.variants![0].scopes.join(','), state });
    return `${host('instagram', 'auth')}/oauth/authorize?${q}`;
  },
  async exchange(code, redirect, _verifier, _app, variant) {
    const c = creds(this, variant);
    if (variant === 'facebook') {
      const short = tokenFrom(await call('Instagram sign-in', `${host('facebook', 'graph')}/${FB}/oauth/access_token?${form({ client_id: c.id, client_secret: c.secret, redirect_uri: redirect, code })}`));
      return tokenFrom(await call('Instagram sign-in', `${host('facebook', 'graph')}/${FB}/oauth/access_token?${form({ grant_type: 'fb_exchange_token', client_id: c.id, client_secret: c.secret, fb_exchange_token: short.accessToken })}`));
    }
    const j = await call('Instagram sign-in', `${host('instagram', 'api')}/oauth/access_token`, { method: 'POST', headers: FORM,
      body: form({ client_id: c.id, client_secret: c.secret, grant_type: 'authorization_code', redirect_uri: redirect, code }) });
    // Older answers are flat, newer ones wrap it in data[0].
    const short = tokenFrom(j?.data?.[0] ?? j);
    const long = tokenFrom(await call('Instagram sign-in', `${host('instagram', 'graph')}/access_token?${form({ grant_type: 'ig_exchange_token', client_secret: c.secret, access_token: short.accessToken })}`));
    // The long-lived token renews itself: it is its own refresh token.
    return { ...long, refreshToken: long.accessToken, scopes: long.scopes ?? short.scopes };
  },
  async refresh(rt, _app, variant) {
    if (variant === 'facebook') throw new SocialError('A Page token does not expire: connect the account again.', { permanent: true });
    const t = tokenFrom(await call('Instagram token renewal', `${host('instagram', 'graph')}/refresh_access_token?${form({ grant_type: 'ig_refresh_token', access_token: rt })}`));
    return { ...t, refreshToken: t.accessToken };
  },
  async accounts(t, variant) {
    if (variant === 'facebook') {
      const j = await call('Instagram accounts', `${host('facebook', 'graph')}/${FB}/me/accounts?fields=id,name,access_token,instagram_business_account{id,username,profile_picture_url,followers_count}&limit=100`, { headers: bearer(t.accessToken) });
      const withIg = (j.data ?? []).filter((p: any) => p.instagram_business_account?.id);
      if (!withIg.length) throw new SocialError('None of the Pages this Facebook account manages has an Instagram professional account tied to it. Tie one in the Page settings, or use Instagram Login.', { permanent: true });
      return withIg.map((p: any) => {
        const ig = p.instagram_business_account;
        return { accessToken: p.access_token, refreshToken: null, expiresIn: null, externalId: String(ig.id), label: ig.username ? `@${ig.username}` : p.name,
          avatar: ig.profile_picture_url ?? null, followers: ig.followers_count != null ? Number(ig.followers_count) : null };
      });
    }
    const me = await call('Instagram profile', `${igGraph(variant)}/me?fields=user_id,username,profile_picture_url,followers_count,account_type`, { headers: bearer(t.accessToken) });
    if (me.account_type && !['BUSINESS', 'MEDIA_CREATOR', 'CREATOR'].includes(String(me.account_type).toUpperCase())) {
      throw new SocialError('This is a personal Instagram account. Only Business and Creator accounts can be published to: switch it to a professional account in the Instagram app.', { permanent: true });
    }
    return [{ ...t, externalId: String(me.user_id ?? me.id), label: me.username ? `@${me.username}` : String(me.user_id ?? me.id),
      avatar: me.profile_picture_url ?? null, followers: me.followers_count != null ? Number(me.followers_count) : null }];
  },
  async upload(c) {
    const g = igGraph(c.variant);
    const auth = bearer(c.token);
    const image = c.kind === 'image';
    const what = image ? 'picture' : 'Reel';
    let st: Record<string, any> = { ...(c.state ?? {}) };
    const save = async (next: Record<string, any> | null) => { st = next ?? {}; await c.saveState?.(next); };
    const permalink = async (mediaId: string) => {
      try { return (await call('Instagram post', `${g}/${encodeURIComponent(mediaId)}?fields=permalink`, { headers: auth })).permalink ?? null; } catch { return null; }
    };
    // Published already on an earlier try (the answer was lost): do not post twice.
    if (st.mediaId) return { externalId: String(st.mediaId), url: await permalink(String(st.mediaId)) };

    if (st.container) {
      const s0 = await call('Instagram status', `${g}/${encodeURIComponent(st.container)}?fields=status_code,status`, { headers: auth });
      if (s0.status_code === 'EXPIRED' || s0.status_code === 'ERROR' && !st.uploaded) await save(null);   // start again with a fresh container
      else if (s0.status_code === 'PUBLISHED' && s0.id) await save({ ...st, mediaId: s0.id });
    }
    if (!st.container) {
      await c.progress(5, `creating the Instagram ${what}`);
      const body: Record<string, string> = { caption: c.post.description.slice(0, 2200) };
      if (image) {
        if (!c.imageUrl) throw new SocialError('Instagram needs the picture at an address it can fetch.', { permanent: true });
        body.image_url = c.imageUrl;
      } else {
        body.media_type = 'REELS'; body.upload_type = 'resumable';
      }
      const made = await call('Instagram container', `${g}/${encodeURIComponent(c.externalAccount)}/media`, { method: 'POST', headers: { ...auth, ...FORM }, body: form(body) });
      if (!made.id) throw new SocialError('Instagram did not return a container id');
      await save({ container: String(made.id), uri: made.uri ?? null, uploaded: image });
    }
    if (!image && !st.uploaded) {
      await c.progress(10, 'uploading');
      const url = st.uri || `${host('instagram', 'rupload')}/ig-api-upload/${FB}/${encodeURIComponent(st.container)}`;
      const r = await fetch(url, { method: 'POST', headers: { authorization: `OAuth ${c.token}`, offset: '0', file_size: String(c.size), 'content-type': 'application/octet-stream' },
        body: await openAsBlob(c.file) as any }).catch((e) => { throw new SocialError(`Instagram upload: could not reach the platform (${e.message})`); });
      const text = await r.text();
      if (!r.ok) throw new SocialError(`Instagram upload: ${r.status} ${text.slice(0, 300)}`, { permanent: r.status >= 400 && r.status < 500 && r.status !== 401 && r.status !== 429, auth: r.status === 401, status: r.status });
      await save({ ...st, uploaded: true });
      await c.progress(70, 'uploaded');
    }
    if (!st.mediaId) {
      for (let n = 0; ; n++) {
        const s = await call('Instagram status', `${g}/${encodeURIComponent(st.container)}?fields=status_code,status`, { headers: auth });
        if (s.status_code === 'FINISHED') break;
        if (s.status_code === 'PUBLISHED') { if (s.id) await save({ ...st, mediaId: s.id }); break; }
        if (s.status_code === 'ERROR') { await save(null); throw new SocialError(`Instagram could not process the ${what}: ${s.status ?? 'error'}`, { permanent: true }); }
        if (s.status_code === 'EXPIRED') { await save(null); throw new SocialError(`The Instagram container expired before it was published. Retry to start again.`); }
        // Kept on the row: the next try waits on the same container.
        if (n >= IG_POLL_MAX) throw new SocialError(`Instagram is still processing the ${what}; it will be checked again`);
        await c.progress(80, `Instagram is processing the ${what}`);
        await sleep(pollMs());
      }
    }
    if (!st.mediaId) {
      await c.progress(92, 'publishing');
      const pub = await call('Instagram publish', `${g}/${encodeURIComponent(c.externalAccount)}/media_publish`, { method: 'POST', headers: { ...auth, ...FORM }, body: form({ creation_id: st.container }) });
      if (!pub.id) throw new SocialError('Instagram did not return the post id');
      await save({ ...st, mediaId: String(pub.id) });
    }
    return { externalId: String(st.mediaId), url: await permalink(String(st.mediaId)) };
  },
  async stats(token, _acct, id, variant) {
    const g = igGraph(variant);
    const m = await call('Instagram likes', `${g}/${encodeURIComponent(id)}?fields=like_count`, { headers: bearer(token) });
    let views: number | null = null;
    try {
      const i = await call('Instagram views', `${g}/${encodeURIComponent(id)}/insights?metric=views`, { headers: bearer(token) });
      const d = i.data?.[0];
      const v = d?.total_value?.value ?? d?.values?.[0]?.value;
      views = v != null ? Number(v) : null;
    } catch (e) { if (e instanceof SocialError && e.auth) throw e; }
    return { views, likes: m.like_count != null ? Number(m.like_count) : null };
  },
  async followers(token, acct, variant) {
    const j = await call('Instagram followers', `${igGraph(variant)}/${encodeURIComponent(acct)}?fields=followers_count`, { headers: bearer(token) });
    return j.followers_count != null ? Number(j.followers_count) : null;
  },
  async publishingLimit(token, acct, variant) {
    const j = await call('Instagram publishing limit', `${igGraph(variant)}/${encodeURIComponent(acct)}/content_publishing_limit?fields=config,quota_usage`, { headers: bearer(token) });
    const d = j.data?.[0] ?? {};
    return { used: Number(d.quota_usage ?? 0), total: Number(d.config?.quota_total ?? 100) };
  },
};

// ---------------------------------------------------------------- Threads

// Threads profiles (build queue 1.14j), on the Threads API at graph.threads.net
// with the profile's own long-lived token (60 days, renewed with
// th_refresh_token, like Instagram Login's). Same Meta app family, its own app
// id and secret (Threads use case in the Meta app dashboard).
//
// Publishing is the container flow: create a container (VIDEO by video_url or
// IMAGE by image_url, the text with it), wait until its status is FINISHED,
// then threads_publish. Unlike Instagram there is NO upload: Threads fetches
// the file from the address it is given, so the publish job hands it a signed,
// expiring link on Volt's public address (services/social fetchableVideo). The
// container id is kept on the publication, so a retry carries on with it.
//
// Limits (Threads API documentation): 500 characters of text, one hashtag
// (the post's topic tag), 250 API posts in a moving 24 hours
// (threads_publishing_limit). Views, likes and follower counts need
// threads_manage_insights. The API offers apps no way to delete a post.
const TH = 'v1.0';
const thGraph = () => `${host('threads', 'graph')}/${TH}`;
const TH_POLL_MAX = 120;
const threads: Platform = {
  id: 'threads', label: 'Threads', accountNoun: 'profile',
  env: { id: 'THREADS_APP_ID', secret: 'THREADS_APP_SECRET' },
  scopes: ['threads_basic', 'threads_content_publish', 'threads_manage_insights'],
  images: true,
  fetchesVideo: true,
  pkce: false,
  limits: { title: null, description: 500, tags: true, hashtags: 1 },
  privacy: ['public'],
  authorizeUrl(clientId, redirect, state) {
    const q = new URLSearchParams({ client_id: clientId, redirect_uri: redirect, scope: this.scopes.join(','), response_type: 'code', state });
    return `${host('threads', 'auth')}/oauth/authorize?${q}`;
  },
  async exchange(code, redirect) {
    const c = creds(this);
    const short = tokenFrom(await call('Threads sign-in', `${host('threads', 'graph')}/oauth/access_token`, { method: 'POST', headers: FORM,
      body: form({ client_id: c.id, client_secret: c.secret, grant_type: 'authorization_code', redirect_uri: redirect, code }) }));
    const long = tokenFrom(await call('Threads sign-in', `${host('threads', 'graph')}/access_token?${form({ grant_type: 'th_exchange_token', client_secret: c.secret, access_token: short.accessToken })}`));
    // The long-lived token renews itself: it is its own refresh token.
    return { ...long, refreshToken: long.accessToken, scopes: long.scopes ?? short.scopes };
  },
  async refresh(rt) {
    const t = tokenFrom(await call('Threads token renewal', `${host('threads', 'graph')}/refresh_access_token?${form({ grant_type: 'th_refresh_token', access_token: rt })}`));
    return { ...t, refreshToken: t.accessToken };
  },
  async accounts(t) {
    const me = await call('Threads profile', `${thGraph()}/me?fields=id,username,threads_profile_picture_url`, { headers: bearer(t.accessToken) });
    if (!me.id) throw new SocialError('Threads did not say which profile this is.', { permanent: true });
    let followers: number | null = null;
    try { followers = await this.followers!(t.accessToken, String(me.id)); } catch { /* read again with the views */ }
    return [{ ...t, externalId: String(me.id), label: me.username ? `@${me.username}` : String(me.id), avatar: me.threads_profile_picture_url ?? null, followers }];
  },
  async upload(c) {
    const g = thGraph();
    const auth = bearer(c.token);
    const image = c.kind === 'image';
    const what = image ? 'picture' : 'video';
    let st: Record<string, any> = { ...(c.state ?? {}) };
    const save = async (next: Record<string, any> | null) => { st = next ?? {}; await c.saveState?.(next); };
    const permalink = async (mediaId: string) => {
      try { return (await call('Threads post', `${g}/${encodeURIComponent(mediaId)}?fields=permalink`, { headers: auth })).permalink ?? null; } catch { return null; }
    };
    // Published already on an earlier try (the answer was lost): do not post twice.
    if (st.mediaId) return { externalId: String(st.mediaId), url: await permalink(String(st.mediaId)) };

    if (st.container) {
      const s0 = await call('Threads status', `${g}/${encodeURIComponent(st.container)}?fields=status,error_message`, { headers: auth });
      if (s0.status === 'EXPIRED' || s0.status === 'ERROR') await save(null);   // start again with a fresh container
      else if (s0.status === 'PUBLISHED' && s0.id) await save({ ...st, mediaId: s0.id });
    }
    if (st.mediaId) return { externalId: String(st.mediaId), url: await permalink(String(st.mediaId)) };
    if (!st.container) {
      const url = image ? c.imageUrl : c.videoUrl;
      if (!url) throw new SocialError(`Threads needs the ${what} at an address it can fetch.`, { permanent: true });
      await c.progress(10, 'creating the Threads post');
      const body: Record<string, string> = { media_type: image ? 'IMAGE' : 'VIDEO', text: c.post.description.slice(0, 500) };
      if (image) body.image_url = url; else body.video_url = url;
      const made = await call('Threads container', `${g}/${encodeURIComponent(c.externalAccount)}/threads`, { method: 'POST', headers: { ...auth, ...FORM }, body: form(body) });
      if (!made.id) throw new SocialError('Threads did not return a container id');
      await save({ container: String(made.id) });
      await c.progress(40, `Threads is fetching the ${what}`);
    }
    for (let n = 0; ; n++) {
      const s = await call('Threads status', `${g}/${encodeURIComponent(st.container)}?fields=status,error_message`, { headers: auth });
      if (s.status === 'FINISHED') break;
      if (s.status === 'PUBLISHED') { if (s.id) await save({ ...st, mediaId: s.id }); break; }
      if (s.status === 'ERROR') { await save(null); throw new SocialError(`Threads could not process the ${what}: ${s.error_message ?? 'error'}`, { permanent: true }); }
      if (s.status === 'EXPIRED') { await save(null); throw new SocialError('The Threads container expired before it was published. Retry to start again.'); }
      // Kept on the row: the next try waits on the same container.
      if (n >= TH_POLL_MAX) throw new SocialError(`Threads is still processing the ${what}; it will be checked again`);
      await c.progress(85, `Threads is processing the ${what}`);
      await sleep(pollMs());
    }
    if (!st.mediaId) {
      await c.progress(92, 'publishing');
      const pub = await call('Threads publish', `${g}/${encodeURIComponent(c.externalAccount)}/threads_publish`, { method: 'POST', headers: { ...auth, ...FORM }, body: form({ creation_id: st.container }) });
      if (!pub.id) throw new SocialError('Threads did not return the post id');
      await save({ ...st, mediaId: String(pub.id) });
    }
    return { externalId: String(st.mediaId), url: await permalink(String(st.mediaId)) };
  },
  async stats(token, _acct, id) {
    const j = await call('Threads views', `${thGraph()}/${encodeURIComponent(id)}/insights?metric=views,likes`, { headers: bearer(token) });
    const val = (name: string) => {
      const d = (j.data ?? []).find((x: any) => x.name === name);
      const v = d?.total_value?.value ?? d?.values?.[0]?.value;
      return v != null ? Number(v) : null;
    };
    return { views: val('views'), likes: val('likes') };
  },
  async followers(token, acct) {
    const j = await call('Threads followers', `${thGraph()}/${encodeURIComponent(acct)}/threads_insights?metric=followers_count`, { headers: bearer(token) });
    const d = (j.data ?? []).find((x: any) => x.name === 'followers_count');
    const v = d?.total_value?.value ?? d?.values?.[0]?.value;
    return v != null ? Number(v) : null;
  },
  async publishingLimit(token, acct) {
    const j = await call('Threads publishing limit', `${thGraph()}/${encodeURIComponent(acct)}/threads_publishing_limit?fields=quota_usage,config`, { headers: bearer(token) });
    const d = j.data?.[0] ?? {};
    return { used: Number(d.quota_usage ?? 0), total: Number(d.config?.quota_total ?? 250) };
  },
};

// Listed in this order on Social accounts: Instagram and Threads beside Facebook, the other Meta platforms.
export const PLATFORMS: Record<PlatformId, Platform> = { youtube, facebook, instagram, threads, x, tiktok, dailymotion };
export const PLATFORM_IDS = Object.keys(PLATFORMS) as PlatformId[];
