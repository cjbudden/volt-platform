// Build a self-contained interactive validator: run the REAL sharp service over a
// full cross-product of controls, embed each true output (webp) + its real metadata,
// and wrap it in an offline HTML playground. Every image the user sees is an actual
// service render, so it validates the API contract without a running server.
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { parseImageUrl } from './src/parse.mjs';
import { renderImage } from './src/render.mjs';

const src = await readFile('media/live_channel/TV1.png');
const KEY = 'live_channel/TV1.png';

// controls exposed in the UI
const fits = ['fit-in', 'fill', 'stretch'];
const sizes = ['500x500', '0x600', '640x360'];
const foci = ['center', 'top-right', 'smart'];
const filters = ['none', 'sharpen:100', 'grayscale', 'blur:6'];

function buildUrl(fit, size, focus, filter) {
  const fl = [];
  if (fit === 'fill' && focus !== 'center') fl.push(`focus:${focus}`);
  if (filter !== 'none') fl.push(filter);
  fl.push('format:webp'); // previews embedded as webp for size; metadata stays truthful
  return `/${fit}/${size}/filter(${fl.join(',')})/${KEY}`;
}

const manifest = {};
let count = 0, totalBytes = 0;
for (const fit of fits) {
  const focusSet = fit === 'fill' ? foci : ['center'];
  for (const size of sizes) {
    for (const focus of focusSet) {
      for (const filter of filters) {
        const url = buildUrl(fit, size, focus, filter);
        const spec = parseImageUrl(url);
        const out = await renderImage(src, spec);
        const b64 = out.buffer.toString('base64');
        manifest[`${fit}|${size}|${focus}|${filter}`] = {
          url, w: out.width, h: out.height, bytes: out.buffer.length, fmt: out.format, b64,
        };
        count++; totalBytes += out.buffer.length;
      }
    }
  }
}

// source reference thumb
const thumb = await renderImage(src, parseImageUrl(`/fit-in/520x0/filter(format:webp)/${KEY}`));
const thumbB64 = thumb.buffer.toString('base64');

// format demo: same request in png / webp / avif -> real byte counts
const fmtDemo = {};
for (const f of ['png', 'webp', 'avif']) {
  const o = await renderImage(src, parseImageUrl(`/fill/600x600/filter(format:${f})/${KEY}`));
  fmtDemo[f] = { bytes: o.buffer.length, w: o.width, h: o.height };
}

// real assertion results from test.mjs
let checks = [];
try {
  const out = execFileSync('node', ['test.mjs'], { encoding: 'utf8' });
  checks = out.split('\n').filter(l => l.startsWith('PASS ') || l.startsWith('FAIL '))
    .map(l => ({ ok: l.startsWith('PASS'), text: l.slice(5) }));
} catch (e) { checks = [{ ok: false, text: 'test run failed' }]; }
const passN = checks.filter(c => c.ok).length;

const DATA = { manifest, fits, sizes, foci, filters, thumbB64, fmtDemo, checks, passN, count, totalKB: Math.round(totalBytes / 1024) };

const html = `<!doctype html><html lang=en><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>Volt — Image API validator</title>
<style>
 :root{--bg:#0b0c10;--card:#14161d;--ink:#e7e9ee;--mut:#98a0ad;--line:#242833;--brand:#2563eb;--ok:#22c55e;--miss:#f59e0b}
 *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 Inter,system-ui,Segoe UI,Roboto,sans-serif}
 .wrap{max-width:1080px;margin:0 auto;padding:22px}
 h1{font-size:18px;margin:0 0 2px}h1 span{color:#818cf8}.sub{color:var(--mut);font-size:12px;margin-bottom:16px}
 .cols{display:grid;grid-template-columns:300px 1fr;gap:18px}@media(max-width:820px){.cols{grid-template-columns:1fr}}
 .card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px;margin-bottom:14px}
 .lbl{color:var(--mut);font-size:11px;text-transform:uppercase;letter-spacing:.04em;margin:10px 0 5px}
 .seg{display:flex;flex-wrap:wrap;gap:6px}
 .seg button{background:#10131a;border:1px solid var(--line);color:var(--ink);border-radius:8px;padding:7px 11px;cursor:pointer;font-size:13px}
 .seg button.on{background:var(--brand);border-color:var(--brand);color:#fff}
 .seg button:disabled{opacity:.35;cursor:not-allowed}
 .stage{display:flex;align-items:center;justify-content:center;background:#000;border-radius:10px;min-height:360px;padding:12px}
 .stage img{max-width:100%;max-height:520px;border:1px solid #000;image-rendering:auto}
 code{color:#8ab4ff;word-break:break-all}
 .url{background:#0e1017;border:1px solid var(--line);border-radius:8px;padding:10px 12px;font-family:ui-monospace,Menlo,monospace;font-size:12.5px;margin:10px 0}
 table{width:100%;border-collapse:collapse;font-size:13px}td{padding:6px 4px;border-bottom:1px solid var(--line)}td.k{color:var(--mut);width:130px}
 .pill{display:inline-block;border-radius:20px;padding:2px 9px;font-size:11px;font-weight:700}
 .pill.ok{background:rgba(34,197,94,.15);color:var(--ok)}
 .bar{height:10px;background:#10131a;border-radius:6px;overflow:hidden}.bar>i{display:block;height:100%;background:var(--brand)}
 .checks li{list-style:none;margin:4px 0;color:var(--ink);font-size:12.5px}.checks li b{color:var(--ok)}
 .grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px}
 .muted{color:var(--mut);font-size:12px}
 .thumb{border-radius:8px;border:1px solid var(--line)}
</style></head><body>
<div class=wrap>
 <h1><span>⚡</span> Volt — Image API validator</h1>
 <div class=sub>Every image below is a real render from the sharp service (${DATA.count} variants bundled). Change the controls, read the exact API URL, and check the response. Grammar: <code>/{fit}/{WxH}/filter(...)/{path}</code> — width or height 0 keeps aspect.</div>
 <div class=cols>
  <div>
   <div class=card>
    <div class=lbl>Fit</div><div class=seg id=fit></div>
    <div class=lbl>Size (W×H, 0 = auto)</div><div class=seg id=size></div>
    <div class=lbl>Focus (crop point · fill only)</div><div class=seg id=focus></div>
    <div class=lbl>Filter</div><div class=seg id=filter></div>
   </div>
   <div class=card>
    <div class=lbl>Source</div>
    <img class=thumb style="width:100%" src="data:image/webp;base64,${DATA.thumbB64}">
    <div class=muted style="margin-top:6px">live_channel/TV1.png · 2400×1350</div>
   </div>
  </div>
  <div>
   <div class=card>
    <div class=lbl>Request</div>
    <div class=url id=url></div>
    <div class=stage"><img id=out></div>
    <div class=lbl style="margin-top:12px">Response</div>
    <table><tbody id=meta></tbody></table>
   </div>
   <div class=card>
    <div class=lbl>Format switching (same 600×600 request, real byte sizes)</div>
    <div id=fmt></div>
   </div>
   <div class=card>
    <div class=lbl>Contract checks — test.mjs (${DATA.passN}/${DATA.checks.length} passed)</div>
    <ul class=checks id=checks></ul>
   </div>
  </div>
 </div>
</div>
<script>
const D=${JSON.stringify(DATA)};
const state={fit:'fit-in',size:'500x500',focus:'center',filter:'none'};
function seg(id,vals,cur,on){const el=document.getElementById(id);el.innerHTML='';vals.forEach(v=>{const b=document.createElement('button');b.textContent=v;b.className=(v===cur?'on':'');b.onclick=()=>on(v);el.appendChild(b);});}
function focusEnabled(){return state.fit==='fill';}
function render(){
 seg('fit',D.fits,state.fit,v=>{state.fit=v;if(v!=='fill')state.focus='center';render();});
 seg('size',D.sizes,state.size,v=>{state.size=v;render();});
 const fEl=document.getElementById('focus');
 fEl.innerHTML='';D.foci.forEach(v=>{const b=document.createElement('button');b.textContent=v;b.className=(v===state.focus?'on':'');b.disabled=!focusEnabled();b.onclick=()=>{state.focus=v;render();};fEl.appendChild(b);});
 seg('filter',D.filters,state.filter,v=>{state.filter=v;render();});
 const key=state.fit+'|'+state.size+'|'+(focusEnabled()?state.focus:'center')+'|'+state.filter;
 const rec=D.manifest[key];
 document.getElementById('url').innerHTML='GET '+rec.url;
 document.getElementById('out').src='data:image/webp;base64,'+rec.b64;
 document.getElementById('meta').innerHTML=
   '<tr><td class=k>Status</td><td><span class="pill ok">200 OK</span></td></tr>'+
   '<tr><td class=k>Content-Type</td><td>image/'+rec.fmt+'</td></tr>'+
   '<tr><td class=k>Dimensions</td><td>'+rec.w+' × '+rec.h+' px</td></tr>'+
   '<tr><td class=k>Bytes</td><td>'+rec.bytes.toLocaleString()+'</td></tr>'+
   '<tr><td class=k>Cache-Control</td><td>public, max-age=31536000, immutable</td></tr>';
}
// format demo bars
(function(){
 const max=Math.max(...Object.values(D.fmtDemo).map(x=>x.bytes));
 document.getElementById('fmt').innerHTML=Object.entries(D.fmtDemo).map(([f,x])=>
   '<div style="margin:8px 0"><div class=muted>'+f.toUpperCase()+' · '+x.bytes.toLocaleString()+' bytes</div><div class=bar><i style="width:'+Math.round(x.bytes/max*100)+'%"></i></div></div>').join('');
})();
document.getElementById('checks').innerHTML=D.checks.map(c=>'<li>'+(c.ok?'<b>✓</b>':'✗')+' '+c.text+'</li>').join('');
render();
</script>
</body></html>`;

await writeFile('validator.html', html);
console.log(`validator.html written — ${DATA.count} real renders (${DATA.totalKB} KB embedded), ${DATA.passN}/${DATA.checks.length} checks pass`);
