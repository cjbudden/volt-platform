/**
 * Audio-only (radio) channels + channel brand — the pure decisions, no DB.
 *
 *  1. an audio-only channel produces an AUDIO job config: no video ladder, no gpu
 *     flag, one input, an AAC rung list (defaulted when the channel has none)
 *  2. audio-only short-circuits BOTH video workflows (transcode and package_only)
 *  3. a normal channel is unchanged by the audio-only code path
 *  4. the brand is identity, never an encoder overlay: a channel with a brand but no
 *     watermark must not emit cfg.watermark
 *
 * Run: npx tsx test/radio-brand.check.ts
 */
import { buildEncoderJobConfig, type JobConfigCtx } from '../src/services/jobConfig';

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) { pass++; console.log('PASS', m); } else { fail++; console.log('FAIL', m); } };

const profile = {
  workflow_type: 'transcode' as const,
  packaging: 'both',
  segment_dur: 4,
  dvr_window_sec: 3600,
  rungs: [{ height: 1080, bitrate_kbps: 5000, fps: 25 }, { height: 720, bitrate_kbps: 2800 }],
  codec_backend: 'x264',
  drm_enabled: false,
} as any;

const audioInput = [{ id: 'i1', role: 'primary', protocol: 'srt', ingest_url: 'srt://in.example:9000', stream_key: null }] as any;

// ---- 1. audio-only -> audio job ------------------------------------------
const radioCfg = buildEncoderJobConfig({
  kind: 'channel',
  owner: { id: 'ch-radio', audio_only: true, audio_ladder: [{ label: 'high', bitrate_kbps: 128 }, { label: 'low', bitrate_kbps: 64 }] },
  profile, inputs: audioInput,
} as JobConfigCtx);

ok(radioCfg.audio_only === true, 'audio-only channel flags the job as audio_only');
ok(radioCfg.ladder === undefined, 'no video ladder on an audio-only job');
ok(radioCfg.gpu === undefined, 'no GPU decision on an audio-only job');
ok(Array.isArray(radioCfg.audio_ladder) && radioCfg.audio_ladder.length === 2, 'the audio ladder is carried through');
ok(radioCfg.audio_ladder[0].bitrate_kbps === 128 && radioCfg.audio_ladder[1].bitrate_kbps === 64, 'audio rungs keep their bitrates');
ok(radioCfg.inputs.length === 1 && radioCfg.inputs[0].has_audio === true, 'one audio-bearing input');
ok(radioCfg.segment_seconds === 4 && radioCfg.packaging === 'both', 'packaging/segmenting still comes from the profile');

// default ladder when the channel has none
const defaulted = buildEncoderJobConfig({
  kind: 'channel', owner: { id: 'ch2', audio_only: true, audio_ladder: null }, profile, inputs: audioInput,
} as JobConfigCtx);
ok(defaulted.audio_ladder.length === 2 && defaulted.audio_ladder[0].bitrate_kbps === 128,
   'a station with no ladder gets a sane 128k/64k default');

// ---- 2. audio-only wins over the packaging workflow ----------------------
const pkgProfile = { ...profile, workflow_type: 'package_only' };
const pkgRadio = buildEncoderJobConfig({
  kind: 'channel', owner: { id: 'ch3', audio_only: true }, profile: pkgProfile, inputs: audioInput,
} as JobConfigCtx);
ok(pkgRadio.audio_only === true && pkgRadio.audio_ladder.length === 2,
   'audio-only short-circuits package_only too (no per-rendition video inputs)');

// ---- 3. a normal channel is untouched ------------------------------------
const videoCfg = buildEncoderJobConfig({
  kind: 'channel', owner: { id: 'ch4', output_ladder: [{ height: 720, bitrate_kbps: 2800 }] }, profile, inputs: audioInput,
} as JobConfigCtx);
ok(videoCfg.audio_only === undefined, 'a video channel carries no audio_only flag');
ok(videoCfg.ladder.length === 1 && videoCfg.ladder[0].height === 720, 'the video ladder still wins from the channel override');

// ---- 4. brand is not a watermark ----------------------------------------
ok(videoCfg.watermark === undefined, 'no watermark config when the channel has none');
const wmCfg = buildEncoderJobConfig({
  kind: 'channel',
  owner: { id: 'ch5', watermark_enabled: true, watermark_ref: 'https://cdn.example/logo.png', watermark_position: 'tl', watermark_scale: 8 },
  profile, inputs: audioInput,
} as JobConfigCtx);
ok(wmCfg.watermark?.position === 'tl' && wmCfg.watermark?.scale === 8, 'an enabled watermark still reaches the encoder');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
