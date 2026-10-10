// ============================================================================
//  RADIO ARGV — the pipeline description shared by the control plane and the
//  container.
//
//  This is a pure-function suite on purpose. buildRadioArgs decides what a
//  station actually IS, and it is about to be executed in two places: the
//  in-process path in development, and volt-radio in production. The whole
//  value of extracting it is that those two cannot drift, which is only true
//  if the argv is pinned by something other than "it worked when I ran it".
//
//  The assertions are about the decisions, not the spelling: whether MP3 is
//  copied or re-encoded, whether it goes to a relay or to a pipe, and whether
//  a password can escape into somewhere it should not be.
//
//  Usage: npx tsx test/radio-args.check.ts   (no database, no ffmpeg)
// ============================================================================
import {
  buildRadioArgs, clampBitrate, resolveOutputs, isMp3Copy, icecastUrl,
  redactIcecastUrl, masterPlaylist, type RadioJobConfig, type IcecastTarget,
} from '../src/services/radio/args';

let pass = 0, fail = 0;
const ok = (m: string) => { console.log('PASS ' + m); pass++; };
const bad = (m: string, d: string) => { console.log(`FAIL ${m} -- ${d}`); fail++; };
const check = (m: string, got: unknown, want: unknown) =>
  got === want ? ok(m) : bad(m, `expected [${String(want)}] got [${String(got)}]`);
const truthy = (m: string, v: unknown) => (v ? ok(m) : bad(m, `expected truthy, got [${String(v)}]`));
const falsy = (m: string, v: unknown) => (!v ? ok(m) : bad(m, `expected falsy, got [${String(v)}]`));

const PATHS = { runDir: '/o/ch/runs/R', audioDir: '/o/ch/runs/R/audio', dashDir: '/o/ch/runs/R/dash' };
const RELAY: IcecastTarget = {
  host: 'icecast', port: 8000, mount: 'ch.mp3',
  username: 'source', password: 'p@ss word/1', stationName: 'Test FM',
};
const base = (over: Partial<RadioJobConfig> = {}): RadioJobConfig => ({
  channelId: 'ch', protocol: 'icecast', url: 'http://up.example/stream',
  // MP3 asked for explicitly: it is opt-in now, and a base fixture that did
  // not say so would silently stop exercising the relay path at all.
  outputs: { mp3: true, hls: true, dash: true }, bitrateKbps: 128,
  // The relay IS the default now; `over` can still put it back to null to get
  // the development pipe, which is what the fallback assertions below do.
  icecast: RELAY, ...over,
});
/** The value ffmpeg would receive for a flag, i.e. the token after it. */
const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

// ---- bitrate ---------------------------------------------------------------
check('a sane bitrate is kept', clampBitrate(192), 192);
check('too low is clamped up', clampBitrate(8), 32);
check('too high is clamped down', clampBitrate(9999), 320);
check('nonsense falls back to the default', clampBitrate(undefined), 128);
check('a string that is not a number does not become NaN', clampBitrate('x' as any), 128);

// ---- outputs ---------------------------------------------------------------
// MP3 IS OPT-IN, HLS AND DASH ARE NOT, and the asymmetry is the assertion.
//
// The three used to default together, which hid that they are different kinds
// of thing. HLS and DASH are files this process writes: they cost the same
// whether anybody listens, because nobody is served from here. MP3 is a live
// push to a relay whose bill is EGRESS, and it is the only output with an
// external dependency that can degrade a station. An output nobody asked for
// should not reserve fan-out capacity.
check('MP3 is OFF unless asked for', resolveOutputs(undefined).mp3, false);
check('HLS is on by default', resolveOutputs(undefined).hls, true);
check('DASH is on by default', resolveOutputs(undefined).dash, true);
check('asking for MP3 turns it on', resolveOutputs({ mp3: true }).mp3, true);
check('an explicit false is honoured, not overwritten by the default',
  resolveOutputs({ dash: false }).dash, false);

// ---- copy vs re-encode -----------------------------------------------------
truthy('an mp3 source with transcode off is a copy', isMp3Copy({ sourceCodec: 'mp3' }));
falsy('an mp3 source with transcode ON is not a copy',
  isMp3Copy({ sourceCodec: 'mp3', transcode: true }));
falsy('an aac source is never a copy', isMp3Copy({ sourceCodec: 'aac' }));
falsy('an unprobed source is not assumed to be mp3', isMp3Copy({ sourceCodec: null }));

// ---- the relay topology ----------------------------------------------------
//
// This is the change that lets radio be a container at all: MP3 leaves as a
// PUSH to a relay rather than a pipe the control plane reads.
const relayed = buildRadioArgs(base(), { ...PATHS });
truthy('with a relay configured, MP3 is pushed to icecast',
  relayed.some((a) => a.startsWith('icecast://')));
falsy('and nothing is piped to stdout', relayed.includes('pipe:1'));
truthy('the mount carries the station name for the relay directory',
  relayed.includes('-ice_name') && after(relayed, '-ice_name') === 'Test FM');
check('content type is set, or the relay rejects the source as a bad request',
  after(relayed, '-content_type'), 'audio/mpeg');

const piped = buildRadioArgs(base({ icecast: null }), { ...PATHS });
truthy('with NO relay, MP3 falls back to the stdout pipe', piped.includes('pipe:1'));
falsy('and no icecast url is built', piped.some((a) => a.startsWith('icecast://')));

// ---- credentials -----------------------------------------------------------
//
// The password can only travel inside the URL, because that is the only form
// the icecast protocol takes. So the thing to pin down is that the redacted
// form is genuinely redacted, since that is what gets logged and stored.
const url = icecastUrl(RELAY);
truthy('the url carries the credentials ffmpeg needs', url.includes('source'));
truthy('a password with url-unsafe characters is encoded',
  url.includes(encodeURIComponent('p@ss word/1')));
truthy('a mount without a leading slash still produces one', url.includes(':8000/ch.mp3'));
check('tls selects the secure scheme',
  icecastUrl({ ...RELAY, tls: true }).startsWith('icecast+https://'), true);
const safe = redactIcecastUrl(RELAY);
falsy('the redacted form does NOT contain the password', safe.includes('p@ss'));
truthy('but still says which mount, so it is useful in a log', safe.includes('/ch.mp3'));

// ---- outputs actually switch off -------------------------------------------
const audioOnlyHls = buildRadioArgs(base({ outputs: { mp3: false, hls: true, dash: false } }), { ...PATHS });
falsy('mp3 off means no mp3 destination',
  audioOnlyHls.includes('pipe:1') || audioOnlyHls.some((a) => a.startsWith('icecast://')));
falsy('dash off means no manifest', audioOnlyHls.some((a) => a.endsWith('manifest.mpd')));
truthy('hls on still writes the media playlist',
  audioOnlyHls.some((a) => a.endsWith('/audio/index.m3u8')));

// ---- the source ------------------------------------------------------------
//
// Three different kinds of thing arrive as "the source", and they are not
// interchangeable. The Radio form has always offered all three; the input flags
// only ever described one of them.
const ice = buildRadioArgs(base({ protocol: 'icecast' }), { ...PATHS });
truthy('an http source gets reconnect flags, because pull sources drop',
  ice.includes('-reconnect'));
falsy('and nothing playlist-shaped, because there is no playlist',
  ice.includes('-live_start_index'));

const srt = buildRadioArgs(base({ protocol: 'srt', url: 'srt://host:9000' }), { ...PATHS });
falsy('an srt source gets no reconnect flags: libsrt reconnects itself',
  srt.includes('-reconnect'));
truthy('but does get +genpts, exactly as encoder.py does for contribution TS',
  srt.includes('-fflags') && after(srt, '-fflags') === '+genpts');

// THE ONE THAT MATTERS, and the reason this section grew.
//
// ffmpeg enters a live playlist at live_start_index = -3 by default: three
// segments back from the end. A station whose source uses six second segments
// therefore goes on air EIGHTEEN SECONDS BEHIND REAL TIME and stays there for
// the whole run. It does not look like a fault -- the station is up, the meters
// move -- it is just permanently late, which is the hardest kind of wrong to
// notice. `-1` is the newest complete segment, the closest to live HLS allows.
const hls = buildRadioArgs(base({ protocol: 'hls', url: 'https://cdn.example/master.m3u8' }), { ...PATHS });
check('an HLS source starts one segment back from the live edge (one in hand for -re)', after(hls, '-live_start_index'), '-2');
truthy('and is read at real time, so a source that arrives in 10 s chunks leaves evenly (no Icecast timeouts)',
  hls.includes('-re') && hls.indexOf('-re') < hls.indexOf('-i'));
falsy('a plain Icecast mount is not paced: it already arrives at real time',
  ice.includes('-re'));
check('and does not reuse a connection across a CDN segment host',
  after(hls, '-http_persistent'), '0');
truthy('while still reconnecting: a playlist fetch fails like any other GET',
  hls.includes('-reconnect'));

// A row can say `icecast` and carry a playlist URL, because somebody pasted the
// wrong one into a form that accepts both. Trust the URL over the label: the
// alternative is a source that works and is silently late.
check('a .m3u8 url is treated as a playlist whatever the row says it is',
  after(buildRadioArgs(base({ protocol: 'icecast', url: 'https://cdn.example/live.m3u8' }), { ...PATHS }),
    '-live_start_index'), '-2');
falsy('but a plain mount is not, so ordinary stations are untouched',
  buildRadioArgs(base({ protocol: 'icecast', url: 'https://ice.example/station-128-mp3' }), { ...PATHS })
    .includes('-live_start_index'));

// ---- the master playlist ---------------------------------------------------
truthy('the master advertises AAC, the only codec HLS carries everywhere',
  masterPlaylist(128).includes('mp4a.40.2'));
truthy('and no video variant, because there is no video',
  !/avc1|RESOLUTION/.test(masterPlaylist(128)));

// ---- the two implementations must not drift --------------------------------
//
// The pipeline is described twice: here in TypeScript for the in-process
// development path, and in volt-encoder/bin/radio.py for the container. Two
// implementations of one thing is the drift risk that the extraction was
// supposed to remove, and a comment saying "keep these in sync" is not a
// mechanism. So run BOTH on the same config and diff the argv.
//
// If this fails, one of the two was edited and the other was not, and stations
// behave differently in development and production, which is the single worst
// outcome this whole change could produce.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const RADIO_PY = resolve(__dirname, '../../volt-encoder/bin/radio.py');
if (!existsSync(RADIO_PY) || !spawnSync('python3', ['--version']).stdout) {
  console.log('SKIP radio.py or python3 not reachable, cannot check parity');
} else {
  // snake_case is the container's config spelling; the control plane converts.
  const pyCfg = (c: RadioJobConfig) => ({
    channel_id: c.channelId, protocol: c.protocol, url: c.url,
    outputs: c.outputs, bitrate_kbps: c.bitrateKbps,
    transcode: c.transcode ?? false, source_codec: c.sourceCodec ?? null,
    segment_seconds: c.segmentSeconds ?? 4,
    icecast: c.icecast ? {
      host: c.icecast.host, port: c.icecast.port, mount: c.icecast.mount,
      username: c.icecast.username, password: c.icecast.password,
      station_name: c.icecast.stationName ?? null,
      description: c.icecast.description ?? null,
      genre: c.icecast.genre ?? null, tls: c.icecast.tls ?? false,
    } : null,
  });

  const pyArgs = (c: RadioJobConfig): string[] | string => {
    const r = spawnSync('python3', [
      '-c',
      'import sys,json,os;sys.path.insert(0,os.path.dirname(sys.argv[1]));' +
      'import radio;' +
      'print(json.dumps(radio.build_args(json.loads(sys.argv[2]),' +
      '{"audio":"/o/ch/runs/R/audio","dash":"/o/ch/runs/R/dash"})))',
      RADIO_PY, JSON.stringify(pyCfg(c)),
    ], { encoding: 'utf8' });
    if (r.status !== 0) return `python failed: ${(r.stderr || '').slice(0, 200)}`;
    try { return JSON.parse(r.stdout); } catch { return `unparseable: ${r.stdout.slice(0, 200)}`; }
  };

  const cases: Array<[string, RadioJobConfig]> = [
    ['an mp3 source copied to a relay', base({ sourceCodec: 'mp3' })],
    ['an aac source re-encoded to a relay', base({ sourceCodec: 'aac' })],
    ['a transcode forced on an mp3 source', base({ sourceCodec: 'mp3', transcode: true })],
    ['hls only, no mp3 and no dash', base({ outputs: { mp3: false, hls: true, dash: false } })],
    ['an srt source, so no reconnect flags', base({ protocol: 'srt', url: 'srt://h:9000' })],
    ['an hls playlist source, entered at the live edge',
      base({ protocol: 'hls', url: 'https://cdn.example/master.m3u8' })],
    ['a playlist url on a row labelled icecast',
      base({ protocol: 'icecast', url: 'https://cdn.example/live.m3u8?token=a' })],
    ['a non-default bitrate and segment length', base({ bitrateKbps: 256, segmentSeconds: 6 })],
    ['a tls relay with an awkward password',
      base({ icecast: { ...RELAY, tls: true, password: 'a b/c@d' } })],
  ];

  for (const [name, cfg] of cases) {
    const ts = buildRadioArgs(cfg, { ...PATHS });
    const py = pyArgs(cfg);
    if (typeof py === 'string') { bad(`parity: ${name}`, py); continue; }
    if (JSON.stringify(ts) === JSON.stringify(py)) { ok(`parity: ${name}`); continue; }
    // Show the first divergence rather than two walls of argv.
    const n = Math.max(ts.length, py.length);
    let at = -1;
    for (let i = 0; i < n; i++) if (ts[i] !== py[i]) { at = i; break; }
    bad(`parity: ${name}`, `diverges at arg ${at}: ts=[${ts[at]}] py=[${py[at]}]`);
  }
}

console.log(`\nradio-args: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
