#!/usr/bin/env node
// ============================================================================
//  THE MAC END-TO-END RUN SHEET (build queue 1.15).
//
//  Runs the whole product path against a Volt that is already running on this
//  Mac (bash run-on-mac.sh) and prints PASS, FAIL or SKIP per step:
//
//    preflight   API up, sign in, tools on this machine
//    setup       its own output profile and group, so nothing shared changes
//    sources     two synthetic live HLS sources: primary RED, backup BLUE
//    channel     a transcode channel with failover, a slate on total loss,
//                recording and live captions
//    start       Start; the delivered playlist has segments and is RED
//    air         On air; the public address answers
//    captions    the delivered master carries subtitles and the cues grow
//    rights      a programme that replaces AU now: AU gets the loop, MY the
//                normal stream (admin preview and the view-as origin path)
//    failover    primary lost: BLUE; backup lost too: the slate; primary
//                back: RED again (read from the frames delivered)
//    stop        Stop closes a recording
//    record      the recording has media, the slate marked over its hole, and
//                the rights window left it unchanged (no loop in it)
//    clip        a 20 s clip from the recording is built
//    vod         the clip plays from its own playlist
//    publish     the clip is published
//    radio       a station on a synthetic ICY source: on air over HLS and
//                the source's titles reach now playing
//    event       an event on the same source: start, live, stop, recording
//    fast        a FAST channel airs the clip from a run order
//
//  Every step reads what was actually delivered (playlists, segments, decoded
//  frames). None takes the API's word for it.
//
//  A step SKIPs, and says what to install, when this machine lacks what it
//  needs (packager, faster-whisper, a speech voice), and when a step it
//  depends on did not pass. A SKIP is never counted as a pass.
//
//  Usage:  bash scripts/e2e-mac.sh [--plan] [--only a,b] [--cleanup]
//  See TESTING_WORKFLOWS.md section 8.
// ============================================================================
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync, statSync, createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const env = (k, d) => (process.env[k] ?? '') !== '' ? process.env[k] : d;
const API = env('VOLT_API', 'http://localhost:8080').replace(/\/$/, '');
const EMAIL = env('VOLT_EMAIL', 'admin@rtm.example');      // the demo sign-in run-on-mac.sh prints
const PASSWORD = env('VOLT_PASSWORD', 'volt1234');
const SRC_PORT = Number(env('E2E_SOURCE_PORT', '8790'));
// The encoder pulls the synthetic sources. A native encoder reaches them on
// this machine; the Docker encoder (ENCODER_MODE=docker) needs the host name.
const SRC_HOST = env('E2E_SOURCE_HOST', '127.0.0.1');
const PACKAGER = env('PACKAGER_BIN', 'packager');
const PYTHON = env('PYTHON_BIN', existsSync(join(ROOT, 'volt-encoder/.venv/bin/python3')) ? join(ROOT, 'volt-encoder/.venv/bin/python3') : 'python3');
const ENCODER_MODE = env('E2E_ENCODER', 'native');  // native | docker: docker has its own packager
const SPEED = Number(env('E2E_TIME_SCALE', '1'));     // stretch every wait on a slow machine

const args = process.argv.slice(2);
const PLAN = args.includes('--plan');
const CLEANUP = args.includes('--cleanup');
const onlyArg = args.find((a) => a.startsWith('--only'));
const ONLY = onlyArg ? (onlyArg.includes('=') ? onlyArg.split('=')[1] : args[args.indexOf(onlyArg) + 1] ?? '').split(',').filter(Boolean) : null;

const STAMP = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
const NAME = `E2E ${STAMP}`;
const WORK = mkdtempSync(join(tmpdir(), 'volt-e2e-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms * SPEED));
const has = (cmd, a = ['-version']) => spawnSync(cmd, a, { stdio: 'ignore' }).status === 0;

// ---------------------------------------------------------------- the steps
// needs: tools this machine must have; after: steps that must have passed.
const STEPS = [
  { id: 'preflight', what: 'API up, sign in, tools on this machine', needs: [], after: [] },
  { id: 'setup', what: 'its own output profile (x264 720p and 360p) and group', needs: [], after: ['preflight'] },
  { id: 'sources', what: 'two synthetic live HLS sources (primary RED, backup BLUE)', needs: ['ffmpeg'], after: ['preflight'] },
  { id: 'channel', what: 'transcode channel: failover on, slate on total loss, recording, captions', needs: [], after: ['setup', 'sources'] },
  { id: 'start', what: 'Start: delivered playlist has segments, the picture is the primary (RED)', needs: ['encoder'], after: ['channel'] },
  { id: 'air', what: 'On air: the public address answers with a playlist', needs: [], after: ['start'] },
  { id: 'captions', what: 'subtitles in the delivered master; cues grow (with text, given speech)', needs: ['whisper'], after: ['start'] },
  { id: 'rights', what: 'AU at a replace time gets the loop, MY the normal stream (preview and public address)', needs: [], after: ['air'] },
  { id: 'failover', what: 'primary lost: BLUE; both lost: slate; primary back: RED', needs: [], after: ['start'] },
  { id: 'stop', what: 'Stop ends the run and closes a recording', needs: [], after: ['start'] },
  { id: 'record', what: 'recording has media, the slate over its hole, no loop from the rights window', needs: [], after: ['stop'] },
  { id: 'clip', what: 'a 20 s clip from the recording is built', needs: [], after: ['record'] },
  { id: 'vod', what: 'the clip plays from its own playlist (segments fetched)', needs: [], after: ['clip'] },
  { id: 'publish', what: 'the clip is published', needs: [], after: ['vod'] },
  { id: 'radio', what: 'station on a synthetic ICY source: on air over HLS, titles reach now playing', needs: ['ffmpeg'], after: ['setup'] },
  { id: 'event', what: 'event on the same source: start, live, stop, a recording', needs: ['encoder'], after: ['setup', 'sources'] },
  { id: 'fast', what: 'FAST channel airs the clip from a run order', needs: ['encoder'], after: ['vod'] },
];

const results = new Map();   // id -> { state: PASS|FAIL|SKIP, notes: [] }
const state = { tools: {}, created: [], procs: [] };
let token = '';

function line(s = '') { process.stdout.write(s + '\n'); }
function note(id, s) { results.get(id).notes.push(s); line(`        ${s}`); }

async function api(method, path, body, opts = {}) {
  const headers = { ...(token && !opts.anon ? { authorization: `Bearer ${token}` } : {}) };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const r = await fetch(API + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
  const text = await r.text();
  let j = null; try { j = JSON.parse(text); } catch { /* a playlist or nothing */ }
  return { s: r.status, j, text };
}
const must = (r, what, codes = [200, 201, 202]) => {
  if (!codes.includes(r.s)) throw new Error(`${what}: HTTP ${r.s} ${(r.j?.error ?? r.text ?? '').toString().slice(0, 300)}`);
  return r.j;
};
async function until(what, fn, sec, every = 2) {
  const end = Date.now() + sec * 1000 * SPEED;
  let last;
  while (Date.now() < end) {
    try { last = await fn(); if (last) return last; } catch (e) { last = undefined; }
    await sleep(every * 1000);
  }
  throw new Error(`${what}: not within ${sec * SPEED} s`);
}
const fetchText = async (url) => { const r = await fetch(url.startsWith('http') ? url : API + url); return { s: r.status, text: await r.text(), url: r.url }; };
const segLines = (pl) => pl.split('\n').filter((l) => l && !l.startsWith('#'));

/** The first media playlist a master names, resolved against the master. */
async function firstVariant(masterUrl) {
  const m = await fetchText(masterUrl);
  if (m.s !== 200) return null;
  const v = segLines(m.text).find((l) => /\.m3u8/.test(l));
  return v ? new URL(v, m.url).toString() : null;
}

/** RED, BLUE, GREEN or OTHER for the newest frame a playlist delivers, decoded
 *  with ffmpeg. Asynchronous on purpose: the synthetic sources are served from
 *  this same process, and a blocking spawn would starve that server. */
function colourOf(playlistUrl) {
  const url = playlistUrl.startsWith('http') ? playlistUrl : API + playlistUrl;
  return new Promise((done) => {
    const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-live_start_index', '-1', '-i', url,
      '-map', '0:v:0', '-frames:v', '1', '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks = [];
    p.stdout.on('data', (d) => chunks.push(d));
    const t = setTimeout(() => p.kill('SIGKILL'), 30000);
    p.on('close', () => {
      clearTimeout(t);
      const b = Buffer.concat(chunks);
      if (b.length < 3) return done({ name: 'NONE', rgb: null });
      const [R, G, B] = [b[0], b[1], b[2]];
      const name = R > 150 && G < 90 && B < 90 ? 'RED' : B > 150 && R < 90 && G < 90 ? 'BLUE' : G > 150 && R < 90 && B < 90 ? 'GREEN' : 'OTHER';
      done({ name, rgb: [R, G, B] });
    });
  });
}

// ------------------------------------------------------- the synthetic sources
// ffmpeg writes a live HLS playlist per colour into WORK; a small HTTP server
// here serves them, and the ICY simulator serves the radio source.
function startHlsSource(name, colour) {
  const dir = join(WORK, name); mkdirSync(dir, { recursive: true });
  const audio = state.tools.speechWav
    ? ['-stream_loop', '-1', '-re', '-i', state.tools.speechWav]
    : ['-re', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000'];
  const a = [
    '-hide_banner', '-loglevel', 'error', '-re', '-f', 'lavfi', '-i', `color=c=${colour}:s=1280x720:r=25`, ...audio,
    '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-g', '50', '-keyint_min', '50',
    '-sc_threshold', '0', '-b:v', '1500k', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k', '-ar', '48000', '-ac', '2',
    '-f', 'hls', '-hls_time', '2', '-hls_list_size', '10', '-hls_flags', 'delete_segments+omit_endlist',
    '-hls_segment_filename', join(dir, 'seg_%05d.ts'), join(dir, 'index.m3u8'),
  ];
  const p = spawn('ffmpeg', a, { stdio: 'ignore' });
  state.procs.push(p);
  return { name, dir, proc: p, url: `http://${SRC_HOST}:${SRC_PORT}/${name}/index.m3u8`, args: a };
}
function stopProc(p) { try { p.kill('SIGKILL'); } catch { /* gone */ } }
function serveWork() {
  const types = { '.m3u8': 'application/vnd.apple.mpegurl', '.ts': 'video/mp2t' };
  const srv = createServer((req, res) => {
    const f = join(WORK, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!f.startsWith(WORK) || !existsSync(f) || !statSync(f).isFile()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': types[extname(f)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    createReadStream(f).pipe(res);
  });
  return new Promise((r, j) => { srv.once('error', j); srv.listen(SRC_PORT, '0.0.0.0', () => r(srv)); });
}

// ------------------------------------------------------------------ each step
class Skip extends Error {}
const skip = (why) => { throw new Skip(why); };

/** An existing transcode group with room, used as it is. Its output profile is
 *  shared with its other channels, so the run never edits it: captions are
 *  checked only if that profile already has them on. */
async function useSharedGroup(id, wanted, why) {
  const groups = must(await api('GET', '/api/groups'), 'list groups');
  const g = wanted ? groups.find((x) => x.id === wanted || x.name === wanted)
    : groups.filter((x) => x.workflow_type === 'transcode' && (x.channel_count + x.radio_count + x.event_count) + 3 <= x.max_channels)
      .sort((a, b) => Number(b.is_default) - Number(a.is_default))[0];
  if (!g) throw new Error(wanted ? `no group ${wanted}` : 'no transcode group with room for three more streams; free some, or set E2E_GROUP');
  state.groupId = g.id; state.sharedGroup = g;
  note(id, `using the existing group "${g.name}" (${why}): profile ${g.profile_name}, captions ${g.captions_enabled ? 'on' : 'off'}; nothing in it is changed`);
}

const run = {
  async preflight(id) {
    const h = await fetchText('/health').catch((e) => ({ s: 0, text: String(e) }));
    if (h.s !== 200) throw new Error(`the API at ${API} does not answer /health (${h.s}). Start it: bash run-on-mac.sh`);
    const r = await api('POST', '/api/auth/login', { email: EMAIL, password: PASSWORD });
    token = r.j?.access ?? r.j?.accessToken ?? r.j?.tokens?.access ?? '';
    if (!token) throw new Error(`sign in as ${EMAIL} refused (HTTP ${r.s}). Set VOLT_EMAIL and VOLT_PASSWORD`);
    const me = must(await api('GET', '/api/auth/me'), 'who am I');
    note(id, `signed in as ${EMAIL} (${me.role ?? me.user?.role ?? 'role ?'}) at ${API}`);
    const t = state.tools;
    t.ffmpeg = has('ffmpeg') && has('ffprobe');
    t.packager = ENCODER_MODE === 'docker' || has(PACKAGER, ['--version']);
    t.encoder = t.ffmpeg && t.packager;
    t.whisper = spawnSync(PYTHON, ['-c', 'import faster_whisper'], { stdio: 'ignore' }).status === 0;
    t.voice = ['say', 'espeak-ng', 'espeak'].find((v) => spawnSync('which', [v], { stdio: 'ignore' }).status === 0) ?? null;
    note(id, `ffmpeg ${t.ffmpeg ? 'yes' : 'NO (brew install ffmpeg)'}; packager ${t.packager ? (ENCODER_MODE === 'docker' ? 'in the Docker encoder' : 'yes') : `NO (${PACKAGER} does not run; set PACKAGER_BIN)`}; ` +
      `faster-whisper ${t.whisper ? 'yes' : `NO (${PYTHON} -m pip install faster-whisper)`}; speech voice ${t.voice ?? 'none (captions are checked without cue text)'}`);
    if (t.ffmpeg && t.voice) {
      const wav = join(WORK, 'speech.wav'), text = 'This is the Volt end to end test. Subtitles are made from the audio. The quick brown fox jumps over the lazy dog.';
      if (t.voice === 'say') {
        spawnSync('say', ['-o', join(WORK, 'speech.aiff'), text]);
        spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', join(WORK, 'speech.aiff'), '-ar', '48000', '-ac', '2', wav]);
      } else spawnSync(t.voice, ['-v', 'en', '-s', '140', '-w', wav, text]);
      if (existsSync(wav) && statSync(wav).size > 1000) t.speechWav = wav;
    }
  },

  async setup(id) {
    if (process.env.E2E_GROUP) return useSharedGroup(id, process.env.E2E_GROUP, 'E2E_GROUP');
    const prof = must(await api('POST', '/api/output-profiles', {
      name: NAME, workflowType: 'transcode', codecBackend: 'x264', packaging: 'both', segmentDur: 4, dvrWindowSec: 300,
      // Light, so a laptop keeps up in real time with captions running too.
      rungs: [{ height: 720, bitrate_kbps: 2500, fps: 25 }, { height: 360, bitrate_kbps: 700, fps: 25 }],
    }), 'create the output profile');
    state.profileId = prof.id ?? prof.profile?.id;
    state.created.push(['output-profile', state.profileId]);
    const gr = await api('POST', '/api/groups', { name: NAME, workflowType: 'transcode', outputProfileId: state.profileId, maxChannels: 6, maxConcurrent: 2 });  // one stream runs at a time, two at a handover
    if (gr.s === 409 || gr.s === 403) {
      // The plan has no room for another group (the demo plan is given out in
      // full). Use an existing transcode group instead and change nothing in it.
      note(id, `no room for a group of its own: ${gr.j?.error ?? gr.s}`);
      await api('DELETE', `/api/output-profiles/${state.profileId}`);
      state.created.pop(); state.profileId = null;
      return useSharedGroup(id, null, 'plan full');
    }
    const g = must(gr, 'create the group');
    state.groupId = g.id ?? g.group?.id;
    state.created.push(['group', state.groupId]);
    note(id, `group "${NAME}" ${state.groupId}, its own profile ${state.profileId}`);
  },

  async sources(id) {
    state.server = await serveWork();
    state.primary = startHlsSource('primary', 'red');
    state.backup = startHlsSource('backup', 'blue');
    await until('both sources writing', async () => existsSync(join(state.primary.dir, 'index.m3u8')) && existsSync(join(state.backup.dir, 'index.m3u8')), 30, 1);
    const c = await until('the primary source decodes', async () => { const x = await colourOf(`http://127.0.0.1:${SRC_PORT}/primary/index.m3u8`); return x.name !== 'NONE' ? x : null; }, 30, 2);
    if (c.name !== 'RED') throw new Error(`the primary source decodes as ${c.name} ${JSON.stringify(c.rgb)}, not RED`);
    note(id, `${state.primary.url} (RED), ${state.backup.url} (BLUE)${state.tools.speechWav ? ', spoken audio' : ', a tone'}`);
  },

  async channel(id) {
    const ch = must(await api('POST', '/api/channels', {
      groupId: state.groupId, name: `${NAME} channel`, kind: 'tv', recordingEnabled: true, dvrWindowSec: 300,
      sources: [{ role: 'primary', protocol: 'hls', ingestUrl: state.primary.url }, { role: 'backup', protocol: 'hls', ingestUrl: state.backup.url }],
      inputFailoverEnabled: true, autoFailback: true, inputLossBehavior: 'slate',
    }), 'create the channel');
    state.channelId = ch.id;
    state.created.push(['channel', ch.id]);
    if (state.tools.whisper && !state.sharedGroup) {
      const cs = must(await api('GET', '/api/account-settings/captions'), 'captions settings');
      const provider = cs.provider ?? cs.account?.provider ?? cs.captionsProvider;
      if (provider === 'none' || provider === null) note(id, 'the account has no captions engine (Admin > Captions): captions will be checked as missing');
      // The profile is this run's own, so turning captions on changes nothing else.
      must(await api('PATCH', `/api/channels/${ch.id}`, { captions: { enabled: true, sourceLang: 'en', targets: [] } }), 'turn captions on');
    }
    const back = must(await api('GET', `/api/channels/${ch.id}`), 'read the channel back');
    note(id, `channel ${ch.id}: ${(back.inputs ?? back.sources ?? []).length || 2} sources, failover ${back.input_failover_enabled ?? back.inputFailoverEnabled ?? '?'}, on loss ${back.input_loss_behavior ?? back.inputLossBehavior ?? '?'}`);
  },

  async start(id) {
    const r = await api('POST', `/api/channels/${state.channelId}/start`);
    must(r, 'Start');
    state.startedAt = Date.now();
    const master = `/origin/${state.channelId}/live/master_cc.m3u8`;
    state.master = master;
    const v = await until('the delivered master names a rendition', () => firstVariant(master), 120, 3);
    state.variant = v;
    await until('the delivered rendition has three segments', async () => segLines((await fetchText(v)).text).length >= 3, 90, 3);
    const c = await until('the delivered picture is the primary (RED)', async () => { const x = await colourOf(v); return x.name === 'RED' ? x : null; }, 60, 4);
    const ch = must(await api('GET', `/api/channels/${state.channelId}`), 'read the channel');
    note(id, `live after ${Math.round((Date.now() - state.startedAt) / 1000)} s, status ${ch.status}, picture ${c.name}`);
    if (ch.status !== 'live') throw new Error(`segments flow but the channel says ${ch.status}`);
  },

  async air(id) {
    must(await api('POST', `/api/channels/${state.channelId}/air`, { on: true }), 'go on air');
    const pub = await until('the public address answers', async () => { const x = await fetchText(`/live/${state.channelId}/master.m3u8`); return x.s === 200 && x.text.startsWith('#EXTM3U') ? x : null; }, 30, 2);
    note(id, `/live/${state.channelId}/master.m3u8 answers ${pub.s} with a playlist`);
  },

  async captions(id) {
    if (state.sharedGroup && !state.sharedGroup.captions_enabled) skip(`the group "${state.sharedGroup.name}" has captions off and its profile is shared, so the run leaves it; set E2E_GROUP to a group whose profile has captions on, or free plan room for the run's own group`);
    const m = await until('SUBTITLES in the delivered master', async () => { const x = await fetchText(state.master); return /TYPE=SUBTITLES/.test(x.text) ? x.text : null; }, 90, 3);
    const uri = (m.match(/TYPE=SUBTITLES[^\n]*URI="([^"]+)"/) ?? [])[1];
    if (!uri) throw new Error('the SUBTITLES entry names no playlist');
    const subs = new URL(uri, new URL(state.master, API)).toString();
    const n0 = segLines((await fetchText(subs)).text).length;
    const grown = await until('the subtitle playlist grows', async () => { const n = segLines((await fetchText(subs)).text).length; return n > n0 ? n : null; }, 60, 4);
    note(id, `subtitle playlist ${uri}: ${n0} then ${grown} cue segments`);
    if (state.tools.speechWav) {
      const words = await until('a cue with words', async () => {
        const pl = await fetchText(subs);
        for (const s of segLines(pl.text).slice(-6)) {
          const t = (await fetchText(new URL(s, subs).toString())).text;
          const cue = t.split('\n').filter((l) => l && !/^(WEBVTT|X-TIMESTAMP|\d\d:|NOTE)/.test(l) && !/-->/.test(l)).join(' ').trim();
          if (cue) return cue;
        }
        return null;
      }, 90, 5);
      note(id, `a cue reads: "${words.slice(0, 80)}"`);
    } else note(id, 'cue text not checked: no speech voice on this machine');
  },

  async rights(id) {
    // A programme from now for ten minutes, replaced for AU by the loop.
    const now = Date.now();
    state.rightsFrom = now - 5000; state.rightsTo = now + 10 * 60 * 1000;
    const p = must(await api('POST', '/api/epg', {
      channelId: state.channelId, title: `${NAME} rights`, startsAt: new Date(state.rightsFrom).toISOString(), endsAt: new Date(state.rightsTo).toISOString(),
      geoMode: 'block', geoCountries: ['AU'], replacementKind: 'loop', replacementRef: 'channel-filler',
    }), 'add the programme with an AU replacement');
    state.rightsProgramme = p.id ?? p.programme?.id;
    const au = must(await api('GET', `/api/channels/${state.channelId}/rights-preview?country=AU`), 'rights preview AU');
    const my = must(await api('GET', `/api/channels/${state.channelId}/rights-preview?country=MY`), 'rights preview MY');
    note(id, `preview: AU ${au.decision} (${au.rule?.reason ?? ''}), loop ready ${au.loopReady}; MY ${my.decision}`);
    if (au.decision !== 'replace' || my.decision !== 'allow') throw new Error(`expected AU replace and MY allow, got ${au.decision} and ${my.decision}`);
    if (!au.play?.hls || !my.play?.hls) throw new Error('the preview gave no play address');
    // What each one is actually given: the AU variant's rendition carries the
    // channel's loop segments, MY's carries none.
    const loopIn = async (masterUrl) => {
      const v = await firstVariant(masterUrl);
      if (!v) return { v: null, loop: -1 };
      const t = (await fetchText(v)).text;
      return { v, loop: segLines(t).filter((l) => /\/filler\//.test(l)).length, all: segLines(t).length };
    };
    const a = await until('the AU variant splices the loop in', async () => { const x = await loopIn(au.play.hls); return x.loop > 0 ? x : null; }, 60, 4);
    const b = await loopIn(my.play.hls);
    note(id, `AU rendition: ${a.loop} of ${a.all} segments from the loop; MY rendition: ${b.loop} of ${b.all}`);
    if (b.loop !== 0) throw new Error('MY was given loop segments');
    // The same on the public address a viewer uses, with the development-only
    // country stand-in (?as=) the Mac's public route honours like the edge.
    const pa = await loopIn(`/live/${state.channelId}/master.m3u8?as=AU`);
    const pm = await loopIn(`/live/${state.channelId}/master.m3u8?as=MY`);
    note(id, `public address as AU: ${pa.loop} of ${pa.all} segments from the loop; as MY: ${pm.loop} of ${pm.all}`);
    if (!(pa.loop > 0) || pm.loop !== 0) throw new Error('the public address does not give AU the loop and MY the normal stream');
  },

  async failover(id) {
    const v = state.variant;
    const seen = [];
    const waitFor = async (want, sec) => {
      const t0 = Date.now();
      const c = await until(`the picture turns ${want}`, async () => { const x = await colourOf(v); seen.push(x.name); return want.includes(x.name) ? x : null; }, sec, 3);
      return { c, s: Math.round((Date.now() - t0) / 1000) };
    };
    stopProc(state.primary.proc);
    const b = await waitFor(['BLUE'], 90);
    note(id, `primary killed: BLUE after ${b.s} s`);
    stopProc(state.backup.proc);
    const s = await waitFor(['OTHER', 'GREEN', 'NONE'], 90);
    note(id, `backup killed too: the slate (${s.c.name} ${JSON.stringify(s.c.rgb)}) after ${s.s} s`);
    state.primary = startHlsSource('primary', 'red');
    state.backup = startHlsSource('backup', 'blue');
    const r = await waitFor(['RED'], 150);
    note(id, `both sources back: RED after ${r.s} s (failback)`);
    const pl = (await fetchText(v)).text;
    note(id, `delivered playlist: ${segLines(pl).length} segments, ${(pl.match(/EXT-X-DISCONTINUITY\b/g) ?? []).length} discontinuities in the window`);
  },

  async stop(id) {
    await sleep(15000); // a little more media after the failback, so the recording ends on the primary
    await api('POST', `/api/channels/${state.channelId}/air`, { on: false });
    must(await api('POST', `/api/channels/${state.channelId}/stop`), 'Stop');
    const ch = await until('the channel ends', async () => { const x = (await api('GET', `/api/channels/${state.channelId}`)).j; return x?.status === 'ended' ? x : null; }, 60, 2);
    const rec = await until('a recording for the run', async () => {
      const l = (await api('GET', `/api/recordings?sourceId=${state.channelId}`)).j;
      const items = l?.items ?? l?.recordings ?? (Array.isArray(l) ? l : []);
      return items[0] ?? null;
    }, 60, 3);
    state.recordingId = rec.id;
    note(id, `channel ${ch.status}; recording ${rec.id} (${rec.status ?? rec.state ?? '?'})`);
  },

  async record(id) {
    const rec = await until('the recording closes', async () => {
      const x = must(await api('GET', `/api/recordings/${state.recordingId}`), 'read the recording');
      const r = x.recording ?? x;
      return (r.end_epoch_ms ?? r.endEpochMs ?? r.ended_at ?? r.endedAt) ? r : null;
    }, 90, 3);
    state.recStart = Number(rec.start_epoch_ms ?? rec.startEpochMs ?? Date.parse(rec.started_at ?? rec.startedAt));
    state.recEnd = Number(rec.end_epoch_ms ?? rec.endEpochMs ?? Date.parse(rec.ended_at ?? rec.endedAt));
    const tl = must(await api('GET', `/api/recordings/${state.recordingId}/timeline`), 'recording timeline');
    const fallbacks = tl.fallbacks ?? [], gaps = tl.gaps ?? [];
    note(id, `${Math.round((state.recEnd - state.recStart) / 1000)} s recorded, ${gaps.length} hole(s), ${fallbacks.length} slate or loop span(s) marked`);
    if (state.recEnd - state.recStart < 30000) throw new Error('less than 30 s recorded');
    if (results.get('failover')?.state === 'PASS' && !fallbacks.length) throw new Error('the slate was on air but the recording marks no fallback over its hole');
    // The rights window replaced AU's copy only: the recording keeps the source.
    const pl = await fetchText(`/api/recordings/${state.recordingId}/range/master.m3u8?from=${state.recStart}&to=${state.recEnd}`);
    const v = pl.s === 200 ? segLines(pl.text).find((l) => /\.m3u8/.test(l)) : null;
    if (v) {
      const t = (await fetchText(new URL(v, API + `/api/recordings/${state.recordingId}/range/master.m3u8`).toString())).text;
      const loop = segLines(t).filter((l) => /\/filler\//.test(l)).length;
      note(id, `recording playlist: ${segLines(t).length} segments, ${loop} from the loop`);
      if (loop) throw new Error('loop segments were recorded');
    } else note(id, `recording range playlist not read (HTTP ${pl.s})`);
  },

  async clip(id) {
    const from = state.recStart + 6000, to = from + 20000;
    const r = await api('POST', `/api/recordings/${state.recordingId}/clip`, { title: `${NAME} clip`, startMs: from, endMs: to, outputKind: 'both' });
    const c = must(r, 'make the clip');
    state.clipId = c.id; state.created.push(['vod', c.id]);
    const job = await until('the clip build finishes', async () => {
      const j = (await api('GET', `/api/jobs/${c.jobId}`)).j;
      if (j?.state === 'failed' || j?.state === 'dead') throw Object.assign(new Error(`clip build ${j.state}: ${j.error ?? j.attempts?.at(-1)?.error ?? ''}`), { final: true });
      return j?.state === 'succeeded' || j?.state === 'done' ? j : null;
    }, 180, 3).catch((e) => { throw e; });
    note(id, `clip ${c.id} built (${c.resolution?.strategy ?? 'strategy ?'}, ${c.resolution?.segments ?? '?'} segments) in job ${job.id}`);
  },

  async vod(id) {
    const a = must(await api('GET', `/api/vod/${state.clipId}`), 'read the clip');
    const key = a.master_key ?? a.masterKey;
    const master = `/clips/${/\.m3u8$/.test(key) ? key : `${key}/master.m3u8`}`;
    const v = await firstVariant(master);
    if (!v) throw new Error(`no playable master at ${master}`);
    const segs = segLines((await fetchText(v)).text);
    const got = await fetch(new URL(segs[0], v)).then((r) => r.status).catch(() => 0);
    const p = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', API + master], { encoding: 'utf8', timeout: 60000 });
    const dur = Number(p.stdout?.trim());
    note(id, `${master}: ${segs.length} segments, first fetched ${got}, ffprobe duration ${dur ? dur.toFixed(1) + ' s' : '?'}`);
    if (got !== 200) throw new Error('the first segment did not load');
    if (dur && Math.abs(dur - 20) > 4) throw new Error(`clip is ${dur.toFixed(1)} s, asked for 20`);
  },

  async publish(id) {
    const r = await api('POST', `/api/vod/${state.clipId}/publish`, {});
    if (r.s === 409 || r.s === 400) throw new Error(`refused: ${r.j?.error ?? r.text.slice(0, 200)}`);
    const out = must(r, 'publish');
    const a = must(await api('GET', `/api/vod/${state.clipId}`), 'read the clip');
    note(id, `state ${out.state}; availability ${a.availability_state ?? a.availabilityState ?? '?'}; ${(out.publications ?? []).length} publication(s)`);
    if (!/published|scheduled|live/.test(String(out.state))) throw new Error(`publish answered state ${out.state}`);
  },

  async radio(id) {
    const mp3 = join(WORK, 'radio.mp3');
    spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=330:beep_factor=4:duration=20', '-ac', '2', '-c:a', 'libmp3lame', '-b:a', '128k', mp3]);
    const port = SRC_PORT + 1;
    // The same ICY simulator the radio suites use: titles change every 6 s.
    const sim = spawn(process.execPath, [join(ROOT, 'volt-app/test/icecast-sim.js'), String(port), mp3, '6'], { stdio: 'ignore' });
    state.procs.push(sim); await sleep(800);
    const st = must(await api('POST', '/api/channels', {
      groupId: state.groupId, name: `${NAME} station`, kind: 'radio', recordingEnabled: true,
      sources: [{ role: 'primary', protocol: 'icecast', ingestUrl: `http://${SRC_HOST}:${port}/stream` }],
      radio: { outputs: { hls: true, dash: false, mp3: false }, metadataCapture: true },
    }), 'create the station');
    state.stationId = st.id; state.created.push(['channel', st.id]);
    must(await api('POST', `/api/radio/${st.id}/start`), 'start the station');
    try {
      const master = `/origin/${st.id}/live/master.m3u8`;
      const v = await until('the station delivers audio segments', async () => {
        const x = await fetchText(master);
        if (x.s !== 200) return null;
        const u = segLines(x.text).find((l) => /\.m3u8/.test(l));
        const pl = u ? new URL(u, API + master).toString() : API + master;
        return segLines((await fetchText(pl)).text).length >= 3 ? pl : null;
      }, 90, 3);
      note(id, `delivered ${v.replace(API, '')}`);
      must(await api('POST', `/api/radio/${st.id}/air`, { on: true }), 'station on air');
      const pub = await until('the station on its public address', async () => { const x = await fetchText(`/live/${st.id}/master.m3u8`); return x.s === 200 && x.text.startsWith('#EXTM3U') ? x : null; }, 30, 2);
      note(id, `on air: /live/${st.id}/master.m3u8 answers ${pub.s}`);
      const np = await until('a title from the source in now playing', async () => {
        const x = (await api('GET', `/api/radio/${st.id}/nowplaying`)).j;
        const t = x?.title ?? x?.now?.title ?? x?.nowPlaying?.title ?? x?.current?.title;
        return t ? x : null;
      }, 60, 3);
      note(id, `now playing: "${np.title ?? np.now?.title ?? np.nowPlaying?.title ?? np.current?.title}"`);
    } finally {
      await api('POST', `/api/radio/${st.id}/stop`);
      stopProc(sim);
    }
  },

  async event(id) {
    if (!state.primary || state.primary.proc.exitCode !== null) state.primary = startHlsSource('primary', 'red');
    const now = Date.now();
    const ev = must(await api('POST', '/api/events', {
      groupId: state.groupId, name: `${NAME} event`, scheduledStart: new Date(now).toISOString(), scheduledEnd: new Date(now + 20 * 60000).toISOString(),
      recordingEnabled: true, sources: [{ role: 'primary', protocol: 'hls', ingestUrl: state.primary.url }],
    }), 'create the event');
    state.eventId = ev.id; state.created.push(['event', ev.id]);
    must(await api('POST', `/api/events/${ev.id}/start`), 'start the event');
    try {
      const v = await until('the event delivers segments', async () => { const u = await firstVariant(`/origin/${ev.id}/live/master.m3u8`); return u && segLines((await fetchText(u)).text).length >= 3 ? u : null; }, 120, 3);
      const c = await colourOf(v);
      const e = must(await api('GET', `/api/events/${ev.id}`), 'read the event');
      note(id, `event ${ev.id} ${e.status}, picture ${c.name}`);
      if (c.name !== 'RED') throw new Error(`the event shows ${c.name}, not the source`);
      await sleep(20000);
    } finally {
      await api('POST', `/api/events/${ev.id}/stop`);
    }
    const rec = await until('the event recording', async () => {
      const l = (await api('GET', `/api/recordings?sourceId=${ev.id}`)).j;
      return (l?.items ?? (Array.isArray(l) ? l : []))[0] ?? null;
    }, 60, 3);
    note(id, `stopped; recording ${rec.id}`);
  },

  async fast(id) {
    const ch = must(await api('POST', '/api/fast/channels', { name: `${NAME} FAST`, groupId: state.groupId, zone: 'UTC', media: 'video' }), 'create the FAST channel');
    state.fastId = ch.id ?? ch.channel?.id; state.created.push(['fast', state.fastId]);
    const lib = must(await api('GET', `/api/fast/library?channel=${state.fastId}`), 'the FAST library');
    const items = lib.items ?? lib;
    if (!items.some((x) => (x.id ?? x.assetId) === state.clipId)) note(id, `the clip is not in the FAST library (${items.length} titles there${lib.hidden ? `, hidden: ${JSON.stringify(lib.hidden).slice(0, 160)}` : ''})`);
    const lu = must(await api('POST', `/api/fast/channels/${state.fastId}/lineups`, {
      name: `${NAME} run order`, zone: 'UTC', slots: [{ id: 's1', kind: 'title', pool: [{ assetId: state.clipId }] }],
    }), 'create the run order');
    const act = must(await api('POST', `/api/fast/lineups/${lu.id}/activate`, {}), 'activate the run order');
    note(id, `run order ${lu.id} active; prepare queued ${(act.prepared?.queued ?? []).length}, skipped ${(act.prepared?.skipped ?? []).length}`);
    await until('every title ready to air', async () => {
      const r = (await api('GET', `/api/fast/channels/${state.fastId}/readiness`)).j;
      const rows = r?.items ?? r ?? [];
      return rows.length && rows.every((x) => x.state === 'ready') ? rows : null;
    }, 300, 5);
    must(await api('POST', `/api/fast/channels/${state.fastId}/on-air`, { on: true }), 'FAST public');
    try {
      const m = `/origin/${state.fastId}/fast/master.m3u8`;
      const v = await until('the FAST playout writes its playlist', async () => { const u = await firstVariant(m); return u && segLines((await fetchText(u)).text).length ? u : null; }, 120, 3);
      const segs = segLines((await fetchText(v)).text);
      const fromClip = segs.filter((s) => s.includes(state.clipId)).length;
      note(id, `${m}: ${segs.length} segments, ${fromClip} from the clip`);
      if (!fromClip) throw new Error('the FAST playlist does not air the clip');
    } finally {
      await api('POST', `/api/fast/channels/${state.fastId}/on-air`, { on: false });
    }
  },
};

// ---------------------------------------------------------------- the runner
async function cleanup() {
  for (const p of state.procs) stopProc(p);
  state.server?.close();
  if (state.channelId) { await api('POST', `/api/channels/${state.channelId}/air`, { on: false }).catch(() => {}); await api('POST', `/api/channels/${state.channelId}/stop`).catch(() => {}); }
  if (!CLEANUP) return;
  // --cleanup removes only what this run made, newest first.
  for (const [kind, cid] of [...state.created].reverse()) {
    const path = { channel: `/api/channels/${cid}`, event: `/api/events/${cid}`, vod: `/api/vod/${cid}`, fast: `/api/channels/${cid}`, group: `/api/groups/${cid}`, 'output-profile': `/api/output-profiles/${cid}` }[kind];
    // The profile goes only once its group has: never leave a group without one.
    if (kind === 'output-profile' && state.keptGroup) { line(`  kept output-profile ${cid}: its group is still there`); continue; }
    const r = await api('DELETE', path).catch((e) => ({ s: String(e), j: null }));
    if (kind === 'group' && !(r.s === 200 || r.s === 204)) state.keptGroup = true;
    line(`  removed ${kind} ${cid}: ${r.s}${r.s === 200 || r.s === 204 ? '' : ` ${r.j?.error ?? ''}`}`);
  }
}

async function main() {
  line(`Volt end-to-end run sheet  ${new Date().toISOString()}  ${PLAN ? '(plan only)' : ''}`);
  line(`API ${API}, sources on ${SRC_HOST}:${SRC_PORT}, encoder ${ENCODER_MODE}, work ${WORK}`);
  line('');
  if (PLAN) {
    for (const s of STEPS) line(`  ${s.id.padEnd(10)} ${s.what}${s.needs.length ? `  [needs ${s.needs.join(', ')}]` : ''}${s.after.length ? `  [after ${s.after.join(', ')}]` : ''}`);
    return 0;
  }
  const stop = async () => { line('\ninterrupted: stopping what this run started'); await cleanup(); process.exit(130); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  for (const s of STEPS) {
    results.set(s.id, { state: 'SKIP', notes: [] });
    if (ONLY && !ONLY.includes(s.id) && s.id !== 'preflight') { results.get(s.id).notes.push('not asked for (--only)'); continue; }
    const blocked = s.after.find((a) => results.get(a)?.state !== 'PASS');
    const missing = s.needs.find((n) => !state.tools[n]);
    const t0 = Date.now();
    if (blocked || missing) {
      const why = blocked ? `needs ${blocked} to pass first` : { ffmpeg: 'ffmpeg is not installed', encoder: `the encoder cannot run here (ffmpeg ${state.tools.ffmpeg ? 'yes' : 'no'}, packager ${state.tools.packager ? 'yes' : 'no'})`, whisper: 'faster-whisper is not installed for the encoder' }[missing];
      results.get(s.id).notes.push(why);
      line(`SKIP  ${s.id.padEnd(10)} ${why}`);
      continue;
    }
    line(`....  ${s.id.padEnd(10)} ${s.what}`);
    try {
      await run[s.id](s.id);
      results.get(s.id).state = 'PASS';
      line(`PASS  ${s.id.padEnd(10)} ${Math.round((Date.now() - t0) / 1000)} s`);
    } catch (e) {
      if (e instanceof Skip) {
        results.get(s.id).state = 'SKIP'; results.get(s.id).notes.push(e.message);
        line(`SKIP  ${s.id.padEnd(10)} ${e.message}`);
        continue;
      }
      results.get(s.id).state = 'FAIL';
      results.get(s.id).notes.push(String(e?.message ?? e));
      line(`FAIL  ${s.id.padEnd(10)} ${String(e?.message ?? e)}`);
    }
  }
  await cleanup();
  const n = (st) => [...results.values()].filter((r) => r.state === st).length;
  line('\n== summary ==');
  for (const s of STEPS) { const r = results.get(s.id); line(`  ${r.state.padEnd(5)} ${s.id.padEnd(10)} ${r.state === 'PASS' ? '' : r.notes.at(-1) ?? ''}`); }
  line(`\n== RESULT: ${n('PASS')} passed, ${n('FAIL')} failed, ${n('SKIP')} skipped ==`);
  if (state.created.length && !CLEANUP) line(`Left in place for a look (named "${NAME}"; run with --cleanup to have a run remove its own at the end). Ids: ${state.created.map(([k, i]) => `${k} ${i}`).join(', ')}`);
  writeFileSync(join(WORK, 'result.json'), JSON.stringify({ at: new Date().toISOString(), api: API, steps: Object.fromEntries(results) }, null, 2));
  line(`Details: ${join(WORK, 'result.json')}`);
  return n('FAIL') ? 1 : 0;
}

main().then((c) => process.exit(c)).catch(async (e) => { line(`run sheet crashed: ${e?.stack ?? e}`); await cleanup().catch(() => {}); process.exit(2); });
