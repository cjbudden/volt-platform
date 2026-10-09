// ============================================================================
//  A RADIO STATION IS NOT A TELEVISION CHANNEL, AND THE ROW ALREADY SAYS SO.
//
//  `channels.kind` has been 'tv' | 'radio' since the first migration. Two places
//  read the table and threw that column away, replacing it with a literal:
//
//    modules/search.ts   pushed `kind: 'channel'` for every row, with
//                        `href: /channels/<id>`. So searching for a station
//                        labelled it CHANNEL and opened the TELEVISION control
//                        page: a 16:9 video surface, no audio visualiser, no
//                        now-playing log, no station settings. The label was the
//                        symptom; the href was the fault.
//
//    modules/epg.ts      selected `'channel'::text AS kind` in the owners
//                        union, so the EPG page's Channels filter swept up every
//                        station in the account. Twenty-one stations buried two
//                        actual channels, and the filter was useless for either.
//
//  THE SHAPE OF THE MISTAKE IS THE SAME BOTH TIMES: a literal doing the
//  classifying instead of the column that already knows. Nothing was wrong with
//  the data, which is why nothing looked broken until somebody clicked a search
//  result and got the wrong page.
//
//  WHY 'radio' AND NOT 'tv'. The rest of the console's vocabulary is
//  channel / radio / event -- that is the navigation, the routes and the
//  filters -- so the API speaks it too. Emitting 'tv' would push a translation
//  into every consumer.
//
//  WHAT DOES NOT SPLIT: a station's programmes still hang off `channel_id`
//  exactly as a channel's do. The split is about which page and which filter,
//  not which column, and this suite asserts BOTH halves -- because a "fix" that
//  also moved the data would have broken every guide.
//
//  Usage: DATABASE_URL=... npx tsx test/kind-routing.check.ts
// ============================================================================
import { pool, query, one } from '../src/db';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let pass = 0, fail = 0;
const ok = (m: string) => { console.log('PASS ' + m); pass++; };
const bad = (m: string, d: string) => { console.log(`FAIL ${m} -- ${d}`); fail++; };
const check = (m: string, got: unknown, want: unknown) =>
  got === want ? ok(m) : bad(m, `expected [${String(want)}] got [${String(got)}]`);
const truthy = (m: string, v: unknown) => (v ? ok(m) : bad(m, `expected something, got [${String(v)}]`));

const A = '00000000-0000-0000-0000-00000ab10001';
const P = '00000000-0000-0000-0000-00000ab10002';
const G = '00000000-0000-0000-0000-00000ab10003';
const TV = '00000000-0000-0000-0000-00000ab10010';
const RADIO = '00000000-0000-0000-0000-00000ab10011';
const EV = '00000000-0000-0000-0000-00000ab10012';

(async () => {
  await query(`DELETE FROM accounts WHERE id=$1`, [A]);
  await query(`INSERT INTO accounts(id,name) VALUES ($1,'KindCo')`, [A]);
  await query(
    `INSERT INTO output_profiles(id,account_id,name,rungs,workflow_type,packaging,segment_dur,dvr_window_sec)
     VALUES ($1,$2,'p','[{"height":720,"bitrate_kbps":2500}]','transcode','both',4,60)`, [P, A]);
  await query(`INSERT INTO groups(id,account_id,name,output_profile_id,max_channels)
               VALUES ($1,$2,'g',$3,20)`, [G, A, P]);
  // Named so one query matches both: the bug was that they came back the SAME.
  await query(
    `INSERT INTO channels(id,group_id,name,status,kind) VALUES
       ($1,$3,'Zebra News TV','ended','tv'),
       ($2,$3,'Zebra FM Station','ended','radio')`, [TV, RADIO, G]);
  await query(`INSERT INTO events(id,group_id,name,status,scheduled_start,scheduled_end)
               VALUES ($1,$2,'Zebra Cup Final','scheduled', now(), now() + interval '2 hours')`, [EV, G]);

  // ---- the shared classifier, as both modules must apply it ----------------
  // Asserted against the DATABASE rather than through HTTP, because the thing
  // under test is the SQL that reads the column, and a route test would pass
  // just as happily with the literal back in place if the fixture were tv-only.
  console.log('== the owners query classifies from the column, not a literal ==');
  const owners = await query<any>(
    `SELECT CASE WHEN c.kind = 'radio' THEN 'radio' ELSE 'channel' END AS kind, c.id, c.name
       FROM channels c JOIN groups g ON g.id=c.group_id
      WHERE g.account_id=$1
      UNION ALL
     SELECT 'event', e.id, e.name FROM events e
       JOIN groups g ON g.id=e.group_id WHERE g.account_id=$1
      ORDER BY 3`, [A]);
  check('all three owners are listed', owners.length, 3);
  check('the television channel is a channel',
    owners.find((o) => o.id === TV)?.kind, 'channel');
  check('the radio station is RADIO, not channel',
    owners.find((o) => o.id === RADIO)?.kind, 'radio');
  check('and an event is still an event', owners.find((o) => o.id === EV)?.kind, 'event');

  // ---- the two modules actually contain that classifier --------------------
  //
  // Structural, and deliberately so: the property being protected is that
  // neither module emits a LITERAL kind for a table that carries one. A test
  // that only called the endpoint would go green again the moment somebody
  // reintroduced the literal alongside a tv-only fixture.
  console.log('\n== neither module hardcodes the kind any more ==');
  const searchSrc = readFileSync(join(__dirname, '../src/modules/search.ts'), 'utf8');
  const epgSrc = readFileSync(join(__dirname, '../src/modules/epg.ts'), 'utf8');

  truthy('search selects the kind column', /SELECT[^`]*c\.kind/.test(searchSrc));
  truthy('search routes a station to /radio, not /channels',
    /\/radio\/\$\{c\.id\}/.test(searchSrc));
  truthy('and still routes a television channel to /channels',
    /\/channels\/\$\{c\.id\}/.test(searchSrc));
  truthy('the EPG owners union derives the kind from the column',
    /WHEN c\.kind = 'radio' THEN 'radio'/.test(epgSrc));

  // ---- what must NOT have split -------------------------------------------
  //
  // A station's programmes hang off channel_id. Splitting the KIND while also
  // splitting the column would have silently emptied every station's guide, and
  // that failure would look like "the EPG is broken" rather than like this
  // change.
  console.log('\n== but the DATA did not split: programmes still hang off channel_id ==');
  await query(
    `INSERT INTO programmes(channel_id, title, starts_at, ends_at)
     VALUES ($1,'Breakfast Show', now(), now() + interval '1 hour')`, [RADIO]);
  const guide = await one<any>(
    `SELECT count(*)::int n FROM programmes WHERE channel_id=$1`, [RADIO]);
  check("a station's programme is stored on channel_id like any other", guide?.n, 1);

  // The owners roll-up must therefore still find it, joining on the same column
  // for both kinds.
  const rolled = await one<any>(
    `SELECT o.kind, count(p.id)::int AS programme_count
       FROM (SELECT CASE WHEN c.kind='radio' THEN 'radio' ELSE 'channel' END AS kind, c.id
               FROM channels c JOIN groups g ON g.id=c.group_id WHERE g.account_id=$1) o
       LEFT JOIN programmes p ON (p.channel_id = o.id)
      WHERE o.id = $2 GROUP BY o.kind`, [A, RADIO]);
  check('and the roll-up still counts it', rolled?.programme_count, 1);
  check('while reporting it as a radio guide', rolled?.kind, 'radio');

  // ---- the console vocabulary is the API's -------------------------------
  console.log('\n== the web types admit the third kind ==');
  const webRoot = join(__dirname, '../../volt-web/src');
  const apiSrc = readFileSync(join(webRoot, 'api.ts'), 'utf8');
  const routerSrc = readFileSync(join(webRoot, 'router.ts'), 'utf8');
  const epgPage = readFileSync(join(webRoot, 'pages/Epg.tsx'), 'utf8');
  truthy("EpgOwnerRow accepts 'radio'",
    /kind: 'channel' \| 'radio' \| 'event'/.test(apiSrc));
  truthy('/epg/radio/:id is a route, or the row would open nothing',
    /parts\[1\] === 'radio'/.test(routerSrc));
  truthy('the EPG page offers a Radio stations filter',
    /label="Radio stations"/.test(epgPage));

  await query(`DELETE FROM accounts WHERE id=$1`, [A]);
  console.log(`\nkind-routing: ${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error('FATAL', e);
  await pool.end().catch(() => {});
  process.exit(1);
});
