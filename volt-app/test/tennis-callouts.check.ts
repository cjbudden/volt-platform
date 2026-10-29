// ============================================================================
//  THE TENNIS SCORE TEMPLATE'S RULES, in Chromium: from the sets, the points, the server
//  and the match format it works out break, set and match point (and how many), tie-breaks
//  (to 7, the 10-point final set, the match tie-break), deuce and no-ad deciding points,
//  set and match won; a feed's match status, a manual callout (about a player) and a
//  custom one take over in that order; and a Sportradar live summary binds to it as is.
//
//  Usage: npx tsx test/tennis-callouts.check.ts   (needs Playwright; no database)
// ============================================================================
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
let pass = 0, fail = 0;
const ok = (c: boolean, m: string, d = '') => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log(`FAIL ${m}${d ? ' -- ' + d : ''}`); } };

(async () => {
  const { createRequire } = await import('node:module');
  const rq = createRequire(__filename);
  let chromium: any = null;
  for (const m of ['playwright', 'playwright-core', join(__dirname, '../../volt-encoder/gfx/node_modules/playwright-core')]) { try { chromium = rq(m).chromium; break; } catch { /* next */ } }
  if (!chromium) { console.log('SKIP: no Playwright here'); process.exit(0); }
  const { analyse } = await import('../src/services/graphics/templatePackage');
  const dir = join(__dirname, '../assets/graphics/tennis-score');
  const a = analyse([{ path: 'index.html', data: readFileSync(join(dir, 'index.html')) }]);
  const st = a.manifest.fields.find((f) => f.id === 'status');
  ok(!!st?.options?.some((o) => o.value === 'MEDICAL TIME-OUT') && a.manifest.fields.find((f) => f.id === 'bestOf')?.options?.length === 2,
    'the manual callouts and the match format are choice lists in the manifest');

  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
  const errs: string[] = []; p.on('pageerror', (e: any) => errs.push(e.message));
  await p.goto('file://' + join(dir, 'index.html'));
  const base = { p1Name: 'A. Rivera', p2Name: 'M. Kowalski', bestOf: 3, finalSet: 'tb7', noAd: false, autoCallouts: true, championship: false,
    status: '', statusCustom: '', calloutPlayer: 0, matchStatus: '', winner: '' };
  await p.evaluate((d: any) => { (window as any).update(JSON.stringify(d)); (window as any).play(); }, base);
  const call = async (d: any) => {
    await p.evaluate((x: any) => (window as any).update(JSON.stringify(x)), { ...base, ...d });
    await p.waitForTimeout(450);
    return p.evaluate(() => { const s = document.getElementById('st')!; return s.classList.contains('show') ? s.textContent : '' });
  };
  const cases: [string, any, string][] = [
    ['serving for the match', { sets: ['6-4', '5-4'], points: '40-30', server: 1 }, 'MATCH POINT'],
    ['two break points', { sets: ['3-4'], points: '15-40', server: 1 }, '2 BREAK POINTS'],
    ['advantage to the receiver', { sets: ['3-3'], points: 'AD-40', server: 2 }, 'BREAK POINT'],
    ['the server with game point says nothing', { sets: ['2-1'], points: '40-15', server: 1 }, ''],
    ['three set points', { sets: ['5-4'], points: '40-0', server: 1 }, '3 SET POINTS'],
    ['a break that is also set point says set point', { sets: ['5-3'], points: '40-15', server: 2 }, '2 SET POINTS'],
    ['deuce', { sets: ['2-2'], points: '40-40', server: 1 }, 'DEUCE'],
    ['no-ad deciding point', { sets: ['2-2'], points: '40-40', server: 1, noAd: true }, 'DECIDING POINT'],
    ['no-ad deciding point for the set', { sets: ['4-5'], points: '40-40', server: 1, noAd: true }, 'SET POINT'],
    ['tie-break', { sets: ['6-6'], points: '3-2', server: 1 }, 'TIE-BREAK'],
    ['tie-break set point', { sets: ['6-6'], points: '6-5', server: 1 }, 'SET POINT'],
    ['tie-break, two match points', { sets: ['6-4', '6-6'], points: '6-4', server: 2 }, '2 MATCH POINTS'],
    ['10-point final-set tie-break is not over at 6', { sets: ['6-4', '4-6', '6-6'], points: '6-5', finalSet: 'tb10' }, 'TIE-BREAK'],
    ['10-point final-set tie-break, match point at 9', { sets: ['6-4', '4-6', '6-6'], points: '9-8', finalSet: 'tb10' }, 'MATCH POINT'],
    ['the same at 6-6 in set 2 is a 7-point tie-break', { sets: ['6-4', '6-6'], points: '6-5', finalSet: 'tb10' }, 'MATCH POINT'],
    ['match tie-break', { sets: ['6-4', '4-6', '0-0'], points: '5-5', finalSet: 'mtb' }, 'MATCH TIE-BREAK'],
    ['match tie-break, two match points', { sets: ['6-4', '4-6', '0-0'], points: '9-7', finalSet: 'mtb' }, '2 MATCH POINTS'],
    ['advantage final set: 6-6 is not a tie-break', { sets: ['6-4', '4-6', '6-6'], points: '40-30', server: 1, finalSet: 'adv' }, ''],
    ['advantage final set: 7-6 serving for it', { sets: ['6-4', '4-6', '7-6'], points: '40-30', server: 1, finalSet: 'adv' }, 'MATCH POINT'],
    ['best of 5: two sets up is not match point at 5-4 in set 2', { sets: ['6-4', '5-4'], points: '40-30', server: 1, bestOf: 5 }, 'SET POINT'],
    ['best of 5: two sets each, serving for it', { sets: ['6-4', '4-6', '6-3', '3-6', '5-4'], points: '40-0', server: 1, bestOf: 5 }, '3 MATCH POINTS'],
    ['a final says championship point', { sets: ['6-4', '5-4'], points: '40-30', server: 1, championship: true }, 'CHAMPIONSHIP POINT'],
    ['a set just won names the player', { sets: ['6-4'], points: '', server: 2 }, 'SET · A. Rivera'],
    ['match won', { sets: ['6-4', '7-6'], points: '', server: 1 }, 'GAME, SET AND MATCH'],
    ['automatic callouts off', { sets: ['6-4', '5-4'], points: '40-30', server: 1, autoCallouts: false }, ''],
    ['a feed status takes over', { sets: ['6-4', '5-4'], points: '40-30', server: 1, matchStatus: 'interrupted' }, 'MATCH SUSPENDED'],
    ['a manual callout about player 2', { sets: ['6-4', '5-4'], points: '40-30', server: 1, status: 'MEDICAL TIME-OUT', calloutPlayer: 2 }, 'MEDICAL TIME-OUT · M. Kowalski'],
    ['a custom callout wins over everything', { sets: ['6-4', '5-4'], points: '40-30', server: 1, status: 'TIME OUT', statusCustom: 'ROOF CLOSING' }, 'ROOF CLOSING'],
    ['cleared, the automatic one is back', { sets: ['6-4', '5-4'], points: '40-30', server: 1 }, 'MATCH POINT'],
  ];
  for (const [name, d, want] of cases) { const got = await call(d); ok(got === want, `${name}: "${want}"`, `got "${got}"`); }
  const won = await p.evaluate(() => ({ r1: document.getElementById('r1')!.className, ball: document.body.classList.contains('s1') }));
  await call({ sets: ['6-4', '7-6'], points: '' });
  const won2 = await p.evaluate(() => ({ r1: document.getElementById('r1')!.className, r2: document.getElementById('r2')!.className, ball: document.body.classList.contains('s1') || document.body.classList.contains('s2') }));
  ok(/won/.test(won2.r1) && /lost/.test(won2.r2) && !won2.ball, 'the winner is worked out from the sets: ticked, no serve marker', JSON.stringify([won, won2]));

  console.log('== a Sportradar live summary, bound by path ==');
  const fx = JSON.parse(readFileSync(join(__dirname, 'fixtures/sportradar-tennis-live.json'), 'utf8'));
  const get = (o: any, path: string) => path.split('.').reduce((x, k) => x?.[k], o);
  const bind = { sets: 'sport_event_status.period_scores', points: 'sport_event_status.game_state', server: 'sport_event_status.game_state.serving',
    bestOf: 'sport_event.sport_event_context.mode.best_of', matchStatus: 'sport_event_status.match_status' };
  const vals: any = Object.fromEntries(Object.entries(bind).map(([k, path]) => [k, get(fx, path)]));
  let got = await call(vals);
  const cellsTxt = await p.evaluate(() => [...document.querySelectorAll('.cells')].map((c) => (c as HTMLElement).innerText.replace(/\s+/g, ' ').trim()));
  ok(got === '2 MATCH POINTS' && cellsTxt[0] === '6 5 40' && cellsTxt[1] === '4 4 15', 'the sets, points and server come straight from the feed', JSON.stringify({ got, cellsTxt }));
  fx.sport_event_status.game_state = { home_score: 40, away_score: 50, serving: 'home', tie_break: false };
  got = await call({ ...vals, points: fx.sport_event_status.game_state });
  ok(got === 'BREAK POINT' && (await p.evaluate(() => (document.querySelectorAll('.cells')[1] as HTMLElement).innerText.includes('AD'))), 'the feed\'s 50 shows as AD, and the receiver\'s advantage is break point', got);
  got = await call({ ...vals, points: { home_score: 40, away_score: 40, serving: 'home', advantage: 'away' } });
  ok(got === 'BREAK POINT', 'or advantage named by side');
  got = await call({ ...vals, matchStatus: 'retired2', points: '' });
  ok(got === 'RETIRED', 'a feed status of retired shows as a callout');
  ok(errs.length === 0, 'no page errors', errs.join('; '));
  await b.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('FAIL threw', e); process.exit(1); });
