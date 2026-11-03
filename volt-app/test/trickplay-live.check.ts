// ============================================================================
//  TRICK-PLAY ON LIVE CHANNELS AND EVENTS: THE ENCODER'S JOB (build queue 3.2b-3).
//
//  The switch is on the group's output profile; the control plane passes it to
//  the encoder in the job config at start (encoder.py build_shaka asks the
//  packager for an I-frame playlist per video rendition). Checked here:
//    - off (the default): the job carries no trick_play at all, so the config
//      an encoder sees is exactly the one it saw before 3.2b-3;
//    - on: trick_play true, for transcode and package-only, HLS or both;
//    - a DASH-only profile: not sent (no HLS master to list them in).
//  The packager side is volt-encoder/dev/test_trick_play.py; the rights
//  variant side is edge-variant-manifests.check.ts.
//
//  Usage: npx tsx test/trickplay-live.check.ts   (no database)
// ============================================================================
let pass = 0, fail = 0;
const ok = (c: unknown, m: string, d?: unknown) => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log('FAIL ' + m + (d !== undefined ? ' -- ' + JSON.stringify(d) : '')); } };

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { buildEncoderJobConfig } = require('../src/services/jobConfig');
const base: any = {
  kind: 'channel', owner: { id: 'ch1' }, account: {},
  inputs: [{ role: 'primary', rendition_label: null, rendition_bitrate_kbps: null, protocol: 'srt', ingest_url: 'srt://x', stream_key: null }],
  profile: { rungs: [{ height: 720, bitrate_kbps: 2500 }], packaging: 'both', workflow_type: 'transcode', codec_backend: 'x264', segment_dur: 4, dvr_window_sec: 60 },
};
const job = (profile: Record<string, unknown>, extra: Record<string, unknown> = {}) => buildEncoderJobConfig({ ...base, ...extra, profile: { ...base.profile, ...profile } });

const off = job({});
ok(!('trick_play' in off), 'off by default: the job has no trick_play key');
ok(!('trick_play' in job({ trick_play: false })), 'switched off: no key either');
ok(job({ trick_play: true }).trick_play === true, 'on, HLS and DASH: trick_play true');
ok(job({ trick_play: true, packaging: 'hls' }).trick_play === true, 'on, HLS only: true');
ok(!('trick_play' in job({ trick_play: true, packaging: 'dash' })), 'on, DASH only: not sent (no HLS master)');
const pkg = job({ trick_play: true, workflow_type: 'package_only' }, {
  inputs: [{ role: 'primary', rendition_label: '1080p', rendition_bitrate_kbps: 6000, protocol: 'srt', ingest_url: 'srt://y', stream_key: null }] });
ok(pkg.trick_play === true, 'package-only: true as well');
ok(job({ trick_play: true }, { kind: 'event', owner: { id: 'ev1' } }).trick_play === true, 'an event: the same');
const { trick_play: _t, ...rest } = job({ trick_play: true });
ok(JSON.stringify(rest) === JSON.stringify(off), 'nothing else in the job changes');

console.log(`\ntrickplay-live: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
