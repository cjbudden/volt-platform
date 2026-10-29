// ============================================================================
//  REQUIRED METADATA IS A PUBLISH RULE, NOT A SAVE RULE
//  (services/metadataValidator.ts, services/review.ts publishGate,
//  services/availability.ts publish).
//
//    * content saves with required fields still empty (an API create, an
//      upload, work in progress), while a wrong value is still refused;
//    * publishing refuses while any required field is empty, naming them, on
//      every path (publish() runs the gate);
//    * a standard type's catalogue-required fields count (a Clip needs a
//      headline and a description), as the library's completeness shows;
//    * filled in, the metadata no longer stands in the way;
//    * an asset with no content type is not held back.
//
//  Needs Postgres (DATABASE_URL, migrations applied).
//  Usage: npx tsx test/publish-required-metadata.check.ts
// ============================================================================
import { randomUUID } from 'node:crypto';

let pass = 0, fail = 0;
const ok = (m: string) => { console.log('PASS ' + m); pass++; };
const bad = (m: string, d: string) => { console.log(`FAIL ${m} -- ${d}`); fail++; };
const check = (m: string, got: unknown, want: unknown) => (JSON.stringify(got) === JSON.stringify(want) ? ok(m) : bad(m, `expected ${JSON.stringify(want)} got ${JSON.stringify(got)}`));

async function main() {
  const { query, one, pool } = await import('../src/db');
  const { validateMetadata } = await import('../src/services/metadataValidator');
  const { publishGate } = await import('../src/services/review');
  const { publish, NotPublishable } = await import('../src/services/availability');

  const ACC = randomUUID();
  await query(`INSERT INTO accounts(id,name) VALUES ($1,'MetaCo')`, [ACC]);
  const fields = [
    { key: 'headline', label: 'Headline', type: 'string', required: true },
    { key: 'genre', label: 'Genre', type: 'enum', options: ['News', 'Sport'], required: true },
    { key: 'notes', label: 'Notes', type: 'text' },
  ];
  const custom = await one<any>(`INSERT INTO metadata_schemas(account_id, name, fields, target_kind) VALUES ($1,'Story',$2::jsonb,'vod') RETURNING id`, [ACC, JSON.stringify(fields)]);
  const clipFields = [{ key: 'headline', label: 'Headline', type: 'string' }, { key: 'description', label: 'Description', type: 'text' }, { key: 'keywords', label: 'Keywords', type: 'tags' }];
  const clip = await one<any>(`INSERT INTO metadata_schemas(account_id, name, fields, target_kind, standard_key) VALUES ($1,'Clip',$2::jsonb,'vod','clip') RETURNING id`, [ACC, JSON.stringify(clipFields)]);
  const asset = async (schemaId: string | null, metadata: Record<string, any>) => (await one<any>(
    `INSERT INTO vod_assets(account_id, source_kind, kind, title, start_epoch_ms, end_epoch_ms, duration_ms, schema_id, metadata)
     VALUES ($1,'upload','export','Draft',0,0,1000,$2,$3::jsonb) RETURNING id`, [ACC, schemaId, JSON.stringify(metadata)])).id as string;

  console.log('== saving ==');
  let saved: any = null, err = '';
  try { saved = validateMetadata(fields as any, { notes: 'started' }); } catch (e: any) { err = e.message; }
  check('saving with required fields empty is allowed', [saved, err], [{ notes: 'started' }, '']);
  err = ''; try { validateMetadata(fields as any, { genre: 'Cooking' }); } catch (e: any) { err = e.message; }
  check('a wrong value is still refused', /genre/.test(err), true);
  err = ''; try { validateMetadata(fields as any, { colour: 'red' }); } catch (e: any) { err = e.message; }
  check('an unknown field is still refused', err, 'unknown metadata field: colour');

  console.log('== publishing ==');
  const a = await asset(custom.id, { notes: 'started' });
  const g = await publishGate(a);
  check('the gate says no, and why', [g.allowed, g.code, g.message], [false, 'metadata_incomplete', 'Fill in the required fields before publishing: Headline, Genre.']);
  check('it lists them', g.missingRequired, [{ key: 'headline', label: 'Headline' }, { key: 'genre', label: 'Genre' }]);
  try { await publish(a, 'test'); bad('publish refuses', 'it published'); }
  catch (e: any) { (e instanceof NotPublishable && e.code === 'metadata_incomplete' && /Headline, Genre/.test(e.message)) ? ok(`publish refuses: ${e.message}`) : bad('publish refuses', `${e?.code} ${e?.message}`); }
  check('nothing was published', (await one<any>(`SELECT published, availability_state FROM vod_assets WHERE id = $1`, [a])), { published: false, availability_state: 'draft' });

  await query(`UPDATE vod_assets SET metadata = $2::jsonb WHERE id = $1`, [a, JSON.stringify({ headline: 'Flood warning', notes: 'started' })]);
  check('one left', (await publishGate(a)).message, 'Fill in the required field before publishing: Genre.');
  await query(`UPDATE vod_assets SET metadata = $2::jsonb WHERE id = $1`, [a, JSON.stringify({ headline: 'Flood warning', genre: 'News' })]);
  const g2 = await publishGate(a);
  check('filled in: the metadata no longer stands in the way', [g2.allowed, g2.code], [true, 'ok']);
  try { await publish(a, 'test'); ok('and it publishes'); }
  catch (e: any) { e?.code === 'metadata_incomplete' ? bad('publishes once filled', e.message) : ok(`publish goes past the metadata check (then: ${e?.code ?? e?.message})`); }

  console.log('== a standard type\'s catalogue-required fields ==');
  const c = await asset(clip.id, { headline: 'Goal of the day' });
  check('a Clip needs a description too', (await publishGate(c)).message, 'Fill in the required field before publishing: Description.');
  check('whitespace is not a value', (await query(`UPDATE vod_assets SET metadata = $2::jsonb WHERE id = $1`, [c, JSON.stringify({ headline: 'Goal of the day', description: '   ' })]), (await publishGate(c)).code), 'metadata_incomplete');

  console.log('== no content type ==');
  const n = await asset(null, {});
  check('an asset with no content type is not held back by metadata', (await publishGate(n)).code, 'ok');

  await query(`DELETE FROM publications WHERE vod_asset_id IN (SELECT id FROM vod_assets WHERE account_id = $1)`, [ACC]).catch(() => {});
  await query(`DELETE FROM accounts WHERE id = $1`, [ACC]);
  await pool.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
