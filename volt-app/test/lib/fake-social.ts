// ============================================================================
//  A local stand-in for YouTube, Facebook, X, TikTok, Dailymotion,
//  Instagram (both login paths and the container flow) and Threads, for the
//  social publishing checks. Mounted at SOCIAL_TEST_BASE: every platform host
//  becomes <base>/<platform>/<host key>, as services/social/platforms.ts maps
//  it. It answers the request sequences the adapters make, checks the parts
//  that matter (bearer tokens, PKCE verifier, byte counts, chunk ranges, post
//  text limits) and records every call so a test can assert the order.
//
//  Knobs on the returned object: `reject` (a title containing it gets a 400),
//  `revoked` (that bearer token gets a 401), `flaky` (the next N calls of a
//  given route answer 503), and for Instagram `igPersonal` (the profile is a
//  personal account), `igQuotaUsed` (posts used of the 24 hour limit); for
//  Threads `thQuotaUsed`, and `thFetch`, which fetches each video or picture
//  URL it is given, as Threads does (off: the URL is only recorded).
// ============================================================================
import { createServer, type IncomingMessage } from 'node:http';

export interface FakeCall { method: string; path: string; auth: string | null; ctype: string; bytes: number; body: string; query: URLSearchParams; headers: Record<string, any> }

export async function startFakeSocial() {
  const calls: FakeCall[] = [];
  const state = {
    reject: 'REJECT', revoked: new Set<string>(), flaky: new Map<string, number>(),
    xStatusPolls: 0, ttStatusPolls: 0, refreshes: 0,
    igPersonal: false, igQuotaUsed: 0, igRefreshes: 0, igContainers: 0,
    igContainer: new Map<string, { kind: 'video' | 'image'; ig: string; uploaded: boolean; polls: number; fail: boolean; published: string | null; imageUrl: string | null; caption: string }>(),
    thQuotaUsed: 0, thContainers: 0, thRefreshes: 0, thFetch: true, thFetchBase: '' as string, thFetched: [] as { url: string; status: number; bytes: number; ctype: string }[],
    thContainer: new Map<string, { kind: 'VIDEO' | 'IMAGE' | 'TEXT'; user: string; polls: number; fail: string | null; published: string | null; url: string | null; text: string }>(),
  };
  let base = '';
  const srv = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const buf = Buffer.concat(chunks);
    const u = new URL(req.url ?? '/', 'http://x');
    const call: FakeCall = { method: req.method ?? 'GET', path: u.pathname, auth: (req.headers.authorization as string) ?? null,
      ctype: String(req.headers['content-type'] ?? ''), bytes: buf.length, body: buf.length < 200_000 ? buf.toString('utf8') : '', query: u.searchParams, headers: req.headers };
    calls.push(call);
    const send = (code: number, body: any, headers: Record<string, string> = {}) => {
      res.writeHead(code, { 'content-type': 'application/json', ...headers }); res.end(body == null ? '' : JSON.stringify(body));
    };
    const key = `${call.method} ${call.path}`;
    const flaky = state.flaky.get(key) ?? 0;
    if (flaky > 0) { state.flaky.set(key, flaky - 1); return send(503, { error: { message: 'temporarily unavailable' } }); }
    const tok = (call.auth ?? '').replace(/^Bearer /, '');
    if (tok && state.revoked.has(tok)) return send(401, { error: { message: 'Invalid Credentials' } });
    const form = () => new URLSearchParams(call.body);
    const json = () => { try { return JSON.parse(call.body || '{}'); } catch { return {}; } };
    const p = call.path;

    // ---------------- YouTube
    if (p === '/youtube/token/token') {
      const f = form();
      if (f.get('grant_type') === 'refresh_token') { state.refreshes++; return send(200, { access_token: `yt-at-r${state.refreshes}`, expires_in: 3600 }); }
      if (!f.get('code_verifier')) return send(400, { error: 'invalid_request', error_description: 'missing code_verifier' });
      return send(200, { access_token: 'yt-at-1', refresh_token: 'yt-rt-1', expires_in: 3600, scope: 'youtube.upload youtube.readonly' });
    }
    if (p === '/youtube/api/youtube/v3/channels') return send(200, { items: [{ id: 'UCvolt', snippet: { title: 'Volt Channel', thumbnails: { default: { url: 'https://img.example/yt.png' } } } }] });
    if (p === '/youtube/upload/upload/youtube/v3/videos' && call.method === 'POST') {
      const m = json();
      if (String(m.snippet?.title ?? '').includes(state.reject)) return send(400, { error: { message: 'The request metadata specifies an invalid video title.' } });
      if (call.query.get('uploadType') !== 'resumable') return send(400, { error: { message: 'expected resumable' } });
      return send(200, {}, { location: `${base}/youtube/upload/session/s1?size=${req.headers['x-upload-content-length']}` });
    }
    if (p === '/youtube/upload/session/s1' && call.method === 'PUT') {
      if (String(call.bytes) !== call.query.get('size')) return send(400, { error: { message: `got ${call.bytes} bytes, expected ${call.query.get('size')}` } });
      return send(200, { id: 'ytVID1' });
    }
    if (p === '/youtube/api/youtube/v3/videos' && call.method === 'GET') return send(200, { items: [{ statistics: { viewCount: '1234' } }] });
    if (p === '/youtube/api/youtube/v3/videos' && call.method === 'DELETE') return send(204, null);

    // ---------------- Facebook
    if (p === '/facebook/graph/v25.0/oauth/access_token') {
      if (call.query.get('grant_type') === 'fb_exchange_token') return send(200, { access_token: 'fb-long', token_type: 'bearer', expires_in: 5184000 });
      return send(200, { access_token: 'fb-short', expires_in: 3600 });
    }
    if (p === '/facebook/graph/v25.0/me/accounts') {
      if (tok !== 'fb-long') return send(400, { error: { message: 'expected the long-lived token' } });
      // Instagram through Facebook Login asks for the Page's Instagram account; only p1 has one.
      if ((call.query.get('fields') ?? '').includes('instagram_business_account')) {
        return send(200, { data: [{ id: 'p1', name: 'Volt News', access_token: 'fb-page-1', instagram_business_account: { id: '1790', username: 'voltnews.page', followers_count: 900 } },
          { id: 'p2', name: 'Volt Sport', access_token: 'fb-page-2' }] });
      }
      return send(200, { data: [{ id: 'p1', name: 'Volt News', access_token: 'fb-page-1' }, { id: 'p2', name: 'Volt Sport', access_token: 'fb-page-2' }] });
    }
    if (/^\/facebook\/video\/v25\.0\/p\d\/videos$/.test(p)) {
      if (!call.ctype.startsWith('multipart/form-data')) return send(400, { error: { message: 'expected multipart' } });
      if (call.body.includes(state.reject)) return send(400, { error: { message: '(#100) Invalid title' } });
      return send(200, { id: 'fbvid1' });
    }
    if (p === '/facebook/graph/v25.0/fbvid1/video_insights') return send(200, { data: [{ values: [{ value: 77 }] }] });

    // ---------------- X
    if (p === '/x/api/2/oauth2/token') {
      if (!String(call.auth).startsWith('Basic ')) return send(401, { error: 'unauthorized_client' });
      const f = form();
      if (f.get('grant_type') === 'refresh_token') { state.refreshes++; return send(200, { access_token: `x-at-r${state.refreshes}`, refresh_token: 'x-rt-2', expires_in: 7200 }); }
      if (!f.get('code_verifier')) return send(400, { error: 'invalid_request', error_description: 'Missing required parameter [code_verifier].' });
      return send(200, { access_token: 'x-at-1', refresh_token: 'x-rt-1', expires_in: 7200, scope: 'tweet.read tweet.write users.read media.write offline.access' });
    }
    if (p === '/x/api/2/users/me') return send(200, { data: { id: '42', username: 'voltnews', name: 'Volt News', profile_image_url: 'https://img.example/x.png' } });
    if (p === '/x/api/2/media/upload/initialize') return send(200, { data: { id: 'm1', expires_after_secs: 86400 } });
    if (p === '/x/api/2/media/upload/m1/append') return send(204, null);
    if (p === '/x/api/2/media/upload/m1/finalize') return send(200, { data: { id: 'm1', processing_info: { state: 'pending', check_after_secs: 0 } } });
    if (p === '/x/api/2/media/upload' && call.query.get('command') === 'STATUS') {
      state.xStatusPolls++;
      return send(200, { data: { id: 'm1', processing_info: { state: state.xStatusPolls < 2 ? 'in_progress' : 'succeeded' } } });
    }
    if (p === '/x/api/2/tweets' && call.method === 'POST') {
      const b = json();
      if ((b.text ?? '').length > 280) return send(400, { detail: 'text is too long' });
      if (!b.media?.media_ids?.includes('m1')) return send(400, { detail: 'media missing' });
      return send(201, { data: { id: 't99', text: b.text } });
    }
    if (p === '/x/api/2/tweets/t99') return send(200, { data: { id: 't99', public_metrics: { impression_count: 555 } } });

    // ---------------- TikTok
    if (p === '/tiktok/api/v2/oauth/token/') return send(200, { access_token: 'tt-at-1', refresh_token: 'tt-rt-1', expires_in: 86400, open_id: 'tt1', scope: 'user.info.basic,video.publish' });
    if (p === '/tiktok/api/v2/user/info/') return send(200, { data: { user: { open_id: 'tt1', username: 'voltnews', display_name: 'Volt News' } }, error: { code: 'ok' } });
    if (p === '/tiktok/api/v2/post/publish/creator_info/query/') return send(200, { data: { privacy_level_options: ['SELF_ONLY'] }, error: { code: 'ok' } });
    if (p === '/tiktok/api/v2/post/publish/video/init/') {
      const b = json();
      if (b.post_info?.privacy_level !== 'SELF_ONLY') return send(400, { error: { code: 'privacy_level_option_mismatch', message: 'unaudited client can only post to private accounts' } });
      return send(200, { data: { publish_id: 'pub1', upload_url: `${base}/tiktok/up/u1?size=${b.source_info?.video_size}&chunks=${b.source_info?.total_chunk_count}` }, error: { code: 'ok' } });
    }
    if (p === '/tiktok/up/u1' && call.method === 'PUT') {
      const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(String(req.headers['content-range'] ?? ''));
      if (!m || +m[2] - +m[1] + 1 !== call.bytes || m[3] !== call.query.get('size')) return send(400, { error: { message: `bad range ${req.headers['content-range']} for ${call.bytes} bytes` } });
      return send(+m[2] + 1 === +m[3] ? 201 : 206, null);
    }
    if (p === '/tiktok/api/v2/post/publish/status/fetch/') {
      state.ttStatusPolls++;
      return send(200, { data: state.ttStatusPolls < 2 ? { status: 'PROCESSING_UPLOAD' } : { status: 'PUBLISH_COMPLETE', publicaly_available_post_id: [7001] }, error: { code: 'ok' } });
    }
    if (p === '/tiktok/api/v2/video/query/') return send(200, { data: { videos: [{ id: '7001', view_count: 9 }] }, error: { code: 'ok' } });

    // ---------------- Dailymotion
    if (p === '/dailymotion/api/oauth/token') return send(200, { access_token: 'dm-at-1', refresh_token: 'dm-rt-1', expires_in: 36000, scope: 'manage_videos' });
    if (p === '/dailymotion/api/me') return send(200, { id: 'dm1', screenname: 'VoltDM', avatar_120_url: 'https://img.example/dm.png' });
    if (p === '/dailymotion/api/file/upload') return send(200, { upload_url: `${base}/dailymotion/up/x1`, progress_url: `${base}/dailymotion/up/p1` });
    if (p === '/dailymotion/up/x1') return call.ctype.startsWith('multipart/form-data') ? send(200, { url: 'https://upload.dailymotion.example/file123', name: 'video.mp4' }) : send(400, { error: 'multipart expected' });
    if (p === '/dailymotion/api/me/videos') {
      const f = form();
      if (f.get('url') !== 'https://upload.dailymotion.example/file123') return send(400, { error: { message: 'unknown upload url' } });
      return send(200, { id: 'xdm1', title: f.get('title') });
    }
    if (p === '/dailymotion/api/video/xdm1' && call.method === 'GET') return send(200, { views_total: 12 });
    if (p === '/dailymotion/api/video/xdm1' && call.method === 'DELETE') return send(200, {});

    // ---------------- Instagram (Instagram Login and Facebook Login share the graph routes)
    if (p === '/instagram/api/oauth/access_token' && call.method === 'POST') {
      const f = form();
      if (f.get('grant_type') !== 'authorization_code' || !f.get('client_secret')) return send(400, { error_type: 'OAuthException', error_message: 'bad grant' });
      return send(200, { data: [{ access_token: 'ig-short', user_id: '1789', permissions: 'instagram_business_basic,instagram_business_content_publish' }] });
    }
    if (p === '/instagram/graph/access_token') {
      if (call.query.get('grant_type') !== 'ig_exchange_token' || call.query.get('access_token') !== 'ig-short') return send(400, { error: { message: 'expected the short token' } });
      return send(200, { access_token: 'ig-long', token_type: 'bearer', expires_in: 5184000 });
    }
    if (p === '/instagram/graph/refresh_access_token') {
      state.igRefreshes++;
      return send(200, { access_token: `ig-long-r${state.igRefreshes}`, token_type: 'bearer', expires_in: 5184000 });
    }
    if (p === '/instagram/graph/v25.0/me') {
      if (!tok.startsWith('ig-long')) return send(400, { error: { message: 'expected the long-lived token' } });
      return send(200, { id: 'scoped-1', user_id: '1789', username: 'voltnews', profile_picture_url: 'https://img.example/ig.png', followers_count: 4200, account_type: state.igPersonal ? 'PERSONAL' : 'BUSINESS' });
    }
    const up = /^\/instagram\/rupload\/ig-api-upload\/v25\.0\/(c\d+)$/.exec(p);
    if (up && call.method === 'POST') {
      const c = state.igContainer.get(up[1]);
      if (!c) return send(404, { debug_info: { message: 'no container' } });
      if (!String(call.auth).startsWith('OAuth ')) return send(401, { debug_info: { message: 'expected OAuth authorization' } });
      if (req.headers.offset !== '0' || String(call.bytes) !== String(req.headers.file_size)) return send(400, { debug_info: { message: `got ${call.bytes} bytes, file_size ${req.headers.file_size}, offset ${req.headers.offset}` } });
      c.uploaded = true;
      return send(200, { success: true, message: 'Upload successful.' });
    }
    const ig = /^\/(instagram|facebook)\/graph\/v25\.0\/(.+)$/.exec(p);
    if (ig) {
      const rest = ig[2];
      let m: RegExpExecArray | null;
      if ((m = /^(\d+)\/media$/.exec(rest)) && call.method === 'POST') {
        const f = form();
        const caption = f.get('caption') ?? '';
        if (caption.includes(state.reject)) return send(400, { error: { message: '(#100) The caption was rejected', code: 100 } });
        if (caption.length > 2200) return send(400, { error: { message: '(#100) caption too long' } });
        const id = `c${++state.igContainers}`;
        if (f.get('media_type') === 'REELS') {
          if (f.get('upload_type') !== 'resumable') return send(400, { error: { message: 'expected a resumable upload' } });
          state.igContainer.set(id, { kind: 'video', ig: m[1], uploaded: false, polls: 0, fail: caption.includes('IGERROR'), published: null, imageUrl: null, caption });
          return send(200, { id, uri: `${base}/instagram/rupload/ig-api-upload/v25.0/${id}` });
        }
        const url = f.get('image_url');
        if (!url) return send(400, { error: { message: 'image_url or media_type is required' } });
        state.igContainer.set(id, { kind: 'image', ig: m[1], uploaded: true, polls: 0, fail: caption.includes('IGERROR'), published: null, imageUrl: url, caption });
        return send(200, { id });
      }
      if ((m = /^(\d+)\/media_publish$/.exec(rest)) && call.method === 'POST') {
        const id = form().get('creation_id') ?? '';
        const c = state.igContainer.get(id);
        if (!c || c.ig !== m[1]) return send(400, { error: { message: 'unknown creation_id' } });
        if (!c.uploaded || c.fail || c.polls < 2) return send(400, { error: { message: 'Media ID is not available', code: 9007 } });
        c.published = `m${id}`;
        state.igQuotaUsed++;
        return send(200, { id: c.published });
      }
      if ((m = /^(\d+)\/content_publishing_limit$/.exec(rest))) return send(200, { data: [{ quota_usage: state.igQuotaUsed, config: { quota_total: 100, quota_duration: 86400 } }] });
      if ((m = /^(mc\d+)\/insights$/.exec(rest))) return call.query.get('metric') === 'views' ? send(200, { data: [{ name: 'views', period: 'lifetime', values: [{ value: 640 }] }] }) : send(400, { error: { message: 'metric' } });
      if ((m = /^(c\d+)$/.exec(rest))) {
        const c = state.igContainer.get(m[1]);
        if (!c) return send(400, { error: { message: 'unknown container' } });
        if (c.published) return send(200, { id: c.published, status_code: 'PUBLISHED', status: 'Published' });
        if (!c.uploaded) return send(200, { id: m[1], status_code: 'IN_PROGRESS', status: 'Waiting for the upload' });
        c.polls++;
        if (c.fail) return send(200, { id: m[1], status_code: 'ERROR', status: 'Error: 2207026 The video format is not supported.' });
        return send(200, { id: m[1], status_code: c.polls < 2 ? 'IN_PROGRESS' : 'FINISHED', status: c.polls < 2 ? 'In progress' : 'Finished' });
      }
      if ((m = /^(mc\d+)$/.exec(rest))) {
        const fields = call.query.get('fields') ?? '';
        if (fields.includes('permalink')) return send(200, { id: m[1], permalink: `https://www.instagram.com/reel/${m[1]}/` });
        if (fields.includes('like_count')) return send(200, { id: m[1], like_count: 31 });
      }
      if ((m = /^(\d+)$/.exec(rest)) && (call.query.get('fields') ?? '').includes('followers_count')) return send(200, { id: m[1], followers_count: m[1] === '1789' ? 4321 : 950 });
    }


    // ---------------- Threads (graph.threads.net, v1.0)
    if (p === '/threads/graph/oauth/access_token' && call.method === 'POST') {
      const f = form();
      if (f.get('grant_type') !== 'authorization_code' || !f.get('client_secret') || !f.get('code')) return send(400, { error: { message: 'bad grant', type: 'OAuthException' } });
      return send(200, { access_token: 'th-short', user_id: '7001' });
    }
    if (p === '/threads/graph/access_token') {
      if (call.query.get('grant_type') !== 'th_exchange_token' || call.query.get('access_token') !== 'th-short' || !call.query.get('client_secret')) return send(400, { error: { message: 'expected the short token' } });
      return send(200, { access_token: 'th-long', token_type: 'bearer', expires_in: 5184000 });
    }
    if (p === '/threads/graph/refresh_access_token') {
      if (call.query.get('grant_type') !== 'th_refresh_token') return send(400, { error: { message: 'expected th_refresh_token' } });
      state.thRefreshes++;
      return send(200, { access_token: `th-long-r${state.thRefreshes}`, token_type: 'bearer', expires_in: 5184000 });
    }
    const th = /^\/threads\/graph\/v1\.0\/(.+)$/.exec(p);
    if (th) {
      if (!tok.startsWith('th-long')) return send(400, { error: { message: 'expected the long-lived token', code: 190 } });
      const rest = th[1];
      let m: RegExpExecArray | null;
      if (rest === 'me') return send(200, { id: '7001', username: 'voltnews', threads_profile_picture_url: 'https://img.example/th.png' });
      if ((m = /^(\d+)\/threads_insights$/.exec(rest))) {
        return call.query.get('metric') === 'followers_count' ? send(200, { data: [{ name: 'followers_count', period: 'day', title: 'followers_count', total_value: { value: 880 } }] }) : send(400, { error: { message: 'metric' } });
      }
      if ((m = /^(\d+)\/threads_publishing_limit$/.exec(rest))) return send(200, { data: [{ quota_usage: state.thQuotaUsed, config: { quota_total: 250, quota_duration: 86400 } }] });
      if ((m = /^(\d+)\/threads$/.exec(rest)) && call.method === 'POST') {
        const f = form();
        const text = f.get('text') ?? '';
        const kind = (f.get('media_type') ?? '') as 'VIDEO' | 'IMAGE' | 'TEXT';
        if (text.includes(state.reject)) return send(400, { error: { message: 'The text was rejected', code: 100 } });
        if (text.length > 500) return send(400, { error: { message: 'Text is too long: at most 500 characters' } });
        if ((text.match(/(^|\s)#[^\s#]+/g) ?? []).length > 1) return send(400, { error: { message: 'Only one tag is allowed per post' } });
        const url = kind === 'VIDEO' ? f.get('video_url') : kind === 'IMAGE' ? f.get('image_url') : null;
        if (kind !== 'TEXT' && !url) return send(400, { error: { message: `${kind === 'VIDEO' ? 'video_url' : 'image_url'} is required` } });
        const id = `t${++state.thContainers}`;
        let fail: string | null = text.includes('THERROR') ? 'Media processing failed: the video is in an unsupported format.' : null;
        // Threads fetches the media itself. The fake does too (Volt's public
        // address swapped for the test server), so a bad link fails as it would.
        if (url && state.thFetch) {
          const target = state.thFetchBase ? url.replace(/^https:\/\/volt\.example/, state.thFetchBase) : url;
          try {
            const r = await fetch(target);
            const b = Buffer.from(await r.arrayBuffer());
            state.thFetched.push({ url, status: r.status, bytes: b.length, ctype: r.headers.get('content-type') ?? '' });
            if (r.status !== 200) fail = fail ?? `Media download has failed. The media URI doesn't meet our requirements (HTTP ${r.status}).`;
          } catch (e: any) { state.thFetched.push({ url, status: 0, bytes: 0, ctype: '' }); fail = fail ?? `Media download has failed (${e?.message ?? e}).`; }
        }
        state.thContainer.set(id, { kind, user: m[1], polls: 0, fail, published: null, url, text });
        return send(200, { id });
      }
      if ((m = /^(\d+)\/threads_publish$/.exec(rest)) && call.method === 'POST') {
        const id = form().get('creation_id') ?? '';
        const c = state.thContainer.get(id);
        if (!c || c.user !== m[1]) return send(400, { error: { message: 'unknown creation_id' } });
        if (c.fail || c.polls < 2) return send(400, { error: { message: 'The media is not ready to be published', code: 24 } });
        c.published = `p${id}`;
        state.thQuotaUsed++;
        return send(200, { id: c.published });
      }
      if ((m = /^(t\d+)$/.exec(rest))) {
        const c = state.thContainer.get(m[1]);
        if (!c) return send(400, { error: { message: 'unknown container' } });
        if (c.published) return send(200, { id: c.published, status: 'PUBLISHED' });
        c.polls++;
        if (c.fail) return send(200, { id: m[1], status: 'ERROR', error_message: c.fail });
        return send(200, { id: m[1], status: c.polls < 2 ? 'IN_PROGRESS' : 'FINISHED' });
      }
      if ((m = /^(pt\d+)\/insights$/.exec(rest))) {
        const metrics = (call.query.get('metric') ?? '').split(',');
        return send(200, { data: metrics.map((n) => ({ name: n, period: 'lifetime', values: [{ value: n === 'views' ? 410 : n === 'likes' ? 22 : 0 }] })) });
      }
      if ((m = /^(pt\d+)$/.exec(rest)) && (call.query.get('fields') ?? '').includes('permalink')) return send(200, { id: m[1], permalink: `https://www.threads.net/@voltnews/post/${m[1]}` });
    }

    send(404, { error: { message: `fake: no route ${call.method} ${p}` } });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(srv.address() as any).port}`;
  return { base, calls, state, close: () => srv.close(), routes: () => calls.map((c) => `${c.method} ${c.path}`) };
}

export type FakeSocial = Awaited<ReturnType<typeof startFakeSocial>>;
export type { IncomingMessage };
