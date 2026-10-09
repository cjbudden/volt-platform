// Render volt_build_status.html FROM VOLT_BUILD_STATUS.md, so the board and the
// markdown can never drift apart again. Run: node scripts/build-status.mjs
//
// It reads the "## n. Section" headings and every | capability | status | notes |
// table row, maps the status emoji to a label + colour, and writes the same
// filterable single-file page as before.
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dir, '..');
const md = await readFile(path.join(root, 'VOLT_BUILD_STATUS.md'), 'utf8');

const STATUS = [
  { emoji: '✅', label: '✅ Built', key: 'Built', color: '#16a34a' },
  { emoji: '🟡', label: '🟡 Partial', key: 'Partial', color: '#d97706' },
  { emoji: '🧪', label: '🧪 Prototype', key: 'Prototype', color: '#0891b2' },
  { emoji: '📐', label: '📐 Designed', key: 'Designed', color: '#6366f1' },
  { emoji: '❌', label: '❌ Not started', key: 'Not started', color: '#dc2626' },
];
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// markdown inline -> plain text: the board reads better without backticks/bold
const plain = (s) => String(s ?? '')
  .replace(/`([^`]*)`/g, '$1')
  .replace(/\*\*([^*]*)\*\*/g, '$1')
  .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  // Strikethrough. A superseded row is deliberately struck in the markdown, and
  // without this the tildes render literally as `~~Admin prototype~~`, which
  // reads as a typo on the page rather than as "this was replaced".
  .replace(/~~([^~]*)~~/g, '$1')
  // Single-asterisk emphasis, after the double-asterisk pass above so bold is
  // not left with one orphan asterisk each side.
  .replace(/(^|[^*])\*([^*]+)\*/g, '$1$2')
  .trim();

const sections = [];
let current = null;
for (const line of md.split(/\r?\n/)) {
  const h = line.match(/^##\s+(?:\d+\.\s*)?(.+?)\s*$/);
  if (h) { current = { title: plain(h[1]), rows: [], isCapTable: false }; sections.push(current); continue; }
  if (!current || !line.startsWith('|')) continue;
  const cells = line.split('|').slice(1, -1).map((c) => c.trim());
  if (cells.length < 3) continue;
  if (/^-+:?$/.test(cells[0].replace(/[\s:]/g, '-'))) continue;   // separator row
  // A CAPABILITY TABLE IS ONE THAT SAYS SO. Any pipe table under any heading
  // used to be counted, so a narrative table that happens to mention a status
  // emoji in its second column was silently folded into the totals -- which is
  // how the 5 Sep prototype sweep, a table ABOUT the statuses, added six
  // phantom capabilities and pushed Prototype from 1 back up to 7. The header
  // row now arms the parser and anything before it is prose.
  if (/^capability$/i.test(cells[0])) { current.isCapTable = true; continue; }
  if (!current.isCapTable) continue;
  const st = STATUS.find((s) => cells[1].includes(s.emoji));
  if (!st) continue;
  current.rows.push({ cap: plain(cells[0]), notes: plain(cells.slice(2).join(' | ')), st });
}

const all = sections.flatMap((s) => s.rows);
const counts = STATUS.map((s) => ({ ...s, n: all.filter((r) => r.st.key === s.key).length })).filter((s) => s.n);

const body = sections.filter((s) => s.rows.length).map((s) =>
  `<section><h2>${esc(s.title)}</h2>` + s.rows.map((r) =>
    `<div class="row" data-s="${esc(r.st.key)}"><span class="pill" style="background:${r.st.color}">${r.st.label}</span>` +
    `<div class="cap">${esc(r.cap)}<span class="notes">${esc(r.notes)}</span></div></div>`
  ).join('') + `</section>`
).join('');

const html = `<!doctype html><html lang=en><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Volt Streaming — Design vs Build Status</title><style>
 :root{--bg:#0b0c10;--card:#14161d;--ink:#e7e9ee;--mut:#98a0ad;--line:#242833}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 Inter,system-ui,Segoe UI,Roboto,sans-serif}header{position:sticky;top:0;z-index:5;background:#0b0c10ee;backdrop-filter:blur(6px);border-bottom:1px solid var(--line);padding:16px 22px}h1{margin:0 0 3px;font-size:18px}h1 span{color:#818cf8}.sub{color:var(--mut);font-size:12px;margin-bottom:10px}.chips{display:flex;gap:8px;flex-wrap:wrap}.chip{cursor:pointer;border:1px solid var(--line);background:#10131a;color:var(--ink);padding:5px 11px;border-radius:20px;font-size:12px}.chip b{color:#fff}.chip.off{opacity:.35}.wrap{max-width:960px;margin:0 auto;padding:14px 22px 80px}section{margin:18px 0}h2{font-size:14px;color:#c7cbd4;margin:0 0 8px}.row{display:flex;gap:12px;align-items:flex-start;background:var(--card);border:1px solid var(--line);border-radius:9px;padding:10px 13px;margin:7px 0}.pill{color:#fff;font-size:11px;font-weight:600;padding:2px 9px;border-radius:20px;white-space:nowrap;min-width:96px;text-align:center}.cap{font-size:13.5px}.notes{display:block;color:var(--mut);font-size:12px;margin-top:2px}</style></head><body>
<header><h1><span>⚡</span> Volt Streaming — Design vs Build Status</h1><div class=sub>${all.length} capabilities · generated from VOLT_BUILD_STATUS.md · click a status to filter</div><div class=chips>${counts.map((c) => `<button class="chip" data-f="${esc(c.key)}"><b>${c.n}</b> ${esc(c.key)}</button>`).join('')}</div></header>
<div class=wrap>${body}</div>
<script>const chips=[...document.querySelectorAll('.chip')];let active=null;function apply(){document.querySelectorAll('.row').forEach(r=>r.style.display=(!active||r.dataset.s===active)?'':'none');document.querySelectorAll('section').forEach(s=>{const any=[...s.querySelectorAll('.row')].some(r=>r.style.display!=='none');s.style.display=any?'':'none';});chips.forEach(c=>c.classList.toggle('off',active&&c.dataset.f!==active));}chips.forEach(c=>c.onclick=()=>{active=active===c.dataset.f?null:c.dataset.f;apply();});apply();</script></body></html>`;

await writeFile(path.join(root, 'volt_build_status.html'), html);
console.log(`volt_build_status.html written — ${all.length} capabilities`, Object.fromEntries(counts.map((c) => [c.key, c.n])));
