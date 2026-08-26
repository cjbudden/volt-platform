/**
 * SEED TEST RADIO STATIONS — an optional, manual post-build step.
 *
 *   npx tsx scripts/seed-radio.ts            # music-metadata set (SomaFM)
 *   npx tsx scripts/seed-radio.ts --all      # + the speech/news test set
 *   npx tsx scripts/seed-radio.ts --speech   # speech/news set only
 *   npx tsx scripts/seed-radio.ts --list     # show what would be added
 *   ... --account "RTM"                      # pick the account by name
 *   ... --group <uuid>                       # or the exact group
 *
 * Idempotent: a station whose name already exists on the account is skipped, so
 * this is safe to re-run after any build. Nothing here is created automatically
 * by the app; these exist purely to exercise the radio features against real,
 * varied sources.
 *
 * Why these two sets:
 *  - MUSIC set (SomaFM): dense, well-formed "Artist - Title" ICY metadata that
 *    changes every few minutes. Best for the metadata log, the song/ad/content
 *    classifier and metadata-driven clipping.
 *  - SPEECH set: news/talk streams where the interesting content is people
 *    talking. These are the ones that exercise TRANSCRIPTION (only offered for
 *    Icecast sources), the 'content' classification path, and the sparse or
 *    station-level-metadata cases where titles change rarely or not at all.
 */
import { query, one, pool } from '../src/db';

interface Seed { name: string; url: string; note: string }

const MUSIC: Seed[] = [
  { name: 'Groove Salad', url: 'https://ice5.somafm.com/groovesalad-128-mp3', note: 'Ambient/downtempo. Rich Artist - Title metadata; artwork via StreamUrl.' },
  { name: 'Secret Agent', url: 'https://ice5.somafm.com/secretagent-128-mp3', note: 'Spy-jazz. Frequent track changes: good for log density.' },
  { name: 'Drone Zone', url: 'https://ice5.somafm.com/dronezone-128-mp3', note: 'Long ambient pieces: sparse title changes, long entries.' },
];

const SPEECH: Seed[] = [
  { name: 'NPO Radio 1', url: 'http://icecast.omroep.nl/radio1-bb-mp3', note: 'Dutch news/talk. Sends PROGRAMME + broadcaster, e.g. "NPO Radio 1 - De Ochtend - KRO-NCRV": the strongest test of programme-level metadata.' },
  { name: 'WPLN 90.3', url: 'https://wpln.streamguys1.com/wplnfm.mp3.m3u', note: 'NPR news/talk. May expose programme or station information.' },
  { name: 'WPLN International', url: 'https://wpln.streamguys1.com/wplnam.mp3.m3u', note: 'BBC/world news. Continuous speech; metadata quality varies.' },
  { name: 'KPFA', url: 'https://streams.kpfa.org:8443/kpfa', note: 'News, interviews, public affairs. Typically station/programme-level information.' },
  { name: 'WFMU Freeform', url: 'https://stream0.wfmu.org/freeform-128k', note: 'Freeform shows, interviews, radio theatre. Alternates between programme and track metadata.' },
  { name: 'NA0D Baxter Stream', url: 'https://audio.na0d.com/BaxterStream', note: 'Ham/GMRS/weather feeds. Speech with sparse or static metadata, and long silences: exercises the dead-air and static QC checks.' },
];

const argv = process.argv.slice(2);
const wantAll = argv.includes('--all');
const wantSpeech = argv.includes('--speech') || wantAll;
const wantMusic = !argv.includes('--speech') || wantAll;
const listOnly = argv.includes('--list');

const chosen = [...(wantMusic ? MUSIC : []), ...(wantSpeech ? SPEECH : [])];

(async () => {
  if (listOnly) {
    for (const s of chosen) console.log(`${s.name}\n    ${s.url}\n    ${s.note}`);
    await pool.end();
    return;
  }
  const groupArg = argv[argv.indexOf('--group') + 1];
  const acctArg = argv[argv.indexOf('--account') + 1];
  const grp = argv.includes('--group')
    ? await one<any>(`SELECT id, account_id FROM groups WHERE id=$1`, [groupArg])
    : argv.includes('--account')
      ? await one<any>(`SELECT g.id, g.account_id FROM groups g JOIN accounts a ON a.id=g.account_id
                         WHERE a.name ILIKE $1 ORDER BY g.created_at LIMIT 1`, [acctArg])
      : await one<any>(`SELECT g.id, g.account_id FROM groups g ORDER BY g.created_at LIMIT 1`);
  if (!grp) { console.error('no matching group: create an account/group first, or pass --account/--group'); process.exit(1); }
  const acct = await one<any>(`SELECT name FROM accounts WHERE id=$1`, [grp.account_id]);
  console.log(`seeding into account "${acct?.name}" (group ${grp.id})\n`);

  let added = 0, skipped = 0;
  for (const s of chosen) {
    const dupe = await one(`SELECT c.id FROM channels c JOIN groups g ON g.id=c.group_id
                             WHERE g.account_id=$1 AND c.name=$2 AND c.kind='radio'`, [grp.account_id, s.name]);
    if (dupe) { console.log(`=  ${s.name} (already seeded)`); skipped++; continue; }
    const ch = await one<any>(
      `INSERT INTO channels(group_id, name, kind, radio_config, recording_enabled, metadata)
       VALUES ($1,$2,'radio',
               '{"outputs":{"mp3":true,"hls":true,"dash":true},"bitrateKbps":128,"metadataCapture":true}'::jsonb,
               true, $3::jsonb)
       RETURNING id`, [grp.id, s.name, JSON.stringify({ seed_note: s.note, seeded: 'scripts/seed-radio.ts' })]);
    await query(
      `INSERT INTO stream_inputs(channel_id, role, protocol, ingest_url) VALUES ($1,'primary','icecast',$2)`,
      [ch.id, s.url]);
    console.log(`+  ${s.name} -> ${ch.id}`);
    console.log(`     ${s.note}`);
    added++;
  }
  console.log(`\n${added} added, ${skipped} already present.`);
  console.log('Stations are created STOPPED and OFF AIR: start one from Radio, then Go on air to publish it.');
  await pool.end();
})();
