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
//      publication, and on demand.
//
//  A failure that retrying cannot fix (the platform rejected the video, the
//  account's access was revoked) fails the publication at once with the
//  platform's own words and tells the account's admins. Anything else is
//  retried by the job queue, and fails the publication only on the last try.
// ============================================================================
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { query, one } from '../../db';
import { config } from '../../config';
import { seal, open, tokenKeyConfigured } from './crypto';
import { PLATFORMS, PLATFORM_IDS, appCreds, SocialError, type PlatformId, type PostSpec, type Privacy, type LinkedAccount } from './platforms';

export { PLATFORMS, PLATFORM_IDS, SocialError };
export type { PlatformId, PostSpec, Privacy };

export const SOCIAL_PUBLISH = 'social.publish';
const STATE_TTL_MIN = 10;

const publicBase = () => config.publicBaseUrl.replace(/\/$/, '');
export const callbackUrl = (p: PlatformId) => `${publicBase()}/api/social/callback/${p}`;

/**
 * Which platforms can be linked here. `setup` adds what whoever runs the
 * deployment needs to set one up (the token key, each platform's two settings,
 * its redirect URL and permissions); an account user gets only whether each is
 * ready, because they cannot act on the rest (services/serverSetup.ts).
 */
export function platformStatus(setup = true) {
  return {
    ...(setup ? { tokenKeyConfigured: tokenKeyConfigured(), callbackBase: `${publicBase()}/api/social/callback/` } : {}),
    setupDetail: setup,
    platforms: PLATFORM_IDS.map((id) => {
      const p = PLATFORMS[id];
      return {
        id, label: p.label, accountNoun: p.accountNoun, configured: !!appCreds(p),
        ...(setup ? { env: [p.env.id, p.env.secret], callbackUrl: callbackUrl(id), scopes: p.scopes } : {}),
        limits: p.limits, privacy: p.privacy,
      };
    }),
  };
}

// ---------------------------------------------------------------- connect

export async function startConnect(platform: PlatformId, accountId: string, userId: string | null): Promise<string> {
  const p = PLATFORMS[platform];
  const c = appCreds(p);
  if (!c) throw new SocialError(`${p.label} is not set up on this deployment: set ${p.env.id} and ${p.env.secret}.`, { permanent: true });
  const state = randomBytes(24).toString('base64url');
  const verifier = p.pkce ? randomBytes(48).toString('base64url') : null;
  const challenge = verifier ? createHash('sha256').update(verifier).digest('base64url') : null;
  await query(`DELETE FROM social_oauth_states WHERE created_at < now() - make_interval(mins => $1)`, [STATE_TTL_MIN]);
  await query(`INSERT INTO social_oauth_states(id, account_id, user_id, platform, code_verifier) VALUES ($1,$2,$3,$4,$5)`,
    [state, accountId, userId, platform, verifier]);
  return p.authorizeUrl(c.id, callbackUrl(platform), state, challenge);
}

/** Store (or refresh) one linked account as a publish target. */
async function upsertTarget(accountId: string, userId: string | null, platform: PlatformId, a: LinkedAccount, mode: 'live' | 'sandbox'): Promise<any> {
  const expires = a.expiresIn ? new Date(Date.now() + a.expiresIn * 1000).toISOString() : null;
  const existing = await one<any>(
    `SELECT id FROM publish_targets WHERE account_id=$1 AND platform=$2 AND external_account=$3 AND mode=$4`,
    [accountId, platform, a.externalId, mode]);
  if (existing) {
    return one(`UPDATE publish_targets SET access_token_enc=$2, refresh_token_enc=COALESCE($3, refresh_token_enc), token_expires_at=$4,
                       scopes=COALESCE($5, scopes), account_label=$6, avatar_url=$7, link_status='connected', link_detail=NULL,
                       linked_by=$8, linked_at=now(), enabled=true, updated_at=now()
                 WHERE id=$1 RETURNING *`,
      [existing.id, seal(a.accessToken), seal(a.refreshToken ?? null), expires, a.scopes ?? null, a.label, a.avatar ?? null, userId]);
  }
  // `name` is unique per account and platform; two Pages can share a name.
  let name = mode === 'sandbox' ? `${a.label} (sandbox)` : a.label;
  for (let i = 2; await one(`SELECT 1 FROM publish_targets WHERE account_id=$1 AND platform=$2 AND name=$3`, [accountId, platform, name]); i++) {
    name = `${mode === 'sandbox' ? `${a.label} (sandbox)` : a.label} ${i}`;
  }
  return one(
    `INSERT INTO publish_targets(account_id, platform, name, external_account, enabled, mode, access_token_enc, refresh_token_enc,
                                 token_expires_at, scopes, account_label, avatar_url, link_status, linked_by, linked_at)
     VALUES ($1,$2,$3,$4,true,$5,$6,$7,$8,$9,$10,$11,'connected',$12, now()) RETURNING *`,
    [accountId, platform, name, a.externalId, mode, seal(a.accessToken), seal(a.refreshToken ?? null), expires, a.scopes ?? null,
     a.label, a.avatar ?? null, userId]);
}

export async function finishConnect(platform: PlatformId, state: string, code: string | null, error: string | null): Promise<{ accountId: string | null; linked: string[]; error?: string }> {
  const st = await one<any>(`DELETE FROM social_oauth_states WHERE id=$1 AND platform=$2 RETURNING *, (created_at > now() - make_interval(mins => $3)) AS fresh`, [state, platform, STATE_TTL_MIN]);
  if (!st) return { accountId: null, linked: [], error: 'This sign-in link has already been used or was not started here. Start again from Social accounts.' };
  if (!st.fresh) return { accountId: st.account_id, linked: [], error: 'The sign-in took longer than ten minutes. Start again.' };
  if (error || !code) return { accountId: st.account_id, linked: [], error: error ? `${PLATFORMS[platform].label} said: ${error}` : 'No authorization code came back.' };
  try {
    const p = PLATFORMS[platform];
    const tokens = await p.exchange(code, callbackUrl(platform), st.code_verifier);
    const accounts = await p.accounts(tokens);
    const linked: string[] = [];
    for (const a of accounts) { await upsertTarget(st.account_id, st.user_id, platform, a, 'live'); linked.push(a.label); }
    return { accountId: st.account_id, linked };
  } catch (e: any) {
    return { accountId: st.account_id, linked: [], error: e.message };
  }
}

/** A sandbox account: behaves like the platform without calling it. */
export async function addSandbox(accountId: string, userId: string | null, platform: PlatformId, label?: string) {
  const p = PLATFORMS[platform];
  const name = label?.trim() || `Volt test ${p.accountNoun}`;
  return upsertTarget(accountId, userId, platform, {
    externalId: `sandbox-${randomBytes(6).toString('hex')}`, label: platform === 'x' || platform === 'tiktok' ? `@${name.replace(/\s+/g, '_').toLowerCase()}` : name,
    accessToken: 'sandbox', refreshToken: null, expiresIn: null,
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
  if (exp && exp < Date.now() + 120_000) {
    const rt = open(target.refresh_token_enc);
    if (!rt || !p.refresh) {
      await markLink(target.id, 'expired', 'The access token expired and the platform gave no way to renew it. Connect the account again.');
      throw new SocialError(`${target.account_label ?? target.name}: access expired. Connect the account again.`, { permanent: true });
    }
    try {
      const t = await p.refresh(rt);
      token = t.accessToken;
      await query(`UPDATE publish_targets SET access_token_enc=$2, refresh_token_enc=COALESCE($3, refresh_token_enc), token_expires_at=$4,
                          link_status='connected', link_detail=NULL, updated_at=now() WHERE id=$1`,
        [target.id, seal(t.accessToken), seal(t.refreshToken ?? null), t.expiresIn ? new Date(Date.now() + t.expiresIn * 1000).toISOString() : null]);
    } catch (e: any) {
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
  const tags = asList(md.tags ?? md.keywords);
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
  if (!full && p.limits.title == null) problems.push(`${p.label} needs a caption`);
  return { post: { title, description: full, tags: p.limits.tags ? tags : [], privacy }, problems };
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
  for (const [pct, stage] of [[10, 'uploading'], [40, 'uploading'], [75, 'uploading'], [90, `${PLATFORMS[target.platform as PlatformId].label} is processing the video`]] as const) {
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
  const asset = await one<any>(`SELECT v.*, g.account_id FROM vod_assets v LEFT JOIN channels c ON c.id=v.channel_id LEFT JOIN events e ON e.id=v.event_id
                                  LEFT JOIN groups g ON g.id=COALESCE(c.group_id, e.group_id) WHERE v.id=$1`, [pub.vod_asset_id]);
  const lastTry = (ctx.job.attempts ?? 1) >= (ctx.job.max_attempts ?? 1);
  const progress = async (pct: number, stage: string) => { await setProgress(pub.id, pct, stage); await ctx.progress(pct, stage); };
  await query(`UPDATE publications SET attempts=attempts+1, error=NULL WHERE id=$1`, [pub.id]);
  let media: { path: string; cleanup: () => void } | null = null;
  try {
    if (!target || !target.enabled) throw new SocialError('The account this was going to is disconnected or disabled.', { permanent: true });
    if (!asset) throw new SocialError('The asset no longer exists.', { permanent: true });
    const p = PLATFORMS[target.platform as PlatformId];
    const post: PostSpec = pub.post ?? defaultPost(asset, target.platform);
    let result: { externalId: string; url: string | null };
    if (target.mode === 'sandbox') {
      await progress(3, 'preparing the video');
      result = await sandboxUpload(pub, target, progress);
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
      result = await p.upload({ token, externalAccount: target.external_account, accountLabel: target.account_label, file: media.path, size, post, progress });
    }
    await query(`UPDATE publications SET status='published', external_id=$2, external_url=$3, published_at=now(), progress=100, stage=NULL, error=NULL WHERE id=$1`,
      [pub.id, result.externalId, result.url]);
    return { externalId: result.externalId, url: result.url };
  } catch (e: any) {
    const se = e instanceof SocialError ? e : new SocialError(String(e?.message ?? e));
    if (se.auth && target) await markLink(target.id, 'expired', `${se.message}. Connect the account again.`);
    const final = se.permanent || se.auth || lastTry;
    await query(`UPDATE publications SET status=$2, error=$3, stage=$4 WHERE id=$1`,
      [pub.id, final ? 'failed' : 'pending', se.message.slice(0, 500), final ? null : 'will retry']);
    if (final && asset?.account_id) {
      const { notifyAccountAdmins } = await import('../notifications');
      await notifyAccountAdmins(asset.account_id, 'publish.failed',
        `Could not publish "${asset.title ?? 'clip'}" to ${target ? PLATFORMS[target.platform as PlatformId]?.label ?? target.platform : 'social'}`,
        `${se.message}\n\nOpen the clip in the Media Library to retry or change the post.`, { publicationId: pub.id, assetId: asset.id });
    }
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
    `SELECT p.id, p.external_id, p.published_at, p.views, t.*, p.id AS pub_id
       FROM publications p JOIN publish_targets t ON t.id = p.target_id
      WHERE p.status = 'published' AND p.external_id IS NOT NULL AND t.enabled
        AND ($1::uuid IS NULL OR t.account_id = $1)
        AND ($2 OR p.last_synced_at IS NULL OR p.last_synced_at < now() - interval '1 hour')
      ORDER BY p.last_synced_at NULLS FIRST LIMIT $3`, [opts.accountId ?? null, !!opts.force, opts.limit ?? 50]);
  let n = 0;
  for (const r of rows) {
    try {
      let views: number | null;
      if (r.mode === 'sandbox') {
        views = Math.floor((Date.now() - new Date(r.published_at).getTime()) / 60000) * 3 + 1;
      } else {
        const p = PLATFORMS[r.platform as PlatformId];
        if (!p.views) continue;
        views = await p.views(await validToken(r), r.external_account, r.external_id);
      }
      await query(`UPDATE publications SET views = COALESCE($2, views), last_synced_at = now() WHERE id = $1`, [r.pub_id, views]);
      n++;
    } catch (e: any) {
      await query(`UPDATE publications SET last_synced_at = now() WHERE id = $1`, [r.pub_id]);
      console.warn('[social] view sync failed', r.pub_id, e?.message ?? e);
    }
  }
  return n;
}

/** Take a post down on the platform, where the platform allows it. */
export async function removeFromPlatform(pubId: string): Promise<void> {
  const r = await one<any>(`SELECT p.external_id, t.* FROM publications p JOIN publish_targets t ON t.id=p.target_id WHERE p.id=$1`, [pubId]);
  if (!r?.external_id) throw new SocialError('Nothing was published here to take down.', { permanent: true });
  if (r.mode !== 'sandbox') {
    const p = PLATFORMS[r.platform as PlatformId];
    if (!p.remove) throw new SocialError(`${p.label} does not let apps delete posts: remove it in the ${p.label} app.`, { permanent: true });
    await p.remove(await validToken(r), r.external_account, r.external_id);
  }
  await query(`UPDATE publications SET status='removed' WHERE id=$1`, [pubId]);
}
