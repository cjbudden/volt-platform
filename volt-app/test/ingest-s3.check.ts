// S3 destination and S3 watchfolder mirror against the in-memory bucket. Pure.
import { mkdtempSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { MemoryS3 } from '../src/services/ingest/s3';
import { S3Destination, LocalDestination } from '../src/services/ingest/destinations';
import { syncS3Folder, quarantineInS3, relativeKeys, type S3Folder } from '../src/services/watchfolder/s3walk';

let pass = 0, fail = 0;
const check = (m: string, got: unknown, want: unknown) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (ok) pass++; else { fail++; console.log(`FAIL ${m}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`); } };

(async () => {
  const dir = mkdtempSync(join(tmpdir(), 's3-'));
  console.log('== destination ==');
  const s3 = new MemoryS3();
  const big = randomBytes(2_500_000); writeFileSync(join(dir, 'big.bin'), big);
  const small = randomBytes(1000); writeFileSync(join(dir, 'small.bin'), small);
  const d = new S3Destination(s3, { bucket: 'b', prefix: '/media/', partBytes: 1_000_000, parallel: 2 });
  check('store label', d.store, 's3://b/media');
  let r = await d.put(join(dir, 'small.bin'), 'acc/x.bin', 'application/octet-stream');
  check('small file is a single put', [r.uri, r.bytes, s3.calls.filter((c) => c.startsWith('put')).length], ['s3://b/media/acc/x.bin', 1000, 1]);
  s3.calls = [];
  r = await d.put(join(dir, 'big.bin'), 'acc/big.bin', 'video/mp4');
  check('big file is multipart in three parts', [r.bytes, s3.calls.filter((c) => c.startsWith('part')).length, s3.calls.includes('complete')], [2_500_000, 3, true]);
  check('bytes reassembled in order', Buffer.compare(s3.objects.get('b/media/acc/big.bin')!.body, big), 0);
  check('content type carried', s3.objects.get('b/media/acc/big.bin')!.contentType, 'video/mp4');
  check('exists', [await d.exists('acc/big.bin'), await d.exists('acc/nope')], [true, false]);
  await d.putText('acc/big.bin.json', '{"a":1}');
  check('sidecar beside the object', s3.objects.get('b/media/acc/big.bin.json')!.body.toString(), '{"a":1}');
  // failure aborts
  const bad = new MemoryS3(); let n = 0; const origPart = bad.uploadPart.bind(bad);
  bad.uploadPart = async (...a: any[]) => { if (++n === 2) throw new Error('boom'); return (origPart as any)(...a); };
  const d2 = new S3Destination(bad, { bucket: 'b', partBytes: 1_000_000, parallel: 1 });
  let err = ''; try { await d2.put(join(dir, 'big.bin'), 'k.bin'); } catch (e: any) { err = e.message; }
  check('a failed part aborts the multipart and throws', [err, bad.calls.includes('abort'), bad.objects.size], ['boom', true, 0]);
  const ld = new LocalDestination(join(dir, 'lib'));
  const lr = await ld.put(join(dir, 'small.bin'), 'a/b/c.bin');
  check('local destination copies under the root', [existsSync(join(dir, 'lib/a/b/c.bin')), lr.bytes], [true, 1000]);

  console.log('== s3 watchfolder ==');
  const now = new Date('2026-09-17T10:00:00Z');
  const clock = { t: now.getTime() };
  const w = new MemoryS3(() => new Date(clock.t));
  const put = (k: string, body: string, ageMs: number) => { w.objects.set('b/' + k, { body: Buffer.from(body), lastModified: new Date(clock.t - ageMs) }); };
  put('drops/sport/Match Day.mxf', 'x'.repeat(100), 120_000);
  put('drops/sport/still copying.mov', 'y', 5_000);
  put('drops/sport/.DS_Store', 'z', 999_999);
  put('drops/sport/edit.prproj.part', 'z', 999_999);
  put('drops/sport/_review/old.txt', 'q', 999_999);
  put('drops/other/nope.mov', 'n', 999_999);
  put('drops/sport/sub/promo.mp4', 'p'.repeat(50), 300_000);
  const f: S3Folder = { id: 'wf1', bucket: 'b', prefix: 'drops/sport', stagingRoot: join(dir, 'stage'), quarantinePath: '_review', minAgeMs: 60_000, deleteAfterIngest: false };
  check('relative keys exclude other prefixes and the review prefix', relativeKeys(await w.list('b', 'drops/sport/'), 'drops/sport', '_review').map((x) => x.rel).sort(), ['.DS_Store', 'Match Day.mxf', 'edit.prproj.part', 'still copying.mov', 'sub/promo.mp4']);
  const known = new Set<string>();
  let res = await syncS3Folder(f, w, async (rel) => known.has(rel), clock.t);
  check('quiet objects downloaded, junk and too-new skipped', [res.downloaded.sort(), res.skippedTooNew, res.junk.sort()], [['Match Day.mxf', 'sub/promo.mp4'], ['still copying.mov'], ['.DS_Store', 'edit.prproj.part']]);
  check('mirrored with the tree kept', [existsSync(join(dir, 'stage/Match Day.mxf')), existsSync(join(dir, 'stage/sub/promo.mp4')), readFileSync(join(dir, 'stage/sub/promo.mp4')).length], [true, true, 50]);
  check('mtime carried so the local quiet check does not wait again', Math.round((clock.t - statSync(join(dir, 'stage/Match Day.mxf')).mtimeMs) / 1000), 120);
  res = await syncS3Folder(f, w, async (rel) => known.has(rel), clock.t);
  check('second sync downloads nothing', [res.downloaded, res.skippedKnown], [[], 2]);
  known.add('sub/promo.mp4');
  clock.t += 100_000;
  res = await syncS3Folder(f, w, async (rel) => known.has(rel), clock.t);
  check('later, the copy that finished is picked up, the known one skipped', [res.downloaded, res.skippedKnown], [['still copying.mov'], 2]);
  await quarantineInS3(f, w, 'edit.prproj.part', '_review/edit.prproj.part');
  check('quarantine mirrored to the bucket review prefix', [w.objects.has('b/drops/sport/_review/edit.prproj.part'), w.objects.has('b/drops/sport/edit.prproj.part')], [true, false]);
  console.log(`ingest-s3: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
