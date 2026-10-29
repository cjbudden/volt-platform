// ============================================================================
//  GRAPHICS LIVE UPDATES OVER SSE (build queue 1.8), against Postgres and the
//  real HTTP app: every graphics state change reaches a console subscribed to
//  GET /api/status/stream as a `gfx` frame within a second, with no poll.
//
//  Covers the write paths (values, on/off, the off timer, a pushed feed, a
//  rundown add / take / take off, an assignment or setup edit), the time path
//  (a rule graphic that goes off at a programme boundary with no write, caught
//  by the tick's watch), frames that must NOT go out (an unchanged value,
//  another account, values inside the frame), who may receive them (Graphics
//  alone opens the stream and gets only gfx frames; Live & monitoring alone
//  gets no gfx frames; neither is refused) and that live control, the event
//  rundown and the channel graphics tab no longer poll.
//
//  Usage: DATABASE_URL=... npx tsx test/graphics-live-push.check.ts   (a migrated, disposable database)
// ============================================================================
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let pass = 0, fail = 0;
const ok = (c: boolean, m: string, d = '') => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log(`FAIL ${m}${d ? ' -- ' + d : ''}`); } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Frame = { event: string; data: any; at: number };

/** A minimal EventSource on fetch: collects every frame with its arrival time. */
async function sse(url: string) {
  const ac = new AbortController();
  const r = await fetch(url, { signal: ac.signal });
  const frames: Frame[] = [];
  const status = r.status;
  if (status === 200 && r.body) {
    (async () => {
      const dec = new TextDecoder(); let buf = '';
      try {
        for await (const chunk of r.body as any) {
          buf += dec.decode(chunk, { stream: true });
          let i: number;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const blk = buf.slice(0, i); buf = buf.slice(i + 2);
            let event = 'message'; const data: string[] = [];
            for (const line of blk.split('\n')) {
              if (line.startsWith('event: ')) event = line.slice(7);
              else if (line.startsWith('data: ')) data.push(line.slice(6));
            }
            if (!data.length) continue;
            let d: any = data.join('\n'); try { d = JSON.parse(d); } catch { /* keep text */ }
            frames.push({ event, data: d, at: Date.now() });
          }
        }
      } catch { /* aborted */ }
    })();
  } else { try { await r.text(); } catch { /* ignore */ } }
  const waitFor = async (pred: (f: Frame) => boolean, ms = 1000, from = 0): Promise<Frame | null> => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const f = frames.slice(from).find(pred);
      if (f) return f;
      await sleep(5);
    }
    return frames.slice(from).find(pred) ?? null;
  };
  return { status, frames, waitFor, close: () => ac.abort() };
}

(async () => {
  const { createServer } = await import('../src/server');
  const { pool, one, query } = await import('../src/db');
  const { signAccess } = await import('../src/auth/jwt');
  const { ensureDefaultTemplates } = await import('../src/services/graphics/defaults');
  const { tick } = await import('../src/services/graphics/runtime');
  const { watchLive, resetLiveWatch } = await import('../src/services/graphics/livePush');
  const { applyReport } = await import('../src/modules/status');

  // ---- seed ----
  const tag = Date.now().toString(36);
  const acct = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`gfxsse-${tag}`]))!.id;
  const other = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`gfxsse-other-${tag}`]))!.id;
  const mkUser = async (a: string, email: string, role: string) =>
    (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x',$3,'active') RETURNING id`, [a, email, role]))!.id;
  const owner = await mkUser(acct, `gfxsse-${tag}@volt.test`, 'owner');
  const otherOwner = await mkUser(other, `gfxsse-o-${tag}@volt.test`, 'owner');
  const gfxOp = await mkUser(acct, `gfxsse-gfx-${tag}@volt.test`, 'operator');
  const liveOp = await mkUser(acct, `gfxsse-live-${tag}@volt.test`, 'operator');
  const nobody = await mkUser(acct, `gfxsse-none-${tag}@volt.test`, 'operator');
  const role = async (u: string, name: string, perms: any) => {
    const g = (await one<any>(`INSERT INTO user_groups(account_id, name, permissions) VALUES ($1,$2,$3::jsonb) RETURNING id`, [acct, name, JSON.stringify(perms)]))!.id;
    await query(`INSERT INTO user_group_members(user_id, group_id) VALUES ($1,$2)`, [u, g]);
  };
  await role(gfxOp, 'Graphics operator', { graphics: 'operate' });
  await role(liveOp, 'Monitoring', { monitoring: 'view' });
  await role(nobody, 'EPG only', { epg: 'manage' });

  const prof = (await one<any>(`INSERT INTO output_profiles(account_id, name, rungs, workflow_type) VALUES ($1,'T','[]','transcode') RETURNING id`, [acct]))!.id;
  const grp = (await one<any>(`INSERT INTO groups(account_id, name, output_profile_id) VALUES ($1,'G',$2) RETURNING id`, [acct, prof]))!.id;
  const ch = (await one<any>(`INSERT INTO channels(group_id, name, status) VALUES ($1,'TV1 News','live') RETURNING id`, [grp]))!.id;
  const now = Date.now();
  const ev = (await one<any>(`INSERT INTO events(group_id, name, status, scheduled_start, scheduled_end, actual_start) VALUES ($1,'Cup final','live',$2,$3,$2) RETURNING id`,
    [grp, new Date(now - 5 * 60_000), new Date(now + 2 * 3600_000)]))!.id;
  const P = (title: string, a: number, b: number, md: any) =>
    query(`INSERT INTO programmes(channel_id, title, starts_at, ends_at, metadata) VALUES ($1,$2,$3,$4,$5::jsonb)`, [ch, title, new Date(now + a * 60_000), new Date(now + b * 60_000), JSON.stringify(md)]);
  await P('Midday News', -30, 1, { genre: 'News' });
  await P('Afternoon Sport', 1, 90, { genre: 'Sport' });

  const app: any = createServer();
  const srv = app.listen(0); const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const T = (sub: string, a: string, r: string) => signAccess({ sub, account_id: a, role: r });
  const tok = T(owner, acct, 'owner');
  const api = async (method: string, path: string, body?: any, token = tok) => {
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const r = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text(); let j: any = null; try { j = JSON.parse(text); } catch { j = text; }
    return { s: r.status, j };
  };
  const stream = (token: string) => sse(`${base}/api/status/stream?ticket=${encodeURIComponent(token)}`);
  const subs: { close: () => void }[] = [];
  const gfxFor = (id: string, reason?: string) => (f: Frame) => f.event === 'gfx' && f.data?.id === id && (!reason || f.data.reason === reason);

  try {
    await ensureDefaultTemplates();
    const tpls = (await api('GET', '/api/graphics/templates')).j.items;
    const lower = tpls.find((t: any) => t.owner === 'volt' && t.kind === 'lower_third' && /^Name super \(who/.test(t.name));
    let r = await api('POST', '/api/graphics/sources', { name: 'Presenter feed', kind: 'push' });
    const push = r.j;
    r = await api('POST', '/api/graphics/setups', { name: 'Presenter super', versionId: lower.latest.id, fields: { name: { source: 'operator' }, title: { source: 'operator' } } });
    const superSetup = r.j;
    r = await api('POST', '/api/graphics/setups', { name: 'From the feed', versionId: lower.latest.id, fields: { name: { source: 'feed', sourceId: push.id, path: 'who' }, title: { source: 'text', value: 'Guest' } } });
    const feedSetup = r.j;
    r = await api('POST', '/api/graphics/setups', { name: 'News strap', versionId: lower.latest.id, fields: { name: { source: 'text', value: 'NEWS' }, title: { source: 'text', value: 'Live' } } });
    const newsSetup = r.j;
    ok(!!(superSetup.id && feedSetup.id && newsSetup.id), 'three setups on the Volt lower third');

    console.log('== the stream: who may open it ==');
    const main = await stream(tok); subs.push(main);
    ok(main.status === 200 && !!(await main.waitFor((f) => f.event === 'ready', 2000)), 'an owner opens the status stream');
    const otherSub = await stream(T(otherOwner, other, 'owner')); subs.push(otherSub);
    const gfxSub = await stream(T(gfxOp, acct, 'operator')); subs.push(gfxSub);
    ok(gfxSub.status === 200, 'a role with Graphics alone may open it (live control needs it)', String(gfxSub.status));
    const liveSub = await stream(T(liveOp, acct, 'operator')); subs.push(liveSub);
    ok(liveSub.status === 200, 'a role with Live & monitoring alone opens it as before');
    const none = await stream(T(nobody, acct, 'operator'));
    ok(none.status === 403, 'a role with neither is refused', String(none.status));
    await Promise.all([otherSub, gfxSub, liveSub].map((s) => s.waitFor((f) => f.event === 'ready', 2000)));

    console.log('== assignment edits ==');
    let mark = main.frames.length;
    r = await api('POST', '/api/graphics/assignments', { setupId: superSetup.id, channelId: ch, targets: 'player', runMode: 'manual' });
    const asg = r.j;
    let f = await main.waitFor(gfxFor(ch, 'assignment'), 1000, mark);
    ok(r.s === 201 && !!f && f.data.assignmentId === asg.id && f.data.kind === 'channel', 'a new assignment is announced for its channel', JSON.stringify(f?.data));

    console.log('== values ==');
    mark = main.frames.length;
    let t0 = Date.now();
    r = await api('PATCH', `/api/graphics/assignments/${asg.id}/state`, { values: { name: 'Jane Doe', title: 'Political editor' } });
    f = await main.waitFor(gfxFor(ch, 'values'), 1000, mark);
    ok(r.s === 200 && !!f, `a value change reaches the subscriber (${f ? f.at - t0 : '-'} ms, bar 1000)`);
    ok(!!f && f.data.assignmentId === asg.id, 'the frame names the assignment');
    ok(!!f && !JSON.stringify(f.data).includes('Jane Doe') && !('values' in f.data), 'the frame carries no values (each page re-reads with its own credential)', JSON.stringify(f?.data));
    const gf = await gfxSub.waitFor(gfxFor(ch, 'values'), 1000);
    ok(!!gf, 'the Graphics-only operator gets it too');
    mark = main.frames.length;
    r = await api('PATCH', `/api/graphics/assignments/${asg.id}/state`, { values: { name: 'Jane Doe' } });
    f = await main.waitFor(gfxFor(ch), 500, mark);
    ok(r.s === 200 && r.j.changed === 0 && !f, 'writing the same value again announces nothing');

    console.log('== on and off air ==');
    mark = main.frames.length; t0 = Date.now();
    r = await api('POST', `/api/graphics/assignments/${asg.id}/air`, { on: true });
    f = await main.waitFor(gfxFor(ch, 'air'), 1000, mark);
    const airMs = f ? f.at - t0 : null;
    ok(r.s === 200 && r.j.state?.onAir === true && !!f, `take on reaches the subscriber (${airMs ?? '-'} ms, bar 1000)`);
    mark = main.frames.length; t0 = Date.now();
    r = await api('POST', `/api/graphics/assignments/${asg.id}/air`, { on: false });
    f = await main.waitFor(gfxFor(ch, 'air'), 1000, mark);
    ok(!!f, `take off reaches the subscriber (${f ? f.at - t0 : '-'} ms)`);
    mark = main.frames.length;
    r = await api('POST', `/api/graphics/assignments/${asg.id}/air`, { on: true, forSec: 1 });
    await main.waitFor(gfxFor(ch, 'air'), 1000, mark);
    mark = main.frames.length;
    await tick(new Date(Date.now() + 2000));
    f = await main.waitFor(gfxFor(ch, 'air'), 1000, mark);
    const st = await one<any>(`SELECT on_air FROM gfx_state WHERE assignment_id = $1`, [asg.id]);
    ok(!!f && st?.on_air === false, 'the off timer taking it off is announced (the tick, no operator)');

    console.log('== a pushed feed ==');
    r = await api('POST', '/api/graphics/assignments', { setupId: feedSetup.id, channelId: ch, targets: 'player', runMode: 'always' });
    const feedAsg = r.j;
    mark = main.frames.length; t0 = Date.now();
    r = await api('POST', `/api/graphics/sources/${push.id}/push`, { who: 'Sam Lee' });
    f = await main.waitFor(gfxFor(ch, 'feed'), 1000, mark);
    ok(r.s === 200 && r.j.changed && !!f, `a pushed payload is announced on the channel showing it (${f ? f.at - t0 : '-'} ms)`);
    r = await api('GET', `/api/graphics/assignments/${feedAsg.id}/state`);
    ok(r.j.values?.name === 'Sam Lee', 'and the re-read shows the new value');
    mark = main.frames.length;
    r = await api('POST', `/api/graphics/sources/${push.id}/push`, { who: 'Sam Lee' });
    f = await main.waitFor(gfxFor(ch, 'feed'), 400, mark);
    ok(!r.j.changed && !f, 'the same payload again announces nothing');

    console.log('== event rundown ==');
    mark = main.frames.length;
    r = await api('POST', `/api/graphics/rundowns/${ev}/items`, { title: 'Captain', setupId: superSetup.id, values: { name: 'A. Captain', title: 'Captain' } });
    const item = r.j.items?.[0];
    f = await main.waitFor(gfxFor(ev, 'rundown'), 1000, mark);
    ok(r.s === 201 && !!f && f.data.kind === 'event', 'adding a rundown item is announced on the event (other operators follow it)');
    mark = main.frames.length; t0 = Date.now();
    r = await api('POST', `/api/graphics/rundowns/${ev}/take`, {});
    f = await main.waitFor(gfxFor(ev, 'rundown'), 1000, mark);
    ok(r.s === 200 && r.j.taken?.itemId === item?.id && !!f, `take next reaches the subscriber (${f ? f.at - t0 : '-'} ms)`);
    mark = main.frames.length;
    r = await api('POST', `/api/graphics/rundowns/${ev}/take-off`, {});
    f = await main.waitFor(gfxFor(ev, 'rundown'), 1000, mark);
    ok(r.s === 200 && r.j.takenOff === 1 && !!f, 'take off is announced');

    console.log('== setup edits ==');
    mark = main.frames.length;
    r = await api('PATCH', `/api/graphics/setups/${superSetup.id}`, { name: 'Presenter super (2)' });
    const chF = await main.waitFor(gfxFor(ch, 'setup'), 1000, mark);
    const evF = await main.waitFor(gfxFor(ev, 'setup'), 1000, mark);
    ok(r.s === 200 && !!chF && !!evF, 'a setup edit is announced on every stream that uses it (the channel and the event)');

    console.log('== time: a rule graphic at a programme boundary ==');
    r = await api('POST', '/api/graphics/assignments', { setupId: newsSetup.id, channelId: ch, targets: 'burn', runMode: 'rule', rule: { genre: 'News' } });
    r = await api('GET', `/api/graphics/live?channel_id=${ch}`);
    const newsNow = r.j.items.find((i: any) => i.setupId === newsSetup.id);
    ok(newsNow?.onAir === true, 'the News strap is on during Midday News', newsNow?.reason);
    resetLiveWatch();
    const at = new Date();
    mark = main.frames.length;
    await watchLive(at);
    await watchLive(at);
    f = await main.waitFor(gfxFor(ch, 'tick'), 300, mark);
    ok(!f, 'the watch announces nothing while nothing changes (first sight only records)');
    const later = new Date(now + 2 * 60_000);
    const n = await watchLive(later);
    f = await main.waitFor(gfxFor(ch, 'tick'), 1000, mark);
    r = await api('GET', `/api/graphics/live?channel_id=${ch}`);
    ok(n >= 1 && !!f, 'when Afternoon Sport starts the strap goes off with no write, and the watch announces it');

    console.log('== who receives what ==');
    ok(!otherSub.frames.some((x) => x.event === 'gfx'), 'another account receives none of these frames', String(otherSub.frames.filter((x) => x.event === 'gfx').length));
    ok(!liveSub.frames.some((x) => x.event === 'gfx'), 'a role without Graphics receives no gfx frames');
    const sMark = liveSub.frames.length, gMark = gfxSub.frames.length, mMark = main.frames.length;
    await applyReport({ kind: 'channel', id: ch, status: { output_available: true, active_source: 'primary', fallback_in_use: false, filler_in_use: false, packager_ok: true, sources: {}, seq: 1, boot_ms: Date.now() } });
    const sF = await liveSub.waitFor((x) => x.event === 'status' && x.data?.id === ch, 1000, sMark);
    const mF = await main.waitFor((x) => x.event === 'status' && x.data?.id === ch, 1000, mMark);
    await sleep(200);
    ok(!!sF && !!mF, 'status frames still reach live status viewers');
    ok(!gfxSub.frames.slice(gMark).some((x) => x.event === 'status' || x.event === 'event'), 'a Graphics-only role receives no status snapshots');

    console.log('== the consoles stop polling ==');
    const web = join(__dirname, '../../volt-web/src');
    const lc = readFileSync(join(web, 'graphics/LiveControl.tsx'), 'utf8');
    const er = readFileSync(join(web, 'graphics/EventRundown.tsx'), 'utf8');
    const cg = readFileSync(join(web, 'graphics/ChannelGraphics.tsx'), 'utf8');
    const ls = readFileSync(join(web, 'liveStatus.ts'), 'utf8');
    ok(!/setInterval\(load, 1000\)/.test(lc) && /useGfxLive\(/.test(lc), 'live control has no one-second poll and follows gfx frames');
    ok(!/setInterval\(load, 2000\)/.test(er) && /useGfxLive\('event'/.test(er), 'the running rundown has no two-second poll');
    ok(!/setInterval\([^\n]*gfx\.live/.test(cg) && /useGfxLive\('channel'/.test(cg), 'the channel graphics tab has no five-second poll');
    ok(/addEventListener\('gfx'/.test(ls) && /gfx:\$\{msg\.kind\}:\$\{msg\.id\}/.test(ls), 'the shared client routes gfx frames to their own keys');
  } finally {
    for (const s of subs) s.close();
    srv.close();
    await query(`DELETE FROM accounts WHERE id = ANY($1::uuid[])`, [[acct, other]]).catch((e) => console.error('cleanup', e.message));
    await pool.end().catch(() => {});
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
