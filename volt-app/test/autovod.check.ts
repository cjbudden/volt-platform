/** Auto-VOD metadata harvest: event metadata → derived full-event VOD. */
import { query, one, pool } from '../src/db';
import { deriveEventVod } from '../src/services/clips';

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => (c ? (pass++, console.log('PASS ' + m)) : (fail++, console.log('FAIL ' + m)));

(async () => {
  // Ids namespaced to THIS suite (…a07d…). They used to start at 0000…00a1,
  // which the orchestrator check also claims as its account: whichever ran
  // second died on a primary-key collision that read like a product fault and
  // was only ever a fixture clash. Every suite owns its own range now, and
  // clears it first so a second run against the same database works.
  const A = '00000000-0000-0000-0000-0000a07d00a1', G = '00000000-0000-0000-0000-0000a07d00b1';
  const D = '00000000-0000-0000-0000-0000a07d00d1', E = '00000000-0000-0000-0000-0000a07d00e1';
  const S = '00000000-0000-0000-0000-0000a07d00c5', R = '00000000-0000-0000-0000-0000a07d00a9';
  await query(`DELETE FROM accounts WHERE id = $1`, [A]);
  await query(`INSERT INTO accounts(id,name) VALUES ($1,'RTM')`, [A]);
  await query(`INSERT INTO output_profiles(id,account_id,name,rungs,workflow_type) VALUES ($1,$2,'p','[]','package_only')`, [D, A]);
  await query(`INSERT INTO groups(id,account_id,name,output_profile_id) VALUES ($1,$2,'g',$3)`, [G, A, D]);
  await query(`INSERT INTO metadata_schemas(id,account_id,name,target_kind,fields) VALUES ($1,$2,'Match','event','[{"key":"competition","type":"string"}]')`, [S, A]);
  await query(
    `INSERT INTO events(id,group_id,name,scheduled_start,scheduled_end,schema_id,metadata)
     VALUES ($1,$2,'Grand Final', now(), now()+interval '2 hours', $3, '{"competition":"GF 2027"}'::jsonb)`,
    [E, G, S]
  );
  // a completed event recording
  await query(
    `INSERT INTO recordings(id,kind,event_id,status,start_epoch_ms,end_epoch_ms,duration_ms,master_key,hi_res_rendition)
     VALUES ($1,'event',$2,'complete',0,7200000,7200000,$3,'1080p')`,
    [R, E, `event/${E}`]
  );
  const rec = await one<any>(`SELECT * FROM recordings WHERE id=$1`, [R]);

  const vod = await deriveEventVod(rec);
  ok(!!vod, 'deriveEventVod produced a VOD');
  ok(vod.kind === 'full_event', 'derived VOD is a full_event');
  ok(vod.event_id === E && vod.recording_id === R, 'VOD links to the event + source recording');
  ok(vod.title === 'Grand Final', 'title harvested from the event');
  ok(vod.schema_id === S, 'schema_id harvested from the event');
  ok(vod.metadata?.competition === 'GF 2027', 'metadata VALUES harvested from the event');
  ok(Number(vod.duration_ms) === 7200000, 'duration carried from the recording');

  // channel recordings are a no-op
  const chNoop = await deriveEventVod({ event_id: null });
  ok(chNoop === null, 'channel_day recording → no auto-VOD (no-op)');

  console.log(`\n${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
})();
