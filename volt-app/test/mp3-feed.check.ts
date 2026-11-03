// ============================================================================
//  NO RELAY, AND MP3 BEHIND A SWITCH (build queue 2.1c-2).
//
//  Christian, 3 Nov 2026: no Icecast relay. Stations write HLS and DASH; MP3
//  for listeners is the control plane's on-demand transcode of the HLS, off by
//  default behind a per-account switch the system admin sets, until it is
//  decided whether to offer it. What is checked here, against Postgres and the
//  real API (the full listening path is radio-container.check.sh):
//
//    - the switch is off for a new account, and only a verified System Admin
//      session can change it (PATCH /api/platform/accounts/{id} mp3FeedEnabled);
//    - off: no MP3 address is advertised (station detail and list), and the
//      public and preview MP3 addresses answer 404;
//    - on: advertised, for stations that have not turned MP3 off themselves;
//    - the relay is gone: no relay routes, no listener-auth callback, and a
//      station's job config names no relay and asks for no MP3.
//
//  Usage: DATABASE_URL=... npx tsx test/mp3-feed.check.ts
// ============================================================================
import type { AddressInfo } from 'node:net';

let pass = 0, fail = 0;
const ok = (m: string, c: boolean, extra?: unknown) => {
  if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log('FAIL ' + m + (extra === undefined ? '' : `  -> ${JSON.stringify(extra)}`)); }
};

const A = '00000000-0000-0000-0000-0000000d3a01';
const G = '00000000-0000-0000-0000-0000000d3b01';
const P = '00000000-0000-0000-0000-0000000d3c01';
const S1 = '00000000-0000-0000-0000-0000000d3d01';   // MP3 left as the default
const S2 = '00000000-0000-0000-0000-0000000d3d02';   // MP3 turned off by the station
const U = '00000000-0000-0000-0000-0000000d3e01';
const SYS = '00000000-0000-0000-0000-0000000d3e02';

async function main() {
  const { query, one, pool } = await import('../src/db');
  const { createServer } = await import('../src/server');
  const { signAccess, AUD_PLATFORM } = await import('../src/auth/jwt');
  const { mp3FeedFor } = await import('../src/services/radio/mp3Feed');
  const { buildRadioJobConfig } = await import('../src/services/radio/jobConfig');

  await query(`DELETE FROM accounts WHERE id = $1`, [A]);
  await query(`INSERT INTO accounts(id,name) VALUES ($1,'FeedCo')`, [A]);
  await query(`INSERT INTO users(id,account_id,email,password_hash,role,status) VALUES ($1,$2,'feed@test.local','x','owner','active')`, [U, A]);
  await query(`INSERT INTO users(id,account_id,email,password_hash,role,status,platform_role) VALUES ($1,$2,'feedsys@test.local','x','owner','active','saas_admin')`, [SYS, A]);
  await query(`INSERT INTO output_profiles(id,account_id,name,rungs,workflow_type) VALUES ($1,$2,'Audio','[]','package_only')`, [P, A]);
  await query(`INSERT INTO groups(id,account_id,name,output_profile_id) VALUES ($1,$2,'Stations',$3)`, [G, A, P]);
  await query(`INSERT INTO channels(id,group_id,name,status,kind,radio_config,on_air) VALUES
    ($1,$3,'Feed FM','live','radio','{"bitrateKbps":128,"outputs":{"hls":true,"dash":true}}'::jsonb,true),
    ($2,$3,'Quiet FM','live','radio','{"bitrateKbps":128,"outputs":{"mp3":false,"hls":true,"dash":true}}'::jsonb,true)`, [S1, S2, G]);

  const app = createServer();
  const srv = app.listen(0);
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown, sub = U, aud?: string) => {
    const tok = signAccess({ sub, account_id: A, role: 'owner' } as any, aud ? { aud } as any : {});
    const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    let j: any = null; try { j = await r.json(); } catch { /* no body */ }
    return { s: r.status, j };
  };
  const has = (o: unknown) => JSON.stringify(o).includes('stream.mp3');

  console.log('== off by default ==');
  ok('a new account has the MP3 feed off', (await one<any>(`SELECT mp3_feed_enabled FROM accounts WHERE id=$1`, [A]))?.mp3_feed_enabled === false);
  ok('so a station has no MP3', !(await mp3FeedFor(S1)));
  const d1 = await call('GET', `/api/radio/${S1}`);
  ok('station detail says the account has no feed', d1.s === 200 && d1.j?.mp3Feed === false, d1.s);
  ok('and advertises no MP3 address', !has(d1.j?.outputs) && !has(d1.j?.publicUrls));
  ok('the station list advertises none either', !has((await call('GET', '/api/radio')).j));
  ok('account settings report the feed off (read only)', (await call('GET', '/api/account-settings')).j?.mp3FeedEnabled === false);
  ok('the public MP3 address answers 404', (await fetch(`${base}/live/${S1}/stream.mp3`)).status === 404);
  ok('and the preview MP3 address 404', (await fetch(`${base}/radio/${S1}/stream.mp3`)).status === 404);

  console.log('\n== who may switch it ==');
  ok('an account owner may not (it is a platform route)', (await call('PATCH', `/api/platform/accounts/${A}`, { mp3FeedEnabled: true })).s === 403);
  ok('a system admin needs a verified platform session', (await call('PATCH', `/api/platform/accounts/${A}`, { mp3FeedEnabled: true }, SYS)).s === 403);
  const on = await call('PATCH', `/api/platform/accounts/${A}`, { mp3FeedEnabled: true }, SYS, AUD_PLATFORM);
  ok('with one, it switches the MP3 feed on', on.s === 200 && on.j?.mp3_feed_enabled === true, on);
  const plist = (await call('GET', '/api/platform/accounts', undefined, SYS, AUD_PLATFORM)).j;
  const prow = (Array.isArray(plist) ? plist : plist?.items ?? plist?.accounts ?? []).find((a: any) => a.id === A);
  ok('and the System Admin account list says so', prow?.mp3_feed_enabled === true);

  console.log('\n== on ==');
  ok('a station with MP3 left alone now has it', await mp3FeedFor(S1));
  ok('a station that turned MP3 off still has none', !(await mp3FeedFor(S2)));
  const d2 = await call('GET', `/api/radio/${S1}`);
  ok('station detail says the account has the feed and advertises MP3', d2.j?.mp3Feed === true && has(d2.j?.publicUrls) && has(d2.j?.outputs));
  ok('the quiet station advertises none', !has((await call('GET', `/api/radio/${S2}`)).j?.publicUrls));

  console.log('\n== the relay is gone ==');
  ok('no relay routes', (await call('GET', '/api/platform/relays', undefined, SYS, AUD_PLATFORM)).s === 404);
  ok('no listener-auth callback', (await fetch(`${base}/api/radio/icecast/listener-auth`, { method: 'POST' })).status !== 200);
  ok('the cost comparison still answers (compute only)', (await call('GET', '/api/platform/costs/comparison', undefined, SYS, AUD_PLATFORM)).s === 200);
  const job = await buildRadioJobConfig({ channelId: S1, channelName: 'Feed FM', protocol: 'icecast', url: 'http://up.example/s', radioConfig: { outputs: { mp3: true } } });
  ok('a station job names no relay and asks for no MP3, even when its config did', !('icecast' in job) && job.outputs.mp3 === false && job.outputs.hls === true);

  srv.close();
  await query(`DELETE FROM accounts WHERE id = $1`, [A]);
  await pool.end();
  console.log(`\nmp3-feed: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
