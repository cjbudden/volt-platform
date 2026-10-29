// ============================================================================
//  IMAGE TYPES FOR AN ASSET: the pure rules, pinned (services/media/
//  assetImageRules.ts, docs/ASSET_IMAGES.md section 13). No database.
//
//  Thumbnail is video's main image and Cover audio's; the order an asset's
//  types are offered in; shapes parsed and labelled; the image-service spec
//  per type (cover crop on a focus point, smart without one, title art whole
//  and transparent); fallbacks (own image, the chain, the primary, never for
//  title art); size and shape warnings; what an account may change.
//
//  Usage: npx tsx test/asset-image-types.check.ts
// ============================================================================
import {
  STANDARD_IMAGE_TYPES, primaryTypeKey, typesFor, aspectLabel, parseAspect, boxFor, specFor, resolveFallback, fitWarnings, cleanType,
  type ImageType,
} from '../src/services/media/assetImageRules';

let pass = 0, fail = 0;
const ok = (m: string) => { console.log('PASS ' + m); pass++; };
const bad = (m: string, d: string) => { console.log(`FAIL ${m} -- ${d}`); fail++; };
const eq = (m: string, got: unknown, want: unknown) => JSON.stringify(got) === JSON.stringify(want) ? ok(m) : bad(m, `expected ${JSON.stringify(want)} got ${JSON.stringify(got)}`);
const throws = (m: string, fn: () => unknown, rx?: RegExp) => {
  try { fn(); bad(m, 'did not throw'); } catch (e: any) { rx && !rx.test(e.message) ? bad(m, `wrong message: ${e.message}`) : ok(m); }
};
const T = (k: string) => STANDARD_IMAGE_TYPES.find((t) => t.key === k)!;

console.log('== the main image ==');
eq('video: thumbnail', primaryTypeKey('video'), 'thumbnail');
eq('audio: cover', primaryTypeKey('audio'), 'cover');
eq('thumbnail is primary for video only', T('thumbnail').primaryFor, ['video']);
eq('cover is primary for audio only', T('cover').primaryFor, ['audio']);

console.log('== what an asset offers ==');
eq('video: thumbnail first, then content, then publishing', typesFor(STANDARD_IMAGE_TYPES, 'video').map((t) => t.key), ['thumbnail', 'cover', 'poster', 'hero', 'banner', 'social', 'title']);
eq('audio: cover first, no thumbnail', typesFor(STANDARD_IMAGE_TYPES, 'audio').map((t) => t.key), ['cover', 'poster', 'hero', 'banner', 'social', 'title']);
eq('a switched-off type is not offered', typesFor(STANDARD_IMAGE_TYPES.map((t) => t.key === 'banner' ? { ...t, enabled: false } : t), 'video').map((t) => t.key).includes('banner'), false);
const custom: ImageType = { ...T('poster'), key: 'partner-tile', label: 'Partner tile', aspectW: 4, aspectH: 3, isStandard: false, sort: 5, purpose: 'publishing' };
eq('a custom type sorts within its group by sort', typesFor([...STANDARD_IMAGE_TYPES, custom], 'video').map((t) => t.key).slice(0, 4), ['thumbnail', 'cover', 'partner-tile', 'poster']);

console.log('== shapes ==');
eq('16:9', aspectLabel(T('thumbnail')), '16:9');
eq('2:3 poster', aspectLabel(T('poster')), '2:3');
eq('40:21 reads 1.91:1', aspectLabel(T('social')), '1.91:1');
eq('title art: any', aspectLabel(T('title')), 'any');
eq('parse 4:3', parseAspect('4:3'), { w: 4, h: 3 });
eq('parse 1920x1080 reduces', parseAspect('1920x1080'), { w: 16, h: 9 });
eq('parse 1.91:1', parseAspect('1.91:1'), { w: 191, h: 100 });
eq('parse any', parseAspect('any'), null);
eq('parse empty', parseAspect(''), null);
throws('parse nonsense', () => parseAspect('wide'), /not a shape/);
throws('parse zero', () => parseAspect('0:1'), /more than 0/);
throws('parse extreme', () => parseAspect('20:1'), /extreme/);
eq('box for poster at 1000', boxFor(T('poster'), 1000), { w: 1000, h: 1500 });
eq('box for title art is natural height', boxFor(T('title'), 800), { w: 800, h: 0 });

console.log('== image-service specs ==');
eq('poster, no focus: smart crop', specFor(T('poster'), 600), '600x900,cover,focus=smart');
eq('hero with a focus point', specFor(T('hero'), 1920, { x: 70, y: 30 }), '1920x1080,cover,focus=70-30');
eq('focus clamped and rounded', specFor(T('banner'), 1920, { x: 120.4, y: -3 }), '1920x640,cover,focus=100-0');
eq('title art: whole, png', specFor(T('title'), 800), '800x0,inside,fmt=png');
eq('version and format', specFor(T('social'), 1200, null, { format: 'jpeg', version: '1730000000000' }), '1200x630,cover,focus=smart,fmt=jpeg,v=1730000000000');

console.log('== fallbacks ==');
const P = 'library/acc/media/show/poster.jpg';
eq('poster falls back to the primary (video)', resolveFallback(T('poster'), {}, P, 'thumbnail'), { from: 'thumbnail', key: P });
eq('poster falls back to the primary (audio: the cover)', resolveFallback(T('poster'), {}, P, 'cover'), { from: 'cover', key: P });
eq('banner prefers a hero of its own', resolveFallback(T('banner'), { hero: { key: 'library/acc/hero.jpg' } }, P, 'thumbnail'), { from: 'hero', key: 'library/acc/hero.jpg' });
eq('banner without a hero: the thumbnail (= primary on video)', resolveFallback(T('banner'), {}, P, 'thumbnail'), { from: 'thumbnail', key: P });
eq('audio banner: no thumbnail, so the cover', resolveFallback(T('banner'), {}, P, 'cover'), { from: 'cover', key: P });
eq('nothing at all', resolveFallback(T('poster'), {}, null, 'thumbnail'), null);
eq('title art never falls back', resolveFallback(T('title'), { hero: { key: 'x' } }, P, 'thumbnail'), null);
eq('a type never falls back to itself', resolveFallback({ key: 'hero', fallback: ['hero', 'primary'] }, { hero: { key: 'h' } }, P, 'thumbnail'), { from: 'thumbnail', key: P });

console.log('== warnings ==');
eq('a full-size poster fits', fitWarnings(T('poster'), 2000, 3000), []);
eq('a small poster', fitWarnings(T('poster'), 500, 750).length, 1);
eq('a wide image as a poster says so', /Not 2:3 \(this one is 16:9\)/.test(fitWarnings(T('poster'), 1920, 1080).join(' ')), true);
eq('title art: any shape is fine', fitWarnings(T('title'), 2000, 400), []);
eq('unknown size: no warnings', fitWarnings(T('poster'), null, null), []);

console.log('== what an account may change ==');
const keys = new Set(STANDARD_IMAGE_TYPES.map((t) => t.key));
const c = cleanType({ key: 'partner-tile', label: 'Partner tile', aspect: '4:3', minWidth: 800, minHeight: 600, appliesTo: ['video'] }, null, keys);
eq('a custom type', [c.key, c.aspectW, c.aspectH, c.appliesTo, c.fallback, c.isStandard, c.purpose], ['partner-tile', 4, 3, ['video'], ['primary'], false, 'publishing']);
throws('a bad key', () => cleanType({ key: 'Partner Tile', label: 'x' }, null, keys), /lower-case/);
throws('a reserved key', () => cleanType({ key: 'primary', label: 'x' }, null, keys), /reserved/);
throws('a key in use', () => cleanType({ key: 'poster', label: 'x' }, null, keys), /already/);
throws('a fallback that is not a type', () => cleanType({ key: 'tile', label: 'x', fallback: ['nope'] }, null, keys), /not an image type/);
throws('neither video nor audio', () => cleanType({ key: 'tile', label: 'x', appliesTo: [] }, null, keys), /video, audio or both/);
const renamed = cleanType({ label: 'Key art', aspect: '16:9', appliesTo: ['audio'] }, T('poster'), keys);
eq('a standard type can be renamed but keeps its shape and media', [renamed.label, renamed.aspectW, renamed.aspectH, renamed.appliesTo], ['Key art', 2, 3, ['video', 'audio']]);
throws('the thumbnail cannot be switched off', () => cleanType({ enabled: false }, T('thumbnail'), keys), /cannot be switched off/);
throws('nor the cover', () => cleanType({ enabled: false }, T('cover'), keys), /cannot be switched off/);
eq('the poster can', cleanType({ enabled: false }, T('poster'), keys).enabled, false);
eq('title art keeps no fallback when edited', cleanType({ label: 'Logo' }, T('title'), keys).fallback, []);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
