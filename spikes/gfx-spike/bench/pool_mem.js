// Memory: one Chromium per binding vs one shared Chromium with N pages.
const fs = require('fs');
const { chromium } = require('playwright-core');
const { findChrome } = require('../sidecar/renderer');
function tree(pid) {
  const kids = {};
  for (const d of fs.readdirSync('/proc')) if (/^\d+$/.test(d)) { try { const pp = +fs.readFileSync(`/proc/${d}/stat`, 'utf8').split(') ')[1].split(' ')[1]; (kids[pp] ||= []).push(+d); } catch (_) {} }
  const out = [], st = [pid]; while (st.length) { const p = st.pop(); out.push(p); st.push(...(kids[p] || [])); } return out;
}
function pss(pids) { let t = 0; for (const p of pids) { try { const m = fs.readFileSync(`/proc/${p}/smaps_rollup`, 'utf8').match(/^Pss:\s+(\d+)/m); if (m) t += +m[1]; } catch (_) {} } return Math.round(t / 1024); }
(async () => {
  const url = 'file://' + require('path').resolve(__dirname, '../templates/scorebug/index.html') + '?preview';
  for (const n of [1, 4, 8]) {
    const b = await chromium.launch({ executablePath: findChrome(), args: ['--disable-gpu', '--disable-frame-rate-limit'] });
    for (let i = 0; i < n; i++) { const c = await b.newContext({ viewport: { width: 1920, height: 1080 } }); const p = await c.newPage(); await p.goto(url); }
    await new Promise(r => setTimeout(r, 2000));
    const v = pss(tree(process.pid)) ;
    console.log(JSON.stringify({ sharedBrowser: true, pages: n, pss_mb_incl_node: v, per_page: Math.round(v / n) }));
    await b.close();
  }
})();
