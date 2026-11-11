// ============================================================================
//  FIND DETAILS: SEARCH THE WEB (build queue F3).
//
//  The free option only (Christian, 11 Nov 2026): "Search the web" opens a web
//  search in a new tab with the term filled in (the title field's value by
//  default, the same box as the Wikidata search), and the person pastes a
//  result's link back into "Or paste a link", which F2 reads. No paid search
//  service, no setting and no key. This pins:
//    1. the address: the term encoded as one query, whitespace folded, cut to
//       a sane length, and nothing at all for an empty term;
//    2. the console wires it: the button is in Find details, opens a new tab
//       without handing the page to it (noopener), takes its term from the
//       same box as Search, and points the person at the paste field;
//    3. the server side stays out of it: no search route, no search provider
//       setting or key anywhere in the API's source.
//  The browser check (the tab really opens with the term, the paste field
//  then reads the page as in F2) is recorded in VOLT_BUILD_STATUS.md, F3.
//
//  Usage: npx tsx test/find-details-web.check.ts     (no database)
// ============================================================================
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { webSearchUrl, WEB_SEARCH_MAX } from '../../volt-web/src/pages/vod/webSearch';

let pass = 0, fail = 0;
const ok = (c: unknown, m: string, d?: unknown) => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log(`FAIL ${m}${d !== undefined ? ' -- ' + JSON.stringify(d).slice(0, 400) : ''}`); } };
const q = (u: string | null) => (u ? new URL(u).searchParams.get('q') : null);

console.log('== 1. the address ==');
const u = webSearchUrl('Nosferatu');
ok(u === 'https://www.google.com/search?q=Nosferatu', 'a title becomes a web search for exactly that', u);
ok(new URL(u!).protocol === 'https:', 'over https');
const amp = webSearchUrl('Tom & Jerry: 100% #1 / part?2');
ok(q(amp) === 'Tom & Jerry: 100% #1 / part?2', 'characters that mean something in an address stay part of the term', amp);
ok(new URL(amp!).searchParams.size === 1, 'and the term is one query, nothing split off it', amp);
ok(q(webSearchUrl('  Das   Cabinet\tdes\nDr. Caligari  ')) === 'Das Cabinet des Dr. Caligari', 'spaces, tabs and new lines fold to single spaces');
ok(q(webSearchUrl('Amélie 東京物語')) === 'Amélie 東京物語', 'accents and other scripts come through unchanged');
ok(webSearchUrl('') === null && webSearchUrl('   ') === null && webSearchUrl(null) === null && webSearchUrl(undefined) === null, 'nothing to search for gives no address');
const long = webSearchUrl('x'.repeat(5000));
ok(q(long)!.length === WEB_SEARCH_MAX, `a very long term is cut to ${WEB_SEARCH_MAX} characters`, q(long)?.length);

console.log('== 2. the console ==');
const ui = readFileSync(join(__dirname, '../../volt-web/src/pages/vod/DetailsFinder.tsx'), 'utf8');
ok(/import \{ webSearchUrl \} from '\.\/webSearch'/.test(ui), 'Find details uses the one address builder');
ok(/>\s*<ExtIcon \/> Search the web<\/button>/.test(ui), 'a Search the web button, with its icon beside the words');
ok(/window\.open\(to, '_blank', 'noopener,noreferrer'\)/.test(ui), 'it opens a new tab that cannot reach back into Volt');
ok(/webSearchUrl\(q\)/.test(ui) && /useState\(term\)/.test(ui), 'from the same box as Search, which starts with the title field\'s value');
ok(/disabled=\{!webSearchUrl\(q\)\}/.test(ui), 'and it is off while the box is empty');
ok(/linkRef\.current\?\.focus\(\)/.test(ui) && /ref=\{linkRef\}/.test(ui), 'the paste field is ready for the link afterwards');
ok(/paste it here/.test(ui), 'and the person is told where the result\'s link goes');
ok(!/apiRequest\([^)]*search/i.test(ui.replace(/details\/find/g, '')), 'no request to Volt for the web search');

console.log('== 3. no search service on the server ==');
const files: string[] = [];
const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (/\.(ts|js)$/.test(f)) files.push(p); } };
walk(join(__dirname, '../src'));
const paid = /(SERPAPI|BING_SEARCH|BRAVE_SEARCH|GOOGLE_CSE|CUSTOMSEARCH|WEB_SEARCH_(KEY|API|PROVIDER))/;
const hits = files.filter((f) => paid.test(readFileSync(f, 'utf8')));
ok(files.length > 50 && hits.length === 0, `no search provider setting or key in the API's ${files.length} source files`, hits);
const routes = readFileSync(join(__dirname, '../docs/openapi.json'), 'utf8');
ok(!/"\/api\/vod\/\{id\}\/details\/(web|search)/.test(routes), 'and no web search route');

console.log(`\nfind-details-web: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
