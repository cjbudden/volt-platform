// ============================================================================
//  ENCODER LOG ROWS SAY WHEN.
//
//  encoder.log lines had no time, so the Connection Log showed "encoder" in
//  the time column and five identical "Error while decoding" rows could be one
//  burst an hour ago or a fault happening now. The encoder stamps every line
//  (volt-encoder/bin/logstamp.py); the detail API reads the stamp, folds a
//  repeated message into one row with its count and first time, and orders
//  the whole log newest first.
//
//  Usage: DATABASE_URL=... API=http://localhost:8080 [ORIGIN_DIR=...] \
//         CHANNEL_ID=<a channel> EMAIL=... PASSWORD=... npx tsx test/encoder-log-times.check.ts
// ============================================================================
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { splitStamp, foldRepeats, newestFirst } from '../src/services/encoderLog';
import { config } from '../src/config';

const API = process.env.API || 'http://localhost:8080';
let pass = 0, fail = 0;
const check = (m: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${m}${ok ? '' : ` -- expected ${JSON.stringify(want)} got ${JSON.stringify(got)}`}`);
};

(async () => {
  console.log('== reading the stamp ==');
  const s = splitStamp('2026-10-27T09:31:02.123Z [relay:primary] Error while decoding stream #1:0');
  check('the time comes off the front', s.at, '2026-10-27T09:31:02.123Z');
  check('and the text is left as it was', s.text, '[relay:primary] Error while decoding stream #1:0');
  check('an unstamped (older) line has no time', splitStamp('Error while decoding').at, null);

  console.log('\n== repeats fold into one row ==');
  const row = (at: string | null, detail: string) => ({ ts: 'x', at, count: 1, level: 'down', title: 'Encoder', detail });
  const f = foldRepeats([row('2026-10-27T09:00:00.000Z', 'A'), row('2026-10-27T09:01:00.000Z', 'B'),
    row('2026-10-27T09:02:00.000Z', 'A'), row('2026-10-27T09:03:00.000Z', 'A')]);
  check('two messages, two rows', f.length, 2);
  check('the repeated one is at the newest end', f[1].detail, 'A');
  check('with how many times', f[1].count, 3);
  check('its first time', f[1].firstAt, '2026-10-27T09:00:00.000Z');
  check('and its last', f[1].at, '2026-10-27T09:03:00.000Z');
  check('newest first, untimed rows kept at the top',
    newestFirst([{ at: '2026-10-27T09:00:00Z' }, { at: null }, { at: '2026-10-27T09:05:00Z' }]).map((r) => r.at),
    [null, '2026-10-27T09:05:00Z', '2026-10-27T09:00:00Z']);

  // ---- through the API, from a real encoder.log -------------------------------
  const id = process.env.CHANNEL_ID;
  if (!id) { console.log('\n(no CHANNEL_ID: API part skipped)'); }
  else {
    console.log('\n== the channel page log, from encoder.log ==');
    const dir = join(config.testStream.originDir, id);
    mkdirSync(dir, { recursive: true });
    const p = join(dir, 'encoder.log');
    const before = existsSync(p) ? readFileSync(p) : null;
    const t = (secAgo: number) => new Date(Date.now() - secAgo * 1000).toISOString();
    const err = 'Error while decoding stream #1:0: Invalid data found when processing input';
    writeFileSync(p, [
      'Error while decoding stream #1:0: from an earlier run, before stamps',
      `${t(3600)} [volt-encoder] channel=${id} run banner`,
      `${t(3590)} [volt-encoder] start relay:primary: ffmpeg -loglevel error -i srt://x`,
      `${t(1800)} [relay:primary] Connection timed out`,
      ...[300, 240, 180, 120, 20].map((a) => `${t(a)} [relay:primary] ${err}`),
      'frame=  100 fps= 25 time=00:00:04.00 speed=1x',
      '',
    ].join('\n'));
    try {
      const L = await (await fetch(`${API}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: process.env.EMAIL, password: process.env.PASSWORD }) })).json();
      const d = await (await fetch(`${API}/api/channels/${id}`, { headers: { authorization: 'Bearer ' + L.access } })).json();
      const enc = (d.log ?? []).filter((r: any) => r.title === 'Encoder');
      check('only this run: the pre-banner line is gone', enc.some((r: any) => /earlier run/.test(r.detail)), false);
      check('a command echo is still not an error', enc.some((r: any) => /start relay/.test(r.detail)), false);
      check('two encoder rows: the timeout and the folded decode error', enc.length, 2);
      const dec = enc.find((r: any) => r.detail.includes('Invalid data'));
      check('every encoder row has a time', enc.every((r: any) => typeof r.at === 'string'), true);
      check('the time column no longer says "encoder"', enc.some((r: any) => r.ts === 'encoder'), false);
      check('the decode error was written five times', dec?.count, 5);
      check('last 20 s ago (so it is still happening)', Math.round((Date.now() - Date.parse(dec?.at)) / 1000 / 10), 2);
      check('first five minutes ago', Math.round((Date.now() - Date.parse(dec?.firstAt)) / 60000), 5);
      check('it names the part of the pipeline', dec?.detail.startsWith('[relay:primary] '), true);
      const times = (d.log ?? []).filter((r: any) => r.at).map((r: any) => Date.parse(r.at));
      check('the whole log is newest first', times.every((x: number, i: number) => i === 0 || times[i - 1] >= x), true);
      check('the decode error comes before the older timeout', d.log.indexOf(dec) < d.log.findIndex((r: any) => /timed out/.test(r.detail)), true);
    } finally {
      if (before) writeFileSync(p, before); else rmSync(p, { force: true });
    }
  }
  console.log(`\nencoder-log-times: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
