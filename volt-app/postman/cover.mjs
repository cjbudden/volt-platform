import { readFileSync, writeFileSync } from 'node:fs';
const BASE='http://127.0.0.1:8080';
const routes = JSON.parse(readFileSync('/tmp/api/routes.json','utf8'));
const gets = routes.filter(([m]) => m==='GET').map(([,p])=>p);

// re-run the walk, but keep the URL list
const login = await (await fetch(BASE+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},
  body:JSON.stringify({email:'admin@rtm.example',password:'volt1234'})})).json();
const H = { authorization:'Bearer '+login.access, accept:'application/ld+json' };
const seen=new Map(), q=[[BASE+'/api',0]];
const isOurs=s=>typeof s==='string'&&s.startsWith(BASE);
function harvest(n,out){ if(n==null)return out;
  if(typeof n==='string'){ if(isOurs(n))out.push(n); return out; }
  if(Array.isArray(n)){ n.slice(0,3).forEach(v=>harvest(v,out)); return out; }
  if(typeof n==='object') for(const v of Object.values(n)) harvest(v,out);
  return out; }
while(q.length){ const [u,d]=q.shift(); if(seen.has(u)||d>5) continue;
  let r,t; try{ r=await fetch(u,{headers:H}); t=await r.text(); }catch{ seen.set(u,{s:'ERR'}); continue; }
  let b=null; try{ b=JSON.parse(t) }catch{}
  seen.set(u,{s:r.status});
  for(const n of harvest(b,[])) if(!seen.has(n)) q.push([n,d+1]);
}

// map a concrete URL back to a route pattern
const toPattern = (u) => {
  const path = new URL(u).pathname;
  const segs = path.split('/');
  for (const p of gets){
    const ps = p.split('/');
    if (ps.length !== segs.length) continue;
    if (ps.every((s,i) => s.startsWith(':') || s === segs[i])) return p;
  }
  return null;
};

const hit = new Set(), ok = new Set(), broke = [];
for (const [u,m] of seen){
  const p = toPattern(u);
  if (p) { hit.add(p); if (m.s===200) ok.add(p); }
  if (m.s>=400) broke.push([m.s, u.replace(BASE,'')]);
}
const miss = gets.filter(p => !hit.has(p));
console.log('GET route patterns in the API :', gets.length);
console.log('reachable by following links  :', hit.size, '(' + Math.round(hit.size/gets.length*100) + '%)');
console.log('   of those, returned 200     :', ok.size);
console.log('never reachable               :', miss.length);
console.log('\n--- links the API emitted that FAILED ---');
[...new Map(broke.map(b=>[b[1].replace(/[0-9a-f-]{36}/g,':id'),b])).values()]
  .forEach(([s,u]) => console.log('  ' + s + '  ' + u.replace(/[0-9a-f-]{36}/g,':id')));
console.log('\n--- a sample of what you can never find by walking ---');
const groups = {};
miss.forEach(p => { const k='/'+p.split('/')[2]; (groups[k] ||= []).push(p); });
Object.entries(groups).sort((a,b)=>b[1].length-a[1].length).slice(0,14)
  .forEach(([k,v]) => console.log(`  ${k.padEnd(22)} ${String(v.length).padStart(2)} unreachable  e.g. ${v[0]}`));
writeFileSync('/tmp/api/out/reached.json', JSON.stringify({reached:[...seen.keys()], hit:[...hit], miss}, null, 1));
