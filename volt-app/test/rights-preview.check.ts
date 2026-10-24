// ============================================================================
//  RIGHTS PREVIEW (services/rightsPreview.ts, build queue 1.14c).
//
//  1. The question: country, rights class and time are validated; the play
//     token is signed, tied to one stream and expires.
//  2. Parity: explainDecision() (the preview's "why") gives the same decision
//     as the CloudFront Function itself over a randomised rule table.
//  3. With Postgres and real HTTP through createServer(): channel and event
//     routes, tenancy (another account and an unknown id get 404), each
//     answer (replace with its variant and programme, allow, the channel's
//     own block, a blackout, an exempt rights class, another time), the
//     edge function deciding the same for every moment of every strip row,
//     and the admin-only play path: the AU variant has the loop, MY the
//     normal stream, before the channel is on air, refusing without a valid
//     token, and the origin's files untouched.
//    DATABASE_URL=... npx tsx test/rights-preview.check.ts
// ============================================================================
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const ORIGIN = mkdtempSync(join(tmpdir(), 'volt-rights-preview-'));
process.env.ORIGIN_DIR = ORIGIN;

let pass = 0, fail = 0;
const check = (m: string, got: unknown, want: unknown) => {
  const g = typeof got === 'object' ? JSON.stringify(got) : got, w = typeof want === 'object' ? JSON.stringify(want) : want;
  if (g === w) { console.log('PASS ' + m); pass++ } else { console.log(`FAIL ${m} -- expected [${String(w)}] got [${String(g)}]`); fail++ }
};
const iso = (s: number) => new Date(s * 1000).toISOString();

/** A delivered media playlist the way playout.py writes it. */
function mediaPlaylist(o: { t0: number; first: number; count: number; init: string; dir: string }) {
  const L = ['#EXTM3U', '#EXT-X-VERSION:6', '#EXT-X-TARGETDURATION:4', `#EXT-X-MEDIA-SEQUENCE:${o.first}`, '#EXT-X-DISCONTINUITY-SEQUENCE:0', `#EXT-X-MAP:URI="${o.init}"`];
  for (let i = 0; i < o.count; i++) {
    const n = o.first + i;
    L.push(`#EXT-X-PROGRAM-DATE-TIME:${iso(o.t0 + n * 4)}`, '#EXTINF:4.000,', `${o.dir}/seg_${n + 1}.m4s`);
  }
  return L.join('\n') + '\n';
}
const MASTER = '#EXTM3U\n#EXT-X-INDEPENDENT-SEGMENTS\n#EXT-X-MEDIA:TYPE=AUDIO,URI="stream_0_cc.m3u8",GROUP-ID="audio",NAME="A"\n#EXT-X-STREAM-INF:BANDWIDTH=1,AUDIO="audio"\nstream_1_cc.m3u8\n';
const loopTrack = (label: string, n = 5) => ({ kind: label === 'audio' ? 'audio' : 'video', init: `${label}/init.mp4`, segments: Array.from({ length: n }, (_, k) => ({ uri: `${label}/seg_${k + 1}.m4s`, dur: 4 })) });

(async () => {
  const rp = await import('../src/services/rightsPreview');
  const er = await import('../src/services/edgeRights');

  // ---- 1. the question and the token ------------------------------------------------------------
  const NOW = Math.floor(Date.now() / 1000);
  check('query: AU, premium, an ISO time', rp.parsePreviewQuery({ country: 'au', rightsClass: 'Premium', at: iso(NOW + 60) }, NOW), { cc: 'AU', rc: 'premium', atSec: NOW + 60 });
  check('query: XX and empty both mean a country the CDN cannot tell; now is null', [rp.parsePreviewQuery({ country: 'XX' }, NOW), rp.parsePreviewQuery({ at: 'now' }, NOW)], [{ cc: '', rc: '', atSec: null }, { cc: '', rc: '', atSec: null }]);
  check('query: epoch seconds work too', (rp.parsePreviewQuery({ country: 'NZ', at: String(NOW + 5) }, NOW) as any).atSec, NOW + 5);
  check('query: nonsense is refused, never defaulted', ['AUS', 'A1'].map((c) => 'error' in (rp.parsePreviewQuery({ country: c }, NOW) as any)).concat(
    'error' in (rp.parsePreviewQuery({ rightsClass: 'gold tier' }, NOW) as any), 'error' in (rp.parsePreviewQuery({ at: 'tomorrowish' }, NOW) as any),
    'error' in (rp.parsePreviewQuery({ at: iso(NOW + 60 * 86400) }, NOW) as any)), [true, true, true, true, true]);
  const S1 = '11111111-1111-1111-1111-111111111111', S2 = '22222222-2222-2222-2222-222222222222';
  const tok = rp.mintPreviewPlayToken({ a: 'acct', k: 'channel', s: S1, c: 'AU', r: '', t: 0 });
  check('token: read back for its stream', rp.readPreviewPlayToken(tok, S1)?.c, 'AU');
  check('...not for another stream', rp.readPreviewPlayToken(tok, S2), null);
  const [b, sig] = tok.split('.');
  const reaimed = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(b, 'base64url').toString()), c: 'MY' })).toString('base64url') + '.' + sig;
  check('...a token re-aimed at another country is refused', rp.readPreviewPlayToken(reaimed, S1), null);
  check('...an expired one too', rp.readPreviewPlayToken(rp.mintPreviewPlayToken({ a: 'acct', k: 'channel', s: S1, c: 'AU', r: '', t: 0 }, -1), S1), null);
  check('...and none at all', [rp.readPreviewPlayToken('', S1), rp.readPreviewPlayToken(undefined, S1), rp.readPreviewPlayToken('x.y', S1)], [null, null, null]);

  // ---- 2. parity of the preview's "why" with the CloudFront Function ----------------------------
  const src = readFileSync(join(__dirname, '../../deploy/edge/rights-viewer-request.js'), 'utf8');
  (globalThis as any).__cf = { kvs: () => ({ async get() { throw new Error('not used'); } }) };
  (globalThis as any).__crypto = await import('node:crypto');
  const body = src.replace("import cf from 'cloudfront';", 'const cf = globalThis.__cf;').replace("import crypto from 'crypto';", 'const crypto = globalThis.__crypto;').replace('${kvs_id}', 'kvs-test');
  const edge = new Function(`${body}\nreturn { handler, edgeDecision, claimClass };`)();
  let seed = 7;
  const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const CC = ['AU', 'NZ', 'FJ', 'MY', 'CN', 'US'], RC = ['', 'gold', 'premium'];
  const sub = () => CC.filter(() => rnd(3) === 0);
  let agree = 0, cases = 0;
  for (let r = 0; r < 300; r++) {
    const rules: any = { v: 1, vs: 1, vm: { '*': 'vaaaaaaaa' } };
    if (rnd(4) === 0) rules.a = [rnd(2) ? 'a' : 'b', sub()];
    if (rnd(4) === 0) rules.c = [rnd(2) ? 'a' : 'b', sub()];
    rules.w = Array.from({ length: rnd(5) }, () => {
      const from = rnd(10) * 600, w: any[] = [from, from + (1 + rnd(6)) * 600, rnd(2) ? 'a' : 'b', sub(), rnd(2)];
      if (rnd(2)) w.push(RC.slice(1).filter(() => rnd(2) === 0));
      return w;
    });
    for (const cc of ['', ...CC]) for (const rc of RC) for (let t = -300; t < 9000; t += 300) {
      cases++;
      const mine = er.explainDecision(rules, cc, rc, t);
      const theirs = edge.edgeDecision(rules, cc, rc, t);
      const ok = (mine.decision === 'replace' ? 'replace:vaaaaaaaa' : mine.decision) === theirs
        && mine.decision === er.decideFor(rules, cc, rc, t)
        && (mine.layer !== 'window' || (rules.w[mine.index][0] <= t && t < rules.w[mine.index][1]));
      if (ok) agree++; else if (cases - agree < 4) console.log('  differs', JSON.stringify(rules), cc, rc, t, mine, theirs);
    }
  }
  check(`explainDecision() and the edge function decide the same in all ${cases} randomised cases`, agree, cases);

  // ---- 3. Postgres and real HTTP ----------------------------------------------------------------
  if (!process.env.DATABASE_URL) {
    console.log('PASS skipped the database part: set DATABASE_URL');
    console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
  }
  process.env.TRUST_EDGE_GEO = '1';
  const { createServer } = await import('../src/server');
  const { pool, one, query } = await import('../src/db');
  const { signAccess } = await import('../src/auth/jwt');
  const tag = Date.now().toString(36);
  const acct = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`rp-${tag}`]))!.id;
  const other = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`rp-o-${tag}`]))!.id;
  const mkUser = async (a: string, email: string) =>
    (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [a, email]))!.id;
  const owner = await mkUser(acct, `rp-${tag}@volt.test`), otherOwner = await mkUser(other, `rp-o-${tag}@volt.test`);
  const g = (await one<any>(`INSERT INTO groups(account_id, name) VALUES ($1,'Sport') RETURNING id`, [acct]))!.id;
  const ch = (await one<any>(`INSERT INTO channels(group_id, name, geo_mode, geo_countries) VALUES ($1,'RP Sport','block',ARRAY['CN']) RETURNING id`, [g]))!.id;
  const now = Math.floor(Date.now() / 1000);
  const ev = (await one<any>(`INSERT INTO events(group_id, name, status, scheduled_start, scheduled_end) VALUES ($1,'RP Final','scheduled',to_timestamp($2),to_timestamp($3)) RETURNING id`, [g, now - 600, now + 7200]))!.id;
  // AU replaced now for ten minutes; FJ blacked out at the same time; NZ replaced from 20 to 30
  // minutes on; AU again from an hour on, with premium exempt.
  await query(`INSERT INTO programmes(channel_id, title, starts_at, ends_at, geo_mode, geo_countries, replacement_kind, replacement_ref, metadata)
               VALUES ($1,'Match AU',to_timestamp($2),to_timestamp($3),'block',ARRAY['AU'],'loop','filler-1','{}'),
                      ($1,'Match FJ',to_timestamp($2),to_timestamp($3),'block',ARRAY['FJ'],'none',NULL,'{}'),
                      ($1,'Match NZ',to_timestamp($4),to_timestamp($5),'block',ARRAY['NZ'],'loop','filler-1','{}'),
                      ($1,'Late AU',to_timestamp($6),to_timestamp($7),'block',ARRAY['AU'],'loop','filler-1','{"rights_exempt":["premium"]}')`,
  [ch, now - 60, now + 600, now + 1200, now + 1800, now + 3600, now + 5400]);
  await query(`INSERT INTO programmes(event_id, title, starts_at, ends_at, geo_mode, geo_countries, replacement_kind, replacement_ref)
               VALUES ($1,'Final AU',to_timestamp($2),to_timestamp($3),'block',ARRAY['AU'],'loop','f')`, [ev, now - 60, now + 900]);
  // the channel's delivered output, as the encoder leaves it (the channel is NOT on air)
  const run = join(ORIGIN, ch, 'runs', '20261023T000000Z');
  mkdirSync(join(run, 'filler'), { recursive: true });
  writeFileSync(join(ORIGIN, ch, 'current_run.txt'), '20261023T000000Z');
  const t0 = now - 160;
  writeFileSync(join(run, 'master_cc.m3u8'), MASTER);
  writeFileSync(join(run, 'stream_0_cc.m3u8'), mediaPlaylist({ t0, first: 0, count: 40, init: 'audio/init.mp4', dir: 'audio' }));
  writeFileSync(join(run, 'stream_1_cc.m3u8'), mediaPlaylist({ t0, first: 0, count: 40, init: '720p/init.mp4', dir: '720p' }));
  writeFileSync(join(run, 'filler', 'filler.json'), JSON.stringify({ hash: 'h', segment_seconds: 4, loop_seconds: 20, tracks: { '720p': loopTrack('720p'), audio: loopTrack('audio') } }));
  const snapshot = () => {
    const h = createHash('sha256');
    const walk = (d: string) => { for (const f of readdirSync(d).sort()) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else h.update(p).update(readFileSync(p)); } };
    walk(ORIGIN); return h.digest('hex');
  };
  const before = snapshot();

  const app: any = createServer();
  const srv = app.listen(0); const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const T = (u: string, a: string) => signAccess({ sub: u, account_id: a, role: 'owner' });
  const get = async (path: string, tok: string | null = T(owner, acct)) => {
    const res = await fetch(base + path, { headers: tok ? { authorization: `Bearer ${tok}` } : {}, redirect: 'manual' });
    const text = await res.text();
    let j: any = null; try { j = JSON.parse(text); } catch { /* a playlist */ }
    return { s: res.status, text, j, variant: res.headers.get('x-volt-variant'), rights: res.headers.get('x-volt-rights'), cache: res.headers.get('cache-control') ?? '' };
  };
  const P = (q: string, kind = 'channels', id = ch) => get(`/api/${kind}/${id}/rights-preview${q}`);
  try {
    const st = await er.loadEdgeState('channel', ch, now);
    const kAU = st.rules!.vm!.AU;

    let r = await P('?country=AU');
    check('AU now: replaced, with the variant the edge maps AU to', [r.s, r.j?.decision, r.j?.variant, r.j?.edge], [200, 'replace', kAU, `replace:${kAU}`]);
    check('...the rule: the programme that replaces it, its window and list', [r.j?.rule?.layer, r.j?.rule?.programme?.title, r.j?.rule?.programme?.countries, r.j?.rule?.programme?.mode, r.j?.rule?.programme?.replacement?.kind],
      ['window', 'Match AU', ['AU'], 'block', 'loop']);
    check('...why, in words', r.j?.rule?.reason, '"Match AU" is replaced for AU: its block list names AU.');
    check('...until the window ends; the loop is built', [r.j?.until, r.j?.loopReady], [iso(now + 600), true]);
    check('...an admin-only play address for exactly that variant', [r.j?.play?.hls?.startsWith(`/origin/${ch}/v/${kAU}/master.m3u8?pt=`), r.j?.play?.dash?.includes(`/v/${kAU}/manifest.mpd?pt=`)], [true, true]);
    const auPlay = r.j.play.hls as string;
    check('...the guide times with rules, for the time picker', r.j?.windows?.map((w: any) => w.title).sort(), ['Late AU', 'Match AU', 'Match FJ', 'Match NZ']);

    r = await P('?country=MY');
    check('MY now: normal, no variant, no rule, played through the same path', [r.j?.decision, r.j?.variant, r.j?.edge, r.j?.rule?.layer, r.j?.until, r.j?.play?.hls?.includes('/v/v00000000/master.m3u8?pt=')],
      ['allow', null, 'allow', 'none', null, true]);
    const myPlay = r.j.play.hls as string;
    r = await P('?country=CN');
    check("CN: blocked by the channel's own list, nothing to play", [r.j?.decision, r.j?.rule?.layer, r.j?.rule?.reason, r.j?.play], ['block', 'channel', "The channel's own block list names CN.", null]);
    r = await P('?country=FJ');
    check('FJ: blacked out by its programme, nothing to play', [r.j?.decision, r.j?.rule?.layer, r.j?.rule?.programme?.title, r.j?.rule?.programme?.replacement, r.j?.play], ['block', 'window', 'Match FJ', null, null]);
    r = await P('?country=XX');
    check('a country the CDN cannot tell: normal (the lists here are block lists)', [r.j?.country, r.j?.decision], ['XX', 'allow']);
    r = await P(`?country=NZ&at=${encodeURIComponent(iso(now + 1500))}`);
    const kNZ = (await er.loadEdgeState('channel', ch, now + 1500)).rules!.vm!.NZ;
    check('NZ at a guide time 25 minutes on: replaced with its own variant', [r.j?.decision, r.j?.variant, r.j?.atIsNow, r.j?.at], ['replace', kNZ, false, iso(now + 1500)]);
    const nzPlay = r.j.play.hls as string;
    r = await P(`?country=AU&at=${encodeURIComponent(iso(now + 1500))}`);
    check('...AU at that time: normal again', r.j?.decision, 'allow');
    r = await P(`?country=AU&rightsClass=premium&at=${now + 4000}`);
    check('AU premium in the late window: normal, the class is exempt', [r.j?.decision, r.j?.rule?.layer], ['allow', 'none']);
    r = await P(`?country=AU&at=${now + 4000}`);
    check('...AU without the class: replaced, and the reason names the exemption', [r.j?.decision, r.j?.rule?.programme?.title, r.j?.rule?.programme?.exemptRightsClasses, /premium is exempt/.test(r.j?.rule?.reason ?? '')],
      ['replace', 'Late AU', ['premium'], true]);

    // the strip
    r = await P('?country=AU');
    const rows = new Map<string, any>((r.j?.strip?.rows ?? []).map((x: any) => [x.audience, x]));
    check('strip: one row per audience the rules name', [...rows.keys()], ['*', '*/premium', 'AU', 'AU/premium', 'CN', 'CN/premium', 'FJ', 'FJ/premium', 'NZ', 'NZ/premium']);
    const seq = (a: string) => rows.get(a)?.segments.map((x: any) => x.decision);
    check('...AU: replaced, normal, replaced (late window), normal', seq('AU'), ['replace', 'allow', 'replace', 'allow']);
    check('...AU premium: the late window does not apply', seq('AU/premium'), ['replace', 'allow']);
    check('...NZ: normal, replaced 20 to 30 minutes on, normal', [seq('NZ'), rows.get('NZ')?.segments[1]?.from, rows.get('NZ')?.segments[1]?.to], [['allow', 'replace', 'allow'], iso(now + 1200), iso(now + 1800)]);
    check('...CN: blocked all day; FJ: blocked, then normal', [seq('CN'), seq('FJ')], [['block'], ['block', 'allow']]);
    check('...the row asked about is marked, and the strip spans 24 hours', [rows.get('AU')?.asked, r.j?.strip?.from, r.j?.strip?.to], [true, iso(now), iso(now + 86400)]);
    // every moment of every row decided as the edge function decides it
    let sAgree = 0, sCases = 0;
    for (const row of r.j.strip.rows) for (const sg of row.segments) {
      const t = Math.floor((Date.parse(sg.from) + Date.parse(sg.to)) / 2000);
      const rules = await er.loadEdgeRules('channel', ch, t);
      const e = edge.edgeDecision(rules, row.country, row.rightsClass, t);
      sCases++;
      if (e === (sg.decision === 'replace' ? `replace:${sg.variant}` : sg.decision)) sAgree++;
      else console.log('  strip differs', row.audience, sg, e);
    }
    check(`...the edge function agrees on all ${sCases} strip pieces`, sAgree, sCases);

    // the event route
    r = await P('?country=AU', 'events', ev);
    check('event: AU replaced by its programme, with a play address', [r.s, r.j?.kind, r.j?.decision, r.j?.rule?.programme?.title, !!r.j?.play?.hls], [200, 'event', 'replace', 'Final AU', true]);
    r = await P('?country=MY', 'events', ev);
    check('...MY normal', r.j?.decision, 'allow');

    // tenancy and validation
    const theirs = T(otherOwner, other);
    check('another account: 404 for the channel and the event', [(await get(`/api/channels/${ch}/rights-preview?country=AU`, theirs)).s, (await get(`/api/events/${ev}/rights-preview?country=AU`, theirs)).s], [404, 404]);
    check('an unknown id: 404', (await P('?country=AU', 'channels', '99999999-9999-9999-9999-999999999999')).s, 404);
    check('no session: 401', (await get(`/api/channels/${ch}/rights-preview?country=AU`, null)).s, 401);
    check('a bad country, class or time: 400', [(await P('?country=AUS')).s, (await P('?country=AU&rightsClass=Gold%20Tier')).s, (await P('?country=AU&at=soon')).s], [400, 400, 400]);

    // the admin-only play path
    let x = await get(auPlay, null);
    check('play: the AU variant master, off air, its playlists carrying the token', [x.s, x.variant, x.text.includes('\nstream_1_cc.m3u8?pt='), /no-store/.test(x.cache)], [200, kAU, true, true]);
    const pt = auPlay.split('?')[1];
    x = await get(`/origin/${ch}/v/${kAU}/stream_1_cc.m3u8?${pt}`, null);
    const fillerSegs = x.text.split('\n').filter((l) => l.includes('/filler/') && !l.startsWith('#'));
    check('...the AU media playlist plays the loop inside the window', [x.s, fillerSegs.length > 0, fillerSegs[0]?.startsWith(`/origin/${ch}/live/filler/720p/seg_`)], [200, true, true]);
    const auPublic = await get(`/live/${ch}/v/${kAU}/stream_1_cc.m3u8?as=AU`, null);
    check('...the public variant path still waits for air (404), the preview does not', auPublic.s, 404);
    await query(`UPDATE channels SET on_air = true, status = 'live' WHERE id = $1`, [ch]);
    (await import('../src/scale/cache')).invalidateTag(`asset:${ch}`);
    const pub = await get(`/live/${ch}/v/${kAU}/stream_1_cc.m3u8?as=AU`, null);
    check('...on air, the preview is byte for byte what the AU viewer gets', [pub.s, pub.text === x.text], [200, true]);
    const mpt = myPlay.split('?')[1];
    x = await get(`/origin/${ch}/v/v00000000/stream_1_cc.m3u8?${mpt}`, null);
    check('...MY: the normal stream through the same path', [x.s, x.variant, x.text.includes('/filler/'), x.text.includes('720p/seg_')], [200, 'none', false, true]);
    x = await get(`/origin/${ch}/v/${kNZ}/stream_1_cc.m3u8?${nzPlay.split('?')[1]}`, null);
    check('...NZ at 25 minutes on: its window, the loop (the guide time carried by the token)', [x.s, x.variant, x.text.includes('/filler/')], [200, kNZ, true]);
    x = await get(`/origin/${ch}/v/${kAU}/stream_1_cc.m3u8?${pt}&as=MY&at=${encodeURIComponent(iso(now + 99999))}`, null);
    check('...the stand-ins cannot re-aim a token', [x.s, x.variant], [200, kAU]);
    x = await get(`/origin/${ch}/v/${kAU}/stream_1_cc.m3u8`, null);
    check('...no token: 401', [x.s, x.j?.reason], [401, 'preview_token']);
    x = await get(`/origin/${ev}/v/${kAU}/stream_1_cc.m3u8?${pt}`, null);
    check('...the channel token on the event: 401', x.s, 401);
    x = await get(`/origin/${ch}/v/${kAU}/stream_1_cc.m3u8?pt=${encodeURIComponent(reaimed)}`, null);
    check('...a forged token: 401', x.s, 401);
    await query(`UPDATE groups SET account_id = $1 WHERE id = $2`, [other, g]);
    x = await get(`/origin/${ch}/v/${kAU}/stream_1_cc.m3u8?${pt}`, null);
    check('...a stream that moved to another account: 404 with the old token', x.s, 404);
    await query(`UPDATE groups SET account_id = $1 WHERE id = $2`, [acct, g]);
    x = await get(`/origin/${ch}/v/${kAU}/empty.vtt`, null);
    check('...the empty subtitle file needs no token', [x.s, x.text], [200, 'WEBVTT\n\n']);
    check("the origin's own files are byte-identical afterwards", snapshot(), before);
  } finally {
    srv.close();
    await pool.end();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
