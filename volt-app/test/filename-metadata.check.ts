// ============================================================================
//  FILE NAMES AS METADATA, the pure part pinned: the parser
//  (services/ingest/filenameParse.ts), the classification rules and their
//  precedence (classify.ts), the related-content scoring and decision
//  (relatedMatch.ts), and the field values a reading gives a type
//  (filenameApply.ts fieldValues). No database.
//
//  Usage: npx tsx test/filename-metadata.check.ts
// ============================================================================
import { parseFilename, titleCase, episodeTitleFrom } from '../src/services/ingest/filenameParse';
import { classify, BUILTIN_RULES, checkRule, type ClassRule } from '../src/services/ingest/classify';
import { decideMatch, titleSimilarity, normTitle, yearInTitle, AUTO_LINK } from '../src/services/relatedMatch';
import { fieldValues, titleFor, matchQuery, DEFAULT_SETTINGS } from '../src/services/ingest/filenameApply';
import { STANDARD_TYPES } from '../src/services/contentTypes';
import { validateMetadata, validateSchemaFields } from '../src/services/metadataValidator';

let pass = 0, fail = 0;
const ok = (m: string) => { console.log('PASS ' + m); pass++; };
const bad = (m: string, d: string) => { console.log(`FAIL ${m} -- ${d}`); fail++; };
const eq = (m: string, got: unknown, want: unknown) => JSON.stringify(got) === JSON.stringify(want) ? ok(m) : bad(m, `expected ${JSON.stringify(want)} got ${JSON.stringify(got)}`);
const yes = (m: string, c: unknown, d = '') => (c ? ok(m) : bad(m, d || 'false'));
const P = (n: string, o: any = {}) => parseFilename(n, { nowYear: 2026, ...o });
const keys = new Set(['clip', 'song', 'interview', 'episode', 'movie', 'trailer', 'music-video', 'bug']);
const C = (n: string, rules: ClassRule[] = [], o: any = {}) => classify(P(n), rules, { known: { keys }, ...o });

console.log('== normalising: extension, separators, case ==');
for (const n of ['Movie_Title_2025_Official_Trailer.mp4', 'movie-title-2025-official-trailer.MOV', 'Movie.Title.2025.Official.Trailer.mkv', 'MOVIE TITLE 2025 OFFICIAL TRAILER.webm', 'Movie Title (2025) [Official Trailer].mp4'])
  eq(`${n}: title, year, promo`, (({ title, year, promo }) => [title, year, promo?.kind])(P(n)), ['Movie Title', 2025, 'Trailer']);
eq('extension kept apart', [P('a_b.webm').extension, P('folder/sub/a_b.mxf').base], ['webm', 'a_b']);
eq('no extension', P('Some Name').extension, null);
eq('the worked example', (({ title, year, resolution, promo }) => [title, year, resolution, promo?.kind])(P('7th-voyage-of-sinbad_1958_trailer_1080p.webm')), ['7th Voyage Of Sinbad', 1958, '1080p', 'Trailer']);
eq('headline case keeps small words low', P('7th-voyage-of-sinbad_1958_trailer.webm', { titleCase: 'headline' }).title, '7th Voyage of Sinbad');
eq('mixed case kept (McDonald, iPhone)', P('McDonald_and_the_iPhone_promo.mp4').title, 'McDonald And The iPhone');
eq('roman numerals', P('rocky_ii_trailer.mp4').title, 'Rocky II');
eq('title case helper', titleCase([{ text: 'hello' }, { text: 'WORLD' }], 'mixed'), 'Hello WORLD');

console.log('== tags taken off and recorded ==');
const tech = P('Blade.Runner.2049.2017.2160p.HDR.x265.mkv');
eq('dotted name: 2049 stays, 2017 is the year', [tech.title, tech.year, tech.resolution], ['Blade Runner 2049', 2017, '2160p']);
eq('codec recorded', tech.signals.find((s) => s.kind === 'videoCodec')?.value, 'h265');
eq('h.264 and a date with dashes', (({ title, date }) => [title, date])(P('my-show.2026-10-28.h.264.aac.mp4')), ['My Show', '2026-10-28']);
eq('compact date and version', (({ date }) => date)(P('Interview_20261028_v2.mxf')), '2026-10-28');
eq('5.1 audio is one token', P('Film_Name_5.1_1080p.mp4').signals.find((s) => s.kind === 'audio')?.value, '5.1');
eq('frame rate', P('Concert_50fps_1080p.mov').fps, 50);
eq('language in capitals or brackets', [P('Movie (2025) [EN] Teaser.mp4').language, P('News_Bulletin_THA.mxf').language], ['en', 'th']);
eq('a lower-case word is not a language', P('The.Merry.Month.of.May.2019.mkv').title, 'The Merry Month Of May');
eq('every signal has a reason', P('7th-voyage-of-sinbad_1958_trailer_1080p.webm').signals.every((s) => s.reason && s.token), true);

console.log('== ordinary words are not tags ==');
eq('Charlotte\'s Web keeps web', P('Charlottes_Web_1080p.mp4').title, 'Charlottes Web');
eq('The Master keeps master', P('The_Master_trailer.mov').title, 'The Master');
eq('Final Destination keeps final', P('Final_Destination_Trailer_2.mp4').title, 'Final Destination');
eq('Hot Spot Cafe keeps spot', P('Hot_Spot_Cafe_promo.mp4').title, 'Hot Spot Cafe');
eq('a workflow word in capitals goes', P('News_At_Six_FINAL.mxf').title, 'News At Six');
eq('never strip to nothing: 1917', [P('1917.mp4').title, P('1917.mp4').year], ['1917', null]);
eq('never strip to nothing: 1917 trailer', [P('1917_trailer.mp4').title, P('1917_trailer.mp4').promo?.kind], ['1917', 'Trailer']);
eq('2001 at the start stays in the title', P('2001_A_Space_Odyssey_teaser.mp4').title, '2001 A Space Odyssey');

console.log('== seasons and episodes ==');
const se = (n: string) => (({ series, title, season, episode }) => [series, title, season, episode])(P(n));
eq('S01E03', se('Show_Name_S01E03.mp4'), ['Show Name', 'Episode 3 (S1)', 1, 3]);
eq('s1 ep01', se('bluey_s1_ep01.mp4'), ['Bluey', 'Episode 1 (S1)', 1, 1]);
eq('1x03', se('Show.Name.1x03.mkv'), ['Show Name', 'Episode 3 (S1)', 1, 3]);
eq('Season 2 Episode 5 with a title after', se('Show Name - Season 2 Episode 5 - The Return.mp4'), ['Show Name', 'The Return', 2, 5]);
eq('series1 eps01', se('Programme_series1_eps01.mp4'), ['Programme', 'Episode 1 (S1)', 1, 1]);
eq('e01 only', se('Show_e01.mp4'), ['Show', 'Episode 1', null, 1]);
eq('Episode 3 alone', se('Episode 3.mp4'), [null, 'Episode 3', null, 3]);
eq('episode title after the marker', se('the-office_s02e01_the-dundies_720p.mov'), ['The Office', 'The Dundies', 2, 1]);
eq('template without a season', episodeTitleFrom({ season: null, episode: 4 }), 'Episode 4');
eq('a promo word starting an episode name stays (Trailer Park Boys)', se('Trailer_Park_Boys_S01E01.mkv'), ['Trailer Park Boys', 'Episode 1 (S1)', 1, 1]);
eq('word "e" needs two digits', P('Plan_e_1.mp4').episode, null);

console.log('== promo kinds ==');
for (const [n, k] of [['X_teaser.mp4', 'Teaser'], ['X_promo.mp4', 'Promo'], ['X_featurette.mp4', 'Featurette'], ['Sneak_Peek_Big_Movie.mp4', 'Teaser'], ['Big Movie - TV Spot.mp4', 'Promo'], ['Big_Movie_tlr.mp4', 'Trailer'], ['Big Movie - Behind the Scenes.mp4', 'Featurette']] as const)
  eq(`${n} is a ${k}`, P(n).promo?.kind, k);
eq('Official Trailer 2 is one marker', P('Movie_Official_Trailer_2.mp4').title, 'Movie');

console.log('== classification ==');
const best = (n: string, r: ClassRule[] = [], o: any = {}) => { const c = C(n, r, o); return [c.best?.typeKey ?? null, c.best?.kind ?? null, c.confident, !!c.conflict]; };
eq('trailer, confident, kind set', best('Movie_Title_2025_Official_Trailer.mp4'), ['trailer', 'Trailer', true, false]);
eq('teaser is the Trailer type with kind Teaser', best('Movie_Teaser.mp4'), ['trailer', 'Teaser', true, false]);
eq('S01E03 is an episode', best('Show_S01E03.mp4'), ['episode', null, true, false]);
eq('Episode 3 alone is an episode', best('Show_Episode_3.mp4'), ['episode', null, true, false]);
eq('Season 1 alone suggests, not confident', best('Show_Season_1.mp4'), ['episode', null, false, false]);
eq('interview word suggests, not confident', best('Jane_Smith_Interview.mp4'), ['interview', null, false, false]);
eq('nothing in a plain name', C('Holiday Footage.mp4').best, null);
const promoEp = C('Show_S01E03_Promo.mp4');
eq('CONFLICT RULE: a promo at the end outranks episode markers', [promoEp.best?.typeKey, promoEp.confident, !!promoEp.conflict], ['trailer', true, false]);
yes('...and says why', /outranks season and episode markers/.test(promoEp.summary));
eq('...both types are kept as votes', promoEp.votes.map((v) => v.typeKey).sort(), ['episode', 'trailer']);
const tpb = C('Trailer_Park_Boys_S01E01.mkv');
eq('a weak promo word does not beat S01E01', [tpb.best?.typeKey, tpb.confident], ['episode', true]);
const close = C('Jane_Smith_Interview_Highlights.mp4');
eq('two types too close: a conflict, nothing confident', [!!close.conflict, close.confident], [true, false]);
yes('...the conflict names both', /Interview/.test(close.conflict?.reason ?? '') && /Clip/.test(close.conflict?.reason ?? ''));
const myRule: ClassRule = { id: 'r1', name: 'House promos', enabled: true, origin: 'account', ordinal: 1, when: { words: ['pkg'] }, then: { typeKey: 'clip' }, confidence: 0.85 };
eq('an account rule applies', best('Story_pkg.mp4', [myRule]), ['clip', null, true, false]);
const rulesWin = C('Movie_trailer_pkg.mp4', [myRule]);
eq('PRECEDENCE: the account rule beats a built-in', [rulesWin.best?.typeKey, rulesWin.best?.origin], ['clip', 'account']);
yes('...and says so', /Your rules take precedence/.test(rulesWin.summary));
eq('a switched-off built-in does nothing', C('Movie_Trailer.mp4', [], { disabledBuiltins: ['builtin:promo'] }).best, null);
eq('a type the account lacks is not suggested', classify(P('Movie_Trailer.mp4'), [], { known: { keys: new Set(['episode']) } }).best, null);
eq('account words are stripped from the title', P('Story_Name_pkg.mp4', { extraWords: [{ words: ['pkg'], ruleId: 'r1' }] }).title, 'Story Name');
const pat: ClassRule = { ...myRule, id: 'r2', when: { pattern: '^abc ' }, then: { typeKey: 'interview' } };
eq('a pattern rule', C('ABC_jane_smith.mxf', [pat]).best?.typeKey, 'interview');
yes('every built-in names a standard type', BUILTIN_RULES.every((r) => STANDARD_TYPES.some((t) => t.key === r.then.typeKey)));
const ruleErr = (r: any) => { try { checkRule(r); return null; } catch (e: any) { return e.message; } };
yes('a rule needs a condition', ruleErr({ when: {}, then: { typeKey: 'clip' } }));
yes('a bad pattern is refused', ruleErr({ when: { pattern: '(' }, then: { typeKey: 'clip' } }));
yes('a rule needs a type', ruleErr({ when: { words: ['x'] }, then: {} }));

console.log('== fields for a type ==');
const typeFields = (k: string) => STANDARD_TYPES.find((t) => t.key === k)!.fields;
const fv = (n: string, k: string) => Object.fromEntries(fieldValues(P(n), k, typeFields(k), DEFAULT_SETTINGS).map((v) => [v.field, v.value]));
eq('trailer: title and kind (year has no field on a trailer)', fv('Movie_Title_2025_Official_Trailer.mp4', 'trailer'), { title: 'Movie Title', trailerType: 'Trailer' });
eq('movie: title and year', fv('Movie_Title_2025_1080p.mp4', 'movie'), { title: 'Movie Title', year: 2025 });
eq('episode: series, season, number, title', fv('bluey_s1_ep01.mp4', 'episode'), { title: 'Episode 1 (S1)', series: 'Bluey', season: 1, episodeNumber: 1 });
eq('promo of an episode is titled with the programme', titleFor(P('Show_S01E03_Promo.mp4'), 'trailer', DEFAULT_SETTINGS.episodeTemplate), 'Show: Episode 3 (S1)');
eq('interview: recorded date', fv('Interview_Jane_Smith_2026-10-28.mxf', 'interview').recordedAt, '2026-10-28');
eq('what a trailer looks for', (({ title, year }) => [title, year])(matchQuery(P('Movie_Title_2025_Official_Trailer.mp4'))), ['Movie Title', 2025]);
eq('a promo of an episode looks for the programme and the episode', (({ title, season, episode }) => [title, season, episode])(matchQuery(P('Show_S01E03_Promo.mp4'))), ['Show', 1, 3]);

console.log('== related content: scoring and the decision ==');
eq('bracketed year comes off a record title', [normTitle('Movie Title (2025)'), yearInTitle('Movie Title (2025)')], ['movie title', 2025]);
eq('an unbracketed number stays', normTitle('Blade Runner 2049'), 'blade runner 2049');
eq('articles do not separate titles', titleSimilarity('The Office', 'Office') >= 0.95, true);
eq('& and "and"', titleSimilarity('Tom & Jerry', 'Tom and Jerry'), 1);
const lib = [
  { id: 'm25', title: 'Movie Title (2025)', typeKey: 'movie' }, { id: 'm98', title: 'Movie Title (1998)', typeKey: 'movie' },
  { id: 'oth', title: 'Another Film', typeKey: 'movie' }, { id: 'mts', title: 'Movie Titles', typeKey: 'movie' },
];
const d1 = decideMatch(matchQuery(P('Movie_Title_2025_Official_Trailer.mp4')), lib);
eq('THE EXAMPLE: one clear match links', [d1.action, d1.best?.id], ['link', 'm25']);
yes('...with reasons a person can read', d1.best!.reasons.some((r) => /exactly/.test(r)) && d1.best!.reasons.some((r) => /Same year/.test(r)));
yes('...naming what was taken out of the file name', d1.best!.reasons.some((r) => /Official Trailer/.test(r)));
const d2 = decideMatch(matchQuery(P('Movie_Title_Trailer.mp4')), lib);
eq('AMBIGUOUS: two equal titles, no year: suggestions, no link', [d2.action, d2.candidates.map((c) => c.id).slice(0, 2).sort()], ['suggest', ['m25', 'm98']]);
yes('...says two are close', /Two records are close/.test(d2.reason));
const d3 = decideMatch(matchQuery(P('Completely_Different_Thing_trailer.mp4')), lib);
eq('INSUFFICIENT: nothing alike, no link and no suggestion', [d3.action, d3.candidates.length], ['none', 0]);
const d4 = decideMatch(matchQuery(P('Movie_Title_1984_trailer.mp4')), lib);
yes('a different year pushes a record away', d4.action !== 'link');
const eps = [
  { id: 'e13', title: 'Episode 3 (S1)', names: ['Show'], typeKey: 'episode', season: 1, episode: 3 },
  { id: 'e14', title: 'Episode 4 (S1)', names: ['Show'], typeKey: 'episode', season: 1, episode: 4 },
  { id: 'mv', title: 'Show', typeKey: 'movie' },
];
const d5 = decideMatch(matchQuery(P('Show_S01E03_Promo.mp4')), eps);
eq('a promo for S01E03 links to that episode', [d5.action, d5.best?.id], ['link', 'e13']);
const d6 = decideMatch(matchQuery(P('Show_Promo.mp4')), eps);
yes('a promo naming no episode does not pick one', !(d6.action === 'link' && d6.best?.typeKey === 'episode'));
yes('the auto-link level is high', AUTO_LINK >= 0.85);
const near = decideMatch({ title: 'Movie Titl' }, [{ id: 'a', title: 'Movie Title', typeKey: 'movie' }]);
eq('a near miss is suggested, not linked', near.action, 'suggest');

console.log('== the content field type ==');
const tf = typeFields('trailer').find((f) => f.key === 'trailerFor')!;
eq('Trailer for is a content-link field with its relation', [tf.type, tf.relation], ['content', 'trailer_for']);
yes('the standard types still validate', (() => { try { for (const t of STANDARD_TYPES) validateSchemaFields(t.fields); return true; } catch { return false; } })());
const cf = [{ key: 'trailerFor', type: 'content' as const }];
eq('a confirmed link keeps id and name', validateMetadata(cf, { trailerFor: { id: '11111111-1111-1111-1111-111111111111', name: 'X' } }), { trailerFor: { id: '11111111-1111-1111-1111-111111111111', name: 'X' } });
eq('an unresolved name', validateMetadata(cf, { trailerFor: { name: ' Movie Title ' } }), { trailerFor: { name: 'Movie Title' } });
eq('a plain string from an older client is a name', validateMetadata(cf, { trailerFor: 'Movie Title' }), { trailerFor: { name: 'Movie Title' } });
const vErr = (v: any) => { try { validateMetadata(cf, { trailerFor: v }); return null; } catch (e: any) { return e.message; } };
yes('an id that is not a record id is refused', vErr({ id: 'nope' }));
yes('an empty object is refused', vErr({}));
yes('a relation on a non-content field is refused', (() => { try { validateSchemaFields([{ key: 'x', type: 'string', relation: 'trailer_for' }]); return false; } catch { return true; } })());

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
