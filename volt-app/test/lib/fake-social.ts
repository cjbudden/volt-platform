// ============================================================================
//  A local stand-in for YouTube, Facebook, X, TikTok and Dailymotion, for the
//  social publishing checks. Mounted at SOCIAL_TEST_BASE: every platform host
//  becomes <base>/<platform>/<host key>, as services/social/platforms.ts maps
//  it. It answers the request sequences the adapters make, checks the parts
//  that matter (bearer tokens, PKCE verifier, byte counts, chunk ranges, post
//  text limits) and records every call so a test can assert the order.
//
//  Knobs on the returned object: `reject` (a title containing it gets a 400),
//  `revoked` (that bearer token gets a 401), `flaky` (the next N calls of a
//  given route answer 503).
// ============================================================================
import { createServer, type IncomingMessage } from 'node:http';

export interface FakeCall { method: string; path: string; auth: string | null; ctype: string; bytes: number; body: string; query: URLSearchParams; headers: Record<string, any> }

export async function startFakeSocial() {
  const calls: FakeCall[] = [];
  const state = {
    reject: 'REJECT', revoked: new Set<string>(), flaky: new Map<string, number>(),
    xStatusPolls: 0, ttStatusPolls: 0, refreshes: 0,
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
    if (p === '/facebook/graph/v21.0/oauth/access_token') {
      if (call.query.get('grant_type') === 'fb_exchange_token') return send(200, { access_token: 'fb-long', token_type: 'bearer', expires_in: 5184000 });
      return send(200, { access_token: 'fb-short', expires_in: 3600 });
    }
    if (p === '/facebook/graph/v21.0/me/accounts') {
      if (tok !== 'fb-long') return send(400, { error: { message: 'expected the long-lived token' } });
      return send(200, { data: [{ id: 'p1', name: 'Volt News', access_token: 'fb-page-1' }, { id: 'p2', name: 'Volt Sport', access_token: 'fb-page-2' }] });
    }
    if (/^\/facebook\/video\/v21\.0\/p\d\/videos$/.test(p)) {
      if (!call.ctype.startsWith('multipart/form-data')) return send(400, { error: { message: 'expected multipart' } });
      if (call.body.includes(state.reject)) return send(400, { error: { message: '(#100) Invalid title' } });
      return send(200, { id: 'fbvid1' });
    }
    if (p === '/facebook/graph/v21.0/fbvid1/video_insights') return send(200, { data: [{ values: [{ value: 77 }] }] });

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

    send(404, { error: { message: `fake: no route ${call.method} ${p}` } });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(srv.address() as any).port}`;
  return { base, calls, state, close: () => srv.close(), routes: () => calls.map((c) => `${c.method} ${c.path}`) };
}

export type FakeSocial = Awaited<ReturnType<typeof startFakeSocial>>;
export type { IncomingMessage };
