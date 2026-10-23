// ============================================================================
//  PLAYBACK STATS: the rules, without a browser (docs/PLAYER_SDK.md section 12).
//
//  What the panel says and what Copy puts on the clipboard are pure functions
//  of a sample (volt-player/src/sdk/stats.ts), so they are checked here: codec
//  names, units, which rows show for live and on-demand, the "optimal" size,
//  merging probes, and that a copied report never carries a playback token.
//  The panel drawn on a real stream is player-stats-browser.check.ts.
//
//  Usage: npx tsx test/player-stats.check.ts
// ============================================================================
import {
  emptySample, combineProbes, statsRows, statsReport, codecName, splitCodecs, redactUrl, hostOf,
  fmtKbps, fmtBytes, fmtSpan, optimalFor, cdnFromHeaders, type StatsSample,
} from '../../volt-player/src/sdk/stats';

let pass = 0, fail = 0;
const ok = (c: unknown, m: string, d?: unknown) => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log('FAIL ' + m + (d !== undefined ? ` -- ${JSON.stringify(d)}` : '')); } };

// --- codecs ---
ok(codecName('avc1.64002a') === 'H.264 High L4.2 (avc1.64002a)', 'H.264 profile and level are read from the codec string', codecName('avc1.64002a'));
ok(codecName('avc1.42e01e') === 'H.264 Baseline L3 (avc1.42e01e)', 'H.264 Baseline', codecName('avc1.42e01e'));
ok(codecName('hvc1.2.4.L120.B0')!.startsWith('HEVC Main 10'), 'HEVC Main 10');
ok(codecName('vp09.00.51.08.01.01.01.01.00')!.startsWith('VP9 ('), 'VP9');
ok(codecName('av01.0.08M.08')!.startsWith('AV1 ('), 'AV1');
ok(codecName('mp4a.40.2') === 'AAC-LC (mp4a.40.2)' && codecName('mp4a.40.5')!.startsWith('HE-AAC'), 'AAC-LC and HE-AAC');
ok(codecName('ec-3')!.startsWith('Dolby Digital Plus') && codecName('opus')!.startsWith('Opus'), 'E-AC-3 and Opus');
ok(codecName('xyz9') === 'xyz9' && codecName(null) === null, 'an unknown codec is shown as it is; none is none');
const sc = splitCodecs('avc1.64001f,mp4a.40.2');
ok(sc.video === 'avc1.64001f' && sc.audio === 'mp4a.40.2', 'a combined CODECS attribute splits into video and audio', sc);

// --- units ---
ok(fmtKbps(5_800_000) === '5800 kbps' && fmtKbps(29_602_000) === '29.6 Mbps' && fmtKbps(null) === '-', 'bitrates: kbps, Mbps above 10 Mbps');
ok(fmtBytes(512) === '512 B' && fmtBytes(312 * 1024) === '312 KB' && fmtBytes(5.5 * 1024 * 1024) === '5.5 MB', 'bytes');
ok(fmtSpan(7200) === '2h 00m' && fmtSpan(95) === '1m 35s' && fmtSpan(0) === '-', 'DVR window spans');

// --- tokens never leave in a report ---
ok(redactUrl('https://cdn.example.com/live/abc/master.m3u8?token=SECRET&exp=1') === 'https://cdn.example.com/live/abc/master.m3u8?…', 'a manifest URL loses its query (tokens)');
ok(redactUrl('https://cdn.example.com/a.m3u8#t=10') === 'https://cdn.example.com/a.m3u8', 'and its fragment');
ok(hostOf('https://edge-syd.cdn.example.com/seg/1.m4s?x=1') === 'edge-syd.cdn.example.com', 'the host of a segment');

// --- optimal size for the box ---
const ladder = [{ width: 1920, height: 1080 }, { width: 1280, height: 720 }, { width: 960, height: 540 }, { width: 640, height: 360 }];
ok(optimalFor(ladder, 793, 2)?.height === 1080, 'a 793 px box on a 2x screen wants 1080p');
ok(optimalFor(ladder, 360, 1)?.height === 360, 'a 360 px box at 1x wants 360p');
ok(optimalFor(ladder, 620, 1)?.height === 540, '620 px at 1x: 540p, not a size the box cannot show');
ok(optimalFor(ladder, 100, 1)?.height === 360, 'a tiny box still gets the smallest rendition');
ok(optimalFor([{ width: null, height: null }], 500, 1) === null, 'audio-only: no optimal size');

// --- CDN headers ---
const cf = cdnFromHeaders((n) => ({ 'x-amz-cf-pop': 'SYD62-P1', 'x-cache': 'Hit from cloudfront', server: 'AmazonS3' } as Record<string, string>)[n], 'https://d123.cloudfront.net/v/1.m4s');
ok(cf?.pop === 'SYD62-P1' && cf?.cache === 'Hit from cloudfront' && cf?.host === 'd123.cloudfront.net', 'CloudFront: the POP and the cache result', cf);
const cfl = cdnFromHeaders((n) => ({ 'cf-ray': '8a1b2c3d4e-SYD', 'cf-cache-status': 'HIT' } as Record<string, string>)[n], null);
ok(cfl?.pop === 'SYD' && cfl?.cache === 'HIT', 'Cloudflare: the POP from cf-ray', cfl);

// --- probes merge, earlier wins, nothing breaks ---
const merged = combineProbes(
  () => ({ assetId: 'ch_1', latency: null }),
  () => { throw new Error('a broken probe'); },
  () => ({ latency: 6.2, assetId: 'ignored', bandwidth: NaN }),
  () => ({ bandwidth: 10_000_000 }),
)();
ok(merged.assetId === 'ch_1' && merged.latency === 6.2, 'the first probe that knows wins; a null leaves room for the next', merged);
ok(merged.bandwidth === 10_000_000, 'a NaN is not an answer: the next probe fills it');

// --- rows: live ---
const live: StatsSample = {
  ...emptySample(),
  assetId: 'ch_42', sessionId: 'web-6f3c2a1e-77aa-4f11-9e0d-1234567890ab', status: 'playing',
  engine: 'Shaka 4.16.46 (MSE)', format: 'HLS', manifest: 'https://cdn.volt.example/live/ch_42/master.m3u8?token=SECRET',
  viewport: { w: 1409, h: 793, dpr: 2 }, frames: { dropped: 8, total: 601 },
  res: { w: 1920, h: 1080, fps: 30 }, optimal: { w: 1920, h: 1080, fps: 30 }, volume: 1, muted: false,
  videoCodec: 'vp09.00.51.08.01.01.01.01.00', audioCodec: 'mp4a.40.2', audioChannels: 2, sampleRate: 48000,
  bitrate: 5_800_000, abr: 'auto', bandwidth: 29_602_000, bytes: 50 * 1024 * 1024, buffer: 45.11,
  live: true, latency: 6.2, targetLatency: 6, lowLatency: false, dvrWindow: 7200, segmentDuration: 4,
  cdn: { host: 'cdn.volt.example', pop: 'SYD62-P1', cache: 'Hit from cloudfront', server: null },
  stalls: 1, stallSeconds: 2.4, errors: 0, programme: 'The Evening News', wallClock: Date.UTC(2026, 9, 22, 18, 9, 58),
};
const rows = statsRows(live, 320 * 1024);
const by = (k: string) => rows.find((r) => r.key === k);
ok(rows[0].key === 'ids' && by('ids')!.value.startsWith('ch_42 / web-6f3c2a1e'), 'asset and session first (what support asks for)', rows[0]);
ok(by('viewport')!.value === '1409×793*2.00 / 8 dropped of 601', 'viewport and dropped frames', by('viewport')?.value);
ok(by('res')!.value === '1920×1080@30 / 1920×1080@30', 'current and optimal resolution', by('res')?.value);
ok(by('codecs')!.value.includes('VP9') && by('codecs')!.value.includes('AAC-LC (mp4a.40.2) 2ch 48 kHz'), 'codecs with channels and rate', by('codecs')?.value);
ok(by('bitrate')!.value === '5800 kbps · auto (ABR)', 'bitrate and ABR');
ok(by('speed')!.graph?.kind === 'speed' && by('speed')!.value === '29.6 Mbps', 'connection speed is a graph row');
ok(by('net')!.value.startsWith('320 KB') && by('net')!.graph?.v === 320 * 1024, 'network activity graphs the bytes this second');
ok(by('buffer')!.value === '45.11 s' && by('buffer')!.graph, 'buffer health');
ok(by('latency')!.value === '6.20 s (target 6.0 s)', 'live latency with its target', by('latency')?.value);
ok(by('mode')!.value === 'HLS, normal latency, DVR 2h 00m, 4 s segments', 'live mode', by('mode')?.value);
ok(by('cdn')!.value === 'cdn.volt.example · POP SYD62-P1 · Hit from cloudfront', 'delivery: host, POP, cache', by('cdn')?.value);
ok(by('health')!.value === '1 stall (2.4 s) / 0', 'stalls and errors', by('health')?.value);
ok(by('manifest')!.value === 'https://cdn.volt.example/live/ch_42/master.m3u8?…', 'the manifest row has no token');
ok(rows[rows.length - 1].key === 'date', 'the date is last');

// --- rows: on demand, audio only ---
const vod = statsRows({ ...emptySample(), engine: 'Progressive', format: 'MP3', live: false, latency: 3, buffer: 12, volume: 0.5, muted: true, audioCodec: 'mp3' });
ok(!vod.some((r) => r.key === 'latency'), 'no live latency row on demand');
ok(vod.find((r) => r.key === 'mode')?.value === 'MP3, on demand', 'on demand says so');
ok(vod.find((r) => r.key === 'volume')?.value === '50% (muted)', 'volume shows muted');
ok(!vod.some((r) => r.key === 'res' || r.key === 'speed' || r.key === 'cdn'), 'rows with nothing to say are left out');

// --- the copied report ---
const rep = statsReport(live, 1024, { version: '1.0.0', userAgent: 'TestAgent/1', page: 'https://site.example/watch?session=abc' }, Date.UTC(2026, 9, 23, 7, 0, 0));
ok(rep.startsWith('Volt Player debug info (SDK 1.0.0)'), 'the report names the SDK version');
ok(rep.includes('Taken       2026-10-23T07:00:00.000Z') && rep.includes('Browser     TestAgent/1'), 'when and in what browser');
ok(!rep.includes('SECRET') && !rep.includes('session=abc'), 'no token from the manifest or the page address');
ok(rep.includes('web-6f3c2a1e-77aa-4f11-9e0d-1234567890ab'), 'the full session id (the row shortens it, the report does not)');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
