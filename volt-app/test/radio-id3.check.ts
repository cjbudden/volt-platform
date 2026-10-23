// ============================================================================
//  NOW-PLAYING IN THE AUDIO SEGMENTS: ID3 in emsg for radio HLS and DASH.
//
//  A station's title changes arrive as ICY on the ingest side and land in the
//  content log. This suite runs the whole path with a synthetic ICY source
//  (test/icecast-sim.js, titles rotating every few seconds):
//
//    the REAL ICY reader          writes each change to the content log
//    the timed-events endpoint    hands the changes to the encoder (now_playing)
//    the REAL radio container     bin/radio.py, local mode, ffmpeg from the sim,
//                                 polling that endpoint and writing the tags
//
//  then reads the delivered playlists and segments back with its own box and
//  ID3 parsers (not the encoder's), and checks every tag against the log:
//  right title and artist, at or after the moment the title changed and never
//  more than a segment plus a poll late; every change in the window carried;
//  ffmpeg's own files (what recordings and clips read) left untouched; audio in
//  the tagged copies byte-identical to the originals.
//
//  Placement details on fixed inputs are volt-encoder/bin/test_id3_emsg.py.
//  Usage: DATABASE_URL=... npx tsx test/radio-id3.check.ts
// ============================================================================
import { spawn, spawnSync, ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pool, query } from '../src/db';
import { id3Fields } from '../src/services/radio/nowPlayingTimeline';

let pass = 0, fail = 0;
const ok = (m: string) => { console.log('PASS ' + m); pass++; };
const bad = (m: string, d: string) => { console.log(`FAIL ${m} -- ${d}`); fail++; };
const check = (m: string, got: unknown, want: unknown) =>
  JSON.stringify(got) === JSON.stringify(want) ? ok(m) : bad(m, `expected [${JSON.stringify(want)}] got [${JSON.stringify(got)}]`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- an independent reader: ISO BMFF boxes, emsg v1, ID3v2.4 ---------------
type Box = { type: string; off: number; size: number };
function boxes(b: Buffer, start = 0, end = b.length): Box[] {
  const out: Box[] = [];
  for (let i = start; i + 8 <= end;) {
    const size = b.readUInt32BE(i);
    if (size < 8 || i + size > end) break;
    out.push({ type: b.toString('latin1', i + 4, i + 8), off: i, size });
    i += size;
  }
  return out;
}
function tfdt(seg: Buffer): number | null {
  const moof = boxes(seg).find((x) => x.type === 'moof'); if (!moof) return null;
  const traf = boxes(seg, moof.off + 8, moof.off + moof.size).find((x) => x.type === 'traf'); if (!traf) return null;
  const t = boxes(seg, traf.off + 8, traf.off + traf.size).find((x) => x.type === 'tfdt'); if (!t) return null;
  return seg[t.off + 8] === 1 ? Number(seg.readBigUInt64BE(t.off + 12)) : seg.readUInt32BE(t.off + 12);
}
function mdhdTimescale(init: Buffer): number | null {
  let range: [number, number] = [0, init.length];
  for (const t of ['moov', 'trak', 'mdia', 'mdhd']) {
    const b = boxes(init, range[0], range[1]).find((x) => x.type === t); if (!b) return null;
    if (t === 'mdhd') return init.readUInt32BE(b.off + (init[b.off + 8] === 1 ? 28 : 20));
    range = [b.off + 8, b.off + b.size];
  }
  return null;
}
const syncsafe = (b: Buffer, i: number) => (b[i] << 21) | (b[i + 1] << 14) | (b[i + 2] << 7) | b[i + 3];
function id3(b: Buffer): Record<string, string> | null {
  if (b.toString('latin1', 0, 3) !== 'ID3' || b[3] !== 4) return null;
  const end = 10 + syncsafe(b, 6); const out: Record<string, string> = {};
  for (let i = 10; i + 10 <= end;) {
    const id = b.toString('latin1', i, i + 4); const size = syncsafe(b, i + 4);
    if (id[0] === 'T' && b[i + 10] === 3) out[id] = b.toString('utf8', i + 11, i + 10 + size);
    i += 10 + size;
  }
  return out;
}
interface Emsg { version: number; timescale: number; pt: number; id: number; scheme: string; value: string; tags: Record<string, string> | null }
function emsgs(seg: Buffer): Emsg[] {
  return boxes(seg).filter((x) => x.type === 'emsg').map((x) => {
    const v = seg[x.off + 8]; let p = x.off + 12;
    const timescale = seg.readUInt32BE(p); const pt = Number(seg.readBigUInt64BE(p + 4)); const id = seg.readUInt32BE(p + 16); p += 20;
    const se = seg.indexOf(0, p); const scheme = seg.toString('utf8', p, se);
    const ve = seg.indexOf(0, se + 1); const value = seg.toString('utf8', se + 1, ve);
    return { version: v, timescale, pt, id, scheme, value, tags: id3(seg.subarray(ve + 1, x.off + x.size)) };
  });
}
const fromMoof = (seg: Buffer) => { const m = boxes(seg).find((x) => x.type === 'moof'); return m ? seg.subarray(m.off) : Buffer.alloc(0); };

function hlsSegments(text: string): { uri: string; start: number; dur: number }[] {
  const out: { uri: string; start: number; dur: number }[] = [];
  let pdt: number | null = null, dur: number | null = null;
  for (const raw of text.split('\n')) {
    const l = raw.trim();
    if (l.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) pdt = Date.parse(l.slice(25).replace(/([+-]\d\d)(\d\d)$/, '$1:$2')) / 1000;
    else if (l.startsWith('#EXTINF:')) dur = parseFloat(l.slice(8));
    else if (l && !l.startsWith('#')) { if (pdt != null && dur != null) out.push({ uri: l, start: pdt, dur }); pdt = dur = null; }
  }
  return out;
}

(async () => {
  console.log('== how a logged title becomes TIT2 / TPE1 ==');
  check('"Artist - Title" is split', id3Fields('Aurora Skies - Neon Rain', 'Sim FM'), { title: 'Neon Rain', artist: 'Aurora Skies' });
  check('an en dash too', id3Fields('Orange Crush – Infinite Lights', 'Sim FM'), { title: 'Infinite Lights', artist: 'Orange Crush' });
  check('"Title" by Artist', id3Fields('"Wonderful Thing" by Ralfi Pagan on WFMU', 'Sim FM'), { title: 'Wonderful Thing', artist: 'Ralfi Pagan' });
  check('anything else is the title as sent', id3Fields('News bulletin with Dana Reeves', 'Sim FM'), { title: 'News bulletin with Dana Reeves', artist: null });
  check('an empty title (a break) shows the station', id3Fields('', 'Sim FM'), { title: 'Sim FM', artist: null });
  check('a programme the ICY reader classed as content is not split', id3Fields('DJ Max morning show - your calls', 'Sim FM', 'content'), { title: 'DJ Max morning show - your calls', artist: null });
  check('a song is', id3Fields('Aurora Skies - Neon Rain', 'Sim FM', 'song'), { title: 'Neon Rain', artist: 'Aurora Skies' });

  for (const bin of ['ffmpeg', 'python3']) {
    if (spawnSync('which', [bin]).status !== 0) {
      console.log(`SKIP ${bin} not installed: the end-to-end part needs it`);
      console.log(`\n${pass} passed, ${fail} failed`); await pool.end(); process.exit(fail ? 1 : 0);
    }
  }

  console.log('\n== the endpoint: radio gets now_playing, television does not ==');
  const A = '00000000-0000-0000-0000-0000000036a1', PR = '00000000-0000-0000-0000-0000000036a2';
  const G = '00000000-0000-0000-0000-0000000036a3', C = '00000000-0000-0000-0000-0000000036a4', TV = '00000000-0000-0000-0000-0000000036a5';
  await query(`DELETE FROM accounts WHERE id = $1`, [A]);
  await query(`INSERT INTO accounts(id,name) VALUES ($1,'Id3Co')`, [A]);
  await query(`INSERT INTO output_profiles(id,account_id,name,rungs,workflow_type) VALUES ($1,$2,'Audio','[]','package_only')`, [PR, A]);
  await query(`INSERT INTO groups(id,account_id,name,output_profile_id,max_channels,max_concurrent) VALUES ($1,$2,'g',$3,5,5)`, [G, A, PR]);
  await query(`INSERT INTO channels(id,group_id,name,status,kind) VALUES ($1,$2,'Sim FM','live','radio'), ($3,$2,'Id3 TV','live','tv')`, [C, G, TV]);

  const { createServer } = await import('../src/server');
  const { config } = await import('../src/config');
  const app: any = createServer();
  const srv = app.listen(0);
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const poll = async (id: string) => (await fetch(`${base}/api/streams/${id}/timed-events?kind=channel`, { headers: { 'X-Volt-Ingest-Token': config.ingestToken } })).json() as any;
  check('a television channel gets no now_playing', 'now_playing' in (await poll(TV)), false);
  // A schedule only: a station that sends no titles still changes programme.
  const t = Date.now();
  await query(`INSERT INTO programmes(channel_id, title, starts_at, ends_at, status) VALUES ($1,'Breakfast with Sam',$2,$3,'scheduled'), ($1,'The Late Show',$3,$4,'scheduled')`,
    [C, new Date(t - 60_000).toISOString(), new Date(t + 60_000).toISOString(), new Date(t + 3600_000).toISOString()]);
  const sched = (await poll(C)).now_playing;
  check('a station with only a schedule gets its programmes, the one in force first',
    (sched ?? []).map((e: any) => [e.title, e.artist, e.source]), [['Breakfast with Sam', null, 'schedule'], ['The Late Show', null, 'schedule']]);
  await query(`DELETE FROM programmes WHERE channel_id = $1`, [C]);

  console.log('\n== end to end: a synthetic ICY source, the ICY reader, the radio container ==');
  const work = mkdtempSync(join(tmpdir(), 'radio-id3-'));
  const loop = join(work, 'loop.mp3');
  spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=330:beep_factor=4:duration=20',
    '-ac', '2', '-c:a', 'libmp3lame', '-b:a', '128k', loop, '-y']);
  const simPort = 9300 + Math.floor(Math.random() * 500);
  const procs: ChildProcess[] = [];
  const sim = spawn('node', [join(__dirname, 'icecast-sim.js'), String(simPort), loop, '6'], { stdio: 'ignore' }); procs.push(sim);
  await sleep(800);
  const url = `http://127.0.0.1:${simPort}/stream`;
  const { startIcyCapture, stopIcyCapture } = await import('../src/services/radio/icyMeta');
  startIcyCapture(C, url, true);

  const origin = join(work, 'origin');
  const cfg = {
    channel_id: C, url, protocol: 'icecast', source_codec: 'mp3',
    outputs: { hls: true, dash: true, mp3: false }, bitrate_kbps: 96, segment_seconds: 2,
    output: { mode: 'local', dir: origin },
    timed_events: { url: `${base}/api/streams/${C}/timed-events?kind=channel`, token: config.ingestToken, poll_sec: 2 },
  };
  const radio = spawn('python3', [join(__dirname, '..', '..', 'volt-encoder', 'bin', 'radio.py')],
    { env: { ...process.env, JOB_CONFIG_JSON: JSON.stringify(cfg), WORK_DIR: work }, stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(radio);
  let radioLog = '';
  radio.stdout!.on('data', (d) => { radioLog += d; }); radio.stderr!.on('data', (d) => { radioLog += d; });
  const RUN_SEC = Number(process.env.ID3_RUN_SEC || 40);
  await sleep(RUN_SEC * 1000);
  radio.kill('SIGTERM');
  await new Promise((r) => { radio.once('exit', r); setTimeout(r, 8000); });
  stopIcyCapture(C);
  sim.kill();
  srv.close();

  const runId = existsSync(join(origin, 'current_run.txt')) ? readFileSync(join(origin, 'current_run.txt'), 'utf8').trim() : '';
  const run = join(origin, 'runs', runId);
  check('the radio container ran and wrote its run', runId !== '' && existsSync(join(run, 'audio', 'index.m3u8')), true);
  if (!runId) console.log(radioLog.slice(-3000));
  await sleep(1500); // the ICY reader closes its last entry
  const log = (await query<any>(`SELECT id, title, metadata->>'class' AS cls, extract(epoch from starts_at)::float8 AS at FROM programmes
      WHERE channel_id = $1 AND metadata->>'source' = 'icy' ORDER BY starts_at`, [C]))
    .map((r) => ({ id: String(r.id), at: Number(r.at), ...id3Fields(r.title, 'Sim FM', r.cls) }));
  check('the content log splits the sim\'s songs and keeps its talk whole',
    [log.some((e) => e.artist === 'Aurora Skies' && e.title === 'Neon Rain'), log.some((e) => e.title === 'News bulletin with Dana Reeves' && e.artist === null)], [true, true]);
  check('the ICY reader logged the rotating titles (at least five changes)', log.length >= 5, true);
  const byTitle = (tags: Record<string, string> | null) => log.filter((e) => tags && e.title === tags.TIT2 && (e.artist ?? undefined) === tags.TPE1);
  const SEG = 2, LATE = SEG + 2 + 1 + 3; // a segment, a poll, a cycle, and slack for the ICY reader and ffmpeg buffers

  // ---- HLS ------------------------------------------------------------------
  const master = readFileSync(join(run, 'master.m3u8'), 'utf8');
  check('the master leads to the delivered copy', master.includes('audio/index_cc.m3u8'), true);
  const own = readFileSync(join(run, 'audio', 'index.m3u8'), 'utf8');
  const cc = readFileSync(join(run, 'audio', 'index_cc.m3u8'), 'utf8');
  const segs = hlsSegments(cc);
  const tagged = segs.filter((s) => s.uri.startsWith('id3/'));
  check('the delivered playlist points tagged segments at their id3/ copies', tagged.length >= 4, true);
  check('and every other segment at ffmpeg\'s own file', segs.filter((s) => !s.uri.startsWith('id3/')).every((s) => /^seg_\d+\.m4s$/.test(s.uri)), true);
  check('ffmpeg\'s playlist is untouched (no id3/ in it)', own.includes('id3/'), false);
  const ownSegs = readdirSync(join(run, 'audio')).filter((f) => /^seg_\d+\.m4s$/.test(f));
  check('ffmpeg\'s own segments carry no emsg (recordings and clips read these)', ownSegs.every((f) => emsgs(readFileSync(join(run, 'audio', f))).length === 0), true);
  check('no id3/ folder has an init.mp4 (the recording index never mistakes it for a rendition)', existsSync(join(run, 'audio', 'id3', 'init.mp4')), false);

  const frames: { at: number; tags: Record<string, string> | null; e: Emsg }[] = [];
  let sameAudio = true, wellFormed = true;
  for (const s of tagged) {
    const copy = readFileSync(join(run, 'audio', s.uri));
    const orig = readFileSync(join(run, 'audio', s.uri.slice(4)));
    if (!fromMoof(copy).equals(fromMoof(orig))) sameAudio = false;
    const top = boxes(copy).map((x) => x.type);
    if (top.indexOf('emsg') < 0 || top.indexOf('emsg') > top.indexOf('moof') || boxes(copy).reduce((n, x) => n + x.size, 0) !== copy.length) wellFormed = false;
    const base = tfdt(copy)!;
    for (const e of emsgs(copy)) frames.push({ at: s.start + (e.pt - base) / e.timescale, tags: e.tags, e });
  }
  check('the audio in every tagged copy is byte-identical to ffmpeg\'s (moof and mdat)', sameAudio, true);
  check('every tagged copy parses to its end with the emsg ahead of the moof', wellFormed, true);
  const trackTs = mdhdTimescale(readFileSync(join(run, 'audio', 'init.mp4')));
  check('every emsg is version 1, scheme https://aomedia.org/emsg/ID3, on the track\'s own timescale',
    [trackTs != null, frames.every((f) => f.e.version === 1 && f.e.scheme === 'https://aomedia.org/emsg/ID3' && f.e.value === '' && f.e.timescale === trackTs)], [true, true]);
  check('every emsg holds an ID3v2.4 tag with a TIT2', frames.length > 0 && frames.every((f) => !!f.tags?.TIT2), true);
  check('emsg ids are distinct (DASH clients drop a repeated id)', new Set(frames.map((f) => f.e.id)).size, frames.length);
  check('every tag names a title from the log, artist split as logged', frames.every((f) => byTitle(f.tags).length > 0), true);

  // Each tag against the change it carries: never early, at most LATE late.
  const lateness = frames.map((f) => {
    const cands = byTitle(f.tags).filter((e) => e.at <= f.at + 0.05);
    const e = cands[cands.length - 1];
    return e ? f.at - e.at : -1;
  });
  check('no tag is earlier than its change in the log', lateness.every((x) => x >= -0.05), true);
  check(`no tag is more than ${LATE} s after its change`, lateness.every((x) => x <= LATE), true);
  console.log(`  (lateness of ${frames.length} tags: min ${Math.min(...lateness).toFixed(2)} s, max ${Math.max(...lateness).toFixed(2)} s)`);
  // Every change the stream covered (with room for the last one to land) is carried, in order.
  const first = segs[0]?.start ?? 0, last = (segs[segs.length - 1]?.start ?? 0) + SEG;
  const covered = log.filter((e) => e.at >= first && e.at <= last - LATE);
  const carried = covered.filter((e) => frames.some((f) => f.tags?.TIT2 === e.title && f.at >= e.at - 0.05 && f.at <= e.at + LATE));
  check(`every change in the stream's window is carried (${covered.length} changes)`, [covered.length >= 3, carried.length], [true, covered.length]);
  const order = frames.map((f) => f.at);
  check('tags in time order', order.every((x, i) => i === 0 || x >= order[i - 1]), true);

  // ---- DASH -----------------------------------------------------------------
  const mpd = readFileSync(join(run, 'dash', 'manifest_cc.mpd'), 'utf8');
  check('the delivered MPD declares the ID3 InbandEventStream', mpd.includes('<InbandEventStream schemeIdUri="https://aomedia.org/emsg/ID3" value=""/>'), true);
  check('inside the AdaptationSet, ahead of the Representation', mpd.indexOf('InbandEventStream') > mpd.indexOf('<AdaptationSet') && mpd.indexOf('InbandEventStream') < mpd.indexOf('<Representation'), true);
  const media = /media="([^"]+)"/.exec(mpd)?.[1] ?? '';
  check('its SegmentTemplate names the id3/ copies', media.startsWith('id3/'), true);
  const ownMpd = readFileSync(join(run, 'dash', 'manifest.mpd'), 'utf8');
  check('ffmpeg\'s MPD is untouched', ownMpd.includes('id3/') || ownMpd.includes('InbandEventStream'), false);
  const startNumber = Number(/startNumber="(\d+)"/.exec(mpd)?.[1] ?? 1);
  const ts = Number(/<SegmentTemplate[^>]*timescale="(\d+)"/.exec(mpd)?.[1] ?? 1);
  const ast = Date.parse(/availabilityStartTime="([^"]+)"/.exec(mpd)?.[1] ?? '') / 1000;
  const tl: { n: number; start: number }[] = [];
  { let n = startNumber, tt = 0; for (const m of mpd.matchAll(/<S\b([^>]*)\/>/g)) { const a = m[1]; const d = Number(/d="(\d+)"/.exec(a)![1]); const tv = /t="(\d+)"/.exec(a); if (tv) tt = Number(tv[1]); for (let k = 0; k <= Number(/r="(\d+)"/.exec(a)?.[1] ?? 0); k++) { tl.push({ n, start: ast + tt / ts }); n++; tt += d; } } }
  const name = (n: number) => media.replace('$RepresentationID$', '0').replace(/\$Number(?:%0(\d+)d)?\$/, (_, w) => String(n).padStart(Number(w || 0), '0'));
  check('every segment the MPD lists exists in id3/', tl.length > 0 && tl.every((s) => existsSync(join(run, 'dash', name(s.n)))), true);
  const dframes: { at: number; tags: Record<string, string> | null }[] = [];
  let dashSame = true;
  for (const s of tl) {
    const copy = readFileSync(join(run, 'dash', name(s.n)));
    const orig = join(run, 'dash', name(s.n).slice(4));
    if (existsSync(orig) && !fromMoof(copy).equals(fromMoof(readFileSync(orig)))) dashSame = false;
    const base = tfdt(copy)!;
    for (const e of emsgs(copy)) dframes.push({ at: s.start + (e.pt - base) / e.timescale, tags: e.tags });
  }
  check('the DASH copies carry tags', dframes.length > 0, true);
  check('the DASH copies are ffmpeg\'s audio unchanged', dashSame, true);
  const dl = dframes.map((f) => { const c = byTitle(f.tags).filter((e) => e.at <= f.at + 0.05); return c.length ? f.at - c[c.length - 1].at : -1; });
  check(`every DASH tag names a logged title, never early, at most ${LATE} s late`, dl.every((x) => x >= -0.05 && x <= LATE), true);

  await query(`DELETE FROM accounts WHERE id = $1`, [A]);
  procs.forEach((p) => { try { p.kill('SIGKILL'); } catch { /* gone */ } });
  if (process.env.KEEP_WORK === '1') console.log(`  (work dir kept: ${work})`); else rmSync(work, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error(e); await pool.end().catch(() => {}); process.exit(1); });
