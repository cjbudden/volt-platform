// ============================================================================
//  VIEW AS A COUNTRY: services/edgeViewAs.ts must decide exactly as the
//  deployed CloudFront Function (deploy/edge/rights-viewer-request.js).
//  The function's own decide() is read from the file and run beside ours over
//  a grid of rules, countries and times. Usage: npx tsx test/edge-viewas.check.ts
// ============================================================================
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decide, explain, ruleCountries } from '../src/services/edgeViewAs';

let pass = 0, fail = 0;
const ok = (c: unknown, m: string, d?: unknown) => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log('FAIL ' + m + (d !== undefined ? ` -- ${JSON.stringify(d)}` : '')); } };

const src = readFileSync(join(__dirname, '../../deploy/edge/rights-viewer-request.js'), 'utf8');
const body = src.slice(src.indexOf('function listStops'), src.indexOf('function blocked'));
// eslint-disable-next-line no-new-func
const edgeDecide = new Function(`${body}; return decide;`)() as (r: any, cc: string, now: number) => string;

const now = 1_800_000_000;
const rules: any[] = [
  null,
  { v: 1 },
  { v: 1, a: ['b', ['CN']] },
  { v: 1, c: ['a', ['MY', 'SG']] },
  { v: 1, w: [[now - 60, now + 60, 'b', ['AU'], 1]], rp: 1 },
  { v: 1, w: [[now - 60, now + 60, 'a', ['MY'], 0]] },
  { v: 1, w: [[now + 60, now + 120, 'b', ['AU'], 1]] },
  { v: 1, a: ['b', ['US']], c: ['a', ['MY', 'AU', 'US']], w: [[now - 1, now + 1, 'b', ['AU'], 1]] },
];
let same = 0, total = 0;
for (const r of rules) for (const cc of ['', 'MY', 'SG', 'AU', 'US', 'CN', 'GB']) for (const t of [now - 100, now, now + 90]) {
  total++;
  if (decide(r, cc, t) === edgeDecide(r, cc, t)) same++;
  else console.log('  differs', JSON.stringify(r), cc, t, decide(r, cc, t), edgeDecide(r, cc, t));
}
ok(same === total, `same decision as the CloudFront Function in all ${total} cases`, { same, total });

const e = explain({ v: 1, w: [[now - 60, now + 600, 'b', ['AU'], 1]], rp: 1 } as any, 'AU', now);
ok(e.decision === 'replace' && e.until === now + 600 && /replaced/.test(e.reason), 'explain says replaced, why and until when', e);
const m = explain({ v: 1, w: [[now - 60, now + 600, 'b', ['AU'], 1]] } as any, 'MY', now);
ok(m.decision === 'allow' && /can watch/.test(m.reason), 'another country is allowed', m);
ok(explain(null, 'AU', now).reason === 'no geo rules on this stream', 'no rules says so');
ok(JSON.stringify(ruleCountries({ v: 1, a: ['b', ['CN']], c: ['a', ['MY', 'SG']], w: [[0, 1, 'b', ['AU'], 1]] } as any)) === '["AU","CN","MY","SG"]', 'countries the rules name, sorted');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
