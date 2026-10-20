// ============================================================================
//  MEDIA LIBRARY VIEWS, the pure half: target metadata and completeness per
//  content type, EPG programme matching (no guide, one programme, overlapping
//  programmes, a linked auto-VOD programme, an uploaded file), the field
//  mapping from a programme to a type, the never-overwrite merge, and the
//  encode details with their provenance.
//
//  Usage: npx tsx test/vod-library-pure.check.ts   (no database)
// ============================================================================
import { STANDARD_TYPES } from '../src/services/contentTypes';
import { TARGETS, completeness, targetFields, encodeDetails, isFilled } from '../src/services/vodLibrary';
import { rankProgrammes, programmeFacts, suggestionsFor, mergeSuggestions, suggestTypeKey, valueForField, type ProgrammeRow } from '../src/services/epgFill';
import { mergeFields, validateMetadata } from '../src/services/metadataValidator';

let pass = 0, fail = 0;
const ok = (c: boolean, m: string, d = '') => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log(`FAIL ${m}${d ? ' -- ' + d : ''}`); } };
const eq = (a: unknown, b: unknown, m: string) => ok(JSON.stringify(a) === JSON.stringify(b), m, `expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`);
const type = (k: string) => {
  const t = STANDARD_TYPES.find((x) => x.key === k)!;
  const parent = t.extendsKey ? STANDARD_TYPES.find((x) => x.key === t.extendsKey)! : null;
  return parent ? mergeFields(parent.fields, t.fields) : t.fields;
};

console.log('== target metadata uses the existing content types ==');
for (const [k, spec] of Object.entries(TARGETS)) {
  const t = STANDARD_TYPES.find((x) => x.key === k);
  ok(!!t, `${k}: is a standard content type`);
  if (!t) continue;
  const keys = new Set(type(k).map((f) => f.key));
  for (const f of [...spec.required, ...spec.recommended]) ok(keys.has(f), `${k}.${f} is a field of the type`);
}
ok(STANDARD_TYPES.some((t) => t.key === 'movie' && t.schemaOrgType === 'Movie'), 'Movie is a standard type (schema.org Movie)');
ok(type('episode').some((f) => f.key === 'rating'), 'Episode carries a content rating');
ok(STANDARD_TYPES.filter((t) => t.appliesTo.includes('vod')).map((t) => t.schemaOrgType).join(',') === 'VideoObject,MusicRecording,Interview,Episode,Movie',
  'on-demand types: VideoObject, MusicRecording, Interview, Episode, Movie');

console.log('\n== completeness ==');
const ep = type('episode');
let c = completeness(ep, 'episode', {});
eq([c.pct, c.filled, c.total], [0, 0, 8], 'empty episode: 0 of 8');
eq(c.missingRequired, ['title', 'series', 'episodeNumber', 'description'], 'empty episode: four required missing, in field order');
c = completeness(ep, 'episode', { title: 'The Pilot', series: 'Harbour', episodeNumber: 1, description: 'It begins.', genre: [] });
eq([c.pct, c.missingRequired.length], [50, 0], 'required filled: 4 of 8 (an empty array is not filled)');
c = completeness(ep.filter((f) => f.key !== 'rating'), 'episode', {});
eq(c.notOnType, ['rating'], 'a client copy seeded before rating: reported as not on the type, not as missing');
c = completeness([{ key: 'a', type: 'string', required: true }, { key: 'b', type: 'string' }], null, { b: 'x' });
eq([c.pct, c.missingRequired], [50, ['a']], 'custom type: every field is a target, its required field is required');
eq(completeness(null, null, {}).pct, null, 'no content type: no percentage');
ok(!isFilled('   ') && !isFilled({}) && isFilled(0) && isFilled(false), 'filled: blank and {} are empty, 0 and false say something');
const sm = targetFields(type('sports-match'), 'sports-match');
eq(sm.fields.filter((f) => f.required).map((f) => f.key), ['name', 'sport', 'competition', 'homeTeam', 'awayTeam'], 'sports match: competition and both teams are required');

console.log('\n== matching the EPG ==');
const H = 3600_000, T0 = Date.parse('2026-10-18T18:00:00Z');
const P = (id: string, a: number, b: number, md: any = {}, extra: Partial<ProgrammeRow> = {}): ProgrammeRow =>
  ({ id, title: id, starts_at: new Date(T0 + a * H).toISOString(), ends_at: new Date(T0 + b * H).toISOString(), metadata: md, ...extra });
let r = rankProgrammes('A', { startMs: T0, endMs: T0 + H }, []);
ok(!r.best && !r.confident && /No programme/.test(r.reason ?? ''), 'no EPG: no match, and it says so');
r = rankProgrammes('A', null, [P('x', 0, 1)]);
ok(!r.best && /no recorded time window/.test(r.reason ?? ''), 'uploaded file (no window): no match, and it says why');
r = rankProgrammes('A', { startMs: T0 + 0.1 * H, endMs: T0 + 0.9 * H }, [P('news', 0, 1), P('weather', 1, 1.2)]);
ok(r.best?.programmeId === 'news' && r.confident && r.candidates.length === 1, 'one programme around the clip: confident');
r = rankProgrammes('A', { startMs: T0 + 0.5 * H, endMs: T0 + 1.5 * H }, [P('first', 0, 1), P('second', 1, 2)]);
ok(r.candidates.length === 2 && !r.confident && /More than one/.test(r.reason ?? ''), 'clip straddles two programmes equally: not confident, operator picks');
r = rankProgrammes('A', { startMs: T0 + 0.8 * H, endMs: T0 + 2 * H }, [P('first', 0, 1), P('second', 1, 2)]);
ok(r.best?.programmeId === 'second' && r.confident, 'mostly in the second programme: the second, confidently');
r = rankProgrammes('A', { startMs: T0, endMs: T0 + 4 * H }, [P('a', 0, 1), P('b', 1, 2), P('c', 2, 3), P('d', 3, 4)]);
ok(!r.confident, 'a four-hour recording over four programmes: no single programme describes it');
r = rankProgrammes('A', { startMs: T0, endMs: T0 + H }, [P('loose', 0, 3)]);
ok(r.confident, 'clip inside a long programme: confident (the programme covers all of it)');
r = rankProgrammes('A', { startMs: T0 + 0.5 * H, endMs: T0 + 1.5 * H }, [P('first', 0, 1), P('second', 1, 2, {}, { clip_asset_id: 'A' })]);
ok(r.best?.programmeId === 'second' && r.best.linked && r.confident, 'the programme whose auto-VOD made this asset wins outright');
r = rankProgrammes('A', { startMs: T0, endMs: T0 + H }, [P('planned', 0, 1, {}, { actual_start: new Date(T0 + 2 * H).toISOString(), actual_end: new Date(T0 + 3 * H).toISOString() })]);
ok(!r.best, 'as-run times win over the plan: a programme that actually aired later does not match');
r = rankProgrammes('A', { startMs: T0, endMs: T0 + H }, [P('overlap-a', -0.5, 0.6), P('overlap-b', 0.4, 1.5)]);
ok(r.candidates.length === 2 && r.best?.programmeId === 'overlap-a' && !r.confident, 'overlapping programmes in the guide (60/60 min): both listed, not confident');

console.log('\n== programme to fields ==');
const xmltvEpisode = P('ep', 0, 1, { subTitle: 'The Pilot', description: 'It begins.', genre: 'Drama', categories: ['Drama', 'Crime'], season: 2, episodeNumber: 5, rating: 'M', icon: 'https://img.example/ep.jpg' });
xmltvEpisode.title = 'Harbour';
const f = programmeFacts(xmltvEpisode);
eq([f.title, f.subTitle, f.season, f.episodeNumber, f.rating], ['Harbour', 'The Pilot', 2, 5, 'M'], 'XMLTV episode: title, sub-title, numbers and rating read');
eq(suggestTypeKey(f), 'episode', 'an episodic programme suggests the Episode type');
const sugg = suggestionsFor(ep, 'episode', { title: 'My own title', description: '' }, xmltvEpisode);
const by = Object.fromEntries(sugg.map((s) => [s.field, s]));
eq(by.title?.value, 'The Pilot', 'episode title is the sub-title');
eq(by.title?.action, 'conflict', 'a typed title is a conflict, not a fill');
eq([by.series?.value, by.season?.value, by.episodeNumber?.value], ['Harbour', 2, 5], 'series, season, episode number suggested');
eq(by.genre?.value, ['Drama'], 'genre keeps only the type\'s options (Crime is not one)');
eq([by.rating?.value, by.image?.value, by.description?.action], ['M', 'https://img.example/ep.jpg', 'fill'], 'rating, image and description suggested');
let m = mergeSuggestions({ title: 'My own title' }, sugg);
eq(m.metadata.title, 'My own title', 'NEVER overwrites a typed value by default');
ok(m.skipped.some((s) => s.field === 'title') && m.changed.includes('series'), 'the conflict is reported as skipped, the empties are filled');
m = mergeSuggestions({ title: 'My own title' }, sugg, { fields: ['title', 'series'], overwrite: ['title'] });
eq([m.metadata.title, m.changed.sort().join(',')], ['The Pilot', 'series,title'], 'overwrite only when the operator names the field');
let valid = true; try { validateMetadata(ep.map((x) => ({ ...x, required: false })), mergeSuggestions({}, sugg).metadata); } catch (e: any) { valid = false; console.log(e.message); }
ok(valid, 'every suggested value passes the type\'s validation');
const onscreen = programmeFacts(P('x', 0, 1, { episode: 'S3E12' }));
eq([onscreen.season, onscreen.episodeNumber], [3, 12], 'onscreen S3E12 is read as season 3 episode 12');
const movie = programmeFacts(P('film', 0, 2, { categories: ['Movie', 'Drama'], date: '1994', credits: [{ role: 'director', name: 'A. Director' }, { role: 'actor', name: 'Lead One' }, { role: 'actor', name: 'Lead Two' }] }));
eq(suggestTypeKey(movie), 'movie', 'a film programme suggests the Movie type');
const mv = Object.fromEntries(type('movie').map((x) => [x.key, valueForField(x, movie)]));
eq([mv.year, mv.director, mv.cast], [1994, 'A. Director', ['Lead One', 'Lead Two']], 'movie: year, director and cast');
const match = programmeFacts(P('Roosters v Storm', 0, 2, { genre: 'Sport', competition: 'NRL 2026', homeTeam: 'Roosters', awayTeam: 'Storm', venue: 'Allianz Stadium' }));
eq(suggestTypeKey(match), 'sports-match', 'home and away teams suggest a sports match');
const smv = Object.fromEntries(type('sports-match').map((x) => [x.key, valueForField(x, match)]));
eq([smv.competition, (smv.homeTeam as any)?.name, (smv.awayTeam as any)?.name, smv.venue, smv.sport], ['NRL 2026', 'Roosters', 'Storm', 'Allianz Stadium', 'Sport'], 'sports match: competition, teams (as references), venue, sport');
eq(suggestTypeKey(programmeFacts(P('Talk', 0, 1, { genre: 'Talk' }))), null, 'nothing episodic or typed: no type suggestion');

console.log('\n== encode details ==');
const file = encodeDetails({
  source_kind: 'upload', original_filename: 'match.mov', source_bytes: 1e9, duration_ms: 5400000,
  formats: { hls: true, dash: true, progressive: false },
  encode_result: { ladder: { name: 'Standard VOD' }, segmentSeconds: 4, fps: 25, kept: [{ height: 720, bitrate_kbps: 3000 }, { height: 1080, bitrate_kbps: 6000 }], dropped: [{ height: 2160, bitrate_kbps: 15000, why: 'above_source_height' }], probe: { width: 1920, height: 1080, fps: 25, hasAudio: true } },
}, { ladderGroup: { codec_backend: 'x264', packaging: 'both' } });
eq([file.summary.topHeight, file.summary.codec, file.summary.renditions], [1080, 'H.264', 2], 'file encode: top 1080p H.264, two renditions (sorted top first)');
eq([file.renditions.source, file.workflow.value, file.ladder.value, file.segmentSeconds.value], ['stored', 'transcode', 'Standard VOD', 4], 'stored facts are marked stored');
eq(file.packaging.value, ['HLS', 'DASH'], 'packaging from the formats it produced');
eq([file.audio.source, file.audio.value[0]?.codec, file.audio.value[0]?.channels], ['derived', 'AAC', 2], 'audio from the encoder contract, marked derived');
eq(file.dropped, [{ height: 2160, why: 'above the source height' }], 'the dropped rung and why');
ok(file.gaps.some((g) => /Audio tracks are not recorded/.test(g)) && file.gaps.some((g) => /Caption/.test(g)), 'gaps name what is not recorded');
const live = encodeDetails({ source_kind: 'recording', channel_id: 'c', master_key: 'x', duration_ms: 60000 }, {
  outputProfile: { name: 'Live HD', rungs: [{ height: 1080, bitrate_kbps: 5000, codec: 'h264' }, { height: 540, bitrate_kbps: 1500 }], packaging: 'both', workflow_type: 'transcode', codec_backend: 'nvenc', segment_dur: '4.00', drm_enabled: true, drm_systems: ['widevine', 'fairplay'], captions_enabled: true, caption_source_lang: 'en', caption_targets: ['fr'] },
});
eq([live.summary.label, live.ladder.value], ['1080p · H.264 · 2 renditions', 'Live HD (live output profile)'], 'recording clip: the live profile renditions');
eq([live.drm.value, live.captions.value.map((x) => `${x.kind}:${x.language}`)], [['Widevine', 'Fairplay'], ['captions:en', 'subtitles:fr']], 'DRM systems and caption tracks from the profile');
const pkg = encodeDetails({ source_kind: 'recording', event_id: 'e' }, { outputProfile: { rungs: [{ height: 1080, bitrate_kbps: 8000 }], workflow_type: 'package_only', packaging: 'hls' } });
eq([pkg.workflow.value, pkg.audio.source, pkg.renditions.value[0].codec], ['package_only', 'unknown', 'unknown'], 'package-only: codec and audio are unknown, not guessed');
const none = encodeDetails({ source_kind: 'recording' });
ok(none.renditions.value.length === 0 && none.gaps.length > 0 && none.summary.label === '', 'nothing known: empty, with the gap stated');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
