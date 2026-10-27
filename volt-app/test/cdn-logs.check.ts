// ============================================================================
//  CDN EDGE LOGS INTO REPORTING (build queue 2.9, QOE_REPORTING.md 3, 5, 9).
//
//    1. Terraform and the code agree: the fields CloudFront is asked for are
//       the ones the reader parses, in the same order; every behaviour of the
//       delivery distribution logs; the rate is left to the control plane;
//       the settings the reader reads are the ones the stack sets.
//    2. Sample CloudFront real-time log records are read right: times, the
//       URL-encoded user agent, CMCD in the query (as the SDK sends it and
//       as CloudFront logs it), dashes, the cache result, Origin Shield.
//    3. No IP address is kept: the raw copy has it blanked, the anonymous
//       session key does not contain it and changes with the day.
//    4. Sampling: a 5 % sample weighted by 20 gives request counts and edge
//       first-byte percentiles within 2 % of the 100 % run on the same
//       traffic; the adaptive rate rule lowers, raises and holds.
//    5. End to end through an in-memory Kinesis and the real API: report 6
//       from the lines, and a player that sends no reports at all is counted
//       (the audience and report 12's coverage), another account sees none.
//    6. The reader resumes where it stopped (no line counted twice, a closed
//       shard left), a rate change is kept and weights the next lines.
//    7. The replay rebuilds identical delivery figures and joins a player's
//       response report to the edge's line by the edge request id.
//    8. The Kinesis and CloudFront calls are signed and shaped right (a
//       stand-in endpoint checks them).
//
//  Usage: DATABASE_URL=... npx tsx test/cdn-logs.check.ts
// ============================================================================
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createServer as httpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

let pass = 0, fail = 0;
const ok = (c: unknown, m: string, d?: unknown) => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log('FAIL ' + m + (d !== undefined ? ` -- ${typeof d === 'string' ? d : JSON.stringify(d)}` : '')); } };
const within = (a: number | null | undefined, b: number, rel: number) => a != null && b !== 0 && Math.abs(a - b) / Math.abs(b) <= rel;
const ROOT = resolve(__dirname, '../..');
process.env.QOE_RAW_DIR = mkdtempSync(join(tmpdir(), 'qoe-raw-cdn-'));
delete process.env.QOE_RAW_BUCKET;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const f of readdirSync(dir)) { const p = join(dir, f); if (statSync(p).isDirectory()) out.push(...walk(p)); else out.push(p); }
  return out;
}

(async () => {
  const cl = await import('../src/services/qoe/cdnLogs');
  const cs = await import('../src/services/qoe/cdnStream');
  const sk = await import('../src/services/qoe/sketch');

  // ------------------------------------------------------------ 1 terraform
  console.log('== 1. Terraform and the reader agree ==');
  {
    const tf = readFileSync(join(ROOT, 'deploy/terraform/cdn_logs.tf'), 'utf8');
    const block = /cdn_log_fields = \[([\s\S]*?)\]/.exec(tf)?.[1] ?? '';
    const fields = [...block.matchAll(/"([a-z-]+)"/g)].map((m) => m[1]);
    ok(JSON.stringify(fields) === JSON.stringify(cl.CDN_LOG_FIELDS), 'the fields Terraform asks CloudFront for are CDN_LOG_FIELDS, in order', { fields });
    ok(/resource "aws_cloudfront_realtime_log_config" "cdn"[\s\S]*fields\s+= local\.cdn_log_fields/.test(tf), 'the log config sends that list');
    ok(/ignore_changes = \[sampling_rate\]/.test(tf), 'Terraform leaves the sampling rate to the control plane');
    ok(/stream_mode = "ON_DEMAND"/.test(tf) && /retention_period = 24/.test(tf) && /encryption_type\s+= "KMS"/.test(tf), 'the stream: on demand, 24 hours, encrypted');
    ok(/"kinesis:GetRecords"/.test(tf) && /"cloudfront:UpdateRealtimeLogConfig"/.test(tf) && /iam:PassRole/.test(tf), 'the control plane may read the stream, change the rate and pass the role');
    const cf = readFileSync(join(ROOT, 'deploy/terraform/s3_cloudfront.tf'), 'utf8');
    const dist = cf.slice(cf.indexOf('resource "aws_cloudfront_distribution" "cdn"'));
    const behaviours = (dist.match(/(default_cache_behavior|ordered_cache_behavior) \{|dynamic "ordered_cache_behavior"/g) ?? []).length;
    const logged = (dist.match(/realtime_log_config_arn\s+= local\.cdn_logs \? aws_cloudfront_realtime_log_config\.cdn\[0\]\.arn : null/g) ?? []).length;
    ok(behaviours === 4 && logged === 4, 'every behaviour of the delivery distribution logs (segments, playlists, DASH, variants)', { behaviours, logged });
    const set = [...tf.matchAll(/name = "(CDN_LOG_[A-Z_]+)"/g)].map((m) => m[1]).sort();
    const src = readFileSync(join(ROOT, 'volt-app/src/services/qoe/cdnStream.ts'), 'utf8');
    const read = [...new Set([...src.matchAll(/process\.env\.(CDN_LOG_[A-Z_]+)/g)].map((m) => m[1]))].sort();
    const cov = JSON.parse(readFileSync(join(ROOT, 'deploy/terraform/env-coverage.json'), 'utf8')).settings;
    const unset = read.filter((n) => !set.includes(n) && !cov[n]);
    ok(set.length === 8 && unset.length === 0, 'every CDN_LOG_ setting the reader reads is set by the stack or explained', { set, read, unset });
    ok(/local\.cdn_logs_env/.test(readFileSync(join(ROOT, 'deploy/terraform/qoe_raw.tf'), 'utf8')), 'and reaches the control plane (in qoe_env)');
  }

  // ------------------------------------------------------------- 2 parsing
  console.log('== 2. sample CloudFront records ==');
  const CH = '7d0c5a8e-1f2b-4c3d-9e4f-a1b2c3d4e5f6'; // replaced by the seeded ids below
  const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
  const TV = 'Mozilla/5.0 (SMART-TV; LINUX; Tizen 7.0) AppleWebKit/537.36 (KHTML, like Gecko) 76.0.3809.146/7.0 TV Safari/537.36';
  interface R { at: number; ip: string; ttfb: number; status?: number; bytes?: number; path: string; reqId: string; time: number; ua?: string; query?: string; result?: string; detailed?: string; cc?: string; ofbl?: number | null; asn?: string }
  /** A record as CloudFront writes it: tab separated, in the configured order, seconds with milliseconds, values URL-encoded, - for none. */
  const rec = (r: R) => [
    (r.at / 1000).toFixed(3), r.ip, (r.ttfb / 1000).toFixed(3), String(r.status ?? 200), String(r.bytes ?? 1_000_000), r.path, 'SYD62-P1', r.reqId,
    (r.time / 1000).toFixed(3), 'HTTP/2.0', encodeURIComponent(r.ua ?? UA), r.query ? r.query : '-', r.result ?? 'Hit', r.detailed ?? (r.result ?? 'Hit'),
    r.cc ?? 'AU', r.ofbl == null ? '-' : (r.ofbl / 1000).toFixed(3), r.ofbl == null ? '-' : ((r.ofbl + 5) / 1000).toFixed(3), r.asn ?? '1221',
  ].join('\t');
  // The SDK writes CMCD as one query argument, its value URL-encoded (svta appendCmcdQuery); CloudFront logs the query as received.
  const cmcdQ = (pairs: string) => 'CMCD=' + encodeURIComponent(pairs);
  {
    const t = Date.UTC(2026, 9, 27, 12, 0, 1, 250);
    const l = cl.parseCdnLine(rec({ at: t, ip: '203.0.113.9', ttfb: 12, path: `/channel/${CH}/1080p/seg_00042.m4s`, reqId: 'REQ-1', time: 180,
      query: cmcdQ('bl=8000,br=3200,bs,cid="' + CH + '",ot=v,sid="sid-abc",su,v=2'), result: 'Miss', detailed: 'OriginShieldHit', ofbl: 30 }))!;
    ok(l && l.at === t && l.ttfbMs === 12 && l.timeMs === 180 && l.status === 200 && l.bytes === 1_000_000, 'timestamp, first byte, time taken, status and bytes in ms and bytes', l);
    ok(l.ua === UA && l.country === 'AU' && l.asn === '1221' && l.pop === 'SYD62-P1' && l.requestId === 'REQ-1', 'user agent decoded, country, network, edge location, request id');
    ok(l.result === 'miss' && l.shieldHit && l.originFblMs === 30, 'a miss answered by Origin Shield, with the origin first byte');
    ok(l.cmcd?.sid === 'sid-abc' && l.cmcd?.ot === 'v' && l.cmcd?.bs === true && l.cmcd?.bl === 8000 && l.contentId === CH, 'CMCD read from the query (sid, object type, starvation, buffer) and the content from the path', l.cmcd);
    ok(cl.objectType(l) === 'v', 'object type from CMCD');
    const twice = cl.cmcdOfQuery('foo=1&CMCD=' + encodeURIComponent(encodeURIComponent('ot=m,sid="s2",v=2')));
    const whole = cl.cmcdOfQuery(encodeURIComponent('CMCD=ot=a,sid="s3"'));
    ok(twice?.sid === 's2' && twice?.ot === 'm' && whole?.sid === 's3', 'CMCD found after other arguments, encoded twice, or with the whole query encoded', { twice, whole });
    ok(cl.cmcdOfQuery('foo=1') === null && cl.cmcdOfQuery(null) === null && cl.cmcdOfQuery('CMCD=' + encodeURIComponent('not cmcd!!')) === null, 'no CMCD, or a malformed one, reads as none');
    const plain = cl.parseCdnLine(rec({ at: t, ip: '198.51.100.7', ttfb: 5, path: `/channel/${CH}/master_cc.m3u8`, reqId: 'R2', time: 6, ua: 'VLC/3.0.20 LibVLC/3.0.20' }))!;
    ok(plain.cmcd === null && plain.result === 'hit' && cl.objectType(plain) === 'm' && plain.originFblMs === null, 'a third-party request: no CMCD, a hit, a playlist by its name, dashes read as none');
    ok(cl.parseCdnLine('garbage') === null && cl.parseCdnLine(rec({ at: t, ip: '1.1.1.1', ttfb: 1, path: '-', reqId: 'x', time: 1 })) === null, 'a line that is not a log record is refused');
  }

  // ------------------------------------------------------------ 3 privacy
  console.log('== 3. no IP address kept ==');
  {
    const t = Date.UTC(2026, 9, 27, 12, 0, 0);
    const mk = (ip: string, at = t) => cl.parseCdnLine(rec({ at, ip, ttfb: 5, path: `/channel/${CH}/a.m3u8`, reqId: 'r', time: 5, ua: 'VLC/3.0.20' }))!;
    const a = cl.sessionKey(mk('203.0.113.9'), 'k'), b = cl.sessionKey(mk('203.0.113.9'), 'k'), c = cl.sessionKey(mk('203.0.113.10'), 'k'), d = cl.sessionKey(mk('203.0.113.9', t + 86_400_000), 'k');
    ok(a.sid === null && a.key.startsWith('a:') && a.key === b.key && a.key !== c.key && a.key !== d.key, 'an anonymous key: the same viewer the same day, another address or day another key', { a, c, d });
    ok(!a.key.includes('203.0.113') && cl.sessionKey(mk('203.0.113.9'), 'other').key !== a.key, 'the key holds no address and depends on the secret');
    const line = rec({ at: t, ip: '203.0.113.9', ttfb: 5, path: '/x', reqId: 'r', time: 5 });
    ok(!cl.storedLine(line).includes('203.0.113.9') && cl.storedLine(line).split('\t').length === cl.CDN_LOG_FIELDS.length && cl.storedLine(line).split('\t')[1] === '-', 'the stored line has the address blanked, nothing else changed');
  }

  // ------------------------------------------------------------ 4 sampling
  console.log('== 4. sampling: 5 % weighted against 100 % on the same traffic ==');
  {
    let seed = 42; // mulberry32: a small generator good enough for sampling statistics
    const rnd = () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const gauss = () => Math.sqrt(-2 * Math.log(Math.max(1e-12, rnd()))) * Math.cos(2 * Math.PI * rnd());
    const full: Record<string, number> = {}, part: Record<string, number> = {};
    const all = new Float64Array(1_000_000);
    let nFull = 0, nPart = 0, errFull = 0, errPart = 0;
    for (let i = 0; i < 1_000_000; i++) {
      const ttfb = Math.exp(3 + 0.8 * gauss());            // lognormal, median ~20 ms, long tail
      const err = rnd() < 0.004;
      all[i] = ttfb; sk.add(full, ttfb); nFull++; if (err) errFull++;
      if (rnd() < 0.05) { sk.add(part, ttfb, 20); nPart += 20; if (err) errPart += 20; }
    }
    const q = (s: any, x: number) => sk.quantile(s, x)!;
    // The 100 % run's true percentiles (nearest rank over every value), and
    // the sketch the 100 % run would have kept, beside the 5 % sample's.
    all.sort();
    const exact = (x: number) => all[Math.max(0, Math.ceil(x * all.length) - 1)];
    const res = [0.5, 0.95, 0.99].map((x) => ({ x, exact: exact(x), full: q(full, x), sample: q(part, x) }));
    ok(within(nPart, nFull, 0.02), 'requests estimated within 2 %', { nFull, nPart });
    for (const r of res) ok(within(r.sample, r.exact, 0.02), `edge first byte p${Math.round(r.x * 100)} from the 5 % sample within 2 % of the 100 % run (${r.exact.toFixed(1)} ms, sample ${r.sample.toFixed(1)} ms; the 100 % run's own sketch ${r.full.toFixed(1)} ms)`);
    ok(res.every((r) => within(r.full, r.exact, 0.011)), 'and the sketch itself within its 1 % on the full run', res);
    ok(within(errPart / nPart, errFull / nFull, 0.15), 'error rate close (a rare event: within 15 % of 0.4 %)', { full: errFull / nFull, sample: errPart / nPart });

    const nr = cs.nextSamplingRate;
    ok(nr({ rate: 100, linesPerSec: 5000, target: 1000 }) === 20, 'over the target: 5,000 lines/s at 100 % becomes 20 %');
    ok(nr({ rate: 2, linesPerSec: 3000, target: 1000 }) === 1, 'never below 1 %, CloudFront\'s floor', nr({ rate: 2, linesPerSec: 3000, target: 1000 }));
    ok(nr({ rate: 20, linesPerSec: 1100, target: 1000 }) === 20 && nr({ rate: 20, linesPerSec: 600, target: 1000 }) === 20, 'near the target (within a fifth over, or above 40 % of it): held, no flapping');
    ok(nr({ rate: 10, linesPerSec: 100, target: 1000 }) === 80, 'well under: raised to 80 % of what meets the target', nr({ rate: 10, linesPerSec: 100, target: 1000 }));
    ok(nr({ rate: 50, linesPerSec: 10, target: 1000 }) === 100 && nr({ rate: 30, linesPerSec: 0, target: 1000 }) === 100, 'a small audience, or none: everything logged');
    ok(nr({ rate: 30, linesPerSec: 380, target: 1000 }) === 63, 'from 30 % at 380 lines/s: to 63 %, short of the target so it does not overshoot', nr({ rate: 30, linesPerSec: 380, target: 1000 }));
  }

  // ---------------------------------------------------------- 5 end to end
  console.log('== 5. through Kinesis and the API ==');
  const { createServer } = await import('../src/server');
  const { one, query } = await import('../src/db');
  const { generateKey } = await import('../src/services/apiKeys');
  const { signAccess } = await import('../src/auth/jwt');
  const adb = await import('../src/services/qoe/analyticsDb');
  const coll = await import('../src/services/qoe/collector');
  const { replayRange } = await import('../src/services/qoe/replay');
  const { config } = await import('../src/config');
  {
    const aname = new URL(adb.analyticsUrl()).pathname.slice(1);
    const { Client } = await import('pg'); const u = new URL(config.databaseUrl); u.pathname = '/postgres';
    const c = new Client({ connectionString: u.toString() }); await c.connect(); await c.query(`DROP DATABASE IF EXISTS "${aname}" WITH (FORCE)`); await c.end();
  }
  const tag = Date.now().toString(36);
  const acct = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`cdn-${tag}`]))!.id;
  const other = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`cdn-b-${tag}`]))!.id;
  const prof = (await one<any>(`INSERT INTO output_profiles(account_id, name, rungs, workflow_type) VALUES ($1,'T','[]','transcode') RETURNING id`, [acct]))!.id;
  const grp = (await one<any>(`INSERT INTO groups(account_id, name, output_profile_id) VALUES ($1,'G',$2) RETURNING id`, [acct, prof]))!.id;
  const ch = (await one<any>(`INSERT INTO channels(group_id, name, status) VALUES ($1,'News 24','live') RETURNING id`, [grp]))!.id;
  const app = await one<any>(`INSERT INTO apps(account_id, name, type, restrictions) VALUES ($1,'Web','web','{}') RETURNING id`, [acct]);
  const k = generateKey('publishable');
  await query(`INSERT INTO api_keys(account_id, app_id, kind, key_prefix, key_hash, scopes) VALUES ($1,$2,'publishable',$3,$4,'{playback}')`, [acct, app!.id, k.prefix, k.hash]);
  const user = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [acct, `cdn-${tag}@example.com`]))!.id;
  const user2 = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [other, `cdn-b-${tag}@example.com`]))!.id;
  const tok = signAccess({ sub: user, account_id: acct, role: 'owner' } as any);
  const tok2 = signAccess({ sub: user2, account_id: other, role: 'owner' } as any);
  const srv = createServer().listen(0);
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const T0 = Math.floor(Date.now() / 60_000) * 60_000 - 10 * 60_000;
  const W = `from=${new Date(T0 - 3_600_000).toISOString()}&to=${new Date(T0 + 3_600_000).toISOString()}`;
  const get = async (path: string, t = tok) => { const r = await fetch(`${base}/api/analytics/qoe${path}`, { headers: { authorization: `Bearer ${t}` } }); return { status: r.status, body: await r.json().catch(() => null) as any }; };

  // The Volt SDK player: reports through the collector AND carries CMCD on its requests.
  const sid = `sdk-${tag}`;
  const ev = (ts: number, sn: number, rest: string) => `v=2,sid="${sid}",cid="${ch}",st=l,ts=${ts},sn=${sn},` + rest;
  const r1 = await fetch(`${base}/api/cmcd?appKey=${encodeURIComponent(k.raw)}`, { method: 'POST', headers: { 'content-type': 'application/cmcd', 'user-agent': UA },
    body: [ev(T0, 1, 'e=ps,sta=s'), ev(T0 + 300, 2, `e=rr,rc=200,ttfb=95,ttlb=200,url="https://cdn.example/x.m4s",com.volt-cfid="EDGE-JOIN-1"`), ev(T0 + 900, 3, 'e=ps,sta=p,msd=900'), ev(T0 + 60_000, 4, 'e=ps,sta=q')].join('\n') });
  ok(r1.status === 204, 'the SDK player\'s reports accepted', r1.status);
  await coll.flushQoe(Date.now());

  const kin = new cs.MemoryKinesis();
  const lines: string[] = [];
  const P = (r: R) => { const l = rec(r); lines.push(l); return l; };
  // SDK player: 10 requests, one joined to its response report by the edge request id.
  for (let i = 0; i < 10; i++) P({ at: T0 + i * 4000, ip: '203.0.113.5', ttfb: i === 0 ? 20 : 10 + i, path: `/channel/${ch}/720p/seg_${i}.m4s`, reqId: i === 0 ? 'EDGE-JOIN-1' : `S${i}`, time: 120,
    query: cmcdQ(`bl=9000,br=3200,cid="${ch}",ot=v,sid="${sid}",v=2`), result: i < 8 ? 'Hit' : 'Miss', ofbl: i < 8 ? null : 40 });
  // A third-party player on the raw address: no CMCD at all, no reports. Two playlist requests and 8 segments, one a 404.
  for (let i = 0; i < 10; i++) P({ at: T0 + i * 4000 + 7, ip: '198.51.100.20', ttfb: 30 + i, path: i < 2 ? `/channel/${ch}/master_cc.m3u8` : `/channel/${ch}/720p/seg_${i}.m4s`, reqId: `T${i}`, time: 200,
    ua: TV, status: i === 5 ? 404 : 200, bytes: i < 2 ? 900 : 800_000, cc: 'NZ', result: i === 5 ? 'Error' : 'Hit' });
  // A player that sends CMCD v1 request keys with a sid, but no event reports.
  for (let i = 0; i < 4; i++) P({ at: T0 + i * 4000 + 9, ip: '192.0.2.44', ttfb: 15, path: `/channel/${ch}/480p/seg_${i}.m4s`, reqId: `V${i}`, time: 150, query: cmcdQ(`ot=v,sid="v1-${tag}"`) });
  // Someone else's (unknown) content, and junk.
  P({ at: T0, ip: '192.0.2.1', ttfb: 5, path: '/channel/00000000-0000-4000-8000-000000000000/a.m3u8', reqId: 'U1', time: 5 });
  lines.push('not a log line');
  // CloudFront puts each line as a record (with a newline); spread over two shards.
  lines.forEach((l, i) => kin.put(i % 2 ? 'shardId-000000000001' : 'shardId-000000000000', l + '\n'));

  cs.resetReader(); cl.resetCdn();
  const opts = { kinesis: kin, stream: 'test-stream', initialRate: 100 };
  const n1 = await cs.readOnce(opts);
  ok(n1 === 26 && cl.cdnStats.kept === 24 && cl.cdnStats.unattributed === 1 && cl.cdnStats.unreadable === 1, 'every record read: 24 kept, the unknown content and the junk line counted and left out', { n1, ...cl.cdnStats });
  await cl.flushCdn();
  const rawFiles = walk(join(process.env.QOE_RAW_DIR!, 'cdn'));
  const rawText = rawFiles.map((f) => readFileSync(f, 'utf8')).join('');
  ok(rawFiles.length >= 1 && rawFiles.every((f) => f.includes(`/cdn/${acct}/`)) && rawText.split('\n').filter(Boolean).length === 24, 'kept raw first, under the account\'s cdn partition', rawFiles);
  ok(!/203\.0\.113\.5|198\.51\.100\.20|192\.0\.2\.44/.test(rawText), 'no viewer address in the raw copy');

  const o = await get(`/overview?${W}`);
  const d = o.body?.delivery;
  ok(o.status === 200 && d, 'report 6 in the overview', o.status);
  ok(d?.requests === 24 && d?.sampledLines === 24, 'requests counted (logged at 100 %)', d && { requests: d.requests, lines: d.sampledLines });
  ok(near(d?.errorRate, 1 / 24) && near(d?.clientErrorRate, 1 / 24) && d?.serverErrorRate === 0, 'the 404 is the error rate', d?.errorRate);
  ok(near(d?.cacheHitRatio, 21 / 23), 'cache hits over hits and misses (21 of 23; the error is neither)', d?.cacheHitRatio);
  ok(near(d?.originShieldShareOfMisses, 0), 'no Origin Shield hits in these misses');
  ok(d?.originFirstByteMs?.p50 != null && within(d.originFirstByteMs.p50, 40, 0.02), 'origin first byte on the misses', d?.originFirstByteMs);
  ok(within(d?.edgeTtfbMs?.p99, 39, 0.02) && d?.edgeTtfbMs?.p50 != null, 'edge first byte percentiles', d?.edgeTtfbMs);
  const types = Object.fromEntries((d?.byObjectType ?? []).map((t: any) => [t.ot, t.requests]));
  ok(types.v === 14 && types.m === 2 && types.av === 8, 'by object type: CMCD\'s video, the playlists and the third party\'s segments by their names', types);
  ok(near(d?.cmcdShare, 14 / 24) && near(d?.sessionIdShare, 14 / 24), 'the share of requests carrying CMCD and a session id', { c: d?.cmcdShare, s: d?.sessionIdShare });
  ok(d?.segmentKbps?.p50 != null && d.segmentKbps.p50 > 0, 'segment delivery rate from bytes over time taken', d?.segmentKbps);
  ok(d?.audience?.sessions === 3 && d?.audience?.withTelemetry === 1 && d?.audience?.withoutTelemetry === 2 && d?.audience?.withoutSessionId === 1,
    'a player that sends no reports is counted: 3 sessions at the edge, 1 reporting, 2 not (one without even a session id)', d?.audience);
  const cov = o.body?.telemetry?.coverage;
  ok(cov && cov.cdnSessions === 3 && cov.withTelemetry === 1 && near(cov.share, 1 / 3), 'report 12: reporting coverage is views with telemetry over sessions seen at the CDN', cov);
  const nz = await get(`/overview?${W}&country=NZ`);
  ok(nz.body?.delivery?.requests === 10 && nz.body?.delivery?.audience?.sessions === 3, 'report 6 honours the country filter (the audience stays the account\'s)', nz.body?.delivery?.requests);
  const o2 = await get(`/overview?${W}`, tok2);
  ok(o2.status === 200 && o2.body?.delivery?.requests === 0 && o2.body?.delivery?.audience?.sessions === 0 && o2.body?.telemetry?.coverage === null, 'another account sees none of it');
  const colr = await get('/collector');
  ok(colr.body?.cdn?.kept === 24 && colr.body?.cdn?.shards === 2, 'the collector route shows the CDN reader', colr.body?.cdn);

  // ------------------------------------------------------------- 6 cursor
  console.log('== 6. the reader resumes, and the rate weights the lines ==');
  {
    const again = await cs.readOnce(opts);
    ok(again === 0, 'a second pass reads nothing new', again);
    cs.resetReader(); // a restart: iterators gone, only the cursor in the database
    const fresh = await cs.readOnce(opts);
    ok(fresh === 0, 'after a restart the reader carries on from the recorded position, not from the start', fresh);
    const cur = await adb.aquery<any>(`SELECT shard_id, closed FROM qoe_cdn_cursor WHERE stream = 'test-stream' ORDER BY shard_id`);
    ok(cur.length === 2 && cur.every((c) => !c.closed), 'a position per shard', cur);
    // The rate: 5,000 lines/s at 100 % is lowered to 20 %, kept, and the next lines count 5 times.
    const calls: number[] = [];
    const rate = await cs.adjustRate({ ...opts, logConfig: { setSamplingRate: async (r) => { calls.push(r); } } }, 5000);
    const [meta] = await adb.aquery<any>(`SELECT v FROM qoe_meta WHERE k = 'cdn_sampling_rate'`);
    ok(rate === 20 && calls.join() === '20' && meta?.v === '20' && cs.readerState.rate === 20, 'the rate is changed through CloudFront and remembered', { rate, calls, meta });
    const failing = await cs.adjustRate({ ...opts, logConfig: { setSamplingRate: async () => { throw new Error('AccessDenied'); } } }, 50_000);
    ok(failing === 20 && /AccessDenied/.test(cs.readerState.lastRateError ?? ''), 'a refused change keeps the rate in force (the weights stay right)');
    P({ at: T0 + 50_000, ip: '198.51.100.20', ttfb: 33, path: `/channel/${ch}/720p/seg_50.m4s`, reqId: 'T50', time: 200, ua: TV, cc: 'NZ' });
    kin.put('shardId-000000000000', lines[lines.length - 1] + '\n');
    kin.close('shardId-000000000001');
    const n3 = await cs.readOnce(opts);
    await cl.flushCdn();
    const d3 = (await get(`/overview?${W}`)).body?.delivery;
    ok(n3 === 1 && d3?.requests === 29 && d3?.sampledLines === 25, 'one new line, logged at 20 %, stands for 5 requests (24 + 5)', { n3, requests: d3?.requests, lines: d3?.sampledLines });
    const cur2 = await adb.aquery<any>(`SELECT shard_id, closed FROM qoe_cdn_cursor WHERE stream = 'test-stream' ORDER BY shard_id`);
    ok(cur2.find((c) => c.shard_id === 'shardId-000000000001')?.closed === true, 'a closed shard read to its end is marked and left', cur2);
    const n4 = await cs.readOnce(opts);
    ok(n4 === 0 && !kin.calls.slice(-3).includes('iterator'), 'and not read again');
  }

  // ------------------------------------------------------------- 7 replay
  console.log('== 7. replay: identical figures, and the join by edge request id ==');
  {
    // The lines are dated just before now; around midnight UTC they and their raw partitions span two days.
    const day = new Date(T0).toISOString().slice(0, 10), today = new Date().toISOString().slice(0, 10);
    const before = (await get(`/overview?${W}`)).body?.delivery;
    await adb.aquery(`DELETE FROM qoe_cdn_minutes WHERE account_id = $1`, [acct]);
    await adb.aquery(`DELETE FROM qoe_cdn_sessions WHERE account_id = $1`, [acct]);
    const gone = (await get(`/overview?${W}`)).body?.delivery;
    ok(gone?.requests === 0, 'the derived rows deleted');
    const res = await replayRange(day, today, acct);
    const after = (await get(`/overview?${W}`)).body?.delivery;
    const strip = (x: any) => JSON.stringify({ ...x, lastMileMs: undefined });
    ok(res.reduce((a, r) => a + r.cdnLines, 0) >= 25 && strip(after) === strip(before), 'the replay rebuilds the same report from the raw lines', { res, b: before?.requests, a: after?.requests });
    ok(after?.lastMileMs?.joinedRequests === 1 && within(after?.lastMileMs?.p50, 75, 0.02), 'the player\'s response report joined to the edge line by request id: 95 ms at the player, 20 ms at the edge, a 75 ms last mile', after?.lastMileMs);
    await replayRange(day, today, acct);
    const twice = (await get(`/overview?${W}`)).body?.delivery;
    ok(JSON.stringify(twice) === JSON.stringify(after), 'a second replay gives the same answer (idempotent)');
  }

  // ------------------------------------------------------------ 8 signing
  console.log('== 8. the Kinesis and CloudFront calls ==');
  {
    const seen: Array<{ method: string; url: string; headers: any; body: string }> = [];
    const stub = httpServer((req, res) => {
      let body = ''; req.on('data', (c) => (body += c)); req.on('end', () => {
        seen.push({ method: req.method!, url: req.url!, headers: req.headers, body });
        const target = String(req.headers['x-amz-target'] ?? '');
        res.setHeader('content-type', 'application/x-amz-json-1.1');
        if (target.endsWith('ListShards')) res.end(JSON.stringify({ Shards: [{ ShardId: 'shardId-1' }] }));
        else if (target.endsWith('GetShardIterator')) res.end(JSON.stringify({ ShardIterator: 'IT-1' }));
        else if (target.endsWith('GetRecords') && JSON.parse(body).ShardIterator) res.end(JSON.stringify({ Records: [{ SequenceNumber: '49', Data: Buffer.from('hello\n').toString('base64'), ApproximateArrivalTimestamp: 1793000000.5 }], NextShardIterator: 'IT-2', MillisBehindLatest: 1200 }));
        else if (req.method === 'PUT') { res.setHeader('content-type', 'text/xml'); res.end('<UpdateRealtimeLogConfigResult/>'); }
        else { res.statusCode = 400; res.end(JSON.stringify({ __type: 'x#Bad', message: 'no' })); }
      });
    }).listen(0);
    const ep = `http://127.0.0.1:${(stub.address() as any).port}`;
    const creds = async () => ({ accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', sessionToken: 'tok' });
    const kc = await cs.realKinesis({ region: 'eu-west-1', endpoint: ep, credentials: creds });
    const shards = await kc.listShards('s');
    const it = await kc.iterator('s', 'shardId-1', '48');
    const got = await kc.getRecords(it, 5);
    ok(shards.join() === 'shardId-1' && it === 'IT-1' && got.records[0].data.toString() === 'hello\n' && got.records[0].seq === '49' && got.next === 'IT-2' && got.behindMs === 1200 && got.records[0].arrivedAt === 1793000000500,
      'ListShards, GetShardIterator and GetRecords read (records base64, arrival in ms)', got);
    const iterBody = JSON.parse(seen[1].body);
    ok(iterBody.ShardIteratorType === 'AFTER_SEQUENCE_NUMBER' && iterBody.StartingSequenceNumber === '48', 'the iterator starts after the recorded position', iterBody);
    ok(seen.slice(0, 3).every((s) => /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/eu-west-1\/kinesis\/aws4_request, SignedHeaders=[a-z0-9;-]+, Signature=[0-9a-f]{64}$/.test(String(s.headers.authorization))
      && s.headers['x-amz-security-token'] === 'tok' && s.headers['content-type'] === 'application/x-amz-json-1.1' && String(s.headers['x-amz-target']).startsWith('Kinesis_20131202.')), 'each Kinesis call signed for the kinesis service, JSON 1.1 with its target');
    await cs.realLogConfig({ configArn: 'arn:aws:cloudfront::1:realtime-log-config/x', streamArn: 'arn:aws:kinesis:eu-west-1:1:stream/s', roleArn: 'arn:aws:iam::1:role/r', credentials: creds, endpoint: ep }).setSamplingRate(20);
    const put = seen[seen.length - 1];
    ok(put.method === 'PUT' && put.url === '/2020-05-31/realtime-log-config/' && /<SamplingRate>20<\/SamplingRate>/.test(put.body) && /<StreamType>Kinesis<\/StreamType>/.test(put.body)
      && cl.CDN_LOG_FIELDS.every((f) => put.body.includes(`<Field>${f}</Field>`)) && /\/us-east-1\/cloudfront\/aws4_request/.test(String(put.headers.authorization)),
      'UpdateRealtimeLogConfig restates the stream, role and every field, with the new rate, signed for CloudFront in us-east-1', put.body.slice(0, 200));
    let refused = '';
    try { await kc.getRecords('', 1); } catch (e) { refused = (e as Error).message; }
    ok(/Kinesis GetRecords 400: Bad: no/.test(refused), 'a refused call says which and why', refused);
    stub.close();
  }

  srv.close();
  await adb.closeAnalytics();
  const { pool } = await import('../src/db'); await pool.end().catch(() => {});
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

function near(a: number | null | undefined, b: number) { return a != null && Math.abs(a - b) < 1e-9; }
