// ============================================================================
//  ONE-OFF RECORDINGS CLEANUP: delete recorded streams that ended more than N days ago.
//
//    npx tsx scripts/prune-recordings.ts                 dry run, 2 days: lists what would go
//    npx tsx scripts/prune-recordings.ts --yes           deletes them
//    npx tsx scripts/prune-recordings.ts --days 7 --yes  another age
//    --include-derived                                   also recordings clips were cut from
//
//  Removes the same way retention does (services/media/prune.ts): the segments clips were cut
//  from stay with their thumbnails (held), everything else goes to the RESTORE BIN for
//  VOLT_TRASH_DAYS (7) days, restorable from Storage > Recently removed, then purged.
//  The recording row is kept so provenance and the audit trail still reach it.
//
//  Skipped and listed: recordings still running and recordings on hold. With
//  --include-derived a recording clips were cut from is pruned too (its clips' sources stay);
//  without it, it is left whole.
// ============================================================================
import { pool, query } from '../src/db';
import { clipsFromRecording } from '../src/services/clips/provenance';
import { pruneRecording } from '../src/services/media/prune';

const arg = (k: string) => process.argv.includes(k);
const days = Number(process.argv[process.argv.indexOf('--days') + 1]) || 2;
const apply = arg('--yes');
const includeDerived = arg('--include-derived');
const gb = (n: number) => n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : `${(n / 1e6).toFixed(0)} MB`;
const day = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');

(async () => {
  const cutoff = Date.now() - days * 86_400_000;
  const recs = await query<any>(
    `SELECT r.id, r.kind, r.title, r.status, r.start_epoch_ms, r.end_epoch_ms, COALESCE(c.name, e.name) AS owner,
            (SELECT COALESCE(sum(m.bytes), 0)::bigint FROM media_objects m WHERE m.recording_id = r.id AND m.state <> 'deleted') AS bytes,
            (SELECT count(*)::int FROM media_objects m WHERE m.recording_id = r.id AND m.state <> 'deleted') AS objects,
            (SELECT bool_or(m.hold) FROM media_objects m WHERE m.recording_id = r.id) AS held
       FROM recordings r LEFT JOIN channels c ON c.id = r.channel_id LEFT JOIN events e ON e.id = r.event_id
      WHERE r.storage_state IS DISTINCT FROM 'deleted' AND r.start_epoch_ms < $1
      ORDER BY r.start_epoch_ms`, [cutoff]);

  let goBytes = 0; const go: any[] = []; const skip: { r: any; why: string }[] = [];
  for (const r of recs) {
    const ended = r.end_epoch_ms != null && Number(r.end_epoch_ms) < cutoff;
    if (!ended) { skip.push({ r, why: r.end_epoch_ms == null ? 'still recording' : 'ended within the window' }); continue; }
    if (r.held) { skip.push({ r, why: 'under a hold' }); continue; }
    const derived = await clipsFromRecording(r.id);
    if (derived.length && !includeDerived) { skip.push({ r, why: `${derived.length} clip${derived.length === 1 ? '' : 's'} cut from it (--include-derived to delete anyway)` }); continue; }
    go.push(r); goBytes += Number(r.bytes);
  }

  console.log(`Recordings older than ${days} day${days === 1 ? '' : 's'} (started before ${day(cutoff)} UTC): ${recs.length}`);
  for (const r of go) console.log(`  DELETE  ${day(Number(r.start_epoch_ms))}  ${String(r.owner ?? '?').padEnd(28).slice(0, 28)}  ${r.kind.padEnd(12)}  ${gb(Number(r.bytes)).padStart(9)}  ${r.objects} object(s)  ${r.id}`);
  for (const s of skip) console.log(`  keep    ${day(Number(s.r.start_epoch_ms))}  ${String(s.r.owner ?? '?').padEnd(28).slice(0, 28)}  ${s.why}`);
  console.log(`${go.length} to delete, ${gb(goBytes)}; ${skip.length} kept.`);
  if (!apply) { console.log('Dry run. Add --yes to delete.'); await pool.end(); return; }

  let done = 0, segs = 0, kept = 0;
  for (const r of go) {
    try {
      const out = await pruneRecording(r.id, { reason: `cleanup script: older than ${days} days`, actor: 'cleanup:prune-recordings' });
      segs += out.reduce((a, x) => a + x.removedSegments, 0); kept += out.reduce((a, x) => a + x.keptSegments, 0);
      done++;
    } catch (e: any) { console.error(`  failed on ${r.id}: ${e?.message ?? e}`); }
  }
  console.log(`Moved ${done} recording(s) to the restore bin: ${segs} segments, about ${gb(goBytes)}; ${kept} segments kept for clips.`);
  console.log('Restore any of them from Storage > Recently removed until the bin purges them.');
  await pool.end();
})().catch(async (e) => { console.error(e); await pool.end().catch(() => {}); process.exit(1); });
