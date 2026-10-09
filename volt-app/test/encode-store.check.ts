// ============================================================================
//  THE LADDER, AS THE DATABASE ACTUALLY RESOLVES IT.
//
//  `encode-ladder.check.ts` pins the pure decision. This pins the query, and the
//  one assertion the whole feature rests on:
//
//    A TRACKING LADDER FOLLOWS THE LIVE PROFILE WITH NO WRITE OF ITS OWN. Change
//    the live 720p rung, re-read the ladder, and it has changed. If it ever
//    stops doing that, "the file encode matches the live channel" quietly stops
//    being true while every test that checks the rungs against a fixture still
//    passes.
//
//  And the two that follow from it:
//
//    THE SEGMENT LENGTH AND FPS COME FROM THE TRACKED PROFILE TOO, because
//    GOP = segment × fps. A file encoded at the group's own 4s while the channel
//    runs 6s has its keyframes somewhere else, which is invisible until somebody
//    tries to splice or switch between them.
//
//    A TRACKING LADDER WHOSE PROFILE IS GONE IS AN ERROR. Falling back to the
//    group's own members means encoding to an empty ladder and reporting
//    success: an asset in the library with no renditions behind it.
//
//  Usage: DATABASE_URL=... npx tsx test/encode-store.check.ts
// ============================================================================
import { pool, query, one } from '../src/db';
import { loadLadder, resolveLadderFor, ensureTrackingGroup, NoLadderError, listLadderGroups } from '../src/services/encode/store';
import { fitToSource, describeFit } from '../src/services/encode/ladder';

let pass = 0, fail = 0;
const ok = (m: string) => { console.log('PASS ' + m); pass++; };
const bad = (m: string, d: string) => { console.log(`FAIL ${m} -- ${d}`); fail++; };
const check = (m: string, got: unknown, want: unknown) =>
  got === want ? ok(m) : bad(m, `expected [${String(want)}] got [${String(got)}]`);
async function threw(m: string, f: () => Promise<unknown>, match: RegExp) {
  try { await f(); bad(m, 'it did not throw'); }
  catch (e: any) {
    match.test(String(e?.message ?? e)) ? ok(m)
      : bad(m, `threw the wrong thing: ${String(e?.message ?? e)}`);
  }
}

const A = '00000000-0000-0000-0000-00000000ea01';
const P = '00000000-0000-0000-0000-00000000ea02';
const heights = (rs: { height: number }[]) => rs.map((r) => r.height).join(',');

(async () => {
  await query(`DELETE FROM accounts WHERE id=$1`, [A]);
  await query(`INSERT INTO accounts(id,name) VALUES ($1,'EncCo')`, [A]);
  await query(
    `INSERT INTO output_profiles(id,account_id,name,rungs,segment_dur)
     VALUES ($1,$2,'Live HD',$3::jsonb,6.00)`,
    [P, A, JSON.stringify([
      { height: 1080, bitrate_kbps: 5000, fps: 50 },
      { height: 720, bitrate_kbps: 3000 },
      { height: 360, bitrate_kbps: 600 },
    ])]
  );

  // ---- tracking -------------------------------------------------------------
  console.log('== a ladder that mirrors a live profile ==');
  const gid = await ensureTrackingGroup(A, P, 'Same as Live HD', { makeDefault: true });
  const l1 = await loadLadder(gid, A);
  check('it resolved the live rungs', heights(l1.rungs), '1080,720,360');
  check('and says where they came from', l1.origin.kind, 'tracked');
  // GOP = segment x fps. Taking the group's own 4s while the channel runs 6s
  // puts the keyframes somewhere else, and nothing fails until somebody tries to
  // switch between the two.
  check('the segment length came from the live profile', l1.segmentSeconds, 6);
  check('and the frame rate did too', l1.fps, 50);

  console.log('\n== THE ASSERTION THE FEATURE RESTS ON ==');
  await query(
    `UPDATE output_profiles SET rungs = $2::jsonb WHERE id = $1`,
    [P, JSON.stringify([{ height: 720, bitrate_kbps: 2600 }, { height: 360, bitrate_kbps: 600 }])]
  );
  const l2 = await loadLadder(gid, A);
  check('re-tuning the LIVE profile changed the file ladder', heights(l2.rungs), '720,360');
  check('including the bitrate', l2.rungs[0]?.bitrate_kbps, 2600);
  // Nothing was written to the ladder group. That is what "cannot drift" means.
  const stored = await one<any>(
    `SELECT (SELECT count(*) FROM encode_ladder_members m WHERE m.group_id = g.id)::int AS n
       FROM encode_ladder_groups g WHERE g.id = $1`, [gid]);
  check('and the group still stores no rungs of its own', stored?.n, 0);

  console.log('\n== mirroring the same profile twice is the same ladder ==');
  check('it did not make a second one', await ensureTrackingGroup(A, P, 'Another name'), gid);

  console.log('\n== a tracking ladder whose profile is emptied is an ERROR ==');
  await query(`UPDATE output_profiles SET rungs = '[]'::jsonb WHERE id = $1`, [P]);
  await threw('it refuses rather than encoding an empty ladder',
    () => loadLadder(gid, A), /no rungs|deleted/);
  await query(
    `UPDATE output_profiles SET rungs = $2::jsonb WHERE id = $1`,
    [P, JSON.stringify([{ height: 1080, bitrate_kbps: 5000 }, { height: 720, bitrate_kbps: 3000 },
                        { height: 480, bitrate_kbps: 1200 }, { height: 360, bitrate_kbps: 600 }])]
  );

  // ---- a standalone ladder ---------------------------------------------------
  console.log('\n== a ladder that owns its renditions ==');
  const own = await one<any>(
    `INSERT INTO encode_ladder_groups(account_id,name,segment_dur,fps)
     VALUES ($1,'Archive',4.00,25.000) RETURNING id`, [A]);
  const p1 = await one<any>(
    `INSERT INTO encode_profiles(account_id,name,height,bitrate_kbps)
     VALUES ($1,'720p 3000k',720,3000) RETURNING id`, [A]);
  const p2 = await one<any>(
    `INSERT INTO encode_profiles(account_id,name,height,bitrate_kbps)
     VALUES ($1,'360p 600k',360,600) RETURNING id`, [A]);
  // Inserted lowest-first on purpose: the resolver must sort, not trust the rows.
  await query(`INSERT INTO encode_ladder_members(group_id,profile_id,ordinal) VALUES ($1,$2,10),($1,$3,20)`,
    [own.id, p2.id, p1.id]);
  const l3 = await loadLadder(own.id, A);
  check('its rungs are its members', heights(l3.rungs), '720,360');
  check('sorted highest first regardless of ordinal', l3.rungs[0]?.height, 720);
  check('and it says they are its own', l3.origin.kind, 'members');
  check('it uses its own segment length', l3.segmentSeconds, 4);

  console.log('\n== an empty standalone ladder is an error too ==');
  const empty = await one<any>(
    `INSERT INTO encode_ladder_groups(account_id,name) VALUES ($1,'Empty') RETURNING id`, [A]);
  await threw('nothing to encode is refused', () => loadLadder(empty.id, A), /no renditions/);

  // ---- the default -----------------------------------------------------------
  console.log('\n== the account default is what an unnamed encode uses ==');
  const d = await resolveLadderFor(A, null);
  check('it found the default', d.groupId, gid);
  check('naming one explicitly wins', (await resolveLadderFor(A, own.id)).groupId, own.id);

  console.log('\n== only one ladder can be the default ==');
  await threw('a second default is refused by the database, not by convention',
    () => query(`UPDATE encode_ladder_groups SET is_default = true WHERE id = $1`, [own.id]),
    /duplicate key|unique/i);

  console.log('\n== an account with no default and no named ladder is told so ==');
  const B = '00000000-0000-0000-0000-00000000eb01';
  await query(`DELETE FROM accounts WHERE id=$1`, [B]);
  await query(`INSERT INTO accounts(id,name) VALUES ($1,'NoLadders')`, [B]);
  await threw('it says what to do rather than encoding to a hardcoded guess',
    () => resolveLadderFor(B, null), /no default|Encoding profiles/);

  // ---- the tenant boundary ---------------------------------------------------
  console.log('\n== a ladder belongs to one account ==');
  await threw('another account cannot load it', () => loadLadder(gid, B), /not found/);
  check('and does not see it listed', (await listLadderGroups(B)).length, 0);

  // ---- resolve + fit together -------------------------------------------------
  console.log('\n== resolving and fitting, the way an encode does ==');
  const full = await loadLadder(gid, A);
  check('a 720p source drops the 1080', heights(fitToSource(full, { height: 720 }).kept), '720,480,360');
  check('an unmeasured source keeps them all',
    fitToSource(full, { height: null }).kept.length, 4);
  check('and says it was not measured',
    fitToSource(full, { height: null }).sourceUnmeasured, true);
  check('the summary reads plainly', describeFit(fitToSource(full, { height: 1080 })),
    '1080p, 720p, 480p, 360p');

  await query(`DELETE FROM accounts WHERE id = ANY($1::uuid[])`, [[A, B]]);
  console.log(`\nencode-store: ${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error('FATAL', e);
  await pool.end().catch(() => {});
  process.exit(1);
});
