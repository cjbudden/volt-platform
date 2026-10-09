/**
 * THE FIXTURE THE CHECK SUITES ASSUME.
 *
 * Six suites look up an account called 'AdminCo' and fail hard if it is not
 * there. Nothing created it except `admin.check.sh`, as a side effect of its
 * own setup — so those six passed only when they happened to run after it, and
 * only against a database somebody had already run it on. Run them in
 * isolation, or first, or on a fresh Postgres, and they died at setup with a
 * fatal that looked nothing like the dependency it actually was.
 *
 * A shared fixture that six suites depend on is a fixture, not a side effect.
 * This creates it explicitly, once, in the template database that every suite
 * is copied from. It is deliberately small: an account, an owner who can log
 * in, a profile, a group, one TV channel, and one radio station with a
 * recording behind it, because that last pair is what the daypart and
 * recording-source suites reach for.
 *
 * Run by scripts/check.js. Idempotent.
 */
import { query, pool } from '../src/db';
import { hashPassword } from '../src/auth/password';

const A = '0000000a-0000-0000-0000-0000000000b1';
const U = '0000000b-0000-0000-0000-0000000000b1';
const P = '0000000c-0000-0000-0000-0000000000b1';
const G = '0000000d-0000-0000-0000-0000000000b1';
const CH = '0000000e-0000-0000-0000-0000000000b1';
const ST = '0000000e-0000-0000-0000-0000000000b2';
const REC = '0000000f-0000-0000-0000-0000000000b1';

async function main() {
  const pw = await hashPassword('volt1234');

  await query(`INSERT INTO accounts(id,name) VALUES ($1,'AdminCo') ON CONFLICT (id) DO NOTHING`, [A]);
  await query(
    `INSERT INTO users(id,account_id,email,password_hash,role,status)
     VALUES ($1,$2,'root@adminco.example',$3,'owner','active')
     ON CONFLICT (id) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
    [U, A, pw]
  );
  await query(
    `INSERT INTO output_profiles(id,account_id,name,rungs,workflow_type,packaging,segment_dur,dvr_window_sec)
     VALUES ($1,$2,'HD','[{"height":360,"bitrate_kbps":800}]','transcode','both',2,60)
     ON CONFLICT (id) DO NOTHING`,
    [P, A]
  );
  await query(
    `INSERT INTO groups(id,account_id,name,output_profile_id,max_channels)
     VALUES ($1,$2,'G',$3,50) ON CONFLICT (id) DO NOTHING`,
    [G, A, P]
  );
  await query(
    `INSERT INTO channels(id,group_id,name,status,kind) VALUES ($1,$2,'AdminCo TV','scheduled','tv')
     ON CONFLICT (id) DO NOTHING`,
    [CH, G]
  );
  // A radio station WITH a recording: the daypart and recording-source suites
  // both select "a radio channel that has recordings", and an empty station
  // fails their setup just as surely as no station at all.
  await query(
    `INSERT INTO channels(id,group_id,name,status,kind,radio_config)
     VALUES ($1,$2,'AdminCo FM','scheduled','radio','{"bitrate_kbps":128}'::jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [ST, G]
  );

  // Two hours ending an hour ago, so it sits inside any sensible window a
  // suite picks without being "now" and racing a live pipeline.
  const endMs = Date.now() - 60 * 60 * 1000;
  const startMs = endMs - 2 * 60 * 60 * 1000;
  await query(
    `INSERT INTO recordings(id,kind,channel_id,day_utc,status,hi_res_rendition,master_key,
                            start_epoch_ms,end_epoch_ms,duration_ms)
     VALUES ($1,'channel_day',$2,(now() at time zone 'utc')::date,'complete','128k',
             $3,$4,$5,$6)
     ON CONFLICT (id) DO NOTHING`,
    [REC, ST, `radio/${ST}`, startMs, endMs, endMs - startMs]
  );

  console.log('[seed-check] AdminCo fixture ready (root@adminco.example / volt1234)');
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch { /* ignore */ }
  process.exit(1);
});
