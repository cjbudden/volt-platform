// ============================================================================
//  THE DOCS SEED CAN AIR A FAST CHANNEL (build queue 1.14-G5c).
//
//  The FAST guides need a channel with a run order and a week to show. The
//  docs seed (scripts/seed-docs.ts) used to have no title that FAST could use:
//  every seeded asset was a row with neither packaged media nor a source file,
//  so the builder's library was empty. This runs the real seed into its own
//  clips folder and then, through the real API:
//
//    1. the FAST library for the seeded channel offers the four titles and the
//       three-episode series (all four counted as not shown before the change);
//    2. the draft run order previews a week: the series and the film on a
//       half-hour grid, one pass two hours, 84 passes;
//    3. readiness says each title needs preparing (its source file is here);
//    4. activating writes the guide and queues one encode per title, and the
//       encodes (the real vod_encoder.py, run as the job worker would) leave
//       every title ready to air;
//    5. the FAST playout (fast_playout.py, started by activation) writes the
//       channel's live playlists from those titles' packaged segments.
//
//  Needs DATABASE_URL (a migrated, disposable database), ffmpeg and python3;
//  steps 4 (the encodes) and 5 also need Shaka Packager (PACKAGER_BIN) and are
//  skipped, saying so, without it. About a minute, most of it the encodes.
//  Usage: DATABASE_URL=... npx tsx test/docs-seed-fast.check.ts
// ============================================================================
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0, fail = 0;
const ok = (c: boolean, m: string, d = '') => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log(`FAIL ${m}${d ? ' -- ' + d : ''}`); } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const WORK = mkdtempSync(join(tmpdir(), 'docs-seed-fast-'));
process.env.CLIPS_DIR = join(WORK, 'clips');
process.env.ORIGIN_DIR = join(WORK, 'origin');
process.env.IMAGE_STORE_DIR = join(WORK, 'images');
process.env.FILLER_DIR = join(WORK, 'filler');
process.env.FAST_OUTPUT = 'local';
process.env.ORCH_LAUNCHER = 'local';          // activation starts the playout as a child process
process.env.ORCH_TICK_SECONDS ??= '3600';
process.env.JWT_ACCESS_SECRET ??= 'x';
process.env.JWT_REFRESH_SECRET ??= 'y';
process.env.INGEST_TOKEN ??= 'z';
process.env.PORT = String(18_000 + Math.floor(Math.random() * 2000));

const ACCOUNT = '3de20755-af2b-46d0-8d24-f39afbf4b3a0';
const ADMIN = '8342a24d-751f-46ca-9636-f72a8a1110ef';
// The seed's fixed ids (scripts/seed-docs.ts, DOCS_FAST). Not imported: the
// seed runs itself when loaded.
const DOCS_FAST = {
  channel: '5d0c6a1e-2f4b-4c1a-9e1d-3a7b2c9d0e30',
  lineup: '5d0c6a1e-2f4b-4c1a-9e1d-3a7b2c9d0e31',
  assets: ['32', '33', '34', '35'].map((n) => ({ id: `5d0c6a1e-2f4b-4c1a-9e1d-3a7b2c9d0e${n}` })),
};

(async () => {
  // ---- 0. the seed, exactly as the screenshot run uses it
  const seed = spawnSync(join(__dirname, '../node_modules/.bin/tsx'), [join(__dirname, '../scripts/seed-docs.ts')], {
    cwd: join(__dirname, '..'), env: process.env, encoding: 'utf8',
  });
  ok(seed.status === 0, 'seed-docs.ts runs', (seed.stderr || seed.stdout).slice(-600));
  const CH = DOCS_FAST.channel;
  const ids = DOCS_FAST.assets.map((a) => a.id as string);
  for (const id of ids) ok(existsSync(join(WORK, 'clips', 'vod-src', `${id}.mp4`)), `source file for ${id.slice(-2)} is under clips/vod-src`);

  const { query, pool } = await import('../src/db');
  const { signAccess } = await import('../src/auth/jwt');
  const { createServer } = await import('../src/server');
  const app: any = createServer();
  const srv = app.listen(Number(process.env.PORT));
  await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${process.env.PORT}`;
  const tok = signAccess({ sub: ADMIN, account_id: ACCOUNT, role: 'owner' } as any);
  const api = async (method: string, path: string, body?: any) => {
    const res = await fetch(base + path, { method, headers: { authorization: `Bearer ${tok}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const t = await res.text(); let j: any = null; try { j = JSON.parse(t); } catch { j = t; }
    return { s: res.status, j };
  };

  try {
    // ---- 1. the builder's library
    console.log('== the FAST library offers the seeded titles ==');
    const lib = await api('GET', `/api/fast/library?channel=${CH}`);
    ok(lib.s === 200, 'library answers', JSON.stringify(lib.j).slice(0, 200));
    const titles = new Set((lib.j.assets ?? []).map((a: any) => a.id));
    ok(ids.every((id) => titles.has(id)), `all four titles are offered (${[...titles].filter((t) => ids.includes(t as string)).length}/4)`);
    const series = (lib.j.series ?? []).find((s: any) => s.name === 'Coastal Kitchens');
    ok(series?.episodes === 3 && series?.seasons?.join() === '1', 'Coastal Kitchens is one series of three episodes', JSON.stringify(series));

    // ---- 2. the draft run order and its week
    console.log('== the draft run order previews a week ==');
    const chan = await api('GET', `/api/fast/channels/${CH}`);
    const draft = (chan.j.lineups ?? []).find((l: any) => l.id === DOCS_FAST.lineup);
    ok(chan.s === 200 && draft?.status === 'draft' && draft.slots.length === 2, 'the channel has its draft run order with two slots', JSON.stringify(chan.j).slice(0, 300));
    ok(chan.j.channel?.name === 'Food & Travel' && chan.j.channel?.media === 'video', 'a video FAST channel with a neutral name');
    const pv = await api('POST', `/api/fast/lineups/${DOCS_FAST.lineup}/preview`, { days: 7 });
    ok(pv.s === 200, 'preview answers', JSON.stringify(pv.j).slice(0, 200));
    const progs: any[] = pv.j.programmes ?? [];
    ok(progs.length > 300, `a week of programmes (${progs.length})`);
    const seen = new Set(progs.map((p) => p.assetId ?? p.asset_id ?? p.title));
    ok(['Harbour Market', 'Smoke and Salt', 'The Night Bakery', 'A Quiet Valley'].every((t) => progs.some((p) => p.title === t)), 'every title airs in the week', [...seen].slice(0, 6).join(', '));
    const offGrid = progs.slice(1).filter((p) => new Date(p.start).getUTCMinutes() % 30 !== 0 || new Date(p.start).getUTCSeconds() !== 0);
    ok(offGrid.length === 0, 'after the first, every programme starts on the half hour', offGrid.slice(0, 2).map((p) => p.start).join(' '));
    ok(pv.j.rotation?.lengthSec === 7200 && pv.j.rotation?.passesPerWeek === 84, `one pass is two hours, 84 a week (${pv.j.rotation?.lengthSec} s, ${pv.j.rotation?.passesPerWeek})`);

    // ---- 3. readiness before
    const before = await api('GET', `/api/fast/channels/${CH}/readiness`);
    const states = (before.j.items ?? before.j ?? []).map((r: any) => r.state);
    ok(states.length === 4 && states.every((s: string) => s === 'needs-prepare'), `each title needs preparing, none is missing its source (${states.join(', ')})`);

    // ---- 4. activate, encode, ready
    console.log('== activating prepares the titles ==');
    const act = await api('POST', `/api/fast/lineups/${DOCS_FAST.lineup}/activate`, {});
    ok(act.s === 200, 'activate answers', JSON.stringify(act.j).slice(0, 300));
    ok((act.j.prepared?.queued ?? []).length === 4 && !(act.j.prepared?.skipped ?? []).length, `four encodes queued, none skipped (${(act.j.prepared?.queued ?? []).length})`);
    ok(act.j.playout === 'running', `the playout started (${act.j.playout})`);
    const guide = await query<any>(`SELECT count(*)::int AS n FROM programmes WHERE channel_id = $1`, [CH]);
    ok(guide[0].n > 300, `the guide is written (${guide[0].n} programmes)`);

    // The encode packages with Shaka Packager (vod_encoder.py, PACKAGER_BIN).
    // Where it is missing (a Linux test box without it) the encode and the
    // playout cannot run: said so, not counted as passed.
    const packager = process.env.PACKAGER_BIN || 'packager';
    if (spawnSync(packager, ['--version'], { stdio: 'ignore' }).status !== 0) {
      console.log(`SKIP encode and air: the packager is needed (${packager} does not run here); on the Mac: PACKAGER_BIN=<path to packager> node scripts/check.js docs-seed-fast`);
    } else {
      const { claim, succeed, fail: failJob } = await import('../src/services/jobs/queue');
      const { handleVodEncode } = await import('../src/services/jobs/handlers/vodEncode');
      const t0 = Date.now();
      for (let i = 0; i < 4; i++) {
        const job = await claim(['vod.encode'], 'docs-seed-fast');
        if (!job) break;
        try { await succeed(job.id, (await handleVodEncode({ job, progress: async () => {}, isCancelled: () => false } as any)) ?? undefined); }
        catch (e: any) { await failJob(job.id, String(e?.message ?? e)); console.log(`encode failed: ${e?.message ?? e}`); }
      }
      console.log(`   four encodes in ${Math.round((Date.now() - t0) / 1000)} s`);
      const after = await api('GET', `/api/fast/channels/${CH}/readiness`);
      const ready = (after.j.items ?? after.j ?? []);
      ok(ready.length === 4 && ready.every((r: any) => r.state === 'ready'), `every title is ready to air (${ready.map((r: any) => `${r.title}: ${r.state}${r.why ? ' ' + r.why : ''}`).join('; ')})`);

      // ---- 5. the playout airs them
      console.log('== the playout writes the channel from the titles ==');
      const out = join(WORK, 'origin', CH, 'fast');
      let media = '';
      for (let i = 0; i < 60 && !/\/clips\/vod\/[0-9a-f-]{36}\//.test(media); i++) {
        await sleep(1000);
        if (!existsSync(out)) continue;
        for (const f of readdirSync(out).filter((f) => f.endsWith('.m3u8') && !/master/.test(f))) media += readFileSync(join(out, f), 'utf8');
      }
      ok(existsSync(join(out, 'master.m3u8')), 'master.m3u8 written');
      const used = [...new Set([...media.matchAll(/\/clips\/vod\/([0-9a-f-]{36})\//g)].map((m) => m[1]))];
      ok(used.length > 0 && used.every((u) => ids.includes(u)), `its segments are the seeded titles' packaged media (${used.map((u) => u.slice(-2)).join(', ')})`, media.slice(0, 400));
    }
  } finally {
    const { stopPlayout } = await import('../src/services/fast/playoutRunner');
    await stopPlayout(CH, 'test over').catch(() => null);
    srv.close();
    await pool.end().catch(() => null);
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
