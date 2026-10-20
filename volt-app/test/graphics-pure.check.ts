// ============================================================================
//  HTML GRAPHICS, the pure parts (no database):
//    services/graphics/zip.ts             packages
//    services/graphics/templatePackage.ts manifest + publish checks
//    services/graphics/schedule.ts        always / rule / trigger / manual, day plan
//    services/graphics/values.ts          where each field's value comes from
//    services/graphics/rundown.ts         cues, Take next, CSV
//    services/graphics/ograf.ts           EBU OGraf packages (fixtures: test/fixtures/ograf, MIT, EBU)
//  Usage: npx tsx test/graphics-pure.check.ts
// ============================================================================
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readZip, writeZip } from '../src/services/graphics/zip';
import { analyse, filesFromUpload, normalise, PackageError, safePath } from '../src/services/graphics/templatePackage';
import { isOn, plan, describe, type Programme, type AssignmentRun } from '../src/services/graphics/schedule';
import { resolveValues, coerce, pick } from '../src/services/graphics/values';
import { nextManual, dueAutomatic, feedFired, normCue, parseCsv, cueFromText, zonedOn } from '../src/services/graphics/rundown';
import { parseRss } from '../src/services/graphics/runtime';
import { injectBridge, BRIDGE } from '../src/modules/graphics';
import { fieldsFromSchema, ografHostPage, stripJsComments } from '../src/services/graphics/ograf';
import { templateStatus } from '../src/services/graphics/status';
import { readStyle, applyStyle, normColor } from '../src/services/graphics/style';

let pass = 0, fail = 0;
const ok = (c: boolean, m: string, d = '') => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log(`FAIL ${m}${d ? ' -- ' + d : ''}`); } };
const eq = (got: unknown, want: unknown, m: string) => ok(JSON.stringify(got) === JSON.stringify(want), m, `expected ${JSON.stringify(want)} got ${JSON.stringify(got)}`);
const throws = (fn: () => unknown, re: RegExp, m: string) => { try { fn(); ok(false, m, 'did not throw'); } catch (e: any) { ok(re.test(String(e?.message)), m, String(e?.message)); } };
const B = (s: string) => Buffer.from(s, 'utf8');

console.log('== zip ==');
{
  const z = writeZip([{ path: 'pkg/index.html', data: B('<html>hi</html>') }, { path: 'pkg/fonts/a.woff2', data: Buffer.from([1, 2, 3]) }, { path: '__MACOSX/pkg/._index.html', data: B('x') }]);
  const r = readZip(z, { maxEntries: 10, maxTotalBytes: 1e6 });
  eq(r.map((e) => e.path), ['pkg/index.html', 'pkg/fonts/a.woff2'], 'reads stored entries and drops Finder litter');
  throws(() => readZip(z, { maxEntries: 1, maxTotalBytes: 1e6 }), /more than the 1 allowed/, 'entry limit');
  throws(() => readZip(z, { maxEntries: 10, maxTotalBytes: 5 }), /unpacks to more than/, 'size limit stops a bomb before inflating');
  throws(() => filesFromUpload(B('not a zip at all'), 'x.zip'), /not a readable \.zip/, 'a .zip that is not a zip');
  eq(filesFromUpload(B('<!doctype html><p>x</p>')).map((f) => f.path), ['index.html'], 'a bare .html upload becomes index.html');
}

console.log('== paths ==');
throws(() => safePath('../etc/passwd'), /may not leave/, 'parent paths refused');
throws(() => safePath('/abs/index.html'), /absolute/, 'absolute paths refused');
throws(() => safePath('C:\\x\\index.html'), /absolute/, 'drive paths refused');
eq(safePath('./a/b/../c.png'), 'a/c.png', 'normalised');
{
  const files = normalise([{ path: 'scorebug/index.html', data: B('<html></html>') }, { path: 'scorebug/img/a.png', data: B('x') }]);
  eq(files.map((f) => f.path), ['index.html', 'img/a.png'], 'one top folder is stripped');
  eq(normalise([{ path: 'Graphic.HTML', data: B('<p>') }]).map((f) => f.path), ['index.html'], 'a single html of another name is the entry');
  throws(() => normalise([{ path: 'a.png', data: B('x') }, { path: 'A.png', data: B('y') }]), /appears twice/, 'case-insensitive duplicates refused');
}

console.log('== manifest + checks ==');
const DEFAULTS = join(__dirname, '../assets/graphics');
for (const key of readdirSync(DEFAULTS)) {
  const a = analyse([{ path: 'index.html', data: readFileSync(join(DEFAULTS, key, 'index.html')) }]);
  ok(a.publishable, `shipped template ${key} passes its own checks`, JSON.stringify(a.checks.filter((c) => c.level !== 'ok')));
  ok(a.manifest.manifestFrom === 'volt-manifest' && a.manifest.fields.length > 0, `shipped template ${key} declares fields`);
}
{
  const html = `<html><head><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Barlow">
  <script type="application/json" id="volt-manifest">{"name":"Results","canvas":[1920,1080],"fields":[{"id":"title","type":"text","label":"Title"},{"id":"n","type":"int"},{"id":"bad id"}]}</script>
  <style>@font-face{src:url(fonts/missing.woff2)} body{background:url('//cdn.example.com/x.png')}</style></head>
  <body><img src="img/logo.png"><script src="https://cdn.jsdelivr.net/npm/gsap"></script>
  <script>function update(d){} function play(){} function stop(){} fetch("https://api.example.com/x"); localStorage.x=1;</script></body></html>`;
  const a = analyse([{ path: 'index.html', data: B(html) }, { path: 'img/logo.png', data: B('png') }]);
  const by = Object.fromEntries(a.checks.map((c) => [c.id, c]));
  eq(a.manifest.fields.map((f) => [f.id, f.type]), [['title', 'text'], ['n', 'number']], 'fields normalised, invalid ids dropped');
  ok(by.network?.level === 'error' && /fonts\.googleapis\.com/.test(by.network.detail) && /cdn\.example\.com/.test(by.network.detail), 'network references are errors and named', by.network?.detail);
  ok(!a.publishable, 'not publishable while it loads from the internet');
  ok(by.missing?.level === 'warn' && /fonts\/missing\.woff2/.test(by.missing.detail) && !/logo/.test(by.missing.detail), 'missing relative files warned, present ones not', by.missing?.detail);
  ok(by.storage?.level === 'warn', 'browser storage warned');
  ok(by.update?.level === 'ok' && by.transport?.level === 'ok', 'CasparCG functions found');
}
{
  const a = analyse([{ path: 'index.html', data: B('<div data-field="name"></div><div data-field="role"></div><script>function play(){}</script>') }]);
  eq(a.manifest.manifestFrom, 'data-field', 'fields from data-field attributes');
  ok(a.checks.find((c) => c.id === 'update')?.level === 'error', 'fields without update() block publishing');
  ok(a.checks.find((c) => c.id === 'canvas')?.level === 'warn', 'undeclared canvas is a warning, assumed 1920x1080');
}
{
  const spx = `<script>window.SPXGCTemplateDefinition = {"description":"SPX lower","DataFields":[{"field":"f0","ftype":"textfield","title":"Name","value":"Jo"},{"ftype":"instruction","value":"x"},{"field":"f1","ftype":"filelist","title":"Logo"}]};</script>
  <script>window.update=function(d){};window.play=function(){};window.stop=function(){};</script>`;
  const a = analyse([{ path: 'index.html', data: B(spx) }]);
  eq([a.manifest.manifestFrom, a.manifest.name, a.manifest.fields.map((f) => f.type), a.manifest.sample], ['spx', 'SPX lower', ['text', 'image'], { f0: 'Jo' }], 'SPX template definition read');
  ok(a.publishable, 'SPX template with window.update publishes');
}
{
  const a = analyse([{ path: 'index.html', data: B('<script id="volt-manifest" type="application/json">{oops</script><script>function update(){}</script>') }]);
  ok(a.checks.some((c) => c.id === 'manifest' && c.level === 'error'), 'a broken manifest block is an error, not silently ignored');
}
{
  const svg = analyse([{ path: 'index.html', data: B('<svg xmlns="http://www.w3.org/2000/svg"><a href="https://example.com">x</a></svg><script>function update(){}</script>') }]);
  ok(svg.checks.find((c) => c.id === 'network')?.level === 'ok', 'xmlns and <a href> are not network loads');
}
ok(/^<html><head><script>/.test(injectBridge('<html><head><title>x</title>')), 'bridge goes first in <head>');
ok(injectBridge('<p>x</p>').startsWith('<script>'), 'bridge prepended when there is no head');

console.log('== run modes ==');
const T = (hhmm: string, day = '20') => new Date(`2026-10-${day}T${hhmm}:00.000Z`);
const progs: Programme[] = [
  { title: 'Breakfast News', startsAt: T('06:00'), endsAt: T('09:00'), genres: ['News'] },
  { title: 'Morning Show', startsAt: T('09:00'), endsAt: T('11:58'), genres: ['Entertainment'] },
  { title: 'Ad break', startsAt: T('11:58'), endsAt: T('12:00'), kind: 'ad' },
  { title: 'Midday News', startsAt: T('12:00'), endsAt: T('13:00'), genres: ['news'] },
];
const A = (p: Partial<AssignmentRun>): AssignmentRun => ({ run_mode: 'always', rule: {}, clear_in_ads: true, enabled: true, ...p });
eq(isOn(A({}), progs, T('07:00'), false).on, true, 'always: on');
eq(isOn(A({}), progs, T('11:59'), false), { on: false, reason: 'ad break' }, 'always: cleared for the ad break');
eq(isOn(A({ clear_in_ads: false }), progs, T('11:59'), false).on, true, 'unless told to stay through ads');
eq(isOn(A({ enabled: false }), progs, T('07:00'), true).on, false, 'switched off wins over a hand take');
eq(isOn(A({ run_mode: 'manual' }), progs, T('07:00'), false).on, false, 'manual: waits');
eq(isOn(A({ run_mode: 'manual' }), progs, T('07:00'), true).on, true, 'manual: on when taken');
eq(isOn(A({ run_mode: 'rule', rule: { genre: 'News' } }), progs, T('12:30'), false).on, true, 'rule: genre matches, case-insensitive');
eq(isOn(A({ run_mode: 'rule', rule: { genre: 'News' } }), progs, T('10:00'), false).on, false, 'rule: genre does not match');
eq(isOn(A({ run_mode: 'rule', rule: { genre: 'News' } }), progs, T('10:00'), true).on, true, 'rule: a hand take forces it up');
eq(isOn(A({ run_mode: 'rule', rule: { titleContains: 'midday' } }), progs, T('12:10'), false).on, true, 'rule: title contains');
eq(isOn(A({ run_mode: 'rule', rule: { from: '06:00', to: '08:00' } }), progs, T('07:59'), false).on, true, 'rule: clock window');
eq(isOn(A({ run_mode: 'rule', rule: { from: '06:00', to: '08:00' } }), progs, T('08:00'), false).on, false, 'rule: window end exclusive');
eq(isOn(A({ run_mode: 'rule', rule: { from: '22:00', to: '02:00' } }), progs, T('01:00'), false).on, true, 'rule: window wraps midnight');
eq(isOn(A({ run_mode: 'rule', rule: { from: '06:00', to: '08:00', tz: 'Australia/Brisbane' } }), progs, T('21:00', '19'), false).on, true, 'rule: window in the channel time zone');
eq(isOn(A({ run_mode: 'rule', rule: { days: [2] } }), progs, T('07:00'), false).on, true, 'rule: 20 Oct 2026 is a Tuesday');
eq(isOn(A({ run_mode: 'rule', rule: { days: [6, 7] } }), progs, T('07:00'), false).on, false, 'rule: not a weekend');
const title = A({ run_mode: 'trigger', rule: { at: 'programme_start', offsetSec: 10, durationSec: 8 } });
eq(isOn(title, progs, new Date(T('09:00').getTime() + 12_000), false).on, true, 'trigger: 10 s after the start, inside 8 s');
eq(isOn(title, progs, new Date(T('09:00').getTime() + 19_000), false).on, false, 'trigger: gone after 8 s');
eq(isOn(title, progs, new Date(T('11:58').getTime() + 12_000), false).on, false, 'trigger: not on ad items');
const upnext = A({ run_mode: 'trigger', rule: { at: 'programme_end', offsetSec: 120, durationSec: 12 } });
eq(isOn(upnext, progs, new Date(T('08:58').getTime() + 5_000), false).on, true, 'trigger: 2 min before the end');
{
  const w = plan(A({ run_mode: 'rule', rule: { genre: 'news' } }), progs, T('00:00'), T('23:59'));
  eq(w.map((x) => [x.start.toISOString().slice(11, 16), x.end.toISOString().slice(11, 16)]), [['06:00', '09:00'], ['12:00', '13:00']], 'plan: rule windows from the guide');
  const al = plan(A({}), progs, T('06:00'), T('13:00'));
  eq(al.map((x) => [x.start.toISOString().slice(11, 16), x.end.toISOString().slice(11, 16)]), [['06:00', '11:58'], ['12:00', '13:00']], 'plan: always, with the ad break cut out');
  eq(plan(title, progs, T('00:00'), T('23:59')).length, 3, 'plan: one trigger per content programme');
  const clk = plan(A({ run_mode: 'rule', rule: { genre: 'news', from: '07:00', to: '08:30' } }), progs, T('00:00'), T('23:59'));
  eq(clk.map((x) => [x.start.toISOString().slice(11, 16), x.end.toISOString().slice(11, 16)]), [['07:00', '08:30']], 'plan: genre and clock together');
  eq(plan(A({ run_mode: 'manual' }), progs, T('00:00'), T('23:59')), [], 'plan: manual has no windows');
}
eq(describe({ run_mode: 'trigger', rule: { at: 'programme_end', offsetSec: 120, durationSec: 12 }, clear_in_ads: true }), '2 min before each programme ends, for 12 s', 'describe trigger');
eq(describe({ run_mode: 'rule', rule: { genre: 'News' }, clear_in_ads: false }), 'During programmes with genre News, including ad breaks', 'describe rule');

console.log('== values ==');
{
  const feeds = new Map([['feed1', { payload: { score: { home: 21, away: 17 }, players: [{ name: 'Barrett' }] }, stale: false, onStale: 'hold' as const }],
                         ['dead', { payload: { x: 1 }, stale: true, onStale: 'hide' as const }]]);
  const r = resolveValues({
    fields: [{ id: 'home' }, { id: 'hs' }, { id: 'as' }, { id: 'p' }, { id: 'logo' }, { id: 'now' }, { id: 'half' }, { id: 'free' }],
    bindings: {
      home: { source: 'text', value: 'BLUES' }, hs: { source: 'feed', sourceId: 'feed1', path: 'score.home' },
      as: { source: 'feed', sourceId: 'feed1', path: 'score.away' }, p: { source: 'feed', sourceId: 'feed1', path: 'players.0.name' },
      logo: { source: 'image', imageId: 'img1' }, now: { source: 'guide', guide: 'next_title' }, half: { source: 'operator', value: '1ST HALF' },
    },
    stateValues: { as: 99, half: '2ND HALF' }, overrides: [], feeds,
    guide: { now: { title: 'Match', startsAt: T('19:35') }, next: { title: 'Evening Bulletin', startsAt: T('21:45') } },
    imageUrl: (id) => id === 'img1' ? '/library/acct/blues.png' : null,
  });
  eq(r.values, { home: 'BLUES', hs: 21, as: 17, p: 'Barrett', logo: '/library/acct/blues.png', now: 'Evening Bulletin', half: '2ND HALF', free: '' }, 'every source resolves; a feed field ignores a stray value until taken over');
  const o = resolveValues({ fields: [{ id: 'as' }], bindings: { as: { source: 'feed', sourceId: 'feed1', path: 'score.away' } }, stateValues: { as: 18 }, overrides: ['as'], feeds, guide: {}, imageUrl: () => null });
  eq([o.values.as, o.origin.as], [18, 'override'], 'an operator override wins over the feed');
  const h = resolveValues({ fields: [{ id: 'x' }], bindings: { x: { source: 'feed', sourceId: 'dead', path: 'x' } }, stateValues: {}, overrides: [], feeds, guide: {}, imageUrl: () => null });
  eq([h.hidden, h.staleFeeds], [true, ['dead']], 'a stale feed set to hide hides the graphic');
}
eq(pick({ a: [{ b: 2 }] }, 'a.0.b'), 2, 'pick through arrays');
eq(coerce('number', '7'), { ok: true, value: 7 }, 'coerce number');
eq(coerce('number', 'x').ok, false, 'reject non-number');
eq(coerce('color', '#0b3a8a').ok, true, 'colour');
eq(coerce('text', { a: 1 }).ok, false, 'object is not text');

console.log('== rundown ==');
{
  const I = (id: string, position: number, kind: string, status: any = 'ready', extra: any = {}) => ({ id, position, status, cue: { kind, ...extra.cue }, stays_sec: extra.stays ?? null, taken_at: extra.taken ?? null });
  const items = [I('a', 1, 'manual', 'done'), I('b', 2, 'feed', 'ready', { cue: { sourceId: 's', path: 'p' } }), I('c', 3, 'manual'), I('d', 4, 'manual', 'skipped'), I('e', 5, 'manual')];
  eq(nextManual(items as any)?.id, 'c', 'Take next skips automatic and done items');
  eq(nextManual([I('a', 1, 'manual'), I('b', 2, 'manual', 'on_air'), I('c', 3, 'manual')] as any)?.id, 'c', 'Take next continues after what is on air');
  eq(nextManual([I('a', 1, 'manual'), I('b', 2, 'manual', 'done')] as any)?.id, 'a', 'a skipped-over earlier item is still reachable');
  const now = T('19:40');
  const due = dueAutomatic([
    I('t', 1, 'time', 'ready', { cue: { at: new Date(now.getTime() - 30_000).toISOString() } }),
    I('old', 2, 'time', 'ready', { cue: { at: T('18:00').toISOString() } }),
    I('off', 3, 'offset', 'ready', { cue: { fromStartSec: 300 } }),
    I('rep', 4, 'repeat', 'done', { cue: { everySec: 600 }, stays: 15, taken: new Date(now.getTime() - 601_000) }),
    I('rep2', 5, 'repeat', 'done', { cue: { everySec: 600 }, stays: 15, taken: new Date(now.getTime() - 100_000) }),
  ] as any, now, T('19:35'), true).map((x) => x.id);
  eq(due, ['t', 'off', 'rep'], 'due: time within a minute, offset from the start, repeat when the gap has passed');
  eq(dueAutomatic([I('t', 1, 'time', 'ready', { cue: { at: T('19:40').toISOString() } })] as any, now, null, false), [], 'nothing fires while the event is not live');
  const cue = normCue({ kind: 'feed', sourceId: 's', path: 'lastEvent.type', equals: 'try' });
  ok(feedFired(cue, { lastEvent: { type: 'penalty' } }, { lastEvent: { type: 'try' } }, pick), 'feed cue fires on the change to its value');
  ok(!feedFired(cue, { lastEvent: { type: 'try' } }, { lastEvent: { type: 'try' } }, pick), 'and not again while it stays');
  ok(!feedFired(cue, { lastEvent: { type: 'try' } }, { lastEvent: { type: 'card' } }, pick), 'and not for another value');
  throws(() => normCue({ kind: 'repeat', everySec: 5 }), /between 30 seconds/, 'repeat bounds');
  throws(() => normCue({ kind: 'feed' }), /data source/, 'feed cue needs a source');
  const rows = parseCsv('segment,title,setup,cue,stays,values\nPre-match,"Host: Kate Rowe",Presenter super,manual,8,"name=Kate Rowe;title=Host"\n,Starting soon,Countdown,19:20,,\nFirst half,Sponsor,Petronas,every 600,15,\n');
  eq(rows.map((r) => [r.segment, r.title, r.setup, r.cue, r.stays]), [['Pre-match', 'Host: Kate Rowe', 'Presenter super', 'manual', '8'], ['', 'Starting soon', 'Countdown', '19:20', ''], ['First half', 'Sponsor', 'Petronas', 'every 600', '15']], 'CSV rows, quoted cells');
  eq(rows[0].values, { name: 'Kate Rowe', title: 'Host' }, 'CSV values');
  const start = new Date('2026-10-20T09:35:00Z');   // 19:35 in Brisbane
  eq(cueFromText('19:20', start, 'Australia/Brisbane'), { kind: 'time', at: '2026-10-20T09:20:00.000Z' }, 'CSV clock time in the event time zone');
  eq(zonedOn(new Date('2026-10-20T13:30:00Z'), 0, 15, 'Australia/Brisbane').toISOString(), '2026-10-20T14:15:00.000Z', 'a time after midnight lands on the next day');
  eq(cueFromText('+300', start), { kind: 'offset', fromStartSec: 300 }, 'CSV offset');
  throws(() => cueFromText('soon', start), /not manual/, 'CSV bad cue');
}

console.log('== rss ==');
{
  const r = parseRss(`<rss><channel><title>Newsroom</title><item><title><![CDATA[Markets & more]]></title><link>https://x/1</link></item><item><title>Rain &amp; wind</title></item></channel></rss>`);
  eq([r.title, r.items.map((i) => i.title)], ['Newsroom', ['Markets & more', 'Rain & wind']], 'RSS titles, CDATA and entities');
}

console.log('== ograf ==');
{
  const fx = join(__dirname, 'fixtures', 'ograf');
  const pkg = (dir: string, prefix = '') => readdirSync(join(fx, dir)).map((n) => ({ path: prefix + n, data: readFileSync(join(fx, dir, n)) }));
  const lvl = (a: ReturnType<typeof analyse>, id: string) => a.checks.find((c) => c.id === id)?.level;

  const min = analyse(pkg('minimal'));
  eq([min.manifest.contract, min.manifest.manifestFrom, min.manifest.name, min.manifest.ograf?.id, min.manifest.ograf?.main], ['ograf', 'ograf', 'Minimal Test Graphic', 'minimal-example', 'graphic.mjs'], 'EBU minimal: read as OGraf');
  eq(min.manifest.fields.map((f) => [f.id, f.type, f.hidden]), [['message', 'text', undefined]], 'minimal: the schema gives the field (OGraf hidden is only about display names)');
  ok(min.checks.every((c) => c.level === 'ok'), 'minimal: every check ok', JSON.stringify(min.checks.filter((c) => c.level !== 'ok')));
  ok(analyse([...pkg('minimal'), { path: 'x.mjs', data: Buffer.from('const u = new URL(BASE, import.meta.url)') }]).checks.every((c) => c.id !== 'missing'), 'new URL(...) in JavaScript is not a missing file');
  ok(min.publishable && lvl(min, 'ograf') === 'ok' && lvl(min, 'transport') === 'ok', 'minimal: publishable, OGraf and methods ok', JSON.stringify(min.checks.filter((c) => c.level !== 'ok')));
  ok(!min.files.some((f) => f.path === 'index.html'), 'no index.html is stored: the host page is generated');

  // As GitHub's "Download ZIP" or Finder's Compress makes it: one top folder.
  const zipped = analyse(filesFromUpload(writeZip(pkg('scoreboard', 'scoreboard/')), 'scoreboard.zip'));
  ok(zipped.files.some((f) => f.path === 'scoreboard.ograf.json'), 'top folder stripped for an OGraf package');
  const sb = zipped.manifest;
  eq(sb.fields.map((f) => `${f.id}:${f.type}`), ['homeShort:text', 'awayShort:text', 'homeScore:number', 'awayScore:number', 'homeColor:color', 'awayColor:color', 'minute:number', 'seconds:number'], 'scoreboard: fields in schema order, typed (integer, gddType color)');
  eq([sb.fields[0].label, sb.sample.homeShort, sb.sample.homeColor, sb.ograf?.stepCount], ['Home team', 'FCZ', '#005ca9', 5], 'labels and sample from the schema, step count');
  ok(zipped.publishable && /5 steps/.test(zipped.checks.find((c) => c.id === 'transport')?.detail ?? ''), 'scoreboard: publishable, steps explained');
  ok(lvl(zipped, 'network') === 'ok', 'a JSDoc import("https://ograf.ebu.io/...") type is not a network load');
  eq(stripJsComments(`/** @typedef {import("https://x.io/a")} A */\nconst u = "http://keep"; // gone\nfetch('./a.json')`), ` \nconst u = "http://keep"; \nfetch('./a.json')`, 'comment stripping keeps strings');

  // The weather sample's schema: select with labels, an image path, ids with - and spaces.
  const w = fieldsFromSchema({ type: 'object', properties: {
    '_sun-lightning-rain-snow': { type: 'integer', label: 'Weather Icon', default: 0, gddType: 'select', gddOptions: { labels: { 0: 'Sun', 1: 'Storm' } }, enum: [0, 1], order: 1 },
    _image: { type: 'string', label: 'image', default: './lib/images/image_0.jpg', gddType: 'file-path/image-path', gddOptions: { extensions: ['jpg'] } },
    '_Value 1': { type: 'number', default: 205, order: 0 },
    nested: { type: 'object', properties: {} },
    ok: { type: ['boolean', 'null'], title: 'On' },
    bad: { type: 'string', title: 'x' }, '</script>': { type: 'string' },
  } });
  eq(w.fields.map((f) => `${f.id}:${f.type}`), ['_Value 1:number', '_sun-lightning-rain-snow:number', '_image:image', 'ok:boolean', 'bad:text'], 'types, order first, then schema order; unsafe ids dropped');
  eq(w.fields[1].options, [{ value: 0, label: 'Sun' }, { value: 1, label: 'Storm' }], 'enum becomes options with gddOptions labels');
  eq([w.unmapped, w.sample], [['nested', '</script>'], { '_Value 1': 205, '_sun-lightning-rain-snow': 0, _image: './lib/images/image_0.jpg' }], 'objects reported, defaults are the sample');

  const mf = (o: any, extra: { path: string; data: Buffer }[] = [], main = 'export default class G extends HTMLElement { async load(){} async playAction(){} async stopAction(){} async updateAction(){} }') =>
    analyse([{ path: 'g.ograf.json', data: Buffer.from(typeof o === 'string' ? o : JSON.stringify({ $schema: 'https://ograf.ebu.io/v1/specification/json-schemas/graphics/schema.json', id: 'g', name: 'G', main: 'g.mjs', supportsRealTime: true, supportsNonRealTime: false, ...o })) },
      { path: 'g.mjs', data: Buffer.from(main) }, ...extra]);
  ok(mf({}).publishable, 'a hand-written minimal package is publishable');
  ok(lvl(mf('{ nope'), 'manifest') === 'error' && !mf('{ nope').publishable, 'manifest that is not JSON blocks publishing');
  ok(lvl(mf({ main: 'missing.mjs' }), 'entry') === 'error', 'main file not in the package blocks publishing');
  ok(lvl(mf({ supportsRealTime: false, supportsNonRealTime: true }), 'realtime') === 'error', 'a non-real-time-only graphic cannot play live');
  ok(lvl(mf({}, [], 'class G extends HTMLElement {}'), 'export') === 'error', 'no default export blocks publishing');
  ok(lvl(mf({}, [], 'export default class G extends HTMLElement { load(){} playAction(){} stopAction(){} }'), 'transport') === 'warn', 'no updateAction is a warning');
  ok(lvl(mf({ customActions: [{ id: 'highlight', name: 'Highlight' }] }), 'custom') === 'warn', 'custom actions flagged as not driven yet');
  ok(lvl(mf({ renderRequirements: [{ accessToPublicInternet: { exact: true } }] }), 'internet') === 'error', 'needs the internet: blocked');
  const sized = mf({ renderRequirements: [{ resolution: { width: { exact: 1280 }, height: { exact: 720 } }, frameRate: { exact: 50 } }] });
  eq([sized.manifest.canvas, sized.manifest.canvasDeclared, sized.manifest.fps], [[1280, 720], true, 50], 'canvas and frame rate from the render requirements');
  ok(lvl(mf({}, [{ path: 'index.html', data: Buffer.from('<p>demo</p>') }]), 'entry-html') === 'warn', 'an index.html alongside is flagged as unused');
  ok(lvl(mf({}, [{ path: 'other.ograf.json', data: Buffer.from('{}') }]), 'manifests') === 'warn', 'two manifests: the first is used, flagged');
  ok(lvl(mf({}, [], 'export default class G extends HTMLElement { load(){ fetch("https://api.example.com/x") } playAction(){} stopAction(){} updateAction(){} }'), 'network') === 'error', 'a real network load is still caught');

  const page = ografHostPage({ ...sb, name: 'A </script><script>x()' });
  ok(page.includes('"main":"./graphic.mjs"') && page.includes("customElements.define('volt-ograf-graphic'") && page.includes('width:1920px'), 'host page imports main and registers the element');
  ok(!/<\/script><script>x/.test(page), 'the name cannot break out of the host page script');
  ok(/playAction',\{goto:0\}/.test(page) && /playAction',\{delta:1\}/.test(page) && /stopAction/.test(page) && /updateAction/.test(page), 'play, next, stop and update map to the OGraf actions');
  ok(injectBridge(page).indexOf("type!=='volt-gfx'") < page.length, 'the bridge goes into the host page like any template');
}

console.log('== status ==');
{
  const okv = { version: 3, checks: [{ level: 'ok' }, { level: 'warn' }] };
  const badv = { checks: [{ level: 'error', title: 'Loads files from the internet' }, { level: 'error' }] };
  eq(templateStatus(okv, null).state, 'ready', 'published: ready');
  eq(templateStatus(okv, badv).draft, { publishable: false, errors: 2, warnings: 0 }, 'published with a broken draft: still ready, the draft says why not');
  eq([templateStatus(null, okv).state, templateStatus(null, okv).label], ['in_development', 'In development'], 'only a passing draft: in development');
  const inc = templateStatus(null, badv);
  ok(inc.state === 'incomplete' && inc.label === '2 errors' && /internet/.test(inc.detail), 'only a failing draft: incomplete, first error named');
  eq(templateStatus(null, null).state, 'empty', 'nothing: empty');
}

console.log('== style ==');
{
  const dir = join(__dirname, '..', 'assets', 'graphics', 'lower-third');
  const lt = [{ path: 'index.html', data: readFileSync(join(dir, 'index.html')) }, ...readdirSync(join(dir, 'fonts')).map((n) => ({ path: `fonts/${n}`, data: readFileSync(join(dir, 'fonts', n)) }))];
  const r = readStyle(lt);
  const ids = r.tokens.map((t) => t.id);
  ok(ids.includes('var:--bar') && ids.includes('var:--accent') && ids.includes('color:#ffffff') && ids.includes('font:Volt Serif') && ids.includes('font:Volt Sans'), 'name super: theme variables, colours and both families found', ids.join());
  eq(r.fonts.filter((f) => f.bundled).map((f) => f.family), ['Volt Sans', 'Volt Serif'], 'bundled families from @font-face');
  const out = applyStyle(lt, { 'var:--bar': '#123456', 'color:#ffffff': '#fafafa', 'font:Volt Serif': 'Volt Sans' });
  const h = out.find((f) => f.path === 'index.html')!.data.toString();
  ok(/--bar:#123456/.test(h) && !/#fff\b/i.test(h.replace(/--[\w-]+:[^;}]*/g, '')) && h.includes('#fafafa'), 'variable and every #fff / #ffffff literal changed');
  ok((h.match(/Volt Serif/g) ?? []).length === 2 && /font:600 52px\/1 "Volt Sans"/.test(h), 'font shorthand swapped; @font-face rules untouched');
  ok(analyse(out).publishable, 'the restyled package still passes its checks');

  const page = (html: string, js = '') => [{ path: 'index.html', data: Buffer.from(html) }, ...(js ? [{ path: 'g.js', data: Buffer.from(js) }] : [])];
  const tricky = page(`<style>#ab1{color:#ab1} .x{background:url(#fff)} a{color:rgb(10, 20, 30)}</style><a href="#bad">x</a><p style="font-family:Arial, sans-serif;color:#0A0">t</p>`,
    `el.style.fontFamily = 'Arial'; el.style.color = "#00aa00"; ctx.font = "bold 40px Arial";`);
  const t2 = readStyle(tricky);
  eq(t2.tokens.filter((t) => t.kind === 'color').map((t) => `${t.value}x${t.uses}`).sort(), ['#00aa00x2', '#aabb11x1', 'rgb(10, 20, 30)x1'], 'id selectors, url(#id) and href="#x" are not colours; #0A0 and #00aa00 are one');
  eq(t2.tokens.find((t) => t.id === 'font:Arial')?.uses, 2, 'CSS inline style and script fontFamily counted (canvas ctx.font is not CSS)');
  const o2 = applyStyle(tricky, { 'font:Arial': 'Brand Sans', 'color:#00aa00': '#ff0000' }, [{ family: 'Brand Sans', filename: 'brand.woff2', data: Buffer.from('wOF2') }]);
  const h2 = o2.find((f) => f.path === 'index.html')!.data.toString(); const j2 = o2.find((f) => f.path === 'g.js')!.data.toString();
  ok(h2.includes('style="font-family:Brand Sans, sans-serif;color:#ff0000"') && j2.includes(`fontFamily = 'Brand Sans'`) && j2.includes('"#ff0000"'), 'swaps keep HTML attributes and script strings valid', h2 + ' | ' + j2);
  ok(h2.includes('href="#bad"') && h2.includes('url(#fff)') && h2.includes('#ab1{'), 'non-colours left alone');
  ok(o2.some((f) => f.path === 'fonts/brand-sans.woff2') && /@font-face\{font-family:"Brand Sans";src:url\("fonts\/brand-sans.woff2"\) format\("woff2"\)/.test(o2.find((f) => f.path === 'volt-fonts.css')!.data.toString()) && h2.includes('<link rel="stylesheet" href="volt-fonts.css">'), 'added font: file, @font-face and link');
  throws(() => applyStyle(tricky, { 'font:Arial': 'Nope Font' }), /not a font in this template/, 'an unknown family is refused');
  throws(() => applyStyle(tricky, { 'color:#00aa00': 'red; } body{display:none' }), /not a colour/, 'a colour value cannot inject CSS');
  throws(() => applyStyle(tricky, { 'color:#123123': '#000' }), /Nothing called/, 'a stale token id is an error, not a silent no-op');
  throws(() => applyStyle(tricky, {}, [{ family: 'x"}', filename: 'a.woff2', data: Buffer.from('') }]), /not a usable font name/, 'font names are sanitised');
  const vendor = readStyle([{ path: 'index.html', data: Buffer.from('<p>x</p>') }, { path: 'lib/gsap.min.js', data: Buffer.from('a="#123456"') }]);
  eq(vendor.tokens.length, 0, 'bundled libraries are not scanned');
  eq(normColor('#FFFF'), '#ffffff', 'short hex with alpha ff is the plain colour');

  // OGraf: colours set from the module, fonts reach the host page.
  const fx = join(__dirname, 'fixtures', 'ograf', 'scoreboard');
  const sbFiles = readdirSync(fx).map((n) => ({ path: n, data: readFileSync(join(fx, n)) }));
  const sbStyle = readStyle(sbFiles);
  ok(sbStyle.tokens.some((t) => t.kind === 'color'), 'OGraf scoreboard: colours found in graphic.mjs', String(sbStyle.tokens.length));
  const sbOut = applyStyle(sbFiles, {}, [{ family: 'Brand Sans', filename: 'b.woff2', data: Buffer.from('wOF2') }]);
  const sbA = analyse(sbOut);
  ok(sbA.manifest.ograf?.css?.[0] === 'volt-fonts.css' && ografHostPage(sbA.manifest).includes('<link rel="stylesheet" href="./volt-fonts.css">'), 'OGraf: an added font is linked from the host page');
  ok(BRIDGE.includes("m.op==='probe'") && BRIDGE.includes('volt-gfx-probe'), 'bridge answers a probe: does the template draw anything');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
