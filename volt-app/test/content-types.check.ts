// ============================================================================
//  CONTENT TYPES — the standard schemas and the EPG mapping, pinned.
//
//  Pure: no database. The seed itself is exercised by the API checks; what is
//  pinned here is the table it seeds from (keys unique, parents before
//  children, every EPG slot valid, each owner kind has a default) and the
//  function that turns an owner's metadata into EPG fields.
//
//  Usage: npx tsx test/content-types.check.ts
// ============================================================================
import { STANDARD_TYPES, DEFAULT_TYPE_KEY, EPG_SLOT_RX, programmeFieldsFrom } from '../src/services/contentTypes';
import { validateSchemaFields, mergeFields, validateMetadata } from '../src/services/metadataValidator';

let pass = 0, fail = 0;
const ok = (m: string) => { console.log('PASS ' + m); pass++; };
const bad = (m: string, d: string) => { console.log(`FAIL ${m} -- ${d}`); fail++; };
const check = (m: string, got: unknown, want: unknown) =>
  got === want ? ok(m) : bad(m, `expected [${String(want)}] got [${String(got)}]`);
const truthy = (m: string, v: unknown, d = '') => (v ? ok(m) : bad(m, d || `expected truthy, got [${String(v)}]`));

console.log('== the standard table ==');
const keys = STANDARD_TYPES.map((t) => t.key);
check('keys are unique', new Set(keys).size, keys.length);
for (const t of STANDARD_TYPES) {
  if (t.extendsKey) {
    truthy(`${t.key}: parent ${t.extendsKey} exists`, keys.includes(t.extendsKey));
    truthy(`${t.key}: parent is seeded before it`, keys.indexOf(t.extendsKey) < keys.indexOf(t.key));
  }
  let valid = true; let why = '';
  try { validateSchemaFields(t.fields); } catch (e: any) { valid = false; why = e.message; }
  truthy(`${t.key}: fields validate`, valid, why);
  for (const f of t.fields) if (f.epg) truthy(`${t.key}.${f.key}: epg slot ${f.epg} is valid`, EPG_SLOT_RX.test(f.epg));
  truthy(`${t.key}: applies to at least one owner kind`, t.appliesTo.length > 0);
  truthy(`${t.key}: has a schema.org type`, !!t.schemaOrgType);
}
for (const [kind, key] of Object.entries(DEFAULT_TYPE_KEY)) {
  const t = STANDARD_TYPES.find((x) => x.key === key);
  truthy(`default for ${kind} (${key}) exists`, !!t);
  truthy(`default for ${kind} is offered for ${kind}`, !!t && t.appliesTo.includes(kind as any));
}
// owner types must bind to derived assets too
for (const k of ['radio-station', 'tv-channel', 'broadcast-event', 'sports-match']) {
  check(`${k} binds to owner and derived assets (target any)`, STANDARD_TYPES.find((t) => t.key === k)?.targetKind, 'any');
}

console.log('\n== a child type inherits the parent fields ==');
const base = STANDARD_TYPES.find((t) => t.key === 'broadcast-event')!;
const match = STANDARD_TYPES.find((t) => t.key === 'sports-match')!;
const eff = mergeFields(base.fields, match.fields);
truthy('sports match has the event name field from its parent', eff.some((f) => f.key === 'name' && f.epg === 'title'));
truthy('and its own teams', eff.some((f) => f.key === 'homeTeam') && eff.some((f) => f.key === 'awayTeam'));

console.log('\n== metadata lands in EPG fields through the mapping ==');
const p = programmeFieldsFrom(eff, {
  name: 'Roosters v Storm', description: 'Round 27', sport: 'Rugby league', competition: 'NRL 2026',
  homeTeam: { name: 'Roosters' }, awayTeam: 'Storm', round: '27', commentators: ['A. Voice', 'B. Voice'],
  performers: [],
});
check('title', p.title, 'Roosters v Storm');
check('sub-title from competition', p.subTitle, 'NRL 2026');
check('episode from round', p.episode, '27');
truthy('sport lands as a category', p.categories.includes('Rugby league'));
check('teams become credits (actor), reference object and string alike', p.credits.filter((c) => c.role === 'actor').map((c) => c.name).join('|'), 'Roosters|Storm');
check('commentators become credits', p.credits.filter((c) => c.role === 'commentator').length, 2);
check('empty lists are skipped', p.credits.some((c) => c.role === 'presenter'), false);

const station = STANDARD_TYPES.find((t) => t.key === 'radio-station')!;
const s = programmeFieldsFrom(station.fields, { name: 'DEF CON Radio', genre: ['Music', 'Talk'], logo: 'https://x/logo.png', language: 'en' });
check('station name is the base title', s.title, 'DEF CON Radio');
check('genres are categories', s.categories.join(','), 'Music,Talk');
check('logo is the icon', s.icon, 'https://x/logo.png');
check('language carried', s.language, 'en');

// --- unknown keys: assets reject, owners keep -------------------------------
// A seeded station carries { seeded: 'scripts/seed-radio.ts' } in its metadata
// column. Saving Settings must not fail on it, and must not delete it either.
{
  const seededMeta = { name: 'ABC Classic', seeded: 'scripts/seed-radio.ts', seed_note: 'x' };
  let threw = '';
  try { validateMetadata(station.fields, seededMeta); } catch (e: any) { threw = e.message; }
  check('asset policy rejects unknown keys', threw, 'unknown metadata field: seeded');
  const kept = validateMetadata(station.fields, seededMeta, 'keep');
  check('owner policy keeps provenance keys', kept.seeded, 'scripts/seed-radio.ts');
  check('owner policy keeps every unknown key', kept.seed_note, 'x');
  check('owner policy still validates known fields', kept.name, 'ABC Classic');
  // Required fields are a publish rule (review.ts publishGate), not a save rule: saving
  // with them empty works, and a caller that must have them can still ask.
  let saved: any = null;
  try { saved = validateMetadata(station.fields, { seeded: 'y' }, 'keep'); } catch { /* */ }
  truthy('saving with a required field empty is allowed', saved && saved.seeded === 'y');
  let req = '';
  try { validateMetadata(station.fields, { seeded: 'y' }, 'keep', 'enforce'); } catch (e: any) { req = e.message; }
  truthy('a caller can still enforce required fields', /missing required field/.test(req));
}

console.log(`content-types: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
