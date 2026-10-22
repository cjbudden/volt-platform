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
import { parseStreams } from '../src/services/media/mediaFacts';

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

// Audio: a song cut from a radio recording, HLS and DASH referencing the recording, MP3 asked for and made, M4A not.
const radio = encodeDetails({ source_kind: 'recording', channel_id: 'r', master_key: 'clips/a/master.m3u8', formats: { hls: true, dash: true, progressive: false }, export_mp3_key: 'clips/a/clip.mp3', duration_ms: 272000 },
  { audioOnly: true, radioConfig: { bitrateKbps: 96 }, extract: { formats: ['hls', 'mp3'], state: 'done' } });
eq([radio.kind, radio.audioEncode?.codec, radio.audioEncode?.bitrateKbps, radio.audioEncode?.source], ['audio', 'AAC (HLS, DASH)', 96, 'stored'], 'audio: AAC at the station\'s bitrate');
eq(radio.deliveries.map((d) => `${d.label}:${d.state}`), ['HLS (audio only):ready', 'DASH (audio only):ready', 'MP3 (progressive):ready', 'AAC .m4a (progressive):not_requested'], 'audio deliveries: HLS and DASH referencing the recording, MP3 made, M4A not asked for');
ok(/recording's segments/.test(radio.deliveries[0].detail ?? '') && radio.deliveries[1].key === 'clips/a/manifest.mpd', 'the manifests reference the recording');
ok(!radio.deliveries.some((d) => d.format === 'mp4') && radio.summary.label === 'Audio only · AAC 96 kb/s · HLS, DASH, MP3' && !radio.gaps.some((g) => /Renditions|Video profile/.test(g)), 'no video rows, a summary that says what it is');
const making = encodeDetails({ source_kind: 'recording', channel_id: 'r', master_key: 'clips/b/master.m3u8', formats: { hls: true } }, { audioOnly: true, extract: { formats: ['hls', 'mp3', 'm4a'], state: 'running' } });
eq(making.deliveries.filter((d) => d.format === 'mp3' || d.format === 'm4a').map((d) => d.state), ['making', 'making'], 'asked for and still being made');
eq(live.kind === 'video' && live.deliveries.map((d) => d.format), ['hls', 'dash', 'mp4', 'mp3', 'm4a'], 'video lists MP4 too');

// ---- media facts (build queue 1.4): what the files carry, stored, not derived
const ps = parseStreams({ streams: [
  { codec_type: 'video', codec_name: 'h264', profile: 'High', level: 40, width: 1920, height: 1080, avg_frame_rate: '25/1' },
  { codec_type: 'video', codec_name: 'hevc', profile: 'Main 10', level: 120, width: 1280, height: 720, avg_frame_rate: '0/0', r_frame_rate: '50/1' },
  { codec_type: 'video', codec_name: 'mjpeg', disposition: { attached_pic: 1 } },
  { codec_type: 'audio', codec_name: 'aac', channels: 2, sample_rate: '48000', bit_rate: '128000', tags: { language: 'spa' } },
  { codec_type: 'audio', codec_name: 'ac3', channels: 6, sample_rate: '48000', tags: { language: 'und' } },
  { codec_type: 'subtitle', codec_name: 'webvtt', tags: { language: 'eng' } },
] }, '1080p');
eq(ps.video.map((v) => [v.codec, v.profile, v.level, v.fps]), [['h264', 'High', '4', 25], ['hevc', 'Main 10', '4', 50]], 'parseStreams: profile and level (H.264 /10, HEVC /30), cover art skipped');
eq(ps.audio.map((a) => [a.codec, a.channels, a.sampleRate, a.bitrateKbps, a.language]), [['aac', 2, 48000, 128, 'spa'], ['ac3', 6, 48000, null, null]], 'parseStreams: audio tracks; und is no language');
eq(ps.subtitles, [{ codec: 'webvtt', language: 'eng' }], 'parseStreams: subtitle tracks');
eq(parseStreams(null), { video: [], audio: [], subtitles: [] }, 'parseStreams: nothing in, nothing out');

const enc14 = encodeDetails({ source_kind: 'upload', master_key: 'clips/vod/x/master.m3u8', formats: { hls: true, dash: true, progressive: false },
  encode_result: { ladder: { name: 'Std' }, segmentSeconds: 4, kept: [{ height: 1080, bitrate_kbps: 6000 }, { height: 720, bitrate_kbps: 3000 }],
    probe: { height: 1080, hasAudio: true, videoCodec: 'h264', videoProfile: 'High 4:2:2', audioTracks: [{ codec: 'pcm_s24le', channels: 2, sampleRate: 48000, bitrateKbps: 2304, language: 'eng' }, { codec: 'aac', channels: 2, sampleRate: 48000, bitrateKbps: 192, language: 'fra' }],
      subtitleTracks: [{ codec: 'subrip', language: 'eng' }] },
    audio: [{ sourceTrack: 0, codec: 'AAC', bitrateKbps: 128, channels: 2, sampleRate: 48000, language: 'eng' }], captions: [], drm: 'clear' },
  media_facts: { how: 'encode', video: [{ label: '1080p', codec: 'h264', profile: 'High', level: '4', width: 1920, height: 1080, fps: 25 }, { label: '720p', codec: 'h264', profile: 'High', level: '3.1', width: 1280, height: 720, fps: 25 }],
    audio: [{ label: 'audio', codec: 'aac', channels: 2, sampleRate: 48000, bitrateKbps: null, language: 'eng' }], subtitles: [] } });
eq(enc14.renditions.value.map((r) => [r.height, r.profile, r.level]), [[1080, 'High', '4'], [720, 'High', '3.1']], 'file encode: profile and level per rendition, read from the files');
eq([enc14.audio.source, enc14.audio.value], ['stored', [{ codec: 'AAC', channels: 2, sampleRate: 48000, bitrateKbps: 128, language: 'eng' }]], 'file encode: the audio track as delivered, stored, with its language');
eq([enc14.captions.source, enc14.captions.value.length, enc14.drm.source, enc14.drm.value.length], ['stored', 0, 'stored', 0], 'file encode: no caption tracks and no DRM, both stored');
ok(!enc14.gaps.some((g) => /Audio tracks|Video profile|Caption|DRM/.test(g)), 'file encode: none of the four is a gap any more', JSON.stringify(enc14.gaps));
eq([enc14.source.videoCodec, enc14.source.videoProfile, enc14.source.audioTracks?.map((t) => `${t.codec}:${t.language}`), enc14.source.subtitleTracks?.length], ['H.264', 'High 4:2:2', ['PCM:eng', 'AAC:fra'], 1], 'file encode: the source codec and every source track');
ok(enc14.notes!.some((n) => /2 audio tracks \(eng, fra\); the encode carries the first/.test(n)) && enc14.notes!.some((n) => /1 subtitle track \(eng\)/.test(n)) && enc14.notes!.some((n) => /in the clear/.test(n)), 'file encode: notes say which track was encoded, what was not carried, and that it is clear', JSON.stringify(enc14.notes));

const pkg14 = encodeDetails({ source_kind: 'recording', channel_id: 'p', master_key: 'm', media_facts: { how: 'recording', run: 'r1', runs: 1,
  video: [{ label: '1080p', codec: 'h264', profile: 'Main', level: '4.1', width: 1920, height: 1080, fps: 50 }, { label: '540p', codec: 'h264', profile: 'Main', level: '3.1', width: 960, height: 540, fps: 50 }],
  audio: [{ label: 'audio', codec: 'mp2', channels: 2, sampleRate: 48000, bitrateKbps: 192, language: 'spa' }], subtitles: [] } },
  { outputProfile: { rungs: [], workflow_type: 'package_only', packaging: 'both' } });
eq(pkg14.renditions.value.map((r) => `${r.height}:${r.codec}:${r.profile}:${r.level}`), ['1080:H.264:Main:4.1', '540:H.264:Main:3.1'], 'package-only: renditions read from the recording when the profile has no rungs');
eq([pkg14.audio.source, pkg14.audio.value[0]?.codec, pkg14.audio.value[0]?.bitrateKbps, pkg14.audio.value[0]?.language], ['stored', 'MP2', 192, 'spa'], 'package-only: the source audio as passed through, stored');
eq([pkg14.source.videoCodec, pkg14.source.videoProfile, pkg14.source.audioTracks?.[0]?.codec, pkg14.source.width, pkg14.source.height, pkg14.source.fps], ['H.264', 'Main', 'MP2', 1920, 1080, 50], 'package-only: the source codec, audio and picture on the Source panel');
eq(enc14.source.subtitleTracks, [{ codec: 'SRT', language: 'eng' }], 'subtitle formats named as people say them');
ok(!pkg14.gaps.some((g) => /package-only|Video profile|Renditions/.test(g)), 'package-only: no gap left for codec, audio or profile', JSON.stringify(pkg14.gaps));
ok(pkg.gaps.some((g) => /package-only source passes audio through/.test(g)), 'package-only not yet read: the gap is still stated');
const old14 = encodeDetails({ source_kind: 'upload', encode_result: { kept: [{ height: 720, bitrate_kbps: 3000 }], probe: { hasAudio: true } } });
ok(old14.gaps.some((g) => /DRM is not applied/.test(g)) && old14.gaps.some((g) => /Caption and subtitle tracks are not recorded/.test(g)) && old14.audio.source === 'derived', 'an encode from before 1.4 still says what was not recorded');
const tr14 = encodeDetails({ source_kind: 'recording', channel_id: 'c', master_key: 'x', media_facts: { how: 'recording', video: [{ label: '720p', codec: 'h264', profile: 'High', level: '3.1', width: 1280, height: 720, fps: 25 }], audio: [{ label: 'audio', codec: 'aac', channels: 2, sampleRate: 48000, bitrateKbps: null, language: null }], subtitles: [] } },
  { outputProfile: { rungs: [{ height: 1080, bitrate_kbps: 5000 }, { height: 720, bitrate_kbps: 3000 }], workflow_type: 'transcode', codec_backend: 'x264', caption_source_lang: 'en', captions_enabled: false } });
eq(tr14.renditions.value.map((r) => `${r.height}:${r.profile ?? '-'}`), ['1080:-', '720:High'], 'transcoded recording: the profile where the recording was read, nothing invented for the rung it lacks');
eq([tr14.audio.source, tr14.audio.value[0]?.language, tr14.audio.value[0]?.bitrateKbps], ['stored', 'en', null], 'transcoded recording: audio stored, language from the spoken-language setting, no bitrate made up');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
