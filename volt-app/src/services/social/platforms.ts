// ============================================================================
//  SOCIAL PLATFORMS: OAuth and upload, one adapter per platform.
//
//  Each adapter is written against the platform's documented public API:
//    YouTube      Data API v3, resumable upload
//    Facebook     Graph API, Page video upload (posts as the Page)
//    X            API v2, chunked media upload then a post with the media
//    TikTok       Content Posting API, direct post with FILE_UPLOAD
//    Dailymotion  REST API, upload URL then create the video
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

export type PlatformId = 'youtube' | 'facebook' | 'x' | 'tiktok' | 'dailymotion';
export type Privacy = 'public' | 'unlisted' | 'private';

export interface PostSpec { title: string; description: string; tags: string[]; privacy: Privacy }
export interface Tokens { accessToken: string; refreshToken?: string | null; expiresIn?: number | null; scopes?: string[] }
export interface LinkedAccount extends Tokens { externalId: string; label: string; avatar?: string | null }
export interface UploadCtx {
  token: string; externalAccount: string; accountLabel: string | null;
  file: string; size: number; post: PostSpec;
  progress: (pct: number, stage: string) => Promise<void>;
}
export interface UploadResult { externalId: string; url: string | null }

export class SocialError extends Error {
  permanent: boolean; auth: boolean; status: number | null;
  constructor(message: string, opts: { permanent?: boolean; auth?: boolean; status?: number | null } = {}) {
    super(message); this.permanent = !!opts.permanent; this.auth = !!opts.auth; this.status = opts.status ?? null;
  }
}

export interface Platform {
  id: PlatformId;
  label: string;
  /** Environment variables holding the app's client id and secret. */
  env: { id: string; secret: string };
  scopes: string[];
  pkce: boolean;
  limits: { title: number | null; description: number; tags: boolean };
  privacy: Privacy[];
  /** What the platform calls the thing the account publishes as. */
  accountNoun: string;
  authorizeUrl(clientId: string, redirect: string, state: string, challenge: string | null): string;
  /** `app` is the account's own developer app when it has one (X only, so far); otherwise the deployment's. */
  exchange(code: string, redirect: string, verifier: string | null, app?: AppCreds | null): Promise<Tokens>;
  refresh?(refreshToken: string, app?: AppCreds | null): Promise<Tokens>;
  accounts(t: Tokens): Promise<LinkedAccount[]>;
  upload(c: UploadCtx): Promise<UploadResult>;
  views?(token: string, externalAccount: string, externalId: string): Promise<number | null>;
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
};
export function host(platform: PlatformId, key: string): string {
  const test = process.env.SOCIAL_TEST_BASE;
  if (test) return `${test.replace(/\/$/, '')}/${platform}/${key}`;
  const h = HOSTS[`${platform}:${key}`];
  if (!h) throw new Error(`no host ${platform}:${key}`);
  return h;
}
const FB = 'v21.0';
const env = (name: string) => process.env[name] ?? '';
export type AppCreds = { id: string; secret: string };
export function appCreds(p: Platform): AppCreds | null {
  const id = env(p.env.id), secret = env(p.env.secret);
  return id && secret ? { id, secret } : null;
}
function creds(p: Platform) {
  const c = appCreds(p);
  if (!c) throw new SocialError(`${p.label} is not set up on this deployment (${p.env.id}, ${p.env.secret}).`, { permanent: true });
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

export const PLATFORMS: Record<PlatformId, Platform> = { youtube, facebook, x, tiktok, dailymotion };
export const PLATFORM_IDS = Object.keys(PLATFORMS) as PlatformId[];
