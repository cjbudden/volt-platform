// Render the Product Feature Tracker (test + approve workflow) from features.json.
// Separate from, and complementary to, the build status board: the build status is
// "what's built"; this is "what you can test and sign off". Approve / request-changes
// buttons copy a ready-to-paste chat message (artifacts can't persist clicks), and
// the source of truth is features.json which I update as you approve or give feedback.
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const data = JSON.parse(await readFile(path.join(__dir, 'features.json'), 'utf8'));

const STATUS = {
  building:          { label: '🔨 Building',          color: '#64748b', hint: 'not ready to test yet' },
  ready_to_test:     { label: '🧪 Ready to test',     color: '#0891b2', hint: 'testable now — your review needed' },
  in_review:         { label: '👀 In review',         color: '#6366f1', hint: 'available to review' },
  approved:          { label: '✅ Approved',           color: '#16a34a', hint: 'you confirmed this works' },
  changes_requested: { label: '🔁 Changes requested', color: '#f59e0b', hint: 'feedback logged — back to build' },
};
const ORDER = ['ready_to_test', 'in_review', 'changes_requested', 'approved', 'building'];
const counts = {};
for (const f of data.features) counts[f.status] = (counts[f.status] || 0) + 1;
const feats = [...data.features].sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status));

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const card = (f) => {
  const s = STATUS[f.status] || STATUS.building;
  const fb = (f.feedback || []).map(x => `<div class=fb>• ${esc(x.date)}: ${esc(x.note)}</div>`).join('');
  const artifact = f.test.artifact ? `<div class=note>Test tool: open <b>“${esc(f.test.artifact)}”</b> in your artifacts gallery.</div>` : '';
  const canApprove = f.status === 'ready_to_test' || f.status === 'in_review' || f.status === 'changes_requested';
  const actions = canApprove
    ? `<div class=actions>
         <button class="btn ok" data-approve="${esc(f.name)}">✓ Approve as working</button>
         <button class="btn warn" data-changes="${esc(f.name)}">Request changes</button>
       </div>`
    : (f.status === 'approved' ? `<div class=approved-line>✅ Approved by you</div>` : '');
  const APP = {
    full:    { label: '📱 In app',              color: '#2563eb' },
    partial: { label: '📱 Partial in app',      color: '#7c3aed' },
    none:    { label: '⚙︎ Backend only — not in app', color: '#6b7280' },
    na:      { label: '— no UI needed',          color: '#3f4656' },
    pending: { label: '⏳ Not built yet',        color: '#6b7280' },
  };
  const a = APP[f.app_surface] || APP.none;
  return `<div class=card data-status="${f.status}" data-app="${esc(f.app_surface || 'none')}">
    <div class=top><div class=name>${esc(f.name)}</div>
      <span class=pill style="background:${s.color}">${s.label}</span>
      <span class=apill style="border-color:${a.color};color:${a.color}">${a.label}</span></div>
    <div class=summary>${esc(f.summary)}</div>
    <div class=meta>${esc(f.checks || '')}</div>
    <div class=how><b>How to test:</b> ${esc(f.test.how)}</div>
    ${artifact}
    ${actions}
    ${fb ? `<div class=fblog>${fb}</div>` : ''}
  </div>`;
};

const chips = ORDER.filter(k => counts[k]).map(k =>
  `<span class=chip style="border-color:${STATUS[k].color}"><b>${counts[k]}</b> ${STATUS[k].label}</span>`).join('');

// app-surfacing coverage: which built features are actually in the app yet
const appCounts = {};
for (const f of data.features) appCounts[f.app_surface || 'none'] = (appCounts[f.app_surface || 'none'] || 0) + 1;
const APPLBL = { full: '📱 In app', partial: '📱 Partial', none: '⚙︎ Backend only', na: '— no UI', pending: '⏳ Not built' };
const appChips = ['full', 'partial', 'none', 'na', 'pending'].filter(k => appCounts[k]).map(k =>
  `<span class=chip><b>${appCounts[k]}</b> ${APPLBL[k]}</span>`).join('');

const html = `<!doctype html><html lang=en><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>Volt — Product Feature Tracker</title><style>
 :root{--bg:#0b0c10;--card:#14161d;--ink:#e7e9ee;--mut:#98a0ad;--line:#242833}
 *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 Inter,system-ui,Segoe UI,Roboto,sans-serif}
 .wrap{max-width:920px;margin:0 auto;padding:22px 22px 80px}
 h1{font-size:19px;margin:0 0 2px}h1 span{color:#818cf8}
 .sub{color:var(--mut);font-size:12px;margin-bottom:12px}
 .chips{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px}
 .chip{border:1px solid var(--line);background:#10131a;border-radius:20px;padding:5px 11px;font-size:12px;color:var(--ink)}
 .how-to{background:#101827;border:1px solid #1e2b45;border-radius:10px;padding:11px 14px;color:#cdd7ea;font-size:12.5px;margin:12px 0 18px}
 .card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:15px 16px;margin:12px 0}
 .top{display:flex;justify-content:space-between;align-items:center;gap:12px}
 .name{font-weight:700;font-size:15.5px}
 .pill{color:#fff;font-size:11px;font-weight:700;padding:3px 10px;border-radius:20px;white-space:nowrap}
 .apill{border:1px solid;background:transparent;font-size:10.5px;font-weight:700;padding:3px 9px;border-radius:20px;white-space:nowrap}
 .summary{color:#cdd2db;font-size:13px;margin:6px 0}
 .meta{color:var(--mut);font-size:12px}
 .how{font-size:12.5px;margin-top:8px;color:#cdd2db}
 .note{font-size:12px;color:var(--mut);margin-top:6px}
 .actions{display:flex;gap:8px;margin-top:12px;flex-wrap:wrap}
 .btn{border:0;border-radius:9px;padding:9px 14px;font-weight:600;cursor:pointer;font-size:13px}
 .btn.ok{background:#16a34a;color:#fff}.btn.warn{background:#10131a;border:1px solid #f59e0b;color:#f59e0b}
 .approved-line{color:#22c55e;font-weight:600;margin-top:10px}
 .fblog{margin-top:10px;border-top:1px solid var(--line);padding-top:8px}.fb{color:var(--mut);font-size:12px}
 #toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);background:#16a34a;color:#fff;padding:10px 16px;border-radius:10px;font-size:13px;opacity:0;transition:opacity .2s;pointer-events:none}
 #toast.show{opacity:1}
</style></head><body>
<div class=wrap>
 <h1><svg class="vmark" viewBox="0 0 24 24" width="1em" height="1em" style="vertical-align:-0.12em" aria-hidden="true"><defs><linearGradient id="vmk" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#5b8cff"/><stop offset="1" stop-color="#4f46e5"/></linearGradient></defs><path fill="url(#vmk)" d="M14 1 3.5 14H11zM10 23 20.5 10H13z"/></svg> Volt — Product Feature Tracker</h1>
 <div class=sub>Separate from the build status. This is what you can test and sign off. Updated ${esc(data.updated)}.</div>
 ${data.note ? `<div class=sub>${esc(data.note)}</div>` : ''}
 <div class=chips>${chips}</div>
 <div class=chips style="margin-bottom:12px">${appChips}</div>
 <div class=how-to><b>How this works:</b> features marked <b>Ready to test</b> have a way to try them (below each). When one works, click <b>Approve</b> (it copies a short message — paste it to me in chat) or just tell me “<i>&lt;feature&gt; passed</i>”. If something’s off, click <b>Request changes</b> or tell me what’s wrong. The second badge row shows <b>app surfacing</b>: <b>In app</b> = usable in the new app now; <b>Backend only</b> = built + tested at the API level but not yet wired into the app (tracked so it isn’t lost). I keep this current as we build, and if we ever formally drop something I remove it here and in the build status.</div>
 ${feats.map(card).join('')}
</div>
<div id=toast></div>
<script>
function toast(t){var el=document.getElementById('toast');el.textContent=t;el.className='show';setTimeout(function(){el.className=''},2200);}
function copy(t){if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(t).then(function(){toast('Copied — paste into chat: '+t)},function(){toast('Say in chat: '+t)});}else{toast('Say in chat: '+t);}}
document.querySelectorAll('[data-approve]').forEach(function(b){b.onclick=function(){copy('Approve: '+b.getAttribute('data-approve'));};});
document.querySelectorAll('[data-changes]').forEach(function(b){b.onclick=function(){copy('Changes: '+b.getAttribute('data-changes')+' — ');};});
</script>
</body></html>`;

await writeFile(path.join(__dir, 'tracker.html'), html);
console.log('tracker.html written — ' + data.features.length + ' features; ' + JSON.stringify(counts));
