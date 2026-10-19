#!/usr/bin/env node
// Data-source adapter sketch: poll a JSON (or RSS) URL, map fields, PATCH the
// binding's state only when a mapped value changes. The same PATCH an operator
// panel or a sports-feed webhook would send.
//
//   node sidecar/feed_poller.js --url https://feed/match/123.json --every 2 \
//        --map homeScore=score.home,awayScore=score.away,clock=clock.display \
//        --target http://127.0.0.1:8090/state
//   node sidecar/feed_poller.js --rss https://site/rss.xml --every 60 --target http://127.0.0.1:8091/state
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const url = arg('url'), rss = arg('rss'), every = +arg('every', 2) * 1000;
const target = arg('target', 'http://127.0.0.1:8090/state');
const map = Object.fromEntries((arg('map', '') || '').split(',').filter(Boolean).map(kv => kv.split('=')));
const get = (o, p) => p.split('.').reduce((a, k) => (a == null ? a : a[/^\d+$/.test(k) ? +k : k]), o);
let last = {};

async function tick() {
  try {
    const r = await fetch(url || rss, { headers: { 'cache-control': 'no-cache' } });
    let next;
    if (rss) {
      const xml = await r.text();
      next = { items: [...xml.matchAll(/<item>[\s\S]*?<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/g)].slice(0, 10).map(m => m[1].trim()) };
    } else {
      const j = await r.json();
      next = Object.fromEntries(Object.entries(map).map(([f, p]) => [f, get(j, p)]));
    }
    const diff = Object.fromEntries(Object.entries(next).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(last[k])));
    if (Object.keys(diff).length) {
      await fetch(target, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(diff) });
      console.log(new Date().toISOString(), 'PATCH', JSON.stringify(diff));
      Object.assign(last, diff);
    }
  } catch (e) { console.error('poll failed:', e.message); }   // a dead feed holds the last state
  setTimeout(tick, every);
}
tick();
