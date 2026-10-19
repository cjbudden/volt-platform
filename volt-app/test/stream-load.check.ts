// ============================================================================
//  Stream load model: CPU, memory, GPU and network worked out from the job a
//  stream will actually run. The point of each case is a DIRECTION (more rungs
//  costs more, a backup doubles ingest, a watermark costs nothing on package-
//  only), so the checks survive the coefficients being calibrated later.
//
//  Usage: npx tsx test/stream-load.check.ts
// ============================================================================
import { estimateEncoderLoad, estimateRadioLoad, estimateWhisperLoad, calibrate, encoderSignature, describeForPeople, reserve } from '../src/services/fleet/streamLoad';
import { checker } from './fleet-fixtures';

const { check, done } = checker();

const ladder4 = [
  { height: 1080, bitrate_kbps: 5000 }, { height: 720, bitrate_kbps: 3000 },
  { height: 480, bitrate_kbps: 1500 }, { height: 360, bitrate_kbps: 800 },
];
const tx = (o: Record<string, any> = {}) => ({
  workflow: 'transcode', fps: 25, gpu: false, ladder: ladder4,
  inputs: [{ role: 'primary', protocol: 'srt', url: 'srt://x' }], ...o,
});
const probe1080 = { video: { codec: 'h264', width: 1920, height: 1080, fps: 25, bitrate_kbps: 8000 }, audio: [{}] };

// 1. Transcode: a 4-rung 1080p x264 ladder is a few vCPUs, not a whole server's worth of guesswork.
const t4 = estimateEncoderLoad(tx(), probe1080);
console.log('   4-rung 1080p x264:', t4.load, t4.reservation);
check('transcode is a transcode task, no GPU', [t4.taskKind, t4.needsGpu, t4.load.gpus], ['transcode', false, 0]);
check('4-rung 1080p25 x264 needs between 2 and 5 vCPU', t4.load.cpuUnits > 2048 && t4.load.cpuUnits < 5120, true);
check('network in = the 8 Mbps source', t4.load.netInBps, 8_000_000);
check('network out = ladder + audio + mux overhead', t4.load.netOutBps, Math.round((10300 + 128) * 1.05 * 1000));
check('reservation adds 30% headroom, rounded to 128 units', t4.reservation.cpuUnits % 128 === 0 && t4.reservation.cpuUnits >= t4.load.cpuUnits * 1.3, true);

// 2. More rungs, higher resolution, more fps all cost more.
const t1 = estimateEncoderLoad(tx({ ladder: [ladder4[1]] }), probe1080);
check('1 rung costs less than 4', t1.load.cpuUnits < t4.load.cpuUnits, true);
const t50 = estimateEncoderLoad(tx({ fps: 50 }), { ...probe1080, video: { ...probe1080.video, fps: 50 } });
check('50 fps costs more than 25 fps', t50.load.cpuUnits > t4.load.cpuUnits, true);

// 3. Watermark: costs on transcode, nothing on package-only (and says why).
const wm = estimateEncoderLoad(tx({ watermark: { url: 'x' } }), probe1080);
check('watermark adds overlay cost on transcode', wm.load.cpuUnits > t4.load.cpuUnits, true);
const pkg = (o: Record<string, any> = {}) => ({
  workflow: 'package_only', fps: 25,
  inputs: [
    { role: 'primary', bitrate_kbps: 5000 }, { role: 'primary', bitrate_kbps: 3000 }, { role: 'primary', bitrate_kbps: 1500 },
  ], ...o,
});
const p3 = estimateEncoderLoad(pkg());
const p3wm = estimateEncoderLoad(pkg({ watermark: { url: 'x' } }));
check('package-only watermark costs nothing', p3wm.load.cpuUnits, p3.load.cpuUnits);
check('...and the person is told it is not burned in', p3wm.notes.some((n) => n.includes('not burned in')), true);

// 4. Package-only is light on CPU and heavy on network, compared with transcode.
console.log('   3-rendition package:', p3.load);
check('package-only uses well under 1 vCPU', p3.load.cpuUnits < 1024, true);
check('package-only CPU is a fraction of transcode', p3.load.cpuUnits * 4 < t4.load.cpuUnits, true);
check('package-only network in = sum of renditions', p3.load.netInBps, 9_500_000);

// 5. Failover: the backup runs all the time, so ingest doubles.
const p3b = estimateEncoderLoad(pkg({ inputs: [...pkg().inputs, { role: 'backup', bitrate_kbps: 5000 }, { role: 'backup', bitrate_kbps: 3000 }, { role: 'backup', bitrate_kbps: 1500 }] }));
check('package-only backup doubles network in', p3b.load.netInBps, 19_000_000);
const txb = estimateEncoderLoad(tx({ inputs: [...tx().inputs, { role: 'backup', url: 'srt://y' }] }), probe1080);
check('transcode backup doubles network in', txb.load.netInBps, 16_000_000);
check('missing input bitrate is assumed and flagged', estimateEncoderLoad(pkg({ inputs: [{ role: 'primary' }] })).notes[0].includes('3 Mbps'), true);

// 6. GPU: NVENC moves the encode off the CPU and onto a whole GPU.
const g = estimateEncoderLoad(tx({ gpu: true }), probe1080);
check('NVENC needs a GPU and reserves one', [g.needsGpu, g.load.gpus, g.reservation.gpus], [true, 1, 1]);
check('NVENC CPU is a fraction of x264', g.load.cpuUnits * 3 < t4.load.cpuUnits, true);
check('NVENC GPU share is under one GPU for a 4-rung 1080p ladder', g.load.gpuShare > 0 && g.load.gpuShare < 1, true);

// 7. Captions: Gladia rides in the encoder; Whisper is its own GPU task.
const cc = estimateEncoderLoad(tx({ captions: { enabled: true, engine: 'gladia' } }), probe1080);
check('Gladia captions add CPU and upstream audio', [cc.load.cpuUnits > t4.load.cpuUnits, cc.load.netOutBps - t4.load.netOutBps], [true, 256_000]);
const wh = estimateWhisperLoad({ estVramGb: 4.5, needsMt: true, modelSize: 'small' });
check('Whisper add-on is a GPU captions task', [wh.taskKind, wh.needsGpu, wh.reservation.gpus], ['captions', true, 1]);

// 8. DRM and radio.
check('DRM adds a little CPU', estimateEncoderLoad(pkg({ drm: { mode: 'cbcs' } })).load.cpuUnits > p3.load.cpuUnits, true);
const r = estimateRadioLoad({ bitrate_kbps: 128, outputs: { hls: true, mp3: true } });
check('radio is tiny: minimum reservation', [r.taskKind, r.reservation.cpuUnits, r.reservation.memoryMib], ['radio', 256, 512]);

// 9. Calibration: history replaces the estimate, but never below half of it.
const hist = { cpuUnitsP95: 3000, memoryMibP95: 900, netBpsP95: null, runs: 5, hours: 40 };
const cal = calibrate(t4, hist);
check('enough history: observed CPU is used', [cal.basis, cal.load.cpuUnits], ['observed', 3000]);
check('...and the reservation follows it', cal.reservation.cpuUnits, reserve(cal.load).cpuUnits);
check('not enough history: estimate kept', calibrate(t4, { ...hist, runs: 1 }).basis, 'estimate');
check('an idle run cannot shrink a ladder below half its estimate', calibrate(t4, { ...hist, cpuUnitsP95: 50 }).load.cpuUnits, Math.round(t4.load.cpuUnits * 0.5));

// 10. Signature: same settings share history, a ladder change does not.
check('same settings, same signature', encoderSignature(tx()), encoderSignature(tx()));
check('different ladder, different signature', encoderSignature(tx()) === encoderSignature(tx({ ladder: [ladder4[0]] })), false);

// 11. What a person sees has no CPU units or instance types in it.
const s = describeForPeople(p3wm);
check('plain description: no units, no instance names', /cpu|units|c7i|xlarge|mib/i.test(s), false);
check('...says capacity is handled automatically', s.includes('automatically'), true);

done();
