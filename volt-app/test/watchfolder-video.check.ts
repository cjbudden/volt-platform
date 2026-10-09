// ============================================================================
//  A VIDEO FILE IN A WATCHFOLDER BECOMES AN ENCODE JOB.
//
//  The image path puts bytes in a store and returns; this one accepts a file and
//  hands it to a job that runs minutes later, and everything interesting follows
//  from that gap.
//
//    THE SOURCE MUST BE COPIED OUT OF THE DROP FOLDER FIRST. Queuing a job that
//    points into the operator's working directory queues a path that may not
//    resolve: in the minutes it waits they can tidy the folder, replace the file
//    or unmount the share. The job then fails on a file that was there when it
//    was accepted, which reads as the system losing it.
//
//    A LOOP IS NOT A VOD. A filler loop's consumer is the live encoder's
//    failover path, which reads the file and re-encodes it into whatever ladder
//    the channel is already producing. Putting it through the ABR ladder makes
//    four renditions nothing will ever request.
//
//    ACCEPTED IS NOT PLAYABLE. The queue must not say "in library" for a file
//    whose encode has not started. Counted separately, said separately.
//
//    AND THE TWO SHARED WITH THE IMAGE PATH, because they are properties of a
//    drop folder rather than of images: the row's checksum is a claim about the
//    past, and two passes can reach one row.
//
//  Usage: npx tsx test/watchfolder-video.check.ts   (no database, no ffmpeg)
// ============================================================================
import { mkdtemp, mkdir, writeFile, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  ingestVideoItem, videoTargetFor, videoTargetKinds, preserveSource, sourcePathFor,
  type VideoIngestFolder, type VideoIngestStore,
} from '../src/services/watchfolder/videoIngest';
import type { PendingItem } from '../src/services/watchfolder/ingest';

let pass = 0, fail = 0;
const ok = (m: string) => { console.log('PASS ' + m); pass++; };
const bad = (m: string, d: string) => { console.log(`FAIL ${m} -- ${d}`); fail++; };
const check = (m: string, got: unknown, want: unknown) =>
  got === want ? ok(m) : bad(m, `expected [${String(want)}] got [${String(got)}]`);
/** A crash still catches a regression, but it stops naming which one and takes
 *  every later assertion with it. Anything reading what the code produced goes
 *  through these. */
const at = <T>(a: T[], i = 0): Partial<T> => (a[i] ?? {}) as Partial<T>;

class MemoryStore implements VideoIngestStore {
  claimed = new Set<any>();
  queuedNotes: { itemId: any; note: string }[] = [];
  failed: { itemId: any; reason: string }[] = [];
  vods: any[] = [];
  fillers: any[] = [];
  jobs: any[] = [];
  failNextAsset = false;
  private n = 0;

  async claim(itemId: any) {
    if (this.claimed.has(itemId)) return false;
    this.claimed.add(itemId); return true;
  }
  async markQueued(itemId: any, note: string) { this.queuedNotes.push({ itemId, note }); }
  async markFailed(itemId: any, reason: string) { this.failed.push({ itemId, reason }); }
  /** The source path we were handed, kept even when the write fails, so the
   *  cleanup can be asserted directly. */
  lastAskedSourceKey: string | null = null;
  async createVodAsset(a: any) {
    this.lastAskedSourceKey = a.sourceKey;
    if (this.failNextAsset) { this.failNextAsset = false; throw new Error('constraint violation'); }
    const id = `vod-${++this.n}`; this.vods.push({ ...a, id }); return { id };
  }
  async createFillerAsset(a: any) {
    const id = `fil-${++this.n}`; this.fillers.push({ ...a, id }); return { id };
  }
  async enqueueEncode(a: any) {
    const id = `job-${++this.n}`; this.jobs.push({ ...a, id }); return { id };
  }
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

async function drop(root: string, rel: string, body: string) {
  const p = join(root, rel);
  await mkdir(join(p, '..'), { recursive: true });
  await writeFile(p, body);
  return p;
}

const folder = (root: string, over: Partial<VideoIngestFolder> = {}): VideoIngestFolder =>
  ({ id: 'wf-1', accountId: 'acct-1', path: root, ladderGroupId: 'lg-1', ...over });

const item = (o: Partial<PendingItem> & { objectKey: string }): PendingItem =>
  ({ id: o.objectKey, checksum: null, targetKind: 'vod', workflow: 'encode', ...o });

(async () => {
  const root = await mkdtemp(join(tmpdir(), 'wfvid-'));

  // ---- the mapping ---------------------------------------------------------
  console.log('== which targets are video, and which are not this path\'s job ==');
  check('vod is a VOD', videoTargetFor('vod'), 'vod');
  check('and so are the words operators actually type',
    [videoTargetFor('episode'), videoTargetFor('programme'), videoTargetFor('video')].join(','),
    'vod,vod,vod');
  check('loop is a filler, not a VOD', videoTargetFor('loop'), 'loop');
  check('filler is too', videoTargetFor('filler'), 'loop');
  // The image path owns these, and claiming them here would ingest a slate twice.
  check('a slate is not this path\'s job', videoTargetFor('slate'), null);
  check('nor a poster', videoTargetFor('poster'), null);
  check('nor an unknown target', videoTargetFor('sausage'), null);
  check('the query narrows to exactly what this handles',
    videoTargetKinds().every((k) => videoTargetFor(k) !== null), true);

  // ---- a VOD, end to end ---------------------------------------------------
  console.log('\n== a video file becomes an asset and a queued encode ==');
  const body = 'x'.repeat(4096);
  await drop(root, 'episode-01.mp4', body);
  const s1 = new MemoryStore();
  const r1 = await ingestVideoItem(folder(root), item({ objectKey: 'episode-01.mp4', checksum: sha(body) }), s1);
  check('it was queued', r1.result, 'queued');
  check('an asset was created', s1.vods.length, 1);
  check('titled from the filename without the extension', at(s1.vods).title, 'episode-01');
  check('owned by the account', at(s1.vods).accountId, 'acct-1');
  check('carrying the folder\'s ladder', at(s1.vods).ladderGroupId, 'lg-1');
  check('and recorded as having come from a watchfolder', at(s1.vods).sourceKind, 'watchfolder');
  check('a job was queued', s1.jobs.length, 1);
  check('pointing at the asset', at(s1.jobs).assetId, at(s1.vods).id);
  // KEYED ON THE ASSET, so a second pass joins the job rather than starting a
  // second encode into the same directory.
  check('with a dedupe key on the asset', at(s1.jobs).dedupeKey, `vod.encode:${at(s1.vods).id}`);

  console.log('\n== the source was COPIED OUT of the drop folder before queueing ==');
  const kept: string = at(s1.jobs).sourcePath ?? '<no job was queued>';
  check('the job points somewhere else entirely', kept.startsWith(root), false);
  check('and that file exists now, not later', existsSync(kept), true);
  check('with the whole file in it',
    existsSync(kept) ? (await stat(kept)).size : 'the job had no source path', body.length);
  // The operator's own copy is left exactly where they put it.
  check('the operator\'s file is untouched', existsSync(join(root, 'episode-01.mp4')), true);
  // THE POINT: the job survives the drop folder being tidied.
  await rm(join(root, 'episode-01.mp4'));
  check('and the job\'s source survives the drop folder being emptied',
    existsSync(kept), true);

  console.log('\n== the queue says QUEUED, not "in library" ==');
  check('the item was noted', s1.queuedNotes.length, 1);
  check('as queued for encoding', /queued for encoding/.test(at(s1.queuedNotes).note ?? ''), true);
  check('and it was not marked failed', s1.failed.length, 0);

  // ---- a loop --------------------------------------------------------------
  console.log('\n== a filler loop is registered, NOT encoded ==');
  await drop(root, 'ident.mp4', 'y'.repeat(2048));
  const s2 = new MemoryStore();
  const r2 = await ingestVideoItem(folder(root), item({ objectKey: 'ident.mp4', targetKind: 'loop' }), s2);
  check('it was registered', r2.result, 'registered');
  check('as a filler asset', s2.fillers.length, 1);
  check('and NOT as a VOD', s2.vods.length, 0);
  // Its consumer re-encodes it into the channel's own ladder, so four ABR
  // renditions would be four things nothing ever requests.
  check('with no encode job at all', s2.jobs.length, 0);
  check('named from the file', at(s2.fillers).name, 'ident');

  // ---- somebody else's target ----------------------------------------------
  console.log('\n== an image target is left for the image path ==');
  const s3 = new MemoryStore();
  const r3 = await ingestVideoItem(folder(root), item({ objectKey: 'slate.png', targetKind: 'slate' }), s3);
  check('it was deferred', r3.result, 'deferred');
  check('nothing was created', s3.vods.length + s3.fillers.length, 0);
  // Claiming it would stop the image path ever seeing it.
  check('and it was not even claimed', s3.claimed.size, 0);

  // ---- the file changed -----------------------------------------------------
  console.log('\n== a file replaced since the scan is refused, and the row is CLOSED ==');
  await drop(root, 'changed.mp4', 'new content');
  const s4 = new MemoryStore();
  const r4 = await ingestVideoItem(folder(root),
    item({ objectKey: 'changed.mp4', checksum: sha('old content') }), s4);
  check('it failed', r4.result, 'failed');
  check('no asset was created for content nobody classified', s4.vods.length, 0);
  check('no job was queued', s4.jobs.length, 0);
  check('and the row was closed rather than retried forever', s4.failed.length, 1);
  check('saying what happened', /changed on disk/.test(at(s4.failed).reason ?? ''), true);

  // ---- gone -----------------------------------------------------------------
  console.log('\n== a file that has gone is closed, not retried ==');
  const s5 = new MemoryStore();
  const r5 = await ingestVideoItem(folder(root), item({ objectKey: 'nope.mp4' }), s5);
  check('it failed', r5.result, 'failed');
  check('and the row was closed', s5.failed.length, 1);

  // ---- two passes -----------------------------------------------------------
  console.log('\n== two passes over one item queue ONE encode ==');
  await drop(root, 'race.mp4', 'z'.repeat(1024));
  const s6 = new MemoryStore();
  const a = await ingestVideoItem(folder(root), item({ objectKey: 'race.mp4' }), s6);
  const b = await ingestVideoItem(folder(root), item({ objectKey: 'race.mp4' }), s6);
  check('the first queued it', a.result, 'queued');
  check('the second did nothing', b.result, 'skipped');
  // Without the claim this is two assets, two copies of the file and two encodes
  // writing into two directories, which looks like a double drop.
  check('exactly one asset', s6.vods.length, 1);
  check('and exactly one job', s6.jobs.length, 1);

  // ---- the asset write fails -------------------------------------------------
  console.log('\n== a failed asset write does not leave a copy nothing points at ==');
  await drop(root, 'orphan.mp4', 'q'.repeat(512));
  const s7 = new MemoryStore();
  s7.failNextAsset = true;
  const r7 = await ingestVideoItem(folder(root), item({ objectKey: 'orphan.mp4' }), s7);
  check('it failed', r7.result, 'failed');
  check('no job was queued', s7.jobs.length, 0);
  check('and the row says why', /could not create the VOD asset/.test(at(s7.failed).reason ?? ''), true);
  // THE ONE THE SUITE ORIGINALLY MISSED. The copy is made BEFORE the asset row,
  // because the row needs the path. When the row fails, that copy is a full-size
  // duplicate of a programme nothing will ever reference or clean up, and on a
  // busy folder it is the disk gone by the weekend.
  check('the copy it had already made was removed again',
    s7.lastAskedSourceKey ? existsSync(s7.lastAskedSourceKey) : 'no path was ever offered', false);

  // ---- preserveSource on its own ---------------------------------------------
  console.log('\n== preserving a source keeps the content and leaves the original ==');
  const from = await drop(root, 'copyme.mp4', 'hello world');
  const to = join(root, 'kept', 'copyme.mp4');
  await preserveSource(from, to);
  check('the copy exists', existsSync(to), true);
  check('with the same bytes', (await stat(to)).size, 'hello world'.length);
  check('and the original is still there', existsSync(from), true);
  check('a source path is keyed by the asset and keeps the extension',
    sourcePathFor('abc-123', 'thing.mov').endsWith('abc-123.mov'), true);
  // A filename with no usable extension must not become a path component.
  check('a nonsense extension does not travel into the path',
    sourcePathFor('abc-123', 'thing.name.with.long.extension').endsWith('.bin'), true);

  await rm(root, { recursive: true, force: true });
  await rm(join(sourcePathFor('x', 'y.mp4'), '..'), { recursive: true, force: true }).catch(() => {});
  console.log(`\nwatchfolder-video: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
