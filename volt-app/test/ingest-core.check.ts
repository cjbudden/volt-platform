// Pure checks for services/ingest: naming, rules ladder, duplicates, sniff, ID3,
// metadata merge, payload. Run:
//   npx tsc --target ES2022 --module commonjs --moduleResolution node --esModuleInterop --skipLibCheck \
//     --outDir /tmp/ing --rootDir . test/ingest-core.check.ts && node /tmp/ing/test/ingest-core.check.js
import { sanitise, applyNaming, sanitisePath, splitExt } from '../src/services/ingest/naming';
import { resolveIngest, matches, kindOf, BASELINE, type IngestRule } from '../src/services/ingest/rules';
import { findMatch, decideDuplicate, nextFree } from '../src/services/ingest/duplicates';
import { sniff } from '../src/services/ingest/sniff';
import { readId3v2 } from '../src/services/ingest/id3';
import { mergeMetadata, missingRequired, candidates, interpretProbe, type Extracted } from '../src/services/ingest/metadata';
import { buildPayload, toXml, signWebhook, sidecarKey } from '../src/services/ingest/payload';
import { INGEST_EVENTS } from '../src/services/ingest/events';

let pass = 0, fail = 0;
const check = (m: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++; else { fail++; console.log(`FAIL ${m}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`); }
};
const truthy = (m: string, v: unknown) => check(m, !!v, true);

console.log('== naming ==');
check('spaces and specials become underscores', sanitise('Match Day (Cam A) FINAL!.MXF').name, 'Match_Day_Cam_A_FINAL.mxf');
check('diacritics stripped', sanitise('Café Août – été.mp3').name, 'Cafe_Aout_ete.mp3');
check('runs collapse and ends trimmed', sanitise('__--my  file--__.mov').name, 'my_file.mov');
check('dot runs collapse, no ..', sanitise('a..b...c.wav').name, 'a.b.c.wav');
check('reserved names are suffixed', sanitise('CON.mp4').name, 'CON_file.mp4');
check('empty becomes file', sanitise('???.png').name, 'file.png');
check('lowercase option', sanitise('ABC.MP4', { lowercase: true }).name, 'abc.mp4');
check('idempotent', sanitise(sanitise('Café (1).mov').name).name, 'Cafe_1.mov');
check('extension kept only when it looks like one', splitExt('archive.tar.gz').ext, '.gz');
check('no extension', splitExt('README').ext, '');
check('long names truncated to the byte cap with extension intact', sanitise('x'.repeat(400) + '.mxf', { maxNameBytes: 50 }).name.length, 50);
check('path segments sanitised, dots dropped', sanitisePath('../Shoots/Day 1/./cam A'), 'Shoots/Day_1/cam_A');
check('only the leaf of a path is a name', sanitise('C:\\Users\\me\\clip one.mp4').name, 'clip_one.mp4');
check('changed flag', sanitise('clean.mp4').changed, false);

const g = '11111111-2222-4333-8444-555555555555';
const base = { originalName: 'Match Day.mxf', relativePath: 'Shoots/Day 1/Match Day.mxf', accountId: 'acc', kind: 'video' as const, now: new Date('2026-09-17T10:00:00Z'), guid: g, contentTypeKey: 'sports-match' };
check('guid flat is the default', applyNaming({}, base).key, `${g}.mxf`);
check('honour name, honour structure', applyNaming({ naming: 'honour', structure: 'honour' }, base).key, 'Shoots/Day_1/Match_Day.mxf');
check('guid prefixed', applyNaming({ naming: 'guid_prefixed' }, base).filename, `${g}_Match_Day.mxf`);
check('minimal structure', applyNaming({ structure: 'minimal' }, base).dir, 'video/2026/09');
check('templates', applyNaming({ naming: 'template', nameTemplate: '{type}_{name}.{ext}', structure: 'template', pathTemplate: '{account}/{yyyy}/{path}' }, base).key, 'acc/2026/Shoots/Day_1/sports-match_Match_Day.mxf');
check('original name and path survive', [applyNaming({}, base).originalName, applyNaming({}, base).originalPath], ['Match Day.mxf', 'Shoots/Day 1/Match Day.mxf']);
check('no relative path means honour is flat', applyNaming({ structure: 'honour' }, { ...base, relativePath: null }).dir, '');

console.log('== rules ==');
const rules: IngestRule[] = [
  { id: 'a1', rung: 'account', ordinal: 0, name: 'account default', then: { naming: 'guid', duplicate: 'ask', sidecar: 'json' } },
  { id: 't1', rung: 'type', scopeId: 'sport', ordinal: 0, name: 'sport type', when: { kinds: ['video'] }, then: { ladderGroupId: 'lad-1080', metadataRequired: 'before_ingest' } },
  { id: 's0', rung: 'source', scopeId: 'wf1', ordinal: 0, name: 'project files', when: { extensions: ['prproj', 'fcpbundle'] }, then: { reject: 'project files are never wanted here' } },
  { id: 's1', rung: 'source', scopeId: 'wf1', ordinal: 1, name: 'long mxf is a match', when: { extensions: ['mxf'], minDurationSec: 1200 }, then: { contentTypeId: 'sport', duplicate: 'skip', structure: 'minimal' } },
  { id: 's2', rung: 'source', scopeId: 'wf1', ordinal: 2, name: 'anything else here', then: { duplicate: 'rename' } },
  { id: 'off', rung: 'source', scopeId: 'wf1', ordinal: -1, name: 'disabled', enabled: false, then: { naming: 'honour' } },
];
const pick = resolveIngest(rules, { name: 'Match Day.mxf', bytes: 60e9, kind: 'video' });
check('pick time: duration unknown so the mxf rule cannot match, the catch-all does', pick.matched.map((m) => m.ruleId), ['a1', 't1', 's2']);
check('pick time is flagged deferred', pick.deferred, true);
check('per field inheritance', [pick.settings.naming, pick.settings.duplicate, pick.settings.ladderGroupId], ['guid', 'rename', 'lad-1080']);
check('sources per key', [pick.sources.naming, pick.sources.duplicate, pick.sources.ladderGroupId, pick.sources.transfer], ['account', 'source', 'type', 'baseline']);
const late = resolveIngest(rules, { name: 'Match Day.mxf', bytes: 60e9, kind: 'video', durationSec: 6720, mime: 'application/mxf' });
check('after probe: the mxf rule wins on its rung', late.matched.map((m) => m.ruleId), ['a1', 't1', 's1']);
check('no longer deferred', late.deferred, false);
check('skip from the folder, minimal structure', [late.settings.duplicate, late.settings.structure, late.settings.contentTypeId], ['skip', 'minimal', 'sport']);
check('disabled rules are ignored even at ordinal -1', late.settings.naming, 'guid');
const rej = resolveIngest(rules, { name: 'edit.prproj', bytes: 10 });
check('reject rule, first match wins by ordinal', rej.settings.reject, 'project files are never wanted here');
const item = resolveIngest(rules, { name: 'x.mp4', kind: 'video' }, { naming: 'honour', contentTypeId: 'interview' });
check('operator override sits on top', [item.settings.naming, item.settings.contentTypeId, item.sources.naming], ['honour', 'interview', 'item']);
check('baseline decisions of 17 Sep', [BASELINE.naming, BASELINE.structure, BASELINE.duplicate, BASELINE.transfer, BASELINE.metadataRequired, BASELINE.autoUpload], ['guid', 'flat', 'ask', 'auto', 'before_ingest', true]);
check('path prefix matches the folder and below', matches({ pathPrefix: 'Shoots/Day 1' }, { name: 'a.mov', relativePath: 'Shoots/Day 1/cam/a.mov' }), true);
check('path prefix does not match a sibling', matches({ pathPrefix: 'Shoots/Day 1' }, { name: 'a.mov', relativePath: 'Shoots/Day 10/a.mov' }), false);
check('glob name pattern', matches({ namePattern: { type: 'glob', pattern: 'slate_*.png' } }, { name: 'slate_open.png' }), true);
check('size window', matches({ minBytes: 10, maxBytes: 20 }, { name: 'x', bytes: 25 }), false);
check('hasTags needs the fact', matches({ hasTags: true }, { name: 'x.mp3' }), false);
check('kind from mime beats extension', kindOf('audio/mpeg', 'weird.mp4'), 'audio');
check('kind from extension when no mime', kindOf(null, 'a.MXF'), 'video');

console.log('== duplicates ==');
const lib = [
  { id: 'v1', name: `${g}.mxf`, originalName: 'Match Day.mxf', bytes: 60e9, sha256: 'abc' },
  { id: 'v2', name: 'promo.mp4', originalName: 'promo.mp4', bytes: 5e6, sha256: 'def' },
];
check('content match is strongest', findMatch({ name: 'whatever.mxf', bytes: 1, sha256: 'abc' }, lib)?.strength, 'content');
check('original name behind a guid still matches', findMatch({ name: 'Match Day.mxf', bytes: 60e9 }, lib)?.strength, 'name_and_size');
check('name only', findMatch({ name: 'Match Day.mxf', bytes: 1 }, lib)?.strength, 'name');
check('size only on a large file', findMatch({ name: 'other.mxf', bytes: 60e9 }, lib)?.strength, 'size');
check('size only on a small file is nothing', findMatch({ name: 'other.mp4', bytes: 5e6 }, lib), null);
check('sanitised name counts too', findMatch({ name: 'Promo.MP4', sanitisedName: 'promo.mp4', bytes: 5e6 }, lib)?.strength, 'name_and_size');
const m = findMatch({ name: 'x.mxf', sha256: 'abc' }, lib)!;
check('ask', decideDuplicate('ask', m, 'x.mxf').outcome, 'ask');
check('skip', decideDuplicate('skip', m, 'x.mxf').outcome, 'skip');
check('version names', (decideDuplicate('version', m, 'x.mxf', new Set(['x_v2.mxf'])) as any).name, 'x_v3.mxf');
check('rename names', (decideDuplicate('rename', m, 'x.mxf') as any).name, 'x_2.mxf');
check('a bare name hit proceeds', decideDuplicate('skip', findMatch({ name: 'Match Day.mxf', bytes: 1 }, lib), 'Match Day.mxf').outcome, 'proceed');
check('no match proceeds', decideDuplicate('skip', null, 'x').outcome, 'proceed');
check('nextFree strips an existing suffix', nextFree('clip_v2.mov', new Set(), '_v'), 'clip_v3.mov');

console.log('== sniff ==');
const B = (hex: string) => Buffer.from(hex.replace(/\s+/g, ''), 'hex');
check('mp4 ftyp isom', sniff(Buffer.concat([B('00000018'), Buffer.from('ftypisom'), B('00000200'), Buffer.from('isomiso2')])).container, 'mp4');
check('quicktime', sniff(Buffer.concat([B('00000014'), Buffer.from('ftypqt  '), B('00000000'), Buffer.from('qt  ')])).mime, 'video/quicktime');
check('m4a', sniff(Buffer.concat([B('00000018'), Buffer.from('ftypM4A '), B('00000000'), Buffer.from('M4A mp42')])).mime, 'audio/mp4');
check('mxf', sniff(B('060e2b34 02050101 0d010201 01020400')).mime, 'application/mxf');
check('matroska', sniff(Buffer.concat([B('1a45dfa3'), Buffer.from('....matroska....')])).container, 'matroska');
check('webm', sniff(Buffer.concat([B('1a45dfa3'), Buffer.from('....webm....')])).container, 'webm');
check('wav', sniff(Buffer.concat([Buffer.from('RIFF'), B('24080000'), Buffer.from('WAVEfmt ')])).container, 'wav');
check('flac', sniff(Buffer.from('fLaC\0\0\0"')).mime, 'audio/flac');
check('opus', sniff(Buffer.concat([Buffer.from('OggS'), B('0002000000000000000000000000000000000000'), Buffer.from('OpusHead')])).container, 'opus');
check('png', sniff(B('89504e470d0a1a0a')).container, 'png');
check('jpeg', sniff(B('ffd8ffe000104a464946')).container, 'jpeg');
check('mpeg-ts', sniff(Buffer.concat([B('47'), Buffer.alloc(187), B('47'), Buffer.alloc(10)])).container, 'mpeg-ts');
check('mp3 frame sync', sniff(B('fffb9064')).container, 'mp3');
check('aac adts', sniff(B('fff15080')).container, 'aac');
check('unknown keeps the extension as a hint only', sniff(Buffer.from('hello world, not media'), 'notes.txt'), { mime: 'application/octet-stream', container: 'txt', unknown: true, id3Bytes: 0 });

console.log('== id3 ==');
function frame(id: string, s: string): Buffer {
  const body = Buffer.concat([Buffer.from([3]), Buffer.from(s, 'utf8')]);
  const h = Buffer.alloc(10); h.write(id, 0, 'latin1'); h.writeUInt32BE(body.length, 4);
  return Buffer.concat([h, body]);
}
function tag(frames: Buffer[], major = 3): Buffer {
  const body = Buffer.concat(frames); const size = body.length;
  const h = Buffer.from([0x49, 0x44, 0x33, major, 0, 0, (size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f]);
  return Buffer.concat([h, body, Buffer.from([0xff, 0xfb, 0x90, 0x64])]);
}
const t = tag([frame('TIT2', 'Blue Train'), frame('TPE1', 'John Coltrane'), frame('TALB', 'Blue Train'), frame('TCON', '(8)'), frame('TRCK', '1/5'), frame('TYER', '1957')]);
const id3 = readId3v2(t)!;
check('title artist album', [id3.title, id3.artist, id3.album], ['Blue Train', 'John Coltrane', 'Blue Train']);
check('genre number resolved', id3.genre, 'Jazz');
check('track and year', [id3.track, id3.year], ['1/5', '1957']);
check('sniff sees the tag and what follows it', sniff(t).container, 'mp3');
check('sniff reports tag length', sniff(t).id3Bytes, 10 + t.length - 10 - 4);
check('no tag is null', readId3v2(Buffer.from('fffb9064', 'hex')), null);
const v24 = tag([frame('TDRC', '2021-03-04'), frame('TIT2', 'x')], 4);
check('v2.4 date frame', readId3v2(v24)!.year, '2021-03-04');

console.log('== metadata ==');
const probe = interpretProbe({
  format: { format_name: 'mxf', duration: '6720.04', bit_rate: '50000000', tags: { title: 'Ignored by ID3?', language: 'eng' } },
  streams: [{ codec_type: 'video', codec_name: 'mpeg2video', width: 1920, height: 1080, avg_frame_rate: '25/1', field_order: 'tt' }, { codec_type: 'audio', codec_name: 'pcm_s24le', channels: 1, sample_rate: '48000' }, { codec_type: 'audio', codec_name: 'pcm_s24le', channels: 1, sample_rate: '48000' }],
});
check('probe basics', [probe.durationSec, probe.bitrateKbps, probe.video?.height, probe.video?.fps, probe.audio?.count], [6720.04, 50000, 1080, 25, 2]);
check('tags lowercased', probe.tags?.language, 'eng');
const x: Extracted = {
  file: { originalName: 'Match Day.mxf', bytes: 60e9, sha256: 'abc' },
  type: { mime: 'application/mxf', container: 'mxf', unknown: false, id3Bytes: 0, kind: 'video', declaredMime: 'video/mp4', extensionMismatch: false },
  probe, id3: null, image: null,
};
const c = candidates(x);
check('candidates from probe', [c.name, c.language, c.durationSec, c.height], ['Ignored by ID3?', 'eng', 6720.04, 1080]);
const fields: any[] = [
  { key: 'name', type: 'text', required: true }, { key: 'competition', type: 'text', required: true },
  { key: 'duration', type: 'number' }, { key: 'inLanguage', type: 'text' }, { key: 'resolution', type: 'text' }, { key: 'homeTeam', type: 'text', required: true },
];
const merged = mergeMetadata(fields, c, { competition: 'NRL' }, { name: 'Roosters v Storm' });
check('operator beats extracted', merged.metadata.name, 'Roosters v Storm');
check('rule default lands', merged.metadata.competition, 'NRL');
check('mapped through the field map', [merged.metadata.duration, merged.metadata.inLanguage, merged.metadata.resolution], [6720.04, 'eng', '1920x1080']);
check('sources recorded', [merged.sources.name, merged.sources.competition, merged.sources.duration], ['operator', 'rule', 'extracted']);
check('only type keys are produced', Object.keys(merged.metadata).sort(), ['competition', 'duration', 'inLanguage', 'name', 'resolution']);
check('unmapped kept for the sidecar', merged.unmapped.videoCodec, 'mpeg2video');
check('missing required after merge', missingRequired(fields, merged.metadata), ['homeTeam']);
const song: any[] = [{ key: 'name', type: 'text', required: true }, { key: 'byArtist', type: 'text' }, { key: 'inAlbum', type: 'text' }, { key: 'genre', type: 'select', options: ['Jazz', 'Rock'] }, { key: 'trackNumber', type: 'integer' }];
const sx: Extracted = { ...x, id3, probe: null, type: { ...x.type, mime: 'audio/mpeg', container: 'mp3', kind: 'audio' } };
const sm = mergeMetadata(song, candidates(sx), null, null);
check('ID3 fills a Song', [sm.metadata.name, sm.metadata.byArtist, sm.metadata.inAlbum, sm.metadata.genre, sm.metadata.trackNumber], ['Blue Train', 'John Coltrane', 'Blue Train', 'Jazz', 1]);
check('select coercion refuses an unknown option', mergeMetadata([{ key: 'genre', type: 'select', options: ['Rock'] } as any], { genre: 'Jazz' }, null, null).metadata.genre, undefined);

console.log('== payload ==');
const naming = applyNaming({ structure: 'minimal' }, base);
const payload = buildPayload({
  event: 'ingested', account: 'acc', assetId: 'vod1', kind: 'video', contentTypeId: 'sport', contentTypeKey: 'sports-match', title: 'Roosters v Storm',
  naming, store: 's3://volt-acc', bytes: 60e9, sha256: 'abc', source: 'upload', sessionId: 'sess1',
  resolved: late, duplicate: decideDuplicate('ask', null, 'x'), metadata: merged.metadata, metadataSources: merged.sources, extracted: x, unmapped: merged.unmapped, now: new Date('2026-09-17T10:00:00Z'),
});
check('payload object key', payload.object.key, `video/2026/09/${g}.mxf`);
check('renamed flag', payload.naming.renamed, true);
check('rules carried', payload.rules.matched.map((r) => r.ruleId), ['a1', 't1', 's1']);
check('no duplicate', payload.duplicate, { outcome: 'proceed', ofAssetId: null, strength: null });
check('sidecar sits beside the object', sidecarKey(payload.object.key, 'json'), `video/2026/09/${g}.mxf.json`);
const xml = toXml(payload);
truthy('xml has a root and the title', xml.startsWith('<?xml') && xml.includes('<title>Roosters v Storm</title>'));
truthy('xml escapes', toXml({ ...payload, asset: { ...payload.asset, title: 'A & B <C>' } }).includes('A &amp; B &lt;C&gt;'));
truthy('xml handles arrays as repeated nodes', xml.includes('<matched>') && xml.split('<matched>').length === 4);
const sig = signWebhook('secret', '{"a":1}', 1700000000);
check('signature is stable', sig.header, `t=1700000000,v1=${sig.signature}`);
check('signature changes with the body', signWebhook('secret', '{"a":2}', 1700000000).signature === sig.signature, false);
check('event list has the ones the panel animates', ['ingested', 'duplicate', 'awaiting_metadata', 'webhook_delivered'].every((e) => (INGEST_EVENTS as readonly string[]).includes(e)), true);

console.log(`ingest-core: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
