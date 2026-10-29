/**
 * The standalone share page (self-contained HTML). It is deliberately ISOLATED:
 * no nav, no links to the console or any other asset. All data comes from
 * POST /api/share/:token/resolve, so the page renders "available", "needs PIN", or
 * "no longer available" states from that one call.
 *
 * THE VOLT PLAYER plays the preview (volt-player/src/sdk, served at
 * /player/volt-player.js): the same player customers embed, in the account's
 * colours, with quality and subtitle menus and the viewer beacons built in.
 * Casting and AirPlay are off: a private preview stays on the device it was
 * opened on. If the bundle is not there (a dev box that has not built it) the
 * page falls back to hls.js, as before.
 *
 * A RADIO STATION plays in the radio layout (audio_radio), not a video frame,
 * and every live preview has an "In-stream graphics" panel: what the stream's
 * manifests announced (Up next and the programme marker), when, and whether it
 * is upcoming, on screen or done. That is how a broadcaster checks the triggers
 * before the channel goes public (docs/DESIGN_stream_graphics_triggers.md).
 */
export function sharePageHtml(token: string): string {
  // JSON.stringify escapes quotes and backslashes. It does NOT escape `<`, so
  // a value containing `</script>` closes the block it is embedded in and
  // everything after it becomes markup on this origin. Escaping the three
  // characters that can start a tag or a comment (and U+2028/9, which are raw
  // line terminators in a script but not in JSON) makes the embedded literal
  // safe for HTML context whatever the caller passes. The route also refuses
  // non-token-shaped input; this is the half that cannot be forgotten.
  const t = JSON.stringify(token)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<meta name="robots" content="noindex,nofollow"/>
<title>Secure share</title>
<script src="/player/volt-player.js"></script>
<style>
  :root{--bg:#f4f5f7;--card:#fff;--ink:#0f172a;--muted:#64748b;--line:#e5e7eb;--brand:#2563eb;--brand-ink:#fff;--accent:#eef2ff;--accent-ink:#3730a3;--accent-line:#e0e7ff}
  *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif}
  .wrap{max-width:1080px;margin:0 auto;padding:22px}
  .topbar{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px}
  .brand{display:flex;align-items:center;gap:10px;font-weight:800;font-size:20px;letter-spacing:.02em}
  .brand .logo{width:34px;height:34px;border-radius:9px;background:var(--brand);display:inline-block}
  .brand .logo-img{height:36px;max-width:180px;object-fit:contain;display:block}
  .pinbox .logo-img{height:44px;max-width:200px;object-fit:contain;margin:0 auto 14px;display:block}
  .pill{border:1px solid var(--line);background:#fff;border-radius:999px;padding:7px 13px;color:var(--muted);font-size:13px}
  .infobar{display:flex;justify-content:space-between;gap:16px;background:var(--accent);border:1px solid var(--accent-line);color:var(--accent-ink);border-radius:12px;padding:12px 16px;font-size:14px;margin-bottom:20px;flex-wrap:wrap}
  h1{font-size:34px;margin:4px 0 6px} .sub{color:var(--muted);margin:0 0 16px}
  .player{position:relative;border-radius:14px;overflow:hidden;background:#000;aspect-ratio:16/9}
  .player video{width:100%;height:100%;display:block;background:#000}
  .player #vp{position:absolute;inset:0}
  .player #vp>.vp{height:100%;aspect-ratio:auto;border-radius:0}
  .player.audio{aspect-ratio:auto;background:transparent;overflow:visible;min-height:120px}
  .player.audio #vp{position:relative;inset:auto}
  .player.audio #vp>.vp{height:auto;border-radius:14px}
  .player.audio .state{border-radius:14px;min-height:240px}
  .gfx .line{display:flex;justify-content:space-between;gap:10px;font-size:13px;color:var(--muted);margin-bottom:10px}
  .gfx .line b{color:var(--ink)}
  .gfx .g{display:grid;grid-template-columns:auto 1fr;gap:2px 10px;padding:10px 0;border-top:1px solid var(--line);font-size:13px}
  .gfx .g .st{grid-row:span 3;align-self:start;font-size:10px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;padding:3px 7px;border-radius:6px;background:#f1f5f9;color:var(--muted);white-space:nowrap}
  .gfx .g .st.on{background:#dcfce7;color:#166534}
  .gfx .g .st.soon{background:var(--accent);color:var(--accent-ink)}
  .gfx .g .t{font-weight:700;color:var(--ink)}
  .gfx .g .w{color:var(--muted);font-variant-numeric:tabular-nums}
  .gfx .empty{font-size:13px;color:var(--muted)}
  .player .badge{pointer-events:none}
  .badge{position:absolute;top:12px;left:12px;background:rgba(15,23,42,.82);color:#fff;font-size:12px;font-weight:700;letter-spacing:.08em;padding:6px 10px;border-radius:7px;z-index:3}
  .dur{position:absolute;bottom:12px;right:12px;background:rgba(15,23,42,.82);color:#fff;font-size:12px;padding:4px 8px;border-radius:6px;z-index:3}
  .wm{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none;z-index:2}
  .wm span{color:rgba(255,255,255,.16);font-size:26px;font-weight:800;transform:rotate(-18deg);white-space:nowrap}
  .under{display:flex;justify-content:space-between;align-items:center;gap:12px;margin:12px 0 26px;flex-wrap:wrap}
  .under .cap{color:var(--muted);font-size:13px}
  .btns{display:flex;gap:10px}
  .btn{border:1px solid var(--line);background:#fff;border-radius:10px;padding:11px 16px;font-weight:600;cursor:pointer;color:var(--ink);text-decoration:none;display:inline-flex;gap:8px;align-items:center}
  .btn.primary{background:var(--brand);border-color:var(--brand);color:var(--brand-ink)}
  .grid{display:grid;grid-template-columns:1fr 360px;gap:22px} @media(max-width:820px){.grid{grid-template-columns:1fr}}
  h3{margin:0 0 10px;font-size:18px} .about{white-space:pre-wrap}
  .card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px 20px;margin-bottom:18px}
  .note{background:#f8fafc}
  .who{display:flex;gap:12px;align-items:center;margin-bottom:8px}
  .avatar{width:38px;height:38px;border-radius:999px;background:var(--brand);color:var(--brand-ink);display:flex;align-items:center;justify-content:center;font-weight:700}
  .row{display:flex;justify-content:space-between;padding:11px 0;border-bottom:1px solid var(--line);gap:16px}
  .row:last-child{border-bottom:0} .row .k{color:var(--muted)} .row .v{font-weight:600;text-align:right}
  .access{background:var(--accent);border-color:var(--accent-line)}
  .access li{list-style:none;margin:8px 0;padding-left:22px;position:relative;color:var(--accent-ink)}
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
// ACCOUNT BRANDING (Admin > Account settings): the account's colours and logo.
// Colours arrive as #rrggbb only (validated on save), so they are safe in CSS.
// Text on each colour is black or white, whichever reads better.
let BRAND=null;
function lum(h){const n=parseInt(h.slice(1),16);const c=[n>>16&255,n>>8&255,n&255].map(v=>{v/=255;return v<=.03928?v/12.92:Math.pow((v+.055)/1.055,2.4)});return .2126*c[0]+.7152*c[1]+.0722*c[2]}
function mix(h,w){const n=parseInt(h.slice(1),16);const c=[n>>16&255,n>>8&255,n&255].map(v=>Math.round(v+(255-v)*w));return '#'+c.map(v=>v.toString(16).padStart(2,'0')).join('')}
function applyBrand(b){
  if(!b)return; BRAND=b;
  const ok=x=>typeof x==='string'&&/^#[0-9a-f]{6}$/i.test(x);
  const r=document.documentElement.style;
  if(ok(b.primary)){r.setProperty('--brand',b.primary);r.setProperty('--brand-ink',lum(b.primary)>.45?'#0f172a':'#ffffff')}
  if(ok(b.secondary)){const L=lum(b.secondary);r.setProperty('--accent',b.secondary);r.setProperty('--accent-ink',L>.45?'#1e293b':'#ffffff');r.setProperty('--accent-line',L>.45?'rgba(15,23,42,.10)':'rgba(255,255,255,.25)')}
  if(b.account)document.title=b.account+' · Secure share';
}
function logoHtml(cls){return BRAND&&BRAND.logo?'<img class="'+cls+'" src="'+esc(BRAND.logo)+'" alt="'+esc(BRAND.account||'')+'"/>':''}
function daysLeft(iso){const d=Math.ceil((new Date(iso)-Date.now())/86400000);return d<=0?'today':d===1?'1 day':d+' days'}

const CREDS={};   // pin / email+code entered by the viewer, reused on re-resolves
// ONE VIEW PER VISIT: an id kept for as long as this tab is open (a reload
// keeps it, a new tab or a new day in a closed browser does not), so a reload,
// Check again and a token refresh are not counted as more views. Without
// session storage it lasts for this page load, which is still one view.
CREDS.visit=(function(){const k='volt-share-visit-'+TOKEN.slice(0,12);let v=null;try{v=sessionStorage.getItem(k)}catch(e){}
  if(!v||!/^[A-Za-z0-9_-]{8,64}$/.test(v)){const a=new Uint8Array(16);(window.crypto||{getRandomValues:function(x){for(let i=0;i<x.length;i++)x[i]=Math.floor(Math.random()*256);return x}}).getRandomValues(a);v=Array.from(a,function(b){return('0'+b.toString(16)).slice(-2)}).join('');try{sessionStorage.setItem(k,v)}catch(e){}}
  return v})();
async function resolve(pin){
  if(pin)CREDS.pin=pin;
  const r=await fetch('/api/share/'+encodeURIComponent(TOKEN)+'/resolve',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(CREDS)});
  if(r.ok)return {ok:true,data:await r.json()};
  let j={};try{j=await r.json()}catch(e){}
  if(j.brand)applyBrand(j.brand);
  return {ok:false,status:r.status,reason:j.reason};
}
// email_pin flow: confirm the recipient email -> a one-time code is emailed -> enter it.
function emailPrompt(note){
  $('#app').innerHTML='<div class="pinbox">'+logoHtml('logo-img')+'<h1>Confirm your email</h1><p>'+(note?esc(note)+' ':'')+'This preview is protected. Enter the email address this link was sent to and we will email you a one-time access code.</p><input id="em" type="email" autocomplete="email" placeholder="you@example.com" style="letter-spacing:normal"/><button class="btn primary" id="emGo" style="width:100%;justify-content:center">Email me a code</button></div>';
  $('#emGo').onclick=async()=>{
    const v=$('#em').value.trim(); if(!v)return;
    CREDS.email=v; delete CREDS.code;
    try{await fetch('/api/share/'+encodeURIComponent(TOKEN)+'/request-code',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:v})});}catch(e){}
    codePrompt(false);
  };
  $('#em').addEventListener('keydown',e=>{if(e.key==='Enter')$('#emGo').click()});
}
function codePrompt(wrong){
  $('#app').innerHTML='<div class="pinbox">'+logoHtml('logo-img')+'<h1>Enter your access code</h1><p>'+(wrong?'That code was not correct. ':'')+'If <b>'+esc(CREDS.email||'your email')+'</b> received this link, a 6-digit code has been emailed to it (valid 10 minutes).</p><input id="code" inputmode="numeric" autocomplete="one-time-code" placeholder="&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;"/><button class="btn primary" id="codeGo" style="width:100%;justify-content:center">Unlock preview</button><p style="margin-top:14px"><a href="#" id="again">Use a different email / send a new code</a></p></div>';
  $('#codeGo').onclick=async()=>{
    const v=$('#code').value.trim(); if(!v)return;
    CREDS.code=v;
    const out=await resolve();
    if(out.ok)render(out.data);
    else if(out.reason==='code_wrong')codePrompt(true);
    else if(out.reason==='code_expired')emailPrompt('That code has expired.');
    else if(out.reason==='code_required')codePrompt(true);
    else stateMsg(out.reason);
  };
  $('#again').onclick=e=>{e.preventDefault();emailPrompt()};
  $('#code').addEventListener('keydown',e=>{if(e.key==='Enter')$('#codeGo').click()});
}
function stateMsg(reason){
  const map={geo_blocked:'This preview is not available in your region.',expired:'This link has expired.',revoked:'This link has been revoked.',view_cap:'This link has reached its view limit.',not_found:'This link is not valid.'};
  $('#app').innerHTML='<div class="state"><h1>Link no longer available</h1><p>'+esc(map[reason]||'This preview can no longer be viewed.')+'</p></div>';
}
function pinPrompt(wrong){
  $('#app').innerHTML='<div class="pinbox">'+logoHtml('logo-img')+'<h1>Enter PIN</h1><p>'+(wrong?'That PIN was not correct. ':'')+'This preview is protected by a PIN.</p><input id="pin" inputmode="numeric" autocomplete="one-time-code" placeholder="••••"/><button class="btn primary" id="pinGo" style="width:100%;justify-content:center">Unlock</button></div>';
  $('#pinGo').onclick=async()=>{const v=$('#pin').value.trim();if(!v)return;const out=await resolve(v);if(out.ok)render(out.data);else if(out.reason==='pin_wrong'||out.reason==='pin_required')pinPrompt(true);else stateMsg(out.reason)};
  $('#pin').addEventListener('keydown',e=>{if(e.key==='Enter')$('#pinGo').click()});
}
function render(d){
  applyBrand(d.brand);
  const md=d.metadata||{};
  const cat=md.category||md.Category||(d.radio?'RADIO':d.kind.toUpperCase());
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
  '<div class="topbar"><div class="brand">'+(d.brand.logo?logoHtml('logo-img'):'<span class="logo"></span>'+esc(d.brand.account||'Volt'))+'</div><span class="pill">Private share</span></div>'+
  '<div class="infobar"><div>Secure preview shared with you · access expires in <b>'+daysLeft(d.expiresAt)+'</b> ('+fmtDate(d.expiresAt)+')</div>'+(d.sharedBy?'<div>Shared by '+esc(d.sharedBy)+' · '+esc(d.brand.account||'')+'</div>':'')+'</div>'+
  '<h1>'+esc(d.title)+'</h1>'+
  '<p class="sub">'+esc(d.brand.account||'')+' · '+esc(cat)+(dt?' · '+esc(dt):'')+(d.durationMs?' · Duration '+fmtDur(d.durationMs):'')+'</p>'+
  '<div class="player'+(d.radio&&SDK?' audio':'')+'">'+(d.radio&&SDK?'':'<span class="badge">'+(d.live?'LIVE PREVIEW':'PREVIEW')+'</span>')+(SDK?'<div id="vp"></div>':wm+'<video id="v" controls playsinline preload="metadata"></video>')+(d.live&&!d.available?'<div class="state" style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;color:#cbd5e1;background:#0b0f16;z-index:3"><h1 style="color:#fff;font-size:22px;margin:0 0 6px">Preview not live right now</h1><p style="margin:0 0 14px">The stream is not currently being produced. This preview will play when the source is active.</p><button class="btn primary" id="retry">Check again</button></div>':'')+(d.durationMs&&!SDK?'<span class="dur">'+fmtDur(d.durationMs)+'</span>':'')+'</div>'+
  '<div class="under"><div class="cap">'+(d.radio?'Live radio preview':'Streaming preview')+(d.watermark&&!d.radio?' · watermarked to your link':'')+'</div><div class="btns">'+metaBtn+hiresBtn+'</div></div>'+
  '<div class="grid"><div>'+
    (md.description||md.about?'<div class="card"><h3>About this asset</h3><div class="about">'+esc(md.description||md.about)+'</div></div>':'')+
    (d.message?'<div class="card note"><div class="who"><div class="avatar">'+esc((d.sharedBy||'?').slice(0,2).toUpperCase())+'</div><div><b>'+esc(d.sharedBy||'Shared')+'</b><div class="cap">'+esc(d.brand.account||'')+'</div></div></div><div>“'+esc(d.message)+'”</div></div>':'')+
  '</div><div>'+
    (d.live&&SDK?'<div class="card gfx" id="gfx"><h3>In-stream graphics</h3><div class="empty">Waiting for the stream…</div></div>':'')+
    '<div class="card"><h3>Details</h3>'+detailRows.map(r=>'<div class="row"><span class="k">'+esc(r[0])+'</span><span class="v">'+esc(r[1])+'</span></div>').join('')+'</div>'+
    '<div class="card access"><h3>Your access</h3><ul>'+accessItems.map(i=>'<li>'+i+'</li>').join('')+'</ul></div>'+
  '</div></div>';

  // live preview not being produced yet: offer a re-resolve instead of a dead player
  const retry=$('#retry'); if(retry){retry.onclick=async()=>{const out=await resolve();if(out.ok)render(out.data);else if(out.reason==='pin_required')pinPrompt(false);else if(out.reason==='code_required'||out.reason==='code_expired')emailPrompt();else stateMsg(out.reason);};}
  // play the preview (skip while a live stream isn't available)
  if(SDK){ if(d.hls||d.dash) playWithSdk(d); }
  else {
    const v=$('#v'), src=d.hls;
    if(src && !(d.live && !d.available)) loadHls().then(()=>{
      if(window.Hls&&Hls.isSupported()){
        const h=new Hls(d.live?{liveSyncDurationCount:3}:{});h.loadSource(src);h.attachMedia(v);HLS=h;
        if(d.live){h.on(Hls.Events.MANIFEST_PARSED,()=>{try{v.muted=true;v.play().catch(()=>{})}catch(e){}});}
      } else { v.src=src; }
    });
    startViewing(d, v);
  }
  const hi=$('#hires'); if(hi){hi.onclick=async e=>{e.preventDefault();const r=await fetch('/api/share/'+encodeURIComponent(TOKEN)+'/download/hi_res');if(r.ok){const j=await r.json();window.location=j.url;}else{alert('Download not available.');}};}
}
// VIEWING IS REPORTED (Analytics): a share-link preview is a real viewer, so
// it sends the same session beacons as any player: start when the picture
// first plays (with the time it took), a heartbeat every 30 s with the seconds
// actually watched and the bitrate, and the end when the page goes away. They
// are filed as "Share link" so previews can be told from the public audience.
let HLS=null, VIEW=null, PLAYER=null;
const SDK=!!(window.VoltPlayer&&window.VoltPlayer.VoltPlayer);
// THE VOLT PLAYER: brand colours, no title bar (the page shows it), the
// watermark inside the picture (so it stays in full screen), and the viewer
// beacons filed as "Share link" by the token the page was given.
function playWithSdk(d){
  if(d.live && !d.available) return;
  const wmText=d.watermark?((d.sharedBy||(d.brand&&d.brand.account)||'preview')+' • do not distribute'):null;
  const b=d.brand||{};
  if(PLAYER){try{PLAYER.destroy()}catch(e){} PLAYER=null}
  const primary=/^#[0-9a-f]{6}$/i.test(b.primary||'')?b.primary:'#2563eb';
  // In-stream graphics are always on here: this page is where they get checked.
  const theme=d.radio
    ? { primary:primary, secondary:'#0f172a', radius:14, logoUrl:b.logo||null, logoPosition:b.logo?'top-left':'none', showGraphics:true, controls:{ schedule:true, upNext:true } }
    : { primary:primary, secondary:'#0f172a', radius:0, logoPosition:'none', showGraphics:true, controls:{ title:false, schedule:false, upNext:true } };
  VoltPlayer.VoltPlayer.create({
    el:'#vp', skin:d.radio?'audio_radio':'video', apiBase:location.origin,
    theme:theme, showGraphics:true,
    item:{ id:TOKEN, title:d.title, live:!!d.live, source:{ hls:d.hls||null, dash:d.dash||null }, playbackToken:d.playbackToken||null, durationMs:d.durationMs||null },
    watermark:d.radio?null:wmText, autoplay:!!d.live, muted:!!d.live&&!d.radio,
    beacons:{ prefix:'share' }, cast:false, airplay:false,
  }).then(p=>{PLAYER=p;startGfx()}).catch(e=>console.error('[share] player failed',e));
}
// IN-STREAM GRAPHICS PANEL: what the manifests announced, read from the player
// (getStreamGraphics, media times) and placed on the wall clock by the stream's
// own PROGRAM-DATE-TIME. Upcoming, on screen, or shown; and the programme the
// stream's marker says is on. A second hand, so the states change on time.
let GFX=null;
function clk(ms){try{return new Date(ms).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'})}catch(e){return ''}}
function words(ms){const s=Math.max(0,Math.round(ms/1000));return s<60?s+' s':Math.round(s/60)+' min'}
function startGfx(){ if(GFX)clearInterval(GFX); GFX=setInterval(gfxPanel,1000); gfxPanel(); }
function gfxPanel(){
  const box=$('#gfx'); if(!box||!PLAYER||!PLAYER.getStreamGraphics)return;
  const st=PLAYER.getState(), all=PLAYER.getStreamGraphics(), t=st.currentTime;
  const wall=m=>st.wallClock!=null?st.wallClock+(m-t)*1000:null;
  const prog=all.filter(g=>g.graphic==='programme'&&t>=g.start&&(g.end==null||t<g.end)).pop();
  const cards=all.filter(g=>g.graphic!=='programme');
  const keep=cards.filter(g=>g.end==null||g.end>t-900).slice(-5);
  let h='<h3>In-stream graphics</h3><div class="line"><span>Programme marker</span><b>'+(prog?esc(prog.data.title||'?'):'none yet')+'</b></div>';
  if(!keep.length){
    h+='<div class="empty">'+(all.length?'No cards in the last 15 minutes.':'Nothing announced yet.')+' Up next is written into the stream shortly before each programme change, when the next programme follows on.</div>';
  }
  for(const g of keep){
    const on=t>=g.start&&(g.end==null||t<g.end), soon=t<g.start;
    const ws=wall(g.start), we=g.end!=null?wall(g.end):null;
    const label=g.graphic==='up-next'?'Up next':g.graphic;
    const starts=g.data.starts?Date.parse(g.data.starts):NaN;
    h+='<div class="g"><span class="st '+(on?'on':soon?'soon':'')+'">'+(on?'On screen':soon?'In '+words((g.start-t)*1000):'Shown')+'</span>'+
      '<span class="t">'+esc(label)+': '+esc(g.data.title||'')+'</span>'+
      '<span class="w">'+(ws?clk(ws):'')+(we?' to '+clk(we):'')+(g.end!=null?' · '+words((g.end-g.start)*1000):'')+'</span>'+
      '<span class="w">'+(isFinite(starts)?'Programme starts '+clk(starts):'')+'</span></div>';
  }
  if(box.innerHTML!==h)box.innerHTML=h;
}
function loadHls(){return window.Hls?Promise.resolve():new Promise(ok=>{const s=document.createElement('script');s.src='https://cdnjs.cloudflare.com/ajax/libs/hls.js/1.5.13/hls.min.js';s.onload=ok;s.onerror=ok;document.head.appendChild(s)})}
function beacon(ev, extra, last){
  if(!VIEW)return;
  const body=JSON.stringify(Object.assign({playbackToken:VIEW.token,sessionId:VIEW.id,event:ev},extra||{}));
  try{
    if(last&&navigator.sendBeacon){navigator.sendBeacon('/api/analytics/beacon',new Blob([body],{type:'application/json'}));return}
    fetch('/api/analytics/beacon',{method:'POST',headers:{'content-type':'application/json'},body,keepalive:!!last}).catch(()=>{});
  }catch(e){}
}
function kbps(){try{const l=HLS&&HLS.levels&&HLS.levels[HLS.currentLevel];return l&&l.bitrate?Math.round(l.bitrate/1000):undefined}catch(e){return undefined}}
function startViewing(d, v){
  if(!d.playbackToken||!v)return;
  const t0=performance.now();
  const id=(crypto.randomUUID?crypto.randomUUID():String(Math.random()).slice(2)+Date.now());
  VIEW={token:d.playbackToken,id:'share-'+id,started:false,watched:0,lastT:null,ended:false};
  v.addEventListener('playing',()=>{if(!VIEW.started){VIEW.started=true;beacon('start',{ttffMs:Math.round(performance.now()-t0),bitrateKbps:kbps()})}});
  v.addEventListener('timeupdate',()=>{const t=v.currentTime;if(VIEW.lastT!=null&&!v.paused){const dt=t-VIEW.lastT;if(dt>0&&dt<5)VIEW.watched+=dt}VIEW.lastT=t});
  setInterval(()=>{if(!VIEW.started||VIEW.ended)return;const s=Math.round(VIEW.watched);VIEW.watched-=s;beacon('heartbeat',{seconds:s,bitrateKbps:kbps()})},30000);
  const end=()=>{if(!VIEW.started||VIEW.ended)return;VIEW.ended=true;beacon('end',{seconds:Math.round(VIEW.watched)},true)};
  addEventListener('pagehide',end);
  document.addEventListener('visibilitychange',()=>{
    if(document.visibilityState==='hidden')end();
    // back to the tab and still playing: a new viewing session
    else if(VIEW.ended&&!v.paused){VIEW.id='share-'+Date.now()+Math.random().toString(36).slice(2);VIEW.ended=false;VIEW.watched=0;beacon('start',{bitrateKbps:kbps()})}
  });
}
(async()=>{const out=await resolve();if(out.ok)render(out.data);else if(out.reason==='pin_required')pinPrompt(false);else if(out.reason==='code_required'||out.reason==='code_expired')emailPrompt();else stateMsg(out.reason);})();
</script>
</body></html>`;
}
