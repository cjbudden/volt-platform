// ============================================================================
//  ASSET READINESS: the usage status every picker filters on, and the QC
//  rules that feed it (services/assetReadiness.ts, services/qc.ts).
//
//  Pure: the TypeScript decision, the playback-fault reader, and that the SQL
//  form names the same statuses. The cases are the ones found on 27 Oct 2026:
//  Sorotan (build refused on a 26.3 s gap, QC "pass" on nothing), a clip with
//  no audio track, and uploads never QC'd.
//
//  Usage: npx tsx test/asset-readiness.check.ts
// ============================================================================
import { usageStatusOf, usageStatusSql, USAGE_STATUSES } from '../src/services/assetReadiness';
import { playbackErrors } from '../src/services/qc';

let pass = 0, fail = 0;
const check = (m: string, got: unknown, want: unknown) => {
  if (got === want) { console.log('PASS ' + m); pass++; } else { console.log(`FAIL ${m} -- expected [${String(want)}] got [${String(got)}]`); fail++; }
};
const built = { master_key: '/clips/x/hls/index.m3u8', kind: 'clip', review_state: 'draft' };

// Sorotan: the build failed. QC once said pass; the build failure wins.
check('a failed build is failed, whatever QC said', usageStatusOf({ media_state: 'failed', qc_state: 'pass', master_key: 'channel/x/clip-1-2/master.m3u8', kind: 'clip' }), 'failed');
check('a placeholder manifest with no producer stamp is no media', usageStatusOf({ media_state: null, master_key: 'channel/x/clip-1-2/master.m3u8', kind: 'clip' }), 'no_media');
check('building is processing', usageStatusOf({ media_state: 'processing', master_key: 'channel/x/m.m3u8' }), 'processing');
check('an upload still encoding is processing', usageStatusOf({ encode_state: 'running' }), 'processing');
check('an upload whose encode failed is failed', usageStatusOf({ encode_state: 'failed' }), 'failed');
check('media that will not decode is unplayable', usageStatusOf({ ...built, media_state: 'unplayable', qc_state: 'failed' }), 'unplayable');
check('built, QC not run: unchecked (not offered)', usageStatusOf({ ...built, media_state: 'ready', qc_state: null }), 'unchecked');
check('built, QC error: qc_failed', usageStatusOf({ ...built, media_state: 'ready', qc_state: 'failed' }), 'qc_failed');
check('QC error approved in review: ready', usageStatusOf({ ...built, media_state: 'ready', qc_state: 'failed', review_state: 'approved' }), 'ready');
check('built, QC warnings: ready', usageStatusOf({ ...built, media_state: 'ready', qc_state: 'warnings' }), 'ready');
check('built, QC pass: ready', usageStatusOf({ ...built, media_state: 'ready', qc_state: 'pass' }), 'ready');
check('legacy built clip without a stamp: judged by its files', usageStatusOf({ ...built, media_state: null, qc_state: 'pass' }), 'ready');
check('a full-event replay is the recording itself', usageStatusOf({ kind: 'full_event', master_key: 'channel/x/master.m3u8', qc_state: 'pass' }), 'ready');
check('an encoded upload without a stamp counts as built', usageStatusOf({ encode_state: 'succeeded', qc_state: 'pass' }), 'ready');

const sql = usageStatusSql('v', 'j.state::text');
for (const s of USAGE_STATUSES) check(`SQL form can answer '${s}'`, sql.includes(`'${s}'`), true);

// Playback faults a player would hit.
check('a missing HLS segment is a playback fault', playbackErrors('[hls @ 0x1] Failed to open segment 12 of playlist 0\nframe= 10').length, 1);
check('an unreadable file is a playback fault', playbackErrors('x.mp4: Invalid data found when processing input').length, 1);
check('a clean decode log has no faults', playbackErrors('frame= 100 fps=0.0 q=-0.0 size=N/A time=00:00:04.00 bitrate=N/A').length, 0);
check('a decoder grumble is not a fault', playbackErrors('[h264 @ 0x1] error while decoding MB 12 34').length, 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
