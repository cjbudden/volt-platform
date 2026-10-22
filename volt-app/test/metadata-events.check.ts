/**
 * Metadata-on-events: schema composition (extends), target_kind enforcement,
 * reference field type, validation. Needs DATABASE_URL -> fresh Postgres with
 * 0001_init.sql applied. Run: npx tsx test/metadata-events.check.ts
 */
import { query, one, pool } from '../src/db';
import { resolveEffectiveFields, validateEntityMetadata } from '../src/modules/metadataSchemas';

let pass = 0,
  fail = 0;
const ok = (c: boolean, m: string) => (c ? (pass++, console.log('PASS ' + m)) : (fail++, console.log('FAIL ' + m)));
async function throws(fn: () => Promise<any>, label: string) {
  try {
    await fn();
    ok(false, label + ' (expected throw)');
  } catch {
    ok(true, label);
  }
}

(async () => {
  const A = '00000000-0000-0000-0000-0000000000a1';
  await query(`INSERT INTO accounts(id,name) VALUES ($1,'RTM') ON CONFLICT DO NOTHING`, [A]);

  // base sports-event schema (target event) + soccer extension
  const base = await one<any>(
    `INSERT INTO metadata_schemas(account_id,name,target_kind,domain,fields)
     VALUES ($1,'Sports Event','event','sports',$2::jsonb) RETURNING id`,
    [A, JSON.stringify([
      { key: 'competition', type: 'string', required: true },
      { key: 'homeTeam', type: 'reference', refDomain: 'sports-team' },
    ])]
  );
  const soccer = await one<any>(
    `INSERT INTO metadata_schemas(account_id,name,target_kind,domain,extends_id,fields)
     VALUES ($1,'Soccer','event','sports',$2,$3::jsonb) RETURNING id`,
    [A, base.id, JSON.stringify([{ key: 'matchday', type: 'number' }])]
  );
  // a vod-target schema to prove target_kind enforcement
  const vodSchema = await one<any>(
    `INSERT INTO metadata_schemas(account_id,name,target_kind,fields)
     VALUES ($1,'Clip','vod',$2::jsonb) RETURNING id`,
    [A, JSON.stringify([{ key: 'title', type: 'string' }])]
  );

  // composition: soccer inherits competition + homeTeam and adds matchday
  const eff = await resolveEffectiveFields(soccer.id, A);
  ok(!!eff && eff.fields.map((f) => f.key).sort().join(',') === 'competition,homeTeam,matchday', 'extends merges parent+child fields');
  ok(eff!.targetKind === 'event', 'effective targetKind is event');

  // valid metadata (reference as object + as string both accepted)
  const good = await validateEntityMetadata(A, soccer.id, { competition: 'Grand Final', homeTeam: { id: 't1', name: 'Lions' }, matchday: 3 }, ['event']);
  ok(good.metadata.competition === 'Grand Final' && good.metadata.homeTeam.id === 't1' && good.metadata.matchday === 3, 'valid event metadata passes with reference object');
  const good2 = await validateEntityMetadata(A, soccer.id, { competition: 'Final', homeTeam: 't2' }, ['event']);
  ok(good2.metadata.homeTeam.id === 't2', 'reference accepts a bare id string');

  // missing required
  await throws(() => validateEntityMetadata(A, soccer.id, { homeTeam: 't1' }, ['event']), 'missing required competition rejected');
  // unknown field: KEPT, by design. validateEntityMetadata validates with
  // 'keep' (modules/metadataSchemas.ts): an owner's own keys survive a type that
  // does not define them. This used to expect a refusal, written before that rule.
  const kept = await validateEntityMetadata(A, soccer.id, { competition: 'X', bogus: 1 }, ['event']);
  ok(kept.metadata.bogus === 1 && kept.metadata.competition === 'X', 'a field the type does not define is kept, not refused');
  // target_kind mismatch (vod schema on an event)
  await throws(() => validateEntityMetadata(A, vodSchema.id, { title: 'x' }, ['event']), 'vod-target schema rejected on event');
  // channel target accepts 'any'? vod schema target vod != channel → reject
  await throws(() => validateEntityMetadata(A, vodSchema.id, {}, ['channel']), 'vod-target schema rejected on channel');

  // null schema clears
  const cleared = await validateEntityMetadata(A, null, { anything: 1 }, ['event']);
  ok(cleared.schemaId === null, 'null schema clears assignment');

  console.log(`\n${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
})();
