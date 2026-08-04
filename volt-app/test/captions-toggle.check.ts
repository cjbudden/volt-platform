/**
 * Captions master-toggle test. The account's captions_provider (none|whisper|gladia)
 * decides whether captions run at all and which engine the encoder uses; a profile
 * opts in via captions_enabled but can never pick an engine the account hasn't
 * licensed. Pure — no DB, no network.  Run: npx tsx test/captions-toggle.check.ts
 */
import { buildEncoderJobConfig } from '../src/services/jobConfig';

const base = {
  kind: 'channel' as const,
  owner: { id: 'ch1' },
  inputs: [{ role: 'primary' as const, rendition_label: null, rendition_bitrate_kbps: null, protocol: 'srt', ingest_url: 'srt://x', stream_key: null }],
  profile: {
    rungs: [{ height: 720, bitrate_kbps: 2500 }], packaging: 'both' as const,
    workflow_type: 'package_only' as const, codec_backend: 'x264' as const,
    segment_dur: 4, dvr_window_sec: 60,
    captions_enabled: true, caption_source_lang: 'auto', caption_targets: ['en'], caption_offset_sec: 3,
  },
};

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) { pass++; console.log('PASS', m); } else { fail++; console.log('FAIL', m); } };

const a = buildEncoderJobConfig({ ...base, account: { captions_provider: 'none' } });
ok(a.captions === undefined, 'account=none disables captions despite profile enabled');

const b = buildEncoderJobConfig({ ...base });
ok(b.captions === undefined, 'missing account defaults to no captions');

const c = buildEncoderJobConfig({ ...base, account: { captions_provider: 'whisper' } });
ok(c.captions?.enabled === true && c.captions.engine === 'whisper', 'account=whisper pins engine=whisper');
ok(c.captions.offset_sec === 3 && JSON.stringify(c.captions.targets) === '["en"]', 'profile source_lang/targets/offset carried through');

const d = buildEncoderJobConfig({ ...base, account: { captions_provider: 'gladia' } });
ok(d.captions?.engine === 'gladia', 'account=gladia pins engine=gladia');

const e = buildEncoderJobConfig({ ...base, profile: { ...base.profile, captions_enabled: false }, account: { captions_provider: 'whisper' } });
ok(e.captions === undefined, 'profile captions_enabled=false -> off even with account provider');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
