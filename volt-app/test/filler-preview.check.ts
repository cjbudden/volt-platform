// ============================================================================
//  SLATE AND LOOP HOUSE PREVIEW, QC, APPROVAL, ARCHIVE AND TAGS
//  (services/media/fillerPreview.ts, migration 0161; Christian, 11 Nov 2026).
//
//    1. the house format: the account's transcode profile used by the most
//       channels (top rung and the one nearest 720p), or the standard;
//    2. the preview playlists: the loop repeated with a discontinuity, the
//       master pointed at the repeats;
//    3. QC's own rules, pure: the cut to whole segments, a jump and a click
//       where the loop restarts, upscaling, bars, frame rate, interlacing;
//    4. a real build with ffmpeg and Shaka: a 13.4 s loop plays 12 s, is
//       upscaled, and says so; a loop that cuts from red to blue jumps at the
//       join; a still green loop does not; a slate is a clip with no join; a
//       4:3 slate is pillarboxed; the profile's 2 s segments are used;
//    5. approval: new rows wait, existing ones are approved by the migration,
//       approving over a QC error needs a note, and only an approved,
//       available slate or loop can be newly given to a stream (channels,
//       events, FAST), while one a stream already has stays;
//    6. archive, tags, and removing the preview with the asset;
//    7. the loop sprite sheets claim only frames that exist (the black frame
//       the list's hover showed where it wrapped);
//    8. each finding carries stills at its moment (a join: the last frame and
//       the first), and a person accepts findings one by one: acceptances
//       outlive QC running again, and accepted errors need no approval note
//       (migration 0175; Christian, 12 Nov).
//
//  Needs Postgres (DATABASE_URL, migrations applied), ffmpeg and Shaka
//  Packager (PACKAGER_BIN). Usage: npx tsx test/filler-preview.check.ts
// ============================================================================
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const ROOT = mkdtempSync(join(tmpdir(), 'filler-preview-'));
process.env.IMAGE_STORE_DIR = join(ROOT, 'store');
process.env.FILLER_DIR = join(ROOT, 'filler');
process.env.ORIGIN_DIR = join(ROOT, 'origin');
process.env.IMAGE_SIGNING_SECRET = 'filler-preview-check-signing-secret-0123456789';
process.env.IMAGE_PUBLIC_BASE_URL = 'https://img.test';

let pass = 0, fail = 0;
const ok = (m: string) => { console.log('PASS ' + m); pass++; };
const bad = (m: string, d: string) => { console.log(`FAIL ${m} -- ${d}`); fail++; };
const check = (m: string, got: unknown, want: unknown) => (JSON.stringify(got) === JSON.stringify(want) ? ok(m) : bad(m, `expected ${JSON.stringify(want)} got ${JSON.stringify(got)}`));
const truthy = (m: string, v: unknown, d = '') => (v ? ok(m) : bad(m, `expected truthy, got [${String(v)}] ${d}`));
async function throwsWith(m: string, fn: () => Promise<unknown>, re: RegExp) {
  try { await fn(); bad(m, 'did not throw'); } catch (e: any) { re.test(String(e?.message)) ? ok(m) : bad(m, `threw "${e?.message}"`); }
}

function ffmpeg(args: string[]) {
  const r = spawnSync('ffmpeg', ['-loglevel', 'error', '-y', ...args]);
  if (r.status !== 0) throw new Error(`ffmpeg: ${r.stderr}`);
}

async function main() {
  const { query, one, pool } = await import('../src/db');
  const P = await import('../src/services/media/fillerPreview');
  const T = await import('../src/services/media/fillerThumbs');
  const { localPathOf } = await import('../src/services/media/fillerStore');
  const { assertFillerAsset, normaliseTags } = await import('../src/modules/fillerAssets');
  const { vodForFiller } = await import('../src/services/fast/fillerBridge');

  // ------------------------------------------------------------ 1. the house format
  console.log('== the house format ==');
  check('no profile: the standard', [P.houseFromProfile(null).standard, P.houseFromProfile(null).video.map((v) => v.label)], [true, ['1080p', '720p']]);
  const h = P.houseFromProfile({ id: 'p', name: 'Sport HD', segment_dur: '2.00', rungs: [
    { height: 480, bitrate_kbps: 1200, fps: 50 }, { height: 1080, bitrate_kbps: 6500, fps: 50 }, { height: 720, bitrate_kbps: 3500, fps: 50 }, { height: 360, bitrate_kbps: 700 }] }, 3);
  check('a profile: its top rung and the one nearest 720p', h.video.map((v) => [v.label, v.width, v.bitrate_kbps, v.fps]), [['1080p', 1920, 6500, 50], ['720p', 1280, 3500, 50]]);
  check('a profile: its segment length, name and use', [h.segmentSeconds, h.profileName, h.usedBy, h.standard], [2, 'Sport HD', 3, false]);
  check('a one-rung profile: one rendition', P.houseFromProfile({ id: 'p', name: 'x', segment_dur: 4, rungs: [{ height: 720, bitrate_kbps: 3000 }] }).video.length, 1);
  check('a profile with no usable rungs: the standard', P.houseFromProfile({ id: 'p', name: 'x', segment_dur: 4, rungs: [] }).standard, true);

  // ------------------------------------------------------------ 2. playlists
  console.log('== the preview playlists ==');
  const media = '#EXTM3U\n#EXT-X-VERSION:6\n#EXT-X-TARGETDURATION:4\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:4.000,\nseg_1.m4s\n#EXTINF:4.000,\nseg_2.m4s\n#EXT-X-ENDLIST\n';
  const rep = P.repeatPlaylist(media, 3);
  check('three rounds, two discontinuities', [(rep.match(/seg_1\.m4s/g) ?? []).length, (rep.match(/DISCONTINUITY/g) ?? []).length], [3, 2]);
  check('the init segment named in every round', (rep.match(/EXT-X-MAP/g) ?? []).length, 3);
  check('one end, at the end', [(rep.match(/ENDLIST/g) ?? []).length, rep.trim().endsWith('#EXT-X-ENDLIST')], [1, true]);
  check('the header once', (rep.match(/TARGETDURATION/g) ?? []).length, 1);
  const master = '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,URI="audio.m3u8",GROUP-ID="audio"\n#EXT-X-STREAM-INF:BANDWIDTH=1\n1080p.m3u8\n';
  check('the master points at the repeats', P.repeatMaster(master).includes('URI="audio.loop.m3u8"') && P.repeatMaster(master).includes('\n1080p.loop.m3u8'), true);

  // ------------------------------------------------------------ 3. QC rules, pure
  console.log('== QC rules ==');
  const lf = P.loopLengthFinding(13400, 12000, 4);
  check('13.4 s at 4 s segments: plays 12 s, a warning', [lf?.check, lf?.severity], ['loop_length', 'warning']);
  truthy('and says what length would join cleanly', lf?.message.includes('12 s or 16 s'), lf?.message);
  check('shorter than two segments is padded, and said so', P.loopLengthFinding(5000, 8000, 4)?.message.includes('shown again'), true);
  check('a whole number of segments: nothing', P.loopLengthFinding(12000, 12000, 4), null);
  check('one frame out: nothing', P.loopLengthFinding(12020, 12000, 4, 40), null);
  check('a quarter second out: information only', P.loopLengthFinding(12250, 12000, 4)?.severity, 'info');
  truthy('over 60 s: only the first 60 s', P.loopLengthFinding(75000, 60000, 4)?.message.includes('capped'));
  check('a join unlike the rest of the loop: a jump', P.loopPointFinding(0.35, 0.97, 12000)?.check, 'loop_point');
  check('a join like the rest of the loop: nothing', P.loopPointFinding(0.93, 0.97, 12000), null);
  check('fast footage changes every frame anyway: nothing', P.loopPointFinding(0.45, 0.52, 12000), null);
  const sr = 48000;
  const sine = (secs: number, hz: number, cut = 0) => { const n = Math.round(secs * sr) - cut; const a = new Float32Array(n); for (let i = 0; i < n; i++) a[i] = 0.5 * Math.sin((2 * Math.PI * hz * i) / sr); return a; };
  check('a whole number of cycles: no click', P.audioLoopPointFinding(sine(4, 500), sr, 4000), null);
  check('cut mid-wave: a click', P.audioLoopPointFinding(sine(4, 500, 24), sr, 4000)?.check, 'audio_loop_point');
  const cutOff = sine(4, 500); for (let i = 0; i < 2400; i++) cutOff[i] = 0;
  check('loud to the end, silent at the start: cut off', P.audioLoopPointFinding(cutOff, sr, 4000)?.measured?.includes('dBFS'), true);
  const S = P.STANDARD_HOUSE;
  const src = (w: number, h2: number, fps = 25, scan = 'progressive') => ({ video: { width: w, height: h2, fps, scan } });
  check('1080p, 25 fps, progressive: nothing', P.sourceFindings(src(1920, 1080), S, 'loop'), []);
  check('720p into 1080p: upscaled', P.sourceFindings(src(1280, 720), S, 'loop').map((f) => f.check), ['resolution']);
  check('4:3: pillarboxed', P.sourceFindings(src(1440, 1080), S, 'loop').map((f) => [f.check, f.message.includes('sides')]), [['aspect', true]]);
  check('29.97 into 25: judder, information', P.sourceFindings(src(1920, 1080, 29.97), S, 'loop').map((f) => [f.check, f.severity]), [['frame_rate', 'info']]);
  check('50 into 25: fine', P.sourceFindings(src(1920, 1080, 50), S, 'loop'), []);
  check('interlaced: a warning', P.sourceFindings(src(1920, 1080, 25, 'interlaced'), S, 'loop').map((f) => [f.check, f.severity]), [['interlaced', 'warning']]);
  check('a slate: no frame rate or scan checks', P.sourceFindings(src(1920, 1080, 29.97, 'interlaced'), S, 'slate'), []);
  check('state: an error fails', P.qcState([{ check: 'media', severity: 'error', message: '' }]), 'failed');
  check('state: information alone passes', P.qcState([{ check: 'silence', severity: 'info', message: '' }]), 'pass');
  check('a join shows its last frame and its first', P.framesFor({ check: 'loop_point', severity: 'warning', message: '', fromMs: 11000 }, 12000, 25).map((f) => f.atMs), [11960, 0]);
  check('a finding with a place shows that frame', P.framesFor({ check: 'black', severity: 'warning', message: '', fromMs: 3000 }, 12000, 25).map((f) => f.atMs), [3000]);
  check('a place past the end shows the last frame', P.framesFor({ check: 'loop_length', severity: 'warning', message: '', fromMs: 13400 }, 12000, 25).map((f) => f.atMs), [11960]);
  check('no place: no frames', P.framesFor({ check: 'resolution', severity: 'warning', message: '' }, 12000, 25), []);
  check('a finding\'s key is its check and place', P.findingKey({ check: 'black', fromMs: 3000 }), 'black:3000');

  // ------------------------------------------------------------ 4. real builds
  console.log('== real builds ==');
  const ACC = randomUUID(), OTHER = randomUUID();
  await query(`INSERT INTO accounts(id,name) VALUES ($1,'LoopCo'),($2,'Other')`, [ACC, OTHER]);
  const addFiller = async (acc: string, kind: 'slate' | 'loop', ext: string, make: (path: string) => void) => {
    const id = randomUUID();
    const key = `filler/${acc}/${id}${ext}`;
    const p = localPathOf(key)!;
    mkdirSync(dirname(p), { recursive: true });
    make(p);
    await query(`INSERT INTO filler_assets(id, account_id, kind, name, status, source_key) VALUES ($1,$2,$3,$4,'ready',$5)`, [id, acc, kind, `${kind} ${ext}`, key]);
    await T.buildFillerThumbs(id);   // the probe QC reads, as the job does first
    return id;
  };
  const row = (id: string) => one<any>(`SELECT * FROM filler_assets WHERE id = $1`, [id]);

  const L134 = await addFiller(ACC, 'loop', '.mp4', (p) => ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=25:duration=13.4',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=13.4', '-ac', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', p]));
  check('a new slate or loop waits for approval', (await row(L134)).review_state, 'pending');
  check('available, with no tags', [(await row(L134)).availability, (await row(L134)).tags], ['available', []]);
  // the sprite fix: 13.4 s at 1 s tiles is 13 frames, not 14
  const sp = (await row(L134)).sprite;
  check('sprite sheets claim only the 13 frames that exist', sp.sheets.reduce((n: number, s: any) => n + s.tiles, 0), 13);

  const b1 = await P.buildFillerPreview(L134);
  let fa = await row(L134);
  check('preview built', [b1.status, fa.preview_status], ['ready', 'ready']);
  check('standard house: 1080p and 720p, 4 s segments', [fa.preview.renditions.map((r: any) => r.label), fa.preview.segmentSeconds, fa.preview.house.standard], [['1080p', '720p'], 4, true]);
  check('plays 12 s of the 13.4 s file', [fa.preview.loopSeconds, fa.preview.sourceMs], [12, 13400]);
  const dir = P.previewDir(L134);
  truthy('the preview playlist is written', existsSync(join(dir, 'preview.m3u8')));
  check('each rendition plays three times over', (readFileSync(join(dir, '1080p.loop.m3u8'), 'utf8').match(/DISCONTINUITY/g) ?? []).length, 2);
  check('served under /origin', fa.preview.url, `/origin/filler-preview/${L134}/preview.m3u8`);
  const checks = (fa.qc_findings as any[]).map((f) => f.check);
  check('QC: warnings', fa.qc_state, 'warnings');
  truthy('QC: the cut to whole segments', checks.includes('loop_length'), checks.join(','));
  truthy('QC: upscaled from 720p', checks.includes('resolution'), checks.join(','));
  truthy('QC: no playback error', !checks.includes('playback') && !checks.includes('media'), checks.join(','));

  const JUMP = await addFiller(ACC, 'loop', '.mp4', (p) => ffmpeg(['-f', 'lavfi', '-i', 'color=c=red:size=1920x1080:rate=25:duration=6',
    '-f', 'lavfi', '-i', 'color=c=blue:size=1920x1080:rate=25:duration=6', '-filter_complex', '[0:v][1:v]concat=n=2:v=1[v]', '-map', '[v]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', p]));
  await P.buildFillerPreview(JUMP);
  fa = await row(JUMP);
  const jc = (fa.qc_findings as any[]).map((f) => f.check);
  truthy('red to blue: a jump where it restarts', jc.includes('loop_point'), jc.join(','));
  truthy('12 s at 4 s segments: no length finding', !jc.includes('loop_length'), jc.join(','));
  truthy('no sound: said, as information', (fa.qc_findings as any[]).some((f) => f.check === 'silence' && f.severity === 'info'));
  const jf = (fa.qc_findings as any[]).find((f) => f.check === 'loop_point');
  check('the jump is placed at the join', [jf?.fromMs, jf?.toMs], [11000, 12000]);

  const STILL = await addFiller(ACC, 'loop', '.mp4', (p) => ffmpeg(['-f', 'lavfi', '-i', 'color=c=green:size=1920x1080:rate=25:duration=8', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', p]));
  await P.buildFillerPreview(STILL);
  fa = await row(STILL);
  check('a seamless 8 s loop: passes', [fa.qc_state, (fa.qc_findings as any[]).filter((f) => f.severity !== 'info').map((f) => f.check)], ['pass', []]);

  const SLATE = await addFiller(ACC, 'slate', '.png', (p) => ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=1920x1080', '-frames:v', '1', p]));
  await P.buildFillerPreview(SLATE);
  fa = await row(SLATE);
  check('a slate: a two-segment clip', [fa.preview_status, fa.preview.loopSeconds, fa.preview.sourceMs], ['ready', 8, null]);
  check('a slate: passes, with no join to check', [fa.qc_state, (fa.qc_skipped as any[]).some((s) => s.check === 'loop_point')], ['pass', true]);
  const SLATE43 = await addFiller(ACC, 'slate', '.png', (p) => ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=800x600', '-frames:v', '1', p]));
  await P.buildFillerPreview(SLATE43);
  check('a 4:3 slate: bars and upscaling', ((await row(SLATE43)).qc_findings as any[]).map((f) => f.check).sort(), ['aspect', 'resolution']);

  // the house format from the account's profile
  const PROF = randomUUID(), GRP = randomUUID();
  await query(`INSERT INTO output_profiles(id, account_id, name, rungs, segment_dur, workflow_type) VALUES ($1,$2,'Sport 2s',$3::jsonb,2,'transcode')`,
    [PROF, OTHER, JSON.stringify([{ height: 720, bitrate_kbps: 2500, fps: 25 }, { height: 360, bitrate_kbps: 600, fps: 25 }])]);
  const house = await P.houseFormat(OTHER);
  check('the account\'s transcode profile is its house format', [house.profileName, house.segmentSeconds, house.video.map((v) => v.label)], ['Sport 2s', 2, ['720p', '360p']]);
  const OL = await addFiller(OTHER, 'loop', '.mp4', (p) => ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=25:duration=13.4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', p]));
  await P.buildFillerPreview(OL);
  fa = await row(OL);
  check('built with its 2 s segments: 13.4 s plays as 14 s', [fa.preview.loopSeconds, fa.preview.house.profileName], [14, 'Sport 2s']);
  truthy('720p into a 720p house: not upscaled', !(fa.qc_findings as any[]).some((f) => f.check === 'resolution'));

  // a file that is gone
  const GONE = randomUUID();
  await query(`INSERT INTO filler_assets(id, account_id, kind, name, status, source_key) VALUES ($1,$2,'loop','gone','ready',$3)`, [GONE, ACC, `filler/${ACC}/${GONE}.mp4`]);
  const g = await P.buildFillerPreview(GONE);
  fa = await row(GONE);
  check('a missing file: failed, with the reason, and QC fails', [g.status, fa.preview_status, /missing/.test(fa.preview_error), fa.qc_state], ['failed', 'failed', true, 'failed']);

  // ------------------------------------------------------------ 5. approval
  console.log('== approval ==');
  const who = { userId: null, label: 'Test Reviewer' };
  await throwsWith('approving over a QC error needs a note', () => P.reviewFiller({ id: GONE, accountId: ACC, decision: 'approve', ...who }), /note/);
  const ra = await P.reviewFiller({ id: GONE, accountId: ACC, decision: 'approve', note: 'Placeholder for a test channel', ...who });
  check('with a note it is approved, note kept', [ra.asset.review_state, ra.asset.review_note, ra.asset.reviewed_by_label], ['approved', 'Placeholder for a test channel', 'Test Reviewer']);
  await throwsWith('another account cannot review it', () => P.reviewFiller({ id: L134, accountId: OTHER, decision: 'approve', ...who }), /not in this account/);
  await P.reviewFiller({ id: L134, accountId: ACC, decision: 'approve', ...who });
  check('warnings alone: approved without a note', (await row(L134)).review_state, 'approved');
  await P.reviewFiller({ id: JUMP, accountId: ACC, decision: 'reject', note: 'Jumps at the join', ...who });
  check('rejected', (await row(JUMP)).review_state, 'rejected');
  const rs = await P.reviewFiller({ id: JUMP, accountId: ACC, decision: 'reset', ...who });
  check('back to waiting clears who and when', [rs.asset.review_state, rs.asset.reviewed_at, rs.asset.review_note], ['pending', null, null]);
  await P.reviewFiller({ id: JUMP, accountId: ACC, decision: 'reject', ...who });

  await throwsWith('a stream cannot be given one waiting for approval', () => assertFillerAsset(ACC, STILL), /waiting for approval/);
  await throwsWith('nor a rejected one', () => assertFillerAsset(ACC, JUMP), /rejected/);
  await assertFillerAsset(ACC, L134); ok('an approved one can be given');
  await assertFillerAsset(ACC, JUMP, JUMP); ok('a stream keeps the one it has when saved again, even rejected');
  await query(`UPDATE filler_assets SET availability = 'archived' WHERE id = $1`, [L134]);
  await throwsWith('an archived one cannot be given', () => assertFillerAsset(ACC, L134), /archived/);
  await assertFillerAsset(ACC, L134, L134); ok('a stream keeps an archived one it already has');
  await throwsWith('FAST: not one waiting for approval', () => vodForFiller(ACC, STILL), /waiting for approval/);
  await throwsWith('FAST: not an archived one', () => vodForFiller(ACC, L134), /archived/);
  await query(`UPDATE filler_assets SET availability = 'available' WHERE id = $1`, [L134]);

  // the migration: rows that existed before it were approved
  const mig = readFileSync(join(__dirname, '..', 'migrations', '0161_filler_house_preview.sql'), 'utf8');
  truthy('the migration approves existing rows, then waits for new ones', /review_state\s+TEXT NOT NULL DEFAULT 'approved'/.test(mig) && /SET DEFAULT 'pending'/.test(mig));
  await throwsWith('review states are checked', () => query(`UPDATE filler_assets SET review_state = 'maybe' WHERE id = $1`, [L134]), /check/i);
  await throwsWith('availability is checked', () => query(`UPDATE filler_assets SET availability = 'gone' WHERE id = $1`, [L134]), /check/i);

  // ------------------------------------------------------------ 8. stills and accepting findings
  console.log('== stills and accepting findings ==');
  fa = await row(JUMP);
  const jfind = (fa.qc_findings as any[]).find((f) => f.check === 'loop_point');
  check('the jump carries the last frame and the first', jfind?.frames?.map((x: any) => x.label), ['Last frame', 'First frame (after the join)']);
  const fileOf = (u: string) => join(P.previewDir(JUMP), 'qc-frames', u.split('/').pop()!);
  truthy('the stills are on disk, served under /origin', jfind?.frames?.every((x: any) => x.url.startsWith(`/origin/filler-preview/${JUMP}/qc-frames/`) && existsSync(fileOf(x.url))));
  const sz = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width', '-of', 'csv=p=0', fileOf(jfind.frames[0].url)]).stdout.toString().trim();
  check('a still is 480 pixels wide', sz, '480');
  // the still's average colour, as one RGB pixel
  const rgb = (u: string) => [...spawnSync('ffmpeg', ['-v', 'error', '-i', fileOf(u), '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']).stdout];
  const [lastPx, firstPx] = [rgb(jfind.frames[0].url), rgb(jfind.frames[1].url)];
  truthy('the last frame is blue and the first red', lastPx[2] > 150 && lastPx[0] < 80 && firstPx[0] > 150 && firstPx[2] < 80, JSON.stringify([lastPx, firstPx]));
  check('every finding has a key', (fa.qc_findings as any[]).every((f) => f.key === P.findingKey(f)), true);
  await throwsWith('a finding that is not there cannot be accepted', () => P.acceptFinding({ id: JUMP, accountId: ACC, key: 'black:1', accepted: true, label: 'x' }), /not on this/);
  await throwsWith('nor another account\'s', () => P.acceptFinding({ id: JUMP, accountId: OTHER, key: jfind.key, accepted: true, label: 'x' }), /not in this account/);
  await P.acceptFinding({ id: JUMP, accountId: ACC, key: jfind.key, accepted: true, note: 'Intended: a sting, not a loop', label: 'Test Reviewer' });
  let acc = (await row(JUMP)).qc_accepted[jfind.key];
  check('accepted, with who and why', [acc?.by, acc?.note, !!acc?.at], ['Test Reviewer', 'Intended: a sting, not a loop', true]);
  const framesBefore = jfind.frames.map((x: any) => x.url);
  await P.runFillerQc(JUMP);
  fa = await row(JUMP);
  truthy('QC again: still accepted', !!fa.qc_accepted[jfind.key]);
  truthy('QC again: new stills under new names', (fa.qc_findings as any[]).find((f) => f.key === jfind.key).frames.every((x: any) => !framesBefore.includes(x.url)));
  await P.acceptFinding({ id: JUMP, accountId: ACC, key: jfind.key, accepted: false, label: 'Test Reviewer' });
  check('taken back', (await row(JUMP)).qc_accepted[jfind.key], undefined);

  const BLACK = await addFiller(ACC, 'loop', '.mp4', (p) => ffmpeg(['-f', 'lavfi', '-i', 'color=c=black:size=1920x1080:rate=25:duration=8', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', p]));
  await P.buildFillerPreview(BLACK);
  fa = await row(BLACK);
  const bf = (fa.qc_findings as any[]).find((f) => f.check === 'black');
  check('an all-black loop: an error, with its still', [bf?.severity, bf?.frames?.length], ['error', 1]);
  await throwsWith('its error not accepted: approving needs a note', () => P.reviewFiller({ id: BLACK, accountId: ACC, decision: 'approve', ...who }), /nobody has accepted/);
  await P.acceptFinding({ id: BLACK, accountId: ACC, key: bf.key, accepted: true, label: 'Test Reviewer' });
  check('its error accepted: approved without a note', (await P.reviewFiller({ id: BLACK, accountId: ACC, decision: 'approve', ...who })).asset.review_state, 'approved');

  // ------------------------------------------------------------ 6. tags and removal
  console.log('== tags and removal ==');
  check('tags: trimmed, one of each whatever the case, spaces folded', normaliseTags([' Sport ', 'sport', 'Brand  A', '', 'x'.repeat(60)]), ['Sport', 'Brand A', 'x'.repeat(40)]);
  check('tags: at most 20', normaliseTags(Array.from({ length: 30 }, (_v, i) => `t${i}`)).length, 20);
  await query(`UPDATE filler_assets SET tags = $2::text[] WHERE id = $1`, [L134, ['Sport', 'Brand A']]);
  await query(`UPDATE filler_assets SET tags = $2::text[] WHERE id = $1`, [STILL, ['Sport']]);
  const tagged = await query<any>(`SELECT id FROM filler_assets WHERE account_id = $1 AND tags @> $2::text[] ORDER BY name`, [ACC, ['Sport']]);
  check('filter by a tag', tagged.length, 2);
  check('filter by two tags: both', (await query<any>(`SELECT id FROM filler_assets WHERE account_id = $1 AND tags @> $2::text[]`, [ACC, ['Sport', 'Brand A']])).map((r) => r.id), [L134]);
  await P.removeFillerPreview(SLATE);
  truthy('removing takes the preview off disk', !existsSync(P.previewDir(SLATE)) && !existsSync(`${P.previewDir(SLATE)}.spec.json`));

  console.log(`\n${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
