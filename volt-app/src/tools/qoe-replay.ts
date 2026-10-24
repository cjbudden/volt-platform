/**
 * Rebuild QoE view rows and minute aggregates from the raw CMCD reports
 * (services/qoe/replay.ts). Safe to run while the collector runs, and to run
 * twice: each day is replaced whole, in one transaction.
 *
 *   npx tsx src/tools/qoe-replay.ts --day 2026-10-24 [--to 2026-10-31] [--account <uuid>]
 */
import { replayRange } from '../services/qoe/replay';
import { closeAnalytics } from '../services/qoe/analyticsDb';

const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined; };
const day = arg('day');
if (!day) { console.error('usage: qoe-replay --day YYYY-MM-DD [--to YYYY-MM-DD] [--account <uuid>]'); process.exit(2); }
replayRange(day, arg('to') ?? day, arg('account'))
  .then(async (r) => {
    for (const x of r) console.log(`${x.day} ${x.account}: ${x.rawReports} raw reports -> ${x.views} views, ${x.minuteRows} minute rows (definitions v${x.definitions})`);
    if (!r.length) console.log('no raw reports in that range');
    await closeAnalytics();
    process.exit(0);
  })
  .catch(async (e) => { console.error(e); await closeAnalytics(); process.exit(1); });
