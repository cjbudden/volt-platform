#!/usr/bin/env node
// Add a change note. One note per customer-visible change, written in the
// customer's words: what they will notice, not how it was done.
//
//   node scripts/release/change.mjs --scope core --type fixed --area EPG "Add EPG on a channel now opens that channel's guide."
//   node scripts/release/change.mjs --scope internal --type changed "Refactor of the recording index; no visible change."
//   node scripts/release/change.mjs list
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { UNRELEASED, SCOPES, TYPES, unreleasedNotes, parseNote } from './lib.mjs';

const args = process.argv.slice(2);
if (args[0] === 'list') {
  const notes = unreleasedNotes();
  if (!notes.length) console.log('No unreleased change notes.');
  for (const n of notes) console.log(`${n.scope.padEnd(8)} ${n.type.padEnd(9)} ${n.area ? `[${n.area}] ` : ''}${n.body.split('\n')[0]}`);
  process.exit(0);
}
const opt = (k) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
const scope = opt('scope'), type = opt('type'), area = opt('area') ?? '';
const body = args.join(' ').trim();
if (!SCOPES.includes(scope) || !TYPES.includes(type) || !body) {
  console.error(`usage: change.mjs --scope ${SCOPES.join('|')} --type ${TYPES.join('|')} [--area Area] "What changed, in the customer's words."`);
  process.exit(2);
}
mkdirSync(UNRELEASED, { recursive: true });
const date = new Date().toLocaleDateString('en-CA') /* local date, YYYY-MM-DD */;
const slug = body.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
let file = join(UNRELEASED, `${date}-${slug}.md`);
for (let i = 2; existsSync(file); i++) file = join(UNRELEASED, `${date}-${slug}-${i}.md`);
writeFileSync(file, `---\nscope: ${scope}\ntype: ${type}\n${area ? `area: ${area}\n` : ''}---\n${body}\n`);
parseNote(file);
console.log(`added ${file.slice(file.indexOf('changes/'))}`);
