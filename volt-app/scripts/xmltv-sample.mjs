#!/usr/bin/env node
/* ============================================================================
 *  SAMPLE XMLTV GUIDE FOR TESTING: "Berita News", a programme every 5 minutes.
 *
 *  For exercising the EPG end to end without a real guide provider: XMLTV
 *  import, now/next, the Live Streams timeline, programme markers and the
 *  in-stream Up next card (which, at 5-minute programmes, needs a lead under
 *  about 3.5 minutes: set the channel's "Up next appears" to 1 or 2 min).
 *
 *  No dependencies. Two ways to use it:
 *
 *  1. A FILE, for EPG -> XMLTV import -> upload:
 *       node scripts/xmltv-sample.mjs --out berita.xml
 *
 *  2. A HOSTED GUIDE that is always current (each request is generated fresh,
 *     so tomorrow it serves tomorrow):
 *       node scripts/xmltv-sample.mjs --serve 8099
 *     then add an XMLTV import source with URL
 *       http://localhost:8099/berita.xml              (single request, today)
 *       http://localhost:8099/berita.xml?days=7       (today + 6 days)
 *       http://localhost:8099/berita.xml?date={date}  (per_day mode, date format YYYY-MM-DD)
 *     If the control plane runs in Docker, use http://host.docker.internal:8099/...
 *
 *  Options:
 *    --tz <IANA zone>   the day and the times are in this zone (default: this
 *                       machine's zone). Every time carries its offset.
 *    --days <n>         days from today (default 1, the current day only)
 *    --date YYYY-MM-DD  start day instead of today
 *    --minutes <n>      programme length (default 5)
 *    --channel <id>     XMLTV channel id (default berita-news)
 *    --name <name>      display name (default "Berita News"). The importer maps
 *                       automatically when exactly one Volt channel has this
 *                       name, or has this id as its XMLTV id; otherwise pick the
 *                       channel once in the import's channel lineup.
 * ========================================================================= */
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']);
  return acc;
}, []));
const TZ = args.tz || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const MIN = Math.max(1, Math.min(120, Number(args.minutes) || 5));
const CH = args.channel || 'berita-news';
const NAME = args.name || 'Berita News';

// One hour of a news channel's running order, repeated. Malay first, English second
// (two <title> languages exercise the source's preferred-language setting).
const SHOWS = [
  ['Berita Utama', 'Headlines', 'Berita utama tempatan dan antarabangsa.', 'The top local and international stories.'],
  ['Laporan Cuaca', 'Weather', 'Ramalan cuaca untuk seluruh negara.', 'The forecast across the country.'],
  ['Sukan Hari Ini', 'Sport Today', 'Keputusan, sorotan dan berita sukan.', 'Results, highlights and sport news.'],
  ['Bisnes & Pasaran', 'Business & Markets', 'Pasaran saham, mata wang dan komoditi.', 'Shares, currencies and commodities.'],
  ['Dunia Hari Ini', 'World Today', 'Peristiwa utama dari seluruh dunia.', 'The main events around the world.'],
  ['Wawancara', 'The Interview', 'Perbualan bersama tetamu istimewa.', 'In conversation with a special guest.'],
  ['Teknologi', 'Tech', 'Berita teknologi dan inovasi terkini.', 'The latest in technology and innovation.'],
  ['Hiburan', 'Entertainment', 'Berita seni dan hiburan.', 'Arts and entertainment news.'],
  ['Trafik Semasa', 'Traffic', 'Keadaan jalan raya dan pengangkutan awam.', 'Roads and public transport.'],
  ['Berita Serantau', 'Regional News', 'Berita dari negeri-negeri dan rantau ASEAN.', 'From the states and across ASEAN.'],
  ['Sorotan', 'Spotlight', 'Liputan mendalam isu semasa.', 'An in-depth look at a current issue.'],
  ['Berita Ringkas', 'News in Brief', 'Ringkasan berita sebelum jam baharu.', 'A round-up before the hour.'],
];
const CATS = ['News', 'Weather', 'Sports', 'Business', 'News', 'Talk', 'Technology', 'Entertainment', 'News', 'News', 'Documentary', 'News'];

/** The zone's offset at an instant, in minutes east of UTC. */
function offsetMin(at) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(at).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / 60000);
}
/** Local midnight of a calendar day in the zone, as an instant. */
function midnight(y, m, d) {
  const guess = new Date(Date.UTC(y, m - 1, d));
  return new Date(guess.getTime() - offsetMin(guess) * 60000);
}
/** Today's date in the zone. */
function todayInZone() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date()).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
/** XMLTV time: YYYYMMDDhhmmss +HHMM, in the zone. */
function xmltvTime(at) {
  const off = offsetMin(at);
  const l = new Date(at.getTime() + off * 60000);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const sign = off >= 0 ? '+' : '-', a = Math.abs(off);
  return `${l.getUTCFullYear()}${pad(l.getUTCMonth() + 1)}${pad(l.getUTCDate())}${pad(l.getUTCHours())}${pad(l.getUTCMinutes())}00 ${sign}${pad(Math.floor(a / 60))}${pad(a % 60)}`;
}
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const hhmm = (at) => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);

export function guide(startDate = todayInZone(), days = 1) {
  const [y, m, d] = startDate.split('-').map(Number);
  const out = [];
  out.push('<?xml version="1.0" encoding="UTF-8"?>');
  out.push('<!DOCTYPE tv SYSTEM "xmltv.dtd">');
  out.push(`<tv generator-info-name="volt xmltv-sample" source-info-name="Volt test guide (${esc(TZ)})">`);
  out.push(`  <channel id="${esc(CH)}">`);
  out.push(`    <display-name lang="ms">${esc(NAME)}</display-name>`);
  out.push(`    <icon src="https://picsum.photos/seed/${esc(CH)}/200/200"/>`);
  out.push('  </channel>');
  let n = 0;
  for (let day = 0; day < days; day++) {
    const start = midnight(y, m, d + day);
    const end = midnight(y, m, d + day + 1);           // 23 or 25 hours on a DST change, handled
    for (let t = start.getTime(); t < end.getTime(); t += MIN * 60000) {
      const at = new Date(t), stop = new Date(Math.min(t + MIN * 60000, end.getTime()));
      const slot = Math.floor(((t - start.getTime()) / 60000) / MIN);
      const k = slot % SHOWS.length;
      const [ms, en, dms, den] = SHOWS[k];
      n++;
      out.push(`  <programme start="${xmltvTime(at)}" stop="${xmltvTime(stop)}" channel="${esc(CH)}">`);
      out.push(`    <title lang="ms">${esc(ms)}</title>`);
      out.push(`    <title lang="en">${esc(en)}</title>`);
      out.push(`    <sub-title lang="ms">Edisi ${hhmm(at)}</sub-title>`);
      out.push(`    <desc lang="ms">${esc(dms)}</desc>`);
      out.push(`    <desc lang="en">${esc(den)}</desc>`);
      out.push(`    <category lang="en">${CATS[k]}</category>`);
      out.push(`    <icon src="https://picsum.photos/seed/berita-${k}/320/180"/>`);
      out.push(`    <episode-num system="onscreen">${hhmm(at)}</episode-num>`);
      out.push('  </programme>');
    }
  }
  out.push('</tv>');
  return { xml: out.join('\n') + '\n', count: n };
}

const days = Math.max(1, Math.min(21, Number(args.days) || 1));
if (args.serve) {
  const port = Number(args.serve === 'true' ? 8099 : args.serve);
  createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (!/\.xml$/.test(u.pathname)) { res.writeHead(404).end('try /berita.xml'); return; }
    const date = /^\d{4}-\d{2}-\d{2}$/.test(u.searchParams.get('date') || '') ? u.searchParams.get('date') : todayInZone();
    const d = Math.max(1, Math.min(21, Number(u.searchParams.get('days')) || days));
    const g = guide(date, d);
    res.writeHead(200, { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'no-store' }).end(g.xml);
    console.log(`${new Date().toISOString()} ${req.url} -> ${g.count} programmes from ${date} (${TZ})`);
  }).listen(port, () => console.log(`Berita News test guide: http://localhost:${port}/berita.xml  (${MIN}-minute programmes, zone ${TZ})`));
} else {
  const g = guide(args.date || todayInZone(), days);
  if (args.out && args.out !== 'true') {
    writeFileSync(args.out, g.xml);
    console.log(`wrote ${args.out}: ${g.count} programmes, ${days} day(s) from ${args.date || todayInZone()} in ${TZ}`);
  } else process.stdout.write(g.xml);
}
