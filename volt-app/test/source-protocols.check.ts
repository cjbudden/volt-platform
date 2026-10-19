// ============================================================================
//  SOURCE TYPES FOR CHANNELS AND EVENTS (docs/SOURCES.md).
//
//  Channels and events take HLS, DASH, SRT, RTMP(S), NDI and ST 2110, for
//  transcoding and packaging, each with its own required settings; Icecast is
//  radio only. The rules are pure (services/ingestProtocols.ts), and the job
//  config carries the settings to the encoder.
//
//  Usage: npx tsx test/source-protocols.check.ts
// ============================================================================
import { INGEST_PROTOCOLS, protocolsFor, validateSource, cleanParams } from '../src/services/ingestProtocols';
import { buildEncoderJobConfig } from '../src/services/jobConfig';
import { sourceProblem } from '../src/services/sourceReadiness';

let pass = 0, fail = 0;
const ok = (c: unknown, m: string, d?: unknown) => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log('FAIL ' + m + (d !== undefined ? ` -- ${JSON.stringify(d)}` : '')); } };

const video = protocolsFor('video').map((p) => p.id);
ok(JSON.stringify(video.sort()) === JSON.stringify(['dash', 'hls', 'ndi', 'rtmp', 'rtmps', 'srt', 'st2110']), 'channels and events offer HLS, DASH, SRT, RTMP(S), NDI, ST 2110', video);
ok(!video.includes('icecast') && protocolsFor('radio').some((p) => p.id === 'icecast'), 'Icecast is for radio only');
ok(INGEST_PROTOCOLS.filter((p) => p.scopes.includes('video')).every((p) => p.packageFriendly), 'every video type can feed a packaging rendition');
ok(INGEST_PROTOCOLS.filter((p) => p.packaging === 'encode').map((p) => p.id).sort().join() === 'ndi,st2110', 'packaging encodes NDI and ST 2110 (uncompressed), remuxes the rest');

const v = (s: Parameters<typeof validateSource>[0]) => validateSource(s, 'video');
ok(/radio stations/.test(v({ protocol: 'icecast', ingestUrl: 'https://ice/x' }) ?? ''), 'a channel refuses Icecast with the reason');
ok(v({ protocol: 'hls', ingestUrl: 'https://cdn/x/master.m3u8' }) === null, 'HLS: a playlist URL is enough');
ok(/should look like/.test(v({ protocol: 'hls', ingestUrl: 'https://cdn/x/master.mpd' }) ?? ''), 'HLS: a non-playlist URL is refused');
ok(v({ protocol: 'dash', ingestUrl: 'https://cdn/x/manifest.mpd' }) === null, 'DASH: an MPD URL is enough');
ok(/required/.test(v({ protocol: 'dash', ingestUrl: '' }) ?? ''), 'an empty address is refused');
ok(v({ protocol: 'srt', ingestUrl: 'srt://src.example.com:9000', params: { mode: 'caller', latency: 200 } }) === null, 'SRT caller with latency');
ok(/passphrase/.test(v({ protocol: 'srt', ingestUrl: 'srt://h:9000', params: { passphrase: 'short' } }) ?? ''), 'SRT: a passphrase under 10 characters is refused');
ok(/Latency/.test(v({ protocol: 'srt', ingestUrl: 'srt://h:9000', params: { latency: 5 } }) ?? ''), 'SRT: latency outside 20 to 8000 ms is refused');
ok(/should look like/.test(v({ protocol: 'srt', ingestUrl: 'srt://h' }) ?? ''), 'SRT: the address needs a port');
ok(/Connection: choose/.test(v({ protocol: 'srt', ingestUrl: 'srt://h:9000', params: { mode: 'rendezvous' } }) ?? ''), 'SRT: only caller or listener');
ok(/stream key/.test(v({ protocol: 'rtmp', ingestUrl: 'rtmp://ingest/live' }) ?? ''), 'RTMP: the stream key is required');
ok(v({ protocol: 'rtmp', ingestUrl: 'rtmp://ingest/live', streamKey: 'abc' }) === null, 'RTMP: URL + key');
ok(v({ protocol: 'rtmp', ingestUrl: 'rtmp://other/app/thekey' }) === null, 'RTMP: a pull URL with the key in its path needs no separate key');
ok(v({ protocol: 'ndi', ingestUrl: 'STUDIO-PC (Camera 1)', params: { discoveryServer: '10.0.0.5:5959', extraIps: '10.0.1.2, 10.0.1.3' } }) === null, 'NDI: source name, discovery server, extra IPs');
ok(/should look like/.test(v({ protocol: 'ndi', ingestUrl: 'Camera 1' }) ?? ''), 'NDI: the name is MACHINE (Source)');
ok(/IPv4/.test(v({ protocol: 'ndi', ingestUrl: 'PC (Cam)', params: { extraIps: 'not-an-ip' } }) ?? ''), 'NDI: extra IPs must be addresses');
ok(/SDP is required/.test(v({ protocol: 'st2110', ingestUrl: '239.10.10.1:5000' }) ?? ''), 'ST 2110: the SDP is required');
ok(v({ protocol: 'st2110', ingestUrl: '239.10.10.1:5000', params: { sdp: 'v=0\no=- 1 1 IN IP4 10.0.0.1', interfaceIp: '192.168.50.10' } }) === null, 'ST 2110: multicast flow + SDP + interface');
ok(/multicast/.test(v({ protocol: 'st2110', ingestUrl: '10.0.0.1:5000', params: { sdp: 'v=0' } }) ?? ''), 'ST 2110: the flow must be multicast');
ok(/SDP is a URL/.test(v({ protocol: 'st2110', ingestUrl: '239.1.1.1:5000', params: { sdp: 'hello' } }) ?? ''), 'ST 2110: the SDP is a URL or SDP text');

const cp = cleanParams('srt', { mode: 'caller', latency: '300', passphrase: '  secretsecret ', junk: 'x', streamid: '' });
ok(JSON.stringify(cp) === JSON.stringify({ mode: 'caller', latency: 300, passphrase: 'secretsecret' }), 'only the protocol\'s own settings are stored, trimmed and typed', cp);

// the job config carries them, and joins RTMP URL + key
const owner = { id: 'c1', input_failover_enabled: false } as any;
const pkgProfile = { rungs: [], packaging: 'both', workflow_type: 'package_only', codec_backend: 'x264', segment_dur: 4, dvr_window_sec: 600 } as any;
const cfg = buildEncoderJobConfig({ kind: 'channel', owner, profile: pkgProfile, inputs: [
  { role: 'primary', rendition_label: '1080p', rendition_bitrate_kbps: 5000, protocol: 'st2110', ingest_url: '239.1.1.1:5000', stream_key: null, params: { sdp: 'v=0' } },
  { role: 'primary', rendition_label: '720p', rendition_bitrate_kbps: 2800, protocol: 'srt', ingest_url: 'srt://h:9000', stream_key: null, params: { latency: 300 } },
  { role: 'primary', rendition_label: '480p', rendition_bitrate_kbps: 1200, protocol: 'rtmp', ingest_url: 'rtmp://ingest/live/', stream_key: 'k480', params: {} },
] });
ok(cfg.inputs[0].encode === true && cfg.inputs[0].params.sdp === 'v=0', 'packaging: an ST 2110 rendition is marked to encode, with its SDP');
ok(!cfg.inputs[1].encode && cfg.inputs[1].params.latency === 300, 'packaging: an SRT rendition is copied, with its latency');
ok(cfg.inputs[2].url === 'rtmp://ingest/live/k480' && !('params' in cfg.inputs[2]), 'RTMP: the key joins the server URL; no empty settings are sent', cfg.inputs[2]);
const tc = buildEncoderJobConfig({ kind: 'event', owner, profile: { ...pkgProfile, workflow_type: 'transcode', rungs: [{ height: 720, bitrate_kbps: 3000 }] }, inputs: [
  { role: 'primary', rendition_label: null, rendition_bitrate_kbps: null, protocol: 'ndi', ingest_url: 'PC (Cam)', stream_key: null, params: { discoveryServer: '10.0.0.5' } },
] });
ok(tc.inputs[0].params.discoveryServer === '10.0.0.5', 'transcode: the NDI settings reach the encoder');

ok(/without its SDP/.test(sourceProblem([{ role: 'primary', protocol: 'st2110', ingest_url: '239.1.1.1:5000', params: {} }]) ?? ''), 'start: an ST 2110 source without its SDP cannot start');
ok(sourceProblem([{ role: 'primary', protocol: 'st2110', ingest_url: '239.1.1.1:5000', params: { sdp: 'v=0' } }]) === null, 'start: with it, it can');

console.log(`\nsource-protocols: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
