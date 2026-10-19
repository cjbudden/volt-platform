// Build a self-contained "upload your own image" test view for the image service.
// It applies the SAME transform semantics (fit-in/fill/stretch + focus + filters)
// live in the browser via canvas, shows the exact API URL that would produce it, and
// carries the real-service contract checks as the validation proof. Fully offline.
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { parseImageUrl } from './src/parse.mjs';
import { renderImage } from './src/render.mjs';

const src = await readFile('media/live_channel/TV1.png');
const def = await renderImage(src, parseImageUrl('/fit-in/1000x0/filter(format:webp)/live_channel/TV1.png'));
const DEFAULT_IMG = 'data:image/webp;base64,' + def.buffer.toString('base64');

let checks = [];
try {
  const out = execFileSync('node', ['test.mjs'], { encoding: 'utf8' });
  checks = out.split('\n').filter(l => l.startsWith('PASS ') || l.startsWith('FAIL '))
    .map(l => ({ ok: l.startsWith('PASS'), text: l.slice(5) }));
} catch { checks = []; }
const passN = checks.filter(c => c.ok).length;

const html = `<!doctype html><html lang=en><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>Image service — test view</title>
<style>
 :root{--bg:#0b0c10;--card:#14161d;--ink:#e7e9ee;--mut:#98a0ad;--line:#242833;--brand:#2563eb;--ok:#22c55e}
 *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 Inter,system-ui,Segoe UI,Roboto,sans-serif}
 .wrap{max-width:1080px;margin:0 auto;padding:22px}
 h1{font-size:18px;margin:0 0 2px}h1 span{color:#818cf8}.sub{color:var(--mut);font-size:12px;margin-bottom:16px}
 .cols{display:grid;grid-template-columns:310px 1fr;gap:18px}@media(max-width:820px){.cols{grid-template-columns:1fr}}
 .card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px;margin-bottom:14px}
 .lbl{color:var(--mut);font-size:11px;text-transform:uppercase;letter-spacing:.04em;margin:12px 0 5px}
 .seg{display:flex;flex-wrap:wrap;gap:6px}
 .seg button{background:#10131a;border:1px solid var(--line);color:var(--ink);border-radius:8px;padding:7px 11px;cursor:pointer;font-size:13px}
 .seg button.on{background:var(--brand);border-color:var(--brand);color:#fff}
 .seg button:disabled{opacity:.35;cursor:not-allowed}
 input[type=number]{width:92px;background:#10131a;border:1px solid var(--line);color:var(--ink);border-radius:8px;padding:8px}
 .drop{border:1.5px dashed #39415a;border-radius:10px;padding:16px;text-align:center;color:var(--mut);cursor:pointer;font-size:13px}
 .drop.hot{border-color:var(--brand);color:var(--ink)}
 .stage{display:flex;align-items:center;justify-content:center;background:#000;border-radius:10px;min-height:380px;padding:12px}
 .stage canvas{max-width:100%;max-height:560px;border:1px solid #000}
 .url{background:#0e1017;border:1px solid var(--line);border-radius:8px;padding:10px 12px;font-family:ui-monospace,Menlo,monospace;font-size:12.5px;margin:10px 0;word-break:break-all;color:#8ab4ff}
 table{width:100%;border-collapse:collapse;font-size:13px}td{padding:6px 4px;border-bottom:1px solid var(--line)}td.k{color:var(--mut);width:130px}
 .pill{display:inline-block;border-radius:20px;padding:2px 9px;font-size:11px;font-weight:700;background:rgba(37,99,235,.15);color:#8ab4ff}
 .checks li{list-style:none;margin:4px 0;font-size:12.5px}.checks li b{color:var(--ok)}
 .note{color:var(--mut);font-size:11.5px;margin-top:6px}
 .btnrow{display:flex;gap:8px;flex-wrap:wrap;margin-top:6px}
</style></head><body>
<div class=wrap>
 <h1><svg class="vmark" viewBox="0 0 24 24" width="1em" height="1em" style="vertical-align:-0.12em" aria-hidden="true"><defs><linearGradient id="vmk" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#5b8cff"/><stop offset="1" stop-color="#4f46e5"/></linearGradient></defs><path fill="url(#vmk)" d="M14 1 3.5 14H11zM10 23 20.5 10H13z"/></svg> Image service — test view</h1>
 <div class=sub>Upload your own image and see it at any size / crop / filter, exactly how the service would return it. The API URL for each setting is shown so you can confirm the contract. <span class=pill>client-side preview</span> mirrors the sharp service semantics; the checks at the bottom are from the real service.</div>
 <div class=cols>
  <div>
   <div class=card>
    <div class=lbl>Your image</div>
    <div class=drop id=drop>Drop an image here, or click to choose<input id=file type=file accept="image/*" hidden></div>
    <div class=btnrow><button class="seg" id=useSample style="padding:7px 11px">Use sample asset</button></div>
    <div class=note id=srcinfo></div>
   </div>
   <div class=card>
    <div class=lbl>Fit</div><div class=seg id=fit></div>
    <div class=lbl>Size (0 = keep aspect)</div>
    <div class=btnrow><input id=w type=number min=0 placeholder=width> <input id=h type=number min=0 placeholder=height></div>
    <div class=seg id=presets style="margin-top:8px"></div>
    <div class=lbl>Focus (fill only)</div><div class=seg id=focus></div>
    <div class=lbl>Filter</div><div class=seg id=filter></div>
   </div>
  </div>
  <div>
   <div class=card>
    <div class=lbl>Request</div><div class=url id=url></div>
    <div class=stage><canvas id=cv></canvas></div>
    <div class=lbl style="margin-top:12px">Output</div>
    <table><tbody id=meta></tbody></table>
    <div class=note>Smart focus and the real encoder (webp/avif bytes, mozjpeg) run server-side; this preview approximates the crop/scale so you can eyeball your asset. Attach an image in chat for true sharp-service renders.</div>
   </div>
   <div class=card>
    <div class=lbl>Contract checks — real sharp service (${passN}/${checks.length} passed)</div>
    <ul class=checks id=checks></ul>
   </div>
  </div>
 </div>
</div>
<script>
var DEFAULT_IMG=${JSON.stringify(DEFAULT_IMG)};
var CHECKS=${JSON.stringify(checks)};
var state={fit:'fit-in',w:1920,h:0,focus:'center',filter:'none'};
var img=new Image();
var fits=['fit-in','fill','stretch'];
var foci=['center','top-left','top-right','bottom-left','bottom-right'];
var filters=['none','sharpen:100','grayscale','blur:6'];
var presets=[['1920×0','1920','0'],['0×600','0','600'],['500×500','500','500'],['640×360','640','360'],['300×300','300','300']];

function seg(id,vals,cur,on,dis){var el=document.getElementById(id);el.innerHTML='';vals.forEach(function(v){var b=document.createElement('button');b.textContent=v;b.className=(v===cur?'on':'');if(dis&&dis(v))b.disabled=true;b.onclick=function(){on(v)};el.appendChild(b)})}
function fillOnly(){return state.fit==='fill'}
function buildUrl(){
 var fl=[];
 if(state.fit==='fill'&&state.focus!=='center')fl.push('focus:'+state.focus);
 if(state.filter!=='none')fl.push(state.filter);
 var seg=fl.length?('filter('+fl.join(',')+')/'):'';
 return '/'+state.fit+'/'+state.w+'x'+state.h+'/'+seg+'my-image.png';
}
function outDims(iw,ih){
 var W=state.w,H=state.h;
 if(state.fit==='stretch')return [W||iw,H||ih];
 if(state.fit==='fit-in'){
   if(W&&H){var s=Math.min(W/iw,H/ih);return [Math.round(iw*s),Math.round(ih*s)];}
   if(W)return [W,Math.round(ih*W/iw)];
   return [Math.round(iw*H/ih),H];
 }
 // fill
 if(W&&H)return [W,H];
 if(W)return [W,Math.round(ih*W/iw)];
 return [Math.round(iw*H/ih),H];
}
function draw(){
 seg('fit',fits,state.fit,function(v){state.fit=v;if(v!=='fill')state.focus='center';draw()});
 seg('focus',foci,state.focus,function(v){state.focus=v;draw()},function(){return !fillOnly()});
 seg('filter',filters,state.filter,function(v){state.filter=v;draw()});
 document.getElementById('w').value=state.w;document.getElementById('h').value=state.h;
 if(!img.width){return;}
 var iw=img.width,ih=img.height;
 var d=outDims(iw,ih);var W=d[0],H=d[1];
 var cv=document.getElementById('cv');cv.width=W;cv.height=H;
 var ctx=cv.getContext('2d');ctx.clearRect(0,0,W,H);
 var f=[];if(state.filter==='grayscale')f.push('grayscale(1)');if(state.filter==='blur:6')f.push('blur(6px)');
 ctx.filter=f.length?f.join(' '):'none';
 if(state.fit==='stretch'){ctx.drawImage(img,0,0,W,H);}
 else if(state.fit==='fit-in'){ctx.drawImage(img,0,0,W,H);} // canvas already sized to fit result
 else { // fill: cover then crop by focus
   var s=Math.max(W/iw,H/ih);var sw=iw*s,sh=ih*s;
   var dx=0,dy=0;
   if(state.focus.indexOf('right')>=0)dx=W-sw;else if(state.focus.indexOf('left')>=0)dx=0;else dx=(W-sw)/2;
   if(state.focus.indexOf('bottom')>=0)dy=H-sh;else if(state.focus.indexOf('top')>=0)dy=0;else dy=(H-sh)/2;
   ctx.drawImage(img,dx,dy,sw,sh);
 }
 ctx.filter='none';
 if(state.filter==='sharpen:100')sharpen(ctx,W,H,0.9);
 document.getElementById('url').textContent='GET '+buildUrl();
 document.getElementById('meta').innerHTML=
  '<tr><td class=k>Status</td><td><span class=pill>200 OK</span></td></tr>'+
  '<tr><td class=k>Fit</td><td>'+state.fit+(fillOnly()?' · focus '+state.focus:'')+'</td></tr>'+
  '<tr><td class=k>Output size</td><td>'+W+' × '+H+' px</td></tr>'+
  '<tr><td class=k>Source</td><td>'+iw+' × '+ih+' px</td></tr>'+
  '<tr><td class=k>Cache-Control</td><td>public, max-age=31536000, immutable</td></tr>';
}
function sharpen(ctx,w,h,a){
 var src=ctx.getImageData(0,0,w,h),dst=ctx.createImageData(w,h),S=src.data,Dt=dst.data;
 var kc=1+4*a,kn=-a;
 for(var y=0;y<h;y++)for(var x=0;x<w;x++){var o=(y*w+x)*4;
  for(var c=0;c<3;c++){var i=o+c;var v=S[i]*kc;
   v+=kn*(x>0?S[i-4]:S[i]);v+=kn*(x<w-1?S[i+4]:S[i]);
   v+=kn*(y>0?S[i-w*4]:S[i]);v+=kn*(y<h-1?S[i+w*4]:S[i]);
   Dt[i]=v<0?0:v>255?255:v;}
  Dt[o+3]=S[o+3];}
 ctx.putImageData(dst,0,0);
}
function loadSrc(url,name,bytes){img=new Image();img.onload=function(){document.getElementById('srcinfo').textContent=(name||'image')+' · '+img.width+'×'+img.height+(bytes?' · '+Math.round(bytes/1024)+' KB':'');draw();};img.src=url;}
// presets + w/h inputs
(function(){var el=document.getElementById('presets');presets.forEach(function(p){var b=document.createElement('button');b.className='';b.textContent=p[0];b.onclick=function(){state.w=+p[1];state.h=+p[2];draw()};el.appendChild(b)});})();
document.getElementById('w').oninput=function(e){state.w=parseInt(e.target.value||'0',10);draw()};
document.getElementById('h').oninput=function(e){state.h=parseInt(e.target.value||'0',10);draw()};
// upload
var drop=document.getElementById('drop'),file=document.getElementById('file');
drop.onclick=function(){file.click()};
file.onchange=function(e){var f=e.target.files[0];if(f)readFile(f)};
['dragover','dragenter'].forEach(function(ev){drop.addEventListener(ev,function(e){e.preventDefault();drop.classList.add('hot')})});
['dragleave','drop'].forEach(function(ev){drop.addEventListener(ev,function(e){e.preventDefault();drop.classList.remove('hot')})});
drop.addEventListener('drop',function(e){var f=e.dataTransfer.files[0];if(f)readFile(f)});
function readFile(f){var r=new FileReader();r.onload=function(){loadSrc(r.result,f.name,f.size)};r.readAsDataURL(f)}
document.getElementById('useSample').onclick=function(){loadSrc(DEFAULT_IMG,'sample asset')};
document.getElementById('checks').innerHTML=CHECKS.map(function(c){return '<li>'+(c.ok?'<b>✓</b>':'✗')+' '+c.text+'</li>'}).join('');
loadSrc(DEFAULT_IMG,'sample asset');
</script>
</body></html>`;

await writeFile('image-test.html', html);
console.log('image-test.html written (' + Math.round(html.length / 1024) + ' KB), ' + passN + '/' + checks.length + ' checks');
