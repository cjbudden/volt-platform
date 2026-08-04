/**
 * The standalone share page (self-contained HTML). It is deliberately ISOLATED:
 * no nav, no links to the console or any other asset. All data comes from
 * POST /api/share/:token/resolve, so the page renders "available", "needs PIN", or
 * "no longer available" states from that one call. hls.js plays the preview.
 */
export function sharePageHtml(token: string): string {
  const t = JSON.stringify(token);
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<meta name="robots" content="noindex,nofollow"/>
<title>Secure share</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/hls.js/1.5.13/hls.min.js"></script>
<style>
  :root{--bg:#f4f5f7;--card:#fff;--ink:#0f172a;--muted:#64748b;--line:#e5e7eb;--brand:#2563eb;--accent:#eef2ff}
  *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif}
  .wrap{max-width:1080px;margin:0 auto;padding:22px}
  .topbar{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px}
  .brand{display:flex;align-items:center;gap:10px;font-weight:800;font-size:20px;letter-spacing:.02em}
  .brand .logo{width:34px;height:34px;border-radius:9px;background:var(--brand);display:inline-block}
  .pill{border:1px solid var(--line);background:#fff;border-radius:999px;padding:7px 13px;color:var(--muted);font-size:13px}
  .infobar{display:flex;justify-content:space-between;gap:16px;background:var(--accent);border:1px solid #e0e7ff;color:#3730a3;border-radius:12px;padding:12px 16px;font-size:14px;margin-bottom:20px;flex-wrap:wrap}
  h1{font-size:34px;margin:4px 0 6px} .sub{color:var(--muted);margin:0 0 16px}
  .player{position:relative;border-radius:14px;overflow:hidden;background:#000;aspect-ratio:16/9}
  .player video{width:100%;height:100%;display:block;background:#000}
  .badge{position:absolute;top:12px;left:12px;background:rgba(15,23,42,.82);color:#fff;font-size:12px;font-weight:700;letter-spacing:.08em;padding:6px 10px;border-radius:7px;z-index:3}
  .dur{position:absolute;bottom:12px;right:12px;background:rgba(15,23,42,.82);color:#fff;font-size:12px;padding:4px 8px;border-radius:6px;z-index:3}
  .wm{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none;z-index:2}
  .wm span{color:rgba(255,255,255,.16);font-size:26px;font-weight:800;transform:rotate(-18deg);white-space:nowrap}
  .under{display:flex;justify-content:space-between;align-items:center;gap:12px;margin:12px 0 26px;flex-wrap:wrap}
  .under .cap{color:var(--muted);font-size:13px}
  .btns{display:flex;gap:10px}
  .btn{border:1px solid var(--line);background:#fff;border-radius:10px;padding:11px 16px;font-weight:600;cursor:pointer;color:var(--ink);text-decoration:none;display:inline-flex;gap:8px;align-items:center}
  .btn.primary{background:var(--brand);border-color:var(--brand);color:#fff}
  .grid{display:grid;grid-template-columns:1fr 360px;gap:22px} @media(max-width:820px){.grid{grid-template-columns:1fr}}
  h3{margin:0 0 10px;font-size:18px} .about{white-space:pre-wrap}
  .card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px 20px;margin-bottom:18px}
  .note{background:#f8fafc}
  .who{display:flex;gap:12px;align-items:center;margin-bottom:8px}
  .avatar{width:38px;height:38px;border-radius:999px;background:var(--brand);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700}
  .row{display:flex;justify-content:space-between;padding:11px 0;border-bottom:1px solid var(--line);gap:16px}
  .row:last-child{border-bottom:0} .row .k{color:var(--muted)} .row .v{font-weight:600;text-align:right}
  .access{background:var(--accent);border-color:#e0e7ff}
  .access li{list-style:none;margin:8px 0;padding-left:22px;position:relative;color:#3730a3}
  .access li:before{content:"";position:absolute;left:0;top:5px;width:12px;height:12px;border:2px solid var(--brand);border-radius:3px}
  .access ul{margin:0;padding:0}
  .state{text-align:center;padding:80px 20px;color:var(--muted)}
  .pinbox{max-width:360px;margin:60px auto;text-align:center}
  .pinbox input{width:100%;padding:12px;border:1px solid var(--line);border-radius:10px;font-size:16px;text-align:center;letter-spacing:.3em;margin:12px 0}
  .hide{display:none}
</style></head>
<body>
<div class="wrap">
  <div id="app"><div class="state">Loading secure preview…</div></div>
</div>
<script>
const TOKEN=${t};
const $=s=>document.querySelector(s);
function esc(x){return String(x==null?'':x).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}
function fmtDur(ms){if(!ms)return '';const s=Math.round(ms/1000);const h=Math.floor(s/3600),m=Math.floor(s%3600/60),ss=s%60;return (h?String(h).padStart(2,'0')+':':'')+String(m).padStart(2,'0')+':'+String(ss).padStart(2,'0')}
function fmtDate(iso){try{return new Date(iso).toLocaleDateString(undefined,{day:'2-digit',month:'short',year:'numeric'})}catch(e){return iso}}
function daysLeft(iso){const d=Math.ceil((new Date(iso)-Date.now())/86400000);return d<=0?'today':d===1?'1 day':d+' days'}

async function resolve(pin){
  const r=await fetch('/api/share/'+encodeURIComponent(TOKEN)+'/resolve',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(pin?{pin}:{})});
  if(r.ok)return {ok:true,data:await r.json()};
  let j={};try{j=await r.json()}catch(e){}
  return {ok:false,status:r.status,reason:j.reason};
}
function stateMsg(reason){
  const map={expired:'This link has expired.',revoked:'This link has been revoked.',view_cap:'This link has reached its view limit.',not_found:'This link is not valid.'};
  $('#app').innerHTML='<div class="state"><h1>Link no longer available</h1><p>'+esc(map[reason]||'This preview can no longer be viewed.')+'</p></div>';
}
function pinPrompt(wrong){
  $('#app').innerHTML='<div class="pinbox"><h1>Enter PIN</h1><p>'+(wrong?'That PIN was not correct. ':'')+'This preview is protected by a PIN.</p><input id="pin" inputmode="numeric" autocomplete="one-time-code" placeholder="••••"/><button class="btn primary" id="pinGo" style="width:100%;justify-content:center">Unlock</button></div>';
  $('#pinGo').onclick=async()=>{const v=$('#pin').value.trim();if(!v)return;const out=await resolve(v);if(out.ok)render(out.data);else if(out.reason==='pin_wrong'||out.reason==='pin_required')pinPrompt(true);else stateMsg(out.reason)};
  $('#pin').addEventListener('keydown',e=>{if(e.key==='Enter')$('#pinGo').click()});
}
function render(d){
  const md=d.metadata||{};
  const cat=md.category||md.Category||d.kind.toUpperCase();
  const dt=md.date||md.Date||'';
  const fmt=md.format||md.Format||'';
  const ref=md.reference||md.Reference||'';
  const dl=d.access||{};
  const wm=d.watermark?('<div class="wm"><span>'+esc((d.sharedBy||d.brand.account||'preview'))+' • do not distribute</span></div>'):'';
  const metaBtn=(dl.metadata)?'<a class="btn" href="/api/share/'+encodeURIComponent(TOKEN)+'/download/metadata">Metadata</a>':'';
  const hiresBtn=(dl.hiRes)?'<a class="btn primary" id="hires" href="#">Download hi-res</a>':'';
  const detailRows=[['Category',cat],['Date',dt||(d.expiresAt?'':'')],['Duration',fmtDur(d.durationMs)],['Format',fmt],['Reference',ref]].filter(r=>r[1]);
  const accessItems=[dl.preview?'Preview playback':null,(dl.hiRes||dl.metadata)?'Hi-res &amp; metadata download':null,'Link expires '+fmtDate(d.expiresAt),(d.access&&!d.access.signInRequired)?'Free access · no sign-in required':null].filter(Boolean);
  $('#app').innerHTML=
  '<div class="topbar"><div class="brand"><span class="logo"></span>'+esc(d.brand.account||'Volt')+'</div><span class="pill">Private share</span></div>'+
  '<div class="infobar"><div>Secure preview shared with you · access expires in <b>'+daysLeft(d.expiresAt)+'</b> ('+fmtDate(d.expiresAt)+')</div>'+(d.sharedBy?'<div>Shared by '+esc(d.sharedBy)+' · '+esc(d.brand.account||'')+'</div>':'')+'</div>'+
  '<h1>'+esc(d.title)+'</h1>'+
  '<p class="sub">'+esc(d.brand.account||'')+' · '+esc(cat)+(dt?' · '+esc(dt):'')+(d.durationMs?' · Duration '+fmtDur(d.durationMs):'')+'</p>'+
  '<div class="player"><span class="badge">PREVIEW</span>'+wm+'<video id="v" controls playsinline preload="metadata"></video>'+(d.durationMs?'<span class="dur">'+fmtDur(d.durationMs)+'</span>':'')+'</div>'+
  '<div class="under"><div class="cap">Streaming preview'+(d.watermark?' · watermarked to your link':'')+'</div><div class="btns">'+metaBtn+hiresBtn+'</div></div>'+
  '<div class="grid"><div>'+
    (md.description||md.about?'<div class="card"><h3>About this asset</h3><div class="about">'+esc(md.description||md.about)+'</div></div>':'')+
    (d.message?'<div class="card note"><div class="who"><div class="avatar">'+esc((d.sharedBy||'?').slice(0,2).toUpperCase())+'</div><div><b>'+esc(d.sharedBy||'Shared')+'</b><div class="cap">'+esc(d.brand.account||'')+'</div></div></div><div>“'+esc(d.message)+'”</div></div>':'')+
  '</div><div>'+
    '<div class="card"><h3>Details</h3>'+detailRows.map(r=>'<div class="row"><span class="k">'+esc(r[0])+'</span><span class="v">'+esc(r[1])+'</span></div>').join('')+'</div>'+
    '<div class="card access"><h3>Your access</h3><ul>'+accessItems.map(i=>'<li>'+i+'</li>').join('')+'</ul></div>'+
  '</div></div>';

  // play the preview
  const v=$('#v'), src=d.hls;
  if(src){ if(window.Hls&&Hls.isSupported()){const h=new Hls();h.loadSource(src);h.attachMedia(v);} else {v.src=src;} }
  const hi=$('#hires'); if(hi){hi.onclick=async e=>{e.preventDefault();const r=await fetch('/api/share/'+encodeURIComponent(TOKEN)+'/download/hi_res');if(r.ok){const j=await r.json();window.location=j.url;}else{alert('Download not available.');}};}
}
(async()=>{const out=await resolve();if(out.ok)render(out.data);else if(out.reason==='pin_required')pinPrompt(false);else stateMsg(out.reason);})();
</script>
</body></html>`;
}
