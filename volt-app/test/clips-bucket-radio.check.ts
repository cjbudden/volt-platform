// ============================================================================
//  RADIO CLIPS ON AWS ARE SOUND FILES (build queue 2.3c-3;
//  services/clips/resolveBucket.ts isAudioOnlyAny, services/clips.ts and the
//  clip, export, rebuild and re-trim routes).
//
//  On the Mac "is this stream sound only" is read from its run folders on
//  disk. On AWS there are none, so every radio station read as video: its
//  clips were promised an MP4 (progressive_key set, formats without MP3) and
//  the job was asked for an MP4 the audio rendition cannot make. Against
//  Postgres and a stand-in S3 client, this checks that:
//    - a channel whose kind is radio is sound only without reading the bucket;
//    - a TV channel or an event whose newest run in the bucket has a picture
//      is not, and an event whose newest run has only the sound is;
//    - nothing in the bucket is not sound only (as on the disk);
//    - the disk is asked first: a stream with runs on this machine is judged
//      by them and the bucket is not read;
//    - a radio clip made on AWS promises MP3 and M4A, no MP4, and its build
//      job asks for HLS, MP3 and M4A as the audio kind; a TV clip still MP4;
//    - the clip, export, rebuild and re-trim routes use the bucket-aware check.
//
//  Usage: DATABASE_URL=... npx tsx test/clips-bucket-radio.check.ts
// ============================================================================
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const ROOT = join(tmpdir(), `volt-clipsr-${Date.now().toString(36)}`);
process.env.ORIGIN_DIR = join(ROOT, 'origin');
process.env.CLIPS_DIR = join(ROOT, 'clips');
process.env.IMAGE_STORE_DIR = join(ROOT, 'image-store');
process.env.MEDIA_STORE_DRIVER = 's3';
process.env.S3_BUCKET = 'volt-origin-test';
const BUCKET = 'volt-origin-test';

let pass = 0, fail = 0;
const ok = (c: unknown, m: string, d?: unknown) => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log('FAIL ' + m + (d !== undefined ? ` -- ${typeof d === 'string' ? d : JSON.stringify(d)}` : '')); } };

const bucket = new Set<string>();
const calls: string[] = [];
const fake = {
  async send(cmd: any): Promise<any> {
    const op = cmd.constructor.name.replace(/Command$/, ''); const i = cmd.input ?? {};
    if (i.Bucket !== BUCKET) throw new Error(`wrong bucket ${i.Bucket}`);
    if (op !== 'ListObjectsV2') throw new Error(`stand-in S3 does not do ${op}`);
    calls.push(i.Prefix);
    const contents: string[] = []; const prefixes = new Set<string>();
    for (const k of [...bucket].filter((k) => k.startsWith(i.Prefix ?? '')).sort()) {
      const rest = k.slice((i.Prefix ?? '').length);
      if (i.Delimiter && rest.includes(i.Delimiter)) prefixes.add((i.Prefix ?? '') + rest.slice(0, rest.indexOf(i.Delimiter) + 1));
      else contents.push(k);
    }
    return { Contents: contents.map((k) => ({ Key: k, Size: 1, LastModified: new Date(), StorageClass: 'STANDARD' })), CommonPrefixes: [...prefixes].map((p) => ({ Prefix: p })), IsTruncated: false };
  },
};
const lay = (root: string, runId: string, rends: string[]) => { for (const r of rends) { bucket.add(`${root}runs/${runId}/${r}/init.mp4`); bucket.add(`${root}runs/${runId}/${r}/seg_1.m4s`); } bucket.add(`${root}runs/${runId}/thumbs/t_1.jpg`); };

(async () => {
  const { pool, one } = await import('../src/db');
  const S = await import('../src/services/media/s3Runs');
  S.setS3RunsApi(fake);
  const { isAudioOnlyAny } = await import('../src/services/clips/resolveBucket');
  const { createClipVod, enqueueClipBuild } = await import('../src/services/clips');

  const tag = Date.now().toString(36);
  const acct = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`clipsr-${tag}`]))!.id as string;
  const prof = (await one<any>(`INSERT INTO output_profiles(account_id, name, rungs, workflow_type) VALUES ($1,'T','[]','transcode') RETURNING id`, [acct]))!.id;
  const grp = (await one<any>(`INSERT INTO groups(account_id, name, output_profile_id) VALUES ($1,'G',$2) RETURNING id`, [acct, prof]))!.id as string;
  const mk = async (name: string, kind: string) => (await one<any>(`INSERT INTO channels(group_id, name, tz, kind) VALUES ($1,$2,'UTC',$3) RETURNING id`, [grp, name, kind]))!.id as string;
  const radio = await mk('Jazz FM', 'radio');
  const tv = await mk('News TV', 'tv');
  const evAudio = '0000000e-0000-0000-0000-00000000a0d1', evVideo = '0000000e-0000-0000-0000-00000000a0d2';

  // A TV channel's runs: an older run that was sound only (a slate with no
  // picture is not how TV runs look, but the newest run is what counts).
  lay(`channel/${tv}/`, '20261112T080000Z', ['audio']);
  lay(`channel/${tv}/`, '20261112T100000Z', ['1080p', '720p', 'audio']);
  lay(`event/${evAudio}/`, '20261112T090000Z', ['audio']);
  lay(`event/${evVideo}/`, '20261112T090000Z', ['720p', 'audio']);

  calls.length = 0;
  ok(await isAudioOnlyAny(radio) === true, 'a radio channel is sound only on AWS');
  ok(calls.length === 0, 'decided from the channel, the bucket not read', calls);
  ok(await isAudioOnlyAny(tv) === false, 'a TV channel whose newest run has a picture is not');
  ok(calls.some((p) => p === `channel/${tv}/runs/20261112T100000Z/`) && !calls.some((p) => p.includes('20261112T080000Z')), 'only the newest run is looked at', calls);
  ok(await isAudioOnlyAny(evAudio) === true, 'an event whose newest run has only the sound is sound only');
  ok(await isAudioOnlyAny(evVideo) === false, 'an event with a picture is not');
  ok(await isAudioOnlyAny('0000000e-0000-0000-0000-00000000dead') === false, 'nothing in the bucket: not sound only (as on the disk)');

  // The disk first: give the TV channel a sound-only run on this machine.
  const run = join(process.env.ORIGIN_DIR!, tv, 'runs', '20261112T120000Z', 'audio');
  mkdirSync(run, { recursive: true }); writeFileSync(join(run, 'init.mp4'), 'x');
  calls.length = 0;
  ok(await isAudioOnlyAny(tv) === true && calls.length === 0, 'a stream with runs on this disk is judged by them, the bucket not read', calls);

  // ---- what a clip promises --------------------------------------------------
  const rec = async (ch: string) => (await one<any>(
    `INSERT INTO recordings(kind, channel_id, day_utc, status, hi_res_rendition, master_key, start_epoch_ms, end_epoch_ms, duration_ms, thumb_status)
     VALUES ('channel_day', $1, CURRENT_DATE, 'complete', 'audio', $2, 1000, 61000, 60000, 'ready') RETURNING *`, [ch, `channel/${ch}/day`]))!;
  const rr = await rec(radio);
  const clip = await createClipVod({ ownerCol: 'channel_id', ownerId: radio, recordingId: rr.id, title: 'Jazz clip', startMs: 1000, endMs: 31000, outputKind: 'both', masterKeyBase: rr.master_key });
  ok(clip.formats?.mp3 === true && clip.formats?.m4a === true && clip.formats?.progressive === false, 'a radio clip on AWS promises MP3 and M4A, no MP4', clip.formats);
  ok(clip.progressive_key == null, 'and no MP4 key', clip.progressive_key);
  const job = await enqueueClipBuild({ vodAssetId: clip.id, streamId: radio, fromMs: 1000, toMs: 31000, outputKind: 'both', channelId: radio });
  const jr = await one<any>(`SELECT payload FROM jobs WHERE id = $1`, [job.id]);
  ok(JSON.stringify(jr?.payload?.formats) === JSON.stringify(['hls', 'mp3', 'm4a']) && jr?.payload?.kind === 'audio', 'its build asks for HLS, MP3 and M4A from the sound', jr?.payload);

  const tv2 = await mk('Sport TV', 'tv');
  lay(`channel/${tv2}/`, '20261112T100000Z', ['720p', 'audio']);
  const rt = await rec(tv2);
  const tclip = await createClipVod({ ownerCol: 'channel_id', ownerId: tv2, recordingId: rt.id, title: 'Goal', startMs: 1000, endMs: 31000, outputKind: 'both', masterKeyBase: rt.master_key });
  ok(tclip.formats?.progressive === true && !tclip.formats?.mp3 && tclip.progressive_key, 'a TV clip still promises its MP4', tclip.formats);
  const tjob = await enqueueClipBuild({ vodAssetId: tclip.id, streamId: tv2, fromMs: 1000, toMs: 31000, outputKind: 'both', channelId: tv2 });
  const tj = await one<any>(`SELECT payload FROM jobs WHERE id = $1`, [tjob.id]);
  ok(JSON.stringify(tj?.payload?.formats) === JSON.stringify(['hls', 'mp4']) && tj?.payload?.kind === 'video', 'and its build asks for HLS and MP4', tj?.payload);

  // ---- the routes ------------------------------------------------------------
  const src = (p: string) => readFileSync(join(__dirname, '..', 'src', p), 'utf8');
  for (const p of ['modules/recordings.ts', 'modules/vod.ts']) {
    const s = src(p);
    ok((s.match(/\(await isAudioOnlyAny\(streamId\)\) \? 'audio' : 'video'/g) ?? []).length === 2 && !/const kind = isAudioOnly\(/.test(s), `${p}: the clip routes judge sound only through the bucket-aware check`);
  }

  console.log(`\nclips-bucket-radio: ${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
