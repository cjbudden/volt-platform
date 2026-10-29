// ============================================================================
//  METADATA LISTS (genres): the pure rules, pinned. No database.
//
//  What a client can do to its genre list without breaking anything already
//  tagged: clean input, retire (still valid, not offered), rename and merge
//  (values rewritten, duplicates folded), remove only what nothing carries,
//  reset keeps values in use. And the copy into linked type fields.
//
//  Usage: npx tsx test/metadata-lists.check.ts
// ============================================================================
import {
  normaliseItems, linkFields, planSave, renameIn, linkedKeys, resetItems, DEFAULT_GENRES, activeValues,
} from '../src/services/metadataLists';
import { STANDARD_TYPES } from '../src/services/contentTypes';
import { validateMetadata, validateSchemaFields, type SchemaField } from '../src/services/metadataValidator';

let pass = 0, fail = 0;
const ok = (m: string) => { console.log('PASS ' + m); pass++; };
const bad = (m: string, d: string) => { console.log(`FAIL ${m} -- ${d}`); fail++; };
const eq = (m: string, got: unknown, want: unknown) => JSON.stringify(got) === JSON.stringify(want) ? ok(m) : bad(m, `expected ${JSON.stringify(want)} got ${JSON.stringify(got)}`);
const throws = (m: string, fn: () => unknown, rx?: RegExp) => {
  try { fn(); bad(m, 'did not throw'); } catch (e: any) { rx && !rx.test(e.message) ? bad(m, `wrong message: ${e.message}`) : ok(m); }
};

console.log('== cleaning a list ==');
eq('trims and collapses spaces', normaliseItems(['  True   Crime ', { value: 'News' }]), [{ value: 'True Crime' }, { value: 'News' }]);
eq('keeps retired', normaliseItems([{ value: 'Talk', retired: true }, 'News']), [{ value: 'Talk', retired: true }, { value: 'News' }]);
throws('refuses duplicates ignoring case', () => normaliseItems(['News', 'news']), /twice/);
throws('refuses an empty value', () => normaliseItems(['News', '  ']), /empty/);
throws('refuses a list with nothing active', () => normaliseItems([{ value: 'News', retired: true }]), /at least one/);
throws('refuses a value that is too long', () => normaliseItems(['x'.repeat(81)]), /longer/);
throws('refuses more than 500', () => normaliseItems(Array.from({ length: 501 }, (_, i) => `g${i}`)), /at most/);

console.log('== the copy into type fields ==');
const fields: SchemaField[] = [
  { key: 'name', type: 'string' },
  { key: 'genre', type: 'enum', options: ['Old'], optionsList: 'genres', multiple: true, retiredOptions: ['Gone'] },
  { key: 'mood', type: 'enum', options: ['Calm'] },
];
const items = [{ value: 'News' }, { value: 'Talk', retired: true }, { value: 'Drama' }];
const linked = linkFields(fields, { genres: items });
eq('linked field takes the active values in order', linked[1].options, ['News', 'Drama']);
eq('linked field records the retired ones', linked[1].retiredOptions, ['Talk']);
eq('unlinked field untouched', linked[2], fields[2]);
eq('no retired values, no retiredOptions key', 'retiredOptions' in linkFields(fields, { genres: [{ value: 'News' }] })[1], false);
eq('a list not given leaves the field as it was', linkFields(fields, {})[1], fields[1]);
try { validateSchemaFields(linked); ok('linked fields pass the schema check'); } catch (e: any) { bad('linked fields pass the schema check', e.message); }
throws('a list cannot feed a non-enum field', () => validateSchemaFields([{ key: 'x', type: 'string', optionsList: 'genres' } as SchemaField]), /enum/);

console.log('== retired values stay valid where they are ==');
eq('a retired value validates', validateMetadata(linked, { genre: ['Talk', 'News'] }), { genre: ['Talk', 'News'] });
throws('a value never in the list is refused', () => validateMetadata(linked, { genre: ['Jazz'] }), /not in options/);

console.log('== planning a save ==');
const before = [{ value: 'News' }, { value: 'Talk' }, { value: 'Kids' }, { value: 'Spare' }];
const after = [{ value: 'News' }, { value: 'Talk' }, { value: 'Children' }];
const p = planSave(before, after, [{ from: 'Kids', to: 'Children' }], { Kids: 4, Spare: 0, News: 9 });
eq('renamed values are not removals', p.removed, ['Spare']);
eq('an unused removal is not blocked', p.blocked, []);
const p2 = planSave(before, [{ value: 'News' }], [], { Talk: 2, Kids: 0, Spare: 0 });
eq('a removal of a value in use is blocked with its count', p2.blocked, [{ value: 'Talk', count: 2 }]);
const p3 = planSave(before, [{ value: 'News' }, { value: 'Talk' }], [{ from: 'Kids', to: 'Talk' }, { from: 'Spare', to: 'Talk' }], { Kids: 1, Spare: 1 });
eq('merge into an existing value', p3.renames.length, 2);
eq('merge removes nothing in use', p3.blocked, []);
throws('rename to a value not in the list', () => planSave(before, after, [{ from: 'Kids', to: 'Kiddies' }], {}), /not in the list/);

console.log('== rewriting stored values ==');
eq('string', renameIn('Kids', 'Kids', 'Children'), 'Children');
eq('other string untouched', renameIn('News', 'Kids', 'Children'), 'News');
eq('array, order kept', renameIn(['News', 'Kids', 'Talk'], 'Kids', 'Children'), ['News', 'Children', 'Talk']);
eq('merge folds duplicates', renameIn(['Talk', 'Kids'], 'Kids', 'Talk'), ['Talk']);
eq('non-string values untouched', renameIn(5, 'Kids', 'x'), 5);

console.log('== which types link the list ==');
const schemas = [
  { id: 'base', extends_id: null, fields: [{ key: 'category', type: 'enum', options: ['a'], optionsList: 'genres' }] as SchemaField[] },
  { id: 'child', extends_id: 'base', fields: [{ key: 'speakers', type: 'tags' }] as SchemaField[] },
  { id: 'override', extends_id: 'base', fields: [{ key: 'category', type: 'enum', options: ['own'] }] as SchemaField[] },
  { id: 'song', extends_id: null, fields: [{ key: 'genre', type: 'enum', options: ['a'], optionsList: 'genres' }] as SchemaField[] },
];
const lk = linkedKeys(schemas, 'genres');
eq('inherited link counts for the child', lk.get('category'), ['base', 'child']);
eq('a type overriding the field is not linked', (lk.get('category') ?? []).includes('override'), false);
eq('genre key found', lk.get('genre'), ['song']);

console.log('== reset ==');
const r = resetItems('genres', [{ value: 'News' }, { value: 'Podcasts' }, { value: 'Unused' }], { Podcasts: 3 });
eq('defaults restored in order', activeValues(r), DEFAULT_GENRES);
eq('a custom value in use is kept, retired', r.filter((i) => i.retired), [{ value: 'Podcasts', retired: true }]);

console.log('== the standard types link the list ==');
for (const key of ['radio-station', 'tv-channel', 'broadcast-event', 'song', 'episode', 'movie']) {
  const t = STANDARD_TYPES.find((x) => x.key === key)!;
  const f = t.fields.find((x) => x.optionsList === 'genres');
  f ? ok(`${key}: ${f.key} links the genre list`) : bad(`${key} links the genre list`, 'no linked field');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
