/**
 * Unit tests for the VOD extractor pure logic — segment selection/snapping,
 * discontinuity marking, and clip_spec multi-recording composition. No I/O.
 * Run: npx tsx test/vod-extractor.check.ts
 */
import { selectSegments, type ClipSpecEntry } from '../src/services/vod-extractor-job';
import { resolveRange, buildHlsMediaPlaylist, buildHlsMaster, type SegmentIndex, type SegmentRecord } from '../src/services/vod-extractor';

let pass = 0,
  fail = 0;
const ok = (c: boolean, m: string) => (c ? (pass++, console.log('PASS ' + m)) : (fail++, console.log('FAIL ' + m)));

// ---- selectSegments (clip_spec) --------------------------------------------
const segMs = 2000;

// single recording, middle range 3s..7s over 10 segments (0..20s) -> segs 2,3,4
{
  const spec: ClipSpecEntry[] = [{ recordingDir: '/recA', startMs: 3000, endMs: 7000 }];
  const sel = selectSegments(spec, segMs, () => 10);
  ok(sel.length === 3, `single-range selects 3 segs (got ${sel.length})`);
  ok(sel.map((s) => s.seq).join(',') === '2,3,4', 'selects the overlapping seq numbers 2,3,4');
  ok(sel.every((s) => !s.discontinuity), 'no discontinuity within a single recording');
}

// exact-boundary range 4s..8s -> segs 3,4 (seg3=4-6, seg4=6-8); seg2 ends at 4 (not >4)
{
  const spec: ClipSpecEntry[] = [{ recordingDir: '/recA', startMs: 4000, endMs: 8000 }];
  const sel = selectSegments(spec, segMs, () => 10);
  ok(sel.map((s) => s.seq).join(',') === '3,4', `boundary-aligned range selects 3,4 (got ${sel.map((s) => s.seq)})`);
}

// multi-recording clip_spec -> discontinuity at the second recording's first seg
{
  const spec: ClipSpecEntry[] = [
    { recordingDir: '/recA', startMs: 0, endMs: 4000 }, // segs 1,2
    { recordingDir: '/recB', startMs: 0, endMs: 4000 }, // segs 1,2
  ];
  const sel = selectSegments(spec, segMs, () => 5);
  ok(sel.length === 4, `multi-recording composes 4 segs (got ${sel.length})`);
  ok(sel[0].discontinuity === false, 'first segment overall is not a discontinuity');
  ok(sel[2].discontinuity === true, 'first segment of second recording IS a discontinuity');
  ok(sel[2].srcDir === '/recB', 'second block comes from recB');
}

// empty when range is before any content
{
  const sel = selectSegments([{ recordingDir: '/recA', startMs: 100000, endMs: 200000 }], segMs, () => 3);
  ok(sel.length === 0, 'out-of-range window selects nothing');
}

// ---- resolveRange / manifest builders (vod-extractor.ts) --------------------
function fakeIndex(segs: SegmentRecord[]): SegmentIndex {
  return {
    query: async (_s, _r, from, to) => segs.filter((x) => x.startEpochMs + x.durationMs > from && x.startEpochMs < to),
    initKey: (_s, r) => `live/s/${r}/init.mp4`,
  };
}
const base = 1_700_000_000_000;
const segs: SegmentRecord[] = Array.from({ length: 6 }, (_, i) => ({
  seq: i + 1,
  s3Key: `live/s/720p/${base + i * 2000}-${i + 1}.m4s`,
  startEpochMs: base + i * 2000,
  durationMs: 2000,
}));

(async () => {
  const range = await resolveRange(fakeIndex(segs), 's', '720p', base + 3000, base + 9000);
  ok(range.segments.length === 4, `resolveRange picks 4 overlapping segments 2..5 (got ${range.segments.length})`);
  ok(range.startEpochMs === base + 2000, 'snaps start back to the containing segment boundary');

  const m = buildHlsMediaPlaylist(fakeIndex(segs), 's', range, '720p');
  ok(m.includes('#EXT-X-PLAYLIST-TYPE:VOD'), 'media playlist is VOD-typed');
  ok(m.includes('#EXT-X-MAP:URI='), 'media playlist has an init MAP');
  ok(m.trim().endsWith('#EXT-X-ENDLIST'), 'media playlist is terminated with ENDLIST');

  // discontinuity when a segment is missing (seq gap)
  const gapRange = await resolveRange(fakeIndex(segs.filter((s) => s.seq !== 3)), 's', '720p', base, base + 12000);
  const gm = buildHlsMediaPlaylist(fakeIndex(segs), 's', gapRange, '720p');
  ok(gm.includes('#EXT-X-DISCONTINUITY'), 'sequence gap inserts a discontinuity');

  const master = buildHlsMaster(
    [{ id: '720p', bandwidthBps: 2_500_000, width: 1280, height: 720, codecs: 'avc1.640028,mp4a.40.2' }],
    (r) => `${r.id}.m3u8`,
  );
  ok(master.includes('#EXT-X-STREAM-INF:BANDWIDTH=2500000'), 'master lists the rendition with bandwidth');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
