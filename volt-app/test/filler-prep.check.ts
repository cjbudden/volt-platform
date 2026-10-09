// What the pre-built fallback loop is built to match (services/fillerPrep.ts).
// Pure: no database, no media.  npx tsx test/filler-prep.check.ts
import { fillerSpec } from '../src/services/fillerPrep';

let pass = 0, fail = 0;
const check = (n: string, a: any, b: any) => {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${ok ? '' : ` -- expected [${JSON.stringify(b)}] got [${JSON.stringify(a)}]`}`);
};

const red = (over: any = {}) => ({ input_failover: true, input_loss_behavior: 'vod_loop',
  filler: { vod_loop_url: 'http://cp/library/loop.mp4', slate_ref: 'http://cp/library/slate.png' }, ...over });
const probe = (w: number, h: number, kbps: number, profile = 'baseline') => ({
  video: { width: w, height: h, fps: 25, bitrate_kbps: kbps, x264_profile: profile, x264_level: '3.1', pix_fmt: 'yuv420p' },
  audio: { sample_rate: 44100, channels: 1, bitrate_kbps: 96 },
});

console.log('== package_only: one rendition per source, matched to its probe ==');
{
  const cfg = { workflow: 'package_only', segment_seconds: 4, fps: 25, redundancy: red() };
  const inputs = [
    { role: 'primary', rendition_label: '720p', probe: probe(1280, 720, 2800, 'main') },
    { role: 'primary', rendition_label: '360p', probe: probe(640, 360, 800) },
    { role: 'backup', rendition_label: '720p', probe: probe(1280, 720, 2800) },
  ];
  const { spec } = fillerSpec(cfg, inputs);
  check('two renditions (primaries only)', spec.video.map((v: any) => v.label), ['720p', '360p']);
  check('size, profile and level from the probe', [spec.video[0].width, spec.video[0].height, spec.video[0].x264_profile, spec.video[0].x264_level], [1280, 720, 'main', '3.1']);
  check('bitrate from the probe', spec.video[1].bitrate_kbps, 800);
  check('audio matches the source (44.1k mono)', [spec.audio.sample_rate, spec.audio.channels], [44100, 1]);
  check('the loop video is the source', spec.source, { kind: 'video', path: 'http://cp/library/loop.mp4' });
  check('no burn-in on a package channel', spec.watermark, undefined);
}

console.log('\n== package_only with a source not probed yet (push) ==');
{
  const cfg = { workflow: 'package_only', segment_seconds: 4, redundancy: red() };
  const r = fillerSpec(cfg, [{ role: 'primary', rendition_label: '720p', probe: { pending: true } }]);
  check('nothing built yet', r.spec, null);
  check('and it says why', /not been probed/.test(r.reason ?? ''), true);
}

console.log('\n== transcode: the ladder, at the source aspect, with the watermark ==');
{
  const cfg = { workflow: 'transcode', segment_seconds: 4, fps: 25,
    ladder: [{ height: 720, bitrate_kbps: 2500 }, { height: 360, bitrate_kbps: 800 }],
    watermark: { url: 'http://cp/library/bug.png', position: 'tr', offset_x: 10, offset_y: 10, opacity: 80, scale: 10 },
    redundancy: red({ input_loss_behavior: 'slate' }) };
  const { spec } = fillerSpec(cfg, [{ role: 'primary', probe: probe(1440, 1080, 6000, 'high') }]);
  check('rungs', spec.video.map((v: any) => [v.label, v.width, v.height, v.bitrate_kbps]), [['720p', 960, 720, 2500], ['360p', 480, 360, 800]]);
  check('slate behaviour builds from the slate image', spec.source, { kind: 'image', path: 'http://cp/library/slate.png' });
  check('live AAC is stereo 128k at the source rate', spec.audio, { sample_rate: 44100, channels: 2, bitrate_kbps: 128 });
  check('watermark carried', spec.watermark?.path, 'http://cp/library/bug.png');
}

console.log('\n== nothing to build ==');
check('failover off', fillerSpec({ workflow: 'transcode', redundancy: null } as any, []).spec, null);
check('loss behaviour black', fillerSpec({ workflow: 'transcode', ladder: [{ height: 360, bitrate_kbps: 800 }], redundancy: red({ input_loss_behavior: 'black' }) }, []).spec, null);
check('no asset added', fillerSpec({ workflow: 'transcode', ladder: [{ height: 360, bitrate_kbps: 800 }], redundancy: red({ filler: {} }) }, []).reason, 'no slate image or loop video has been added');

console.log(`\nfiller-prep: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
