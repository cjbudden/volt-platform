/**
 * Seed the three SomaFM sample stations (Christian's test set) as radio
 * channels on the FIRST account that has a group. Idempotent: skips any
 * station name that already exists. Run from volt-app/ with DATABASE_URL set:
 *   npx tsx scripts/seed-radio.ts
 */
import { query, one, pool } from '../src/db';

const STATIONS = [
  { name: 'Groove Salad', url: 'https://ice5.somafm.com/groovesalad-128-mp3' },
  { name: 'Secret Agent', url: 'https://ice5.somafm.com/secretagent-128-mp3' },
  { name: 'Drone Zone', url: 'https://ice5.somafm.com/dronezone-128-mp3' },
];

(async () => {
  const grp = await one<any>(`SELECT g.id, g.account_id FROM groups g ORDER BY g.created_at LIMIT 1`);
  if (!grp) { console.error('no groups exist yet: create an account/group first'); process.exit(1); }
  for (const s of STATIONS) {
    const dupe = await one(`SELECT c.id FROM channels c JOIN groups g ON g.id=c.group_id
                             WHERE g.account_id=$1 AND c.name=$2 AND c.kind='radio'`, [grp.account_id, s.name]);
    if (dupe) { console.log(`= ${s.name} already seeded`); continue; }
    const ch = await one<any>(
      `INSERT INTO channels(group_id, name, kind, radio_config, recording_enabled)
       VALUES ($1,$2,'radio','{"outputs":{"mp3":true,"hls":true,"dash":true},"bitrateKbps":128,"metadataCapture":true}'::jsonb,true)
       RETURNING id`, [grp.id, s.name]);
    await query(
      `INSERT INTO stream_inputs(channel_id, role, protocol, ingest_url) VALUES ($1,'primary','icecast',$2)`,
      [ch.id, s.url]);
    console.log(`+ ${s.name} -> ${ch.id}`);
  }
  await pool.end();
})();
