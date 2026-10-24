/**
 * Demo account for the customer guides' screenshots (build queue 1.14-G0).
 *
 * The everyday demo seed (seed-demo.ts) is named after a real prospect, and a
 * screenshot carries whatever the page shows: the docs site's banned-term
 * check reads text, not pictures. So this runs that seed and then gives the
 * account, its people and its streams neutral names, plus a little history
 * (audit rows) so pages that list past actions are not empty in a guide.
 * The screenshot script (docs-site/scripts/screenshots.mjs) still checks every
 * page's visible text against scrub.json before it saves a picture, as a net
 * for anything a future seed or page adds.
 *
 *   DATABASE_URL=... npx tsx scripts/seed-docs.ts
 * Sign-in afterwards: admin@example.com / volt1234
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { query, pool } from '../src/db';
import { writeAudit } from '../src/services/audit';
import { fillerPath } from '../src/services/uploads';

const ACCOUNT = '3de20755-af2b-46d0-8d24-f39afbf4b3a0';
const ADMIN = '8342a24d-751f-46ca-9636-f72a8a1110ef';
const NEWS = 'ae0e5ac4-9833-48b7-ab97-91df0d27467c';
const SPORT = '32cfef30-0d1d-44df-b2b8-0ed5a06bdf80';
export const DOCS_LOGIN = { email: 'admin@example.com', password: 'volt1234' };

async function main() {
  const r = spawnSync(join(__dirname, '../node_modules/.bin/tsx'), [join(__dirname, 'seed-demo.ts')], {
    cwd: join(__dirname, '..'), stdio: 'inherit', env: process.env,
  });
  if (r.status !== 0) throw new Error('seed-demo.ts failed');

  await query(`UPDATE accounts SET name='Example Broadcaster' WHERE id=$1`, [ACCOUNT]);
  await query(`UPDATE users SET email=$2 WHERE id=$1`, [ADMIN, DOCS_LOGIN.email]);
  await query(`UPDATE groups SET name='Main' WHERE account_id=$1 AND name='RTM Main'`, [ACCOUNT]);
  await query(`UPDATE channels SET name='News 24' WHERE id=$1`, [NEWS]);
  await query(`UPDATE channels SET name='Sport One' WHERE id=$1`, [SPORT]);

  // One radio station, so the Radio guide shows a station rather than the
  // empty state. Neutral name and an example source: a screenshot carries
  // whatever the page shows. Created stopped and off air; re-running the seed
  // keeps the one already there.
  const grp = await query<{ id: string }>(`SELECT id FROM groups WHERE account_id=$1 ORDER BY created_at LIMIT 1`, [ACCOUNT]);
  const have = await query(`SELECT 1 FROM channels c JOIN groups g ON g.id=c.group_id WHERE g.account_id=$1 AND c.kind='radio' AND c.name='Radio One'`, [ACCOUNT]);
  if (grp[0] && !have.length) {
    const ch = await query<{ id: string }>(
      `INSERT INTO channels(group_id, name, kind, radio_config, recording_enabled) VALUES ($1,'Radio One','radio',$2::jsonb,true) RETURNING id`,
      [grp[0].id, JSON.stringify({ outputs: { mp3: true, hls: true, dash: true }, bitrateKbps: 128, metadataCapture: true })]);
    await query(`INSERT INTO stream_inputs(channel_id, role, protocol, ingest_url) VALUES ($1,'primary','icecast'::ingest_protocol,$2)`,
      [ch[0].id, 'https://source.example/radio-one-128-mp3']);
  }

  // Loops & Fillers: one slate and one loop, so its guide shows the list rather
  // than the empty state, and News 24 falls back to the slate (Used by). The
  // files are small neutral pictures kept beside this script; the rows are laid
  // out exactly as an upload leaves them. Fixed ids keep re-runs to one each.
  const fillers: Array<[string, 'slate' | 'loop', string, string, string, number, number, number | null]> = [
    ['5d0c6a1e-2f4b-4c1a-9e1d-3a7b2c9d0e01', 'slate', 'Standby slate', 'standby-slate.png', 'image/png', 1280, 720, null],
    ['5d0c6a1e-2f4b-4c1a-9e1d-3a7b2c9d0e02', 'loop', 'Break loop', 'break-loop.mp4', 'video/mp4', 640, 360, 4000],
  ];
  for (const [id, kind, name, file, ct, w, h, ms] of fillers) {
    const src = join(__dirname, 'docs-media', file);
    const dest = fillerPath(ACCOUNT, id, file);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
    const key = `filler/${ACCOUNT}/${id}${file.slice(file.lastIndexOf('.'))}`;
    await query(
      `INSERT INTO filler_assets(id, account_id, kind, name, status, source_key, width, height, duration_ms, bytes, content_type, filename, uploaded_at, created_at)
       VALUES ($1,$2,$3,$4,'ready',$5,$6,$7,$8,$9,$10,$11, now() - interval '2 days', now() - interval '2 days')
       ON CONFLICT (id) DO UPDATE SET status='ready', source_key=EXCLUDED.source_key, bytes=EXCLUDED.bytes`,
      [id, ACCOUNT, kind, name, key, w, h, ms, statSync(src).size, ct, file]);
  }
  await query(`UPDATE channels SET input_loss_behavior='slate', filler_asset_id=$2, filler_slate_ref=NULL WHERE id=$1`, [NEWS, fillers[0][0]]);

  // A short, believable history for the audit log. Re-running the seed
  // replaces it rather than piling up copies.
  await query(`DELETE FROM audit_log WHERE account_id=$1 AND detail->>'seed'='docs'`, [ACCOUNT]);
  const label = 'admin@example.com';
  // The snapshot carries the name, so the log says which channel, not an id.
  const rows: Array<[string, 'create' | 'update' | 'delete', string, string, string, Record<string, { from: any; to: any }> | undefined]> = [
    ['5 hours', 'create', 'channel', SPORT, 'Sport One', undefined],
    ['3 hours', 'update', 'channel', NEWS, 'News 24', { name: { from: 'News', to: 'News 24' } }],
    ['2 hours', 'update', 'channel', NEWS, 'News 24', { failover_enabled: { from: false, to: true } }],
    ['40 minutes', 'update', 'channel', SPORT, 'Sport One', { name: { from: 'Sport', to: 'Sport One' } }],
  ];
  for (const [ago, action, type, id, name, changes] of rows) {
    await writeAudit(null, { accountId: ACCOUNT, userId: ADMIN, label, action, entityType: type, entityId: id, changes, snapshot: { name } });
    await query(
      `UPDATE audit_log SET created_at = now() - $2::interval, detail = detail || '{"seed":"docs"}'::jsonb
        WHERE id = (SELECT id FROM audit_log WHERE account_id=$1 ORDER BY created_at DESC LIMIT 1)`,
      [ACCOUNT, ago],
    );
  }

  console.log(`\ndocs demo ready. Sign in as ${DOCS_LOGIN.email} (password as in seed-demo.ts)`);
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
