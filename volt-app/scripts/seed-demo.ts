/**
 * Rich demo seed for the local test console. Two tenants (RTM + OtherCo), a
 * client admin and a SaaS admin, live + scheduled channels, upcoming events, an
 * EPG now/next, VOD, live status + viewers, a rollup, and a ticket — so every
 * console tab shows real data. Idempotent-ish (truncates the demo rows first).
 * Run via run-local.sh (sets DATABASE_URL). Logins printed at the end.
 */
import { query, pool } from '../src/db';
import { hashPassword } from '../src/auth/password';

const A = '00000000-0000-0000-0000-00000000a001';   // RTM
const A2 = '00000000-0000-0000-0000-00000000a002';  // OtherCo
const D = '00000000-0000-0000-0000-00000000d001', D2 = '00000000-0000-0000-0000-00000000d002';
const G = '00000000-0000-0000-0000-00000000b001', G2 = '00000000-0000-0000-0000-00000000b002';
const C1 = '00000000-0000-0000-0000-0000000c0001'; // RTM News 24 (live)
const C2 = '00000000-0000-0000-0000-0000000c0002'; // RTM Sport (scheduled)
const C3 = '00000000-0000-0000-0000-0000000c0003'; // OtherCo News (live)
const UAD = '00000000-0000-0000-0000-0000000u0001'.replace(/u/g, 'a');
const USA = '00000000-0000-0000-0000-0000000u0002'.replace(/u/g, 'a');

async function main() {
  const pw = await hashPassword('volt1234');
  await query(`INSERT INTO accounts(id,name) VALUES ($1,'RTM'),($2,'OtherCo') ON CONFLICT (id) DO NOTHING`, [A, A2]);
  await query(
    `INSERT INTO users(id,account_id,email,password_hash,role,status,platform_role) VALUES
       ($1,$3,'admin@rtm.example',$4,'owner','active',NULL),
       ($2,$3,'saas@volt.example',$4,'owner','active','saas_admin')
     ON CONFLICT (id) DO UPDATE SET password_hash=EXCLUDED.password_hash`,
    [UAD, USA, A, pw]
  );
  await query(`INSERT INTO refresh_tokens(user_id,token_hash,expires_at) VALUES ($1,'seed',now()+interval '14 days'),($2,'seed',now()+interval '14 days')`, [UAD, USA]);
  await query(`INSERT INTO output_profiles(id,account_id,name,rungs,workflow_type) VALUES ($1,$3,'HD','[{"height":1080,"bitrate_kbps":5000},{"height":720,"bitrate_kbps":2500}]','package_only'),($2,$4,'HD','[]','package_only') ON CONFLICT (id) DO NOTHING`, [D, D2, A, A2]);
  await query(`INSERT INTO groups(id,account_id,name,output_profile_id,max_channels,max_concurrent) VALUES ($1,$3,'RTM Main',$5,10,5),($2,$4,'Other',$6,10,5) ON CONFLICT (id) DO NOTHING`, [G, G2, A, A2, D, D2]);
  await query(`INSERT INTO channels(id,group_id,name,status) VALUES
     ($1,$4,'RTM News 24','live'),($2,$4,'RTM Sport','scheduled'),($3,$5,'OtherCo News','live')
     ON CONFLICT (id) DO UPDATE SET status=EXCLUDED.status`, [C1, C2, C3, G, G2]);

  // upcoming events
  await query(
    `INSERT INTO events(group_id,name,scheduled_start,scheduled_end) VALUES
       ($1,'Grand Final', now()+interval '3 hours', now()+interval '6 hours'),
       ($1,'Evening Bulletin', now()+interval '20 hours', now()+interval '21 hours')`,
    [G]
  );

  // EPG now/next on RTM News 24
  await query(`DELETE FROM programmes WHERE channel_id=$1`, [C1]);
  await query(
    `INSERT INTO programmes(channel_id,title,starts_at,ends_at) VALUES
      ($1,'Morning News', now()-interval '30 min', now()+interval '30 min'),
      ($1,'Midday Report', now()+interval '30 min', now()+interval '90 min'),
      ($1,'Sports Roundup', now()+interval '90 min', now()+interval '150 min')`,
    [C1]
  );

  // VOD
  await query(`DELETE FROM vod_assets WHERE channel_id=$1`, [C1]);
  await query(
    `INSERT INTO vod_assets(channel_id,kind,title,master_key,start_epoch_ms,end_epoch_ms,duration_ms,output_kind,formats,thumb_status,published,portal_visible) VALUES
       ($1,'clip','Goal of the Month','channel/${C1}/clip-1000-61000',1000,61000,60000,'both','{"hls":true,"dash":true,"progressive":true}','ready',true,true),
       ($1,'full_event','Morning News (full)','channel/${C1}/full','0',5400000,5400000,'manifest','{"hls":true,"dash":true}','ready',false,false)`,
    [C1]
  );

  // live status + viewers + running server + rollup + ticket
  await query(`INSERT INTO stream_status(channel_id,output_available,active_source,fallback_in_use,packager_ok,last_seq) VALUES ($1,true,'primary',false,true,10) ON CONFLICT (channel_id) DO UPDATE SET output_available=true`, [C1]);
  await query(`INSERT INTO stream_concurrency(account_id,asset_kind,asset_id,concurrent) VALUES ($1,'channel',$2,842),($3,'channel',$4,318) ON CONFLICT (asset_kind,asset_id) DO UPDATE SET concurrent=EXCLUDED.concurrent, updated_at=now()`, [A, C1, A2, C3]);
  await query(`INSERT INTO instances(channel_id,state,lifecycle,is_gpu,launched_at) VALUES ($1,'running','spot',false,now()-interval '2 hours'),($2,'running','on_demand',false,now()-interval '1 hour')`, [C1, C3]);
  await query(`INSERT INTO analytics_rollups(account_id,scope,scope_id,bucket_date,total_views,unique_views,peak_concurrent,watch_seconds,by_app,by_device,by_geo) VALUES
     ($1,'account',NULL,current_date, 12840, 9102, 1420, 5230000, '{"RTM Web":8000,"News iOS":3200,"TV app":1640}','{"Mobile":6100,"Desktop":3500,"TV":3240}','{"MY":9000,"SG":2200,"GB":1640}') ON CONFLICT DO NOTHING`, [A]);
  await query(`INSERT INTO support_tickets(account_id,opened_by,subject,priority,status) VALUES ($1,$2,'Stream buffering on iOS','high','open'),($1,$2,'Add a new channel','normal','pending')`, [A, UAD]);

  console.log('\n✅ demo seeded. Logins (password: volt1234):');
  console.log('   • Client admin : admin@rtm.example');
  console.log('   • SaaS admin   : saas@volt.example');
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
