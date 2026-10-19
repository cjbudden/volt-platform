// Fails if anything on scrub.json's banned list appears in the given files or
// folders. Run on the sources (npm run check) and on the built site (npm run
// build does it last), so a term cannot slip in through generated content.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, extname, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(dirname(fileURLToPath(import.meta.url)));
const cfg = JSON.parse(readFileSync(join(here, 'scrub.json'), 'utf8'));
const banned = cfg.banned.map((b) => ({ re: new RegExp(b.pattern, 'gi'), why: b.why, pattern: b.pattern }));
const targets = process.argv.slice(2).length ? process.argv.slice(2) : ['docs', 'release-notes'];

function* files(p) {
  if (!existsSync(p)) return;
  if (statSync(p).isDirectory()) {
    for (const f of readdirSync(p)) {
      if (f === 'node_modules' || f === 'vendor' || f === 'assets') continue;
      yield* files(join(p, f));
    }
  } else if (cfg.scan.includes(extname(p))) yield p;
}

let hits = 0;
for (const t of targets) {
  for (const f of files(join(here, t))) {
    const text = readFileSync(f, 'utf8');
    for (const b of banned) {
      b.re.lastIndex = 0;
      let m;
      while ((m = b.re.exec(text))) {
        hits++;
        const line = text.slice(0, m.index).split('\n').length;
        if (hits <= 50) console.error(`  ${relative(here, f)}:${line}  "${m[0]}"  (${b.why})`);
      }
    }
  }
}
if (hits) {
  console.error(`scrub check: ${hits} banned term(s) found. Reword the page, or for generated content add a 'replace' rule in scrub.json.`);
  process.exit(1);
}
console.log(`scrub check: clean (${targets.join(', ')})`);
