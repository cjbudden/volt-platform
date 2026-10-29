// ============================================================================
//  JOB LOGS (migration 0088, services/jobs/jobLog.ts): what the Encoding queue's
//  job view shows. Lines split across chunks, progress thinned to one per 5%,
//  the per-job cap keeps the LAST lines, a retry appends under its attempt,
//  and the log goes with its job. docs/ENCODING_QUEUE.md.
//
//  Usage: DATABASE_URL=... npx tsx test/job-log.check.ts   (a migrated, disposable database)
// ============================================================================
import { JobLog, readJobLog } from '../src/services/jobs/jobLog';
import { one, pool, query } from '../src/db';

let pass = 0, fail = 0;
const ok = (c: boolean, m: string, d = '') => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log(`FAIL ${m}${d ? ' -- ' + d : ''}`); } };

(async () => {
  try {
    const J = (await one<{ id: string }>(`INSERT INTO jobs (type, payload) VALUES ('vod.encode', '{}'::jsonb) RETURNING id`))!.id;
    const log = await JobLog.open(J, 1);
    log.step('encoder started');
    log.out('frame 1\nframe 2\r\nprogress encode 1% at 1x\nprogress encode 2% at 1x\nprogress encode 6%');
    log.out(' at 2x\n');
    log.err('an error line\n');
    for (let i = 0; i < 5000; i++) log.out(`noise ${i}\n`);
    log.out('the last words');
    await log.close();
    const all = await readJobLog(J, 0, 5000);
    const lines = all.map((l) => l.line);
    ok(lines[0] === 'encoder started' && all[0].stream === 'step', 'a step is logged as a step');
    ok(lines.filter((l) => l.startsWith('progress encode')).length === 2, 'progress lines thinned to one per 5%');
    ok(lines.includes('progress encode 6% at 2x'), 'a line split across chunks is joined');
    ok(all.some((l) => l.stream === 'err' && l.line === 'an error line'), 'stderr kept as err');
    ok(all.some((l) => l.stream === 'warn' && /log capped at 4000 lines/.test(l.line)), 'the cap says so in the log');
    ok(lines[lines.length - 1] === 'the last words' && lines.includes('noise 4999'), 'past the cap, the last lines are kept');
    ok(all.length === 4000 + 1 + 200, 'kept: 4000, the note and a 200-line tail', String(all.length));
    ok(all.every((l, i) => l.seq === i + 1), 'seq is continuous');
    const log2 = await JobLog.open(J, 2); log2.step('retrying'); await log2.close();
    const more = await readJobLog(J, all.length);
    ok(more.length === 2 && more[0].attempt === 2 && more[0].line === 'attempt 2 started', 'a retry appends under its own attempt');
    await query(`DELETE FROM jobs WHERE id = $1`, [J]);
    ok((await readJobLog(J)).length === 0, 'the log goes with its job');
  } catch (e) {
    fail++; console.log('FAIL threw', e);
  } finally {
    await pool.end().catch(() => {});
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
