// ============================================================================
//  SCTE-35 ON LIVE STREAMS: every ad break (Go to break, the API, a FAST
//  break) carries the cue every downstream ad inserter reads.
//
//    HLS   EXT-X-DATERANGE with SCTE35-OUT (RFC 8216 4.3.2.7.1) and
//          EXT-X-CUE-OUT / CUE-OUT-CONT / CUE-IN on the segments it covers
//    DASH  an EventStream urn:scte:scte35:2014:xml+bin, the cue as base64 in
//          Signal/Binary (SCTE 214-1)
//
//  The bytes are built by services/graphicTriggers.ts (breakCue) and placed by
//  the encoder (volt-encoder/bin/timed_events.py). This suite runs the whole
//  path: a break row in Postgres, the timed-events endpoint the encoder polls,
//  and the REAL encoder placement code on a live playlist and MPD written
//  around now; then reads the cues back and decodes them. Players: the Volt
//  SDK's own trigger reader must still see one ad break and nothing else.
//  The placement details on captured manifests are test_timed_events.py.
//
//  Usage: DATABASE_URL=... npx tsx test/live-scte35.check.ts
// ============================================================================
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pool, query } from '../src/db';
import { buildTriggers, hlsTag, wireFormat, dashScte35, breakCue, DEFAULT_GRAPHICS, SCHEME_SCTE35 } from '../src/services/graphicTriggers';
import { decode, eventIdFor } from '../src/services/fast/scte35';
import { fromHlsRegions, fromDashRegion } from '../../volt-player/src/sdk/triggers';

let pass = 0, fail = 0;
const ok = (m: string) => { console.log('PASS ' + m); pass++; };
const bad = (m: string, d: string) => { console.log(`FAIL ${m} -- ${d}`); fail++; };
const check = (m: string, got: unknown, want: unknown) =>
  JSON.stringify(got) === JSON.stringify(want) ? ok(m) : bad(m, `expected [${JSON.stringify(want)}] got [${JSON.stringify(got)}]`);

const T = (hhmm: string) => new Date(`2026-10-20T${hhmm}:00.000Z`);

/** The attribute list of a DATERANGE, by the RFC's grammar: quoted strings, hex, decimals, enums. */
function attrs(tag: string): Record<string, string> | null {
  const body = tag.replace(/^#EXT-X-DATERANGE:/, '');
  const re = /([A-Z0-9-]+)=("[^"\r\n]*"|0[xX][0-9A-Fa-f]+|-?[0-9]+(?:\.[0-9]+)?|[^",\s]+)(,|$)/y;
  const out: Record<string, string> = {};
  let m: RegExpExecArray | null;
  while (re.lastIndex < body.length && (m = re.exec(body))) out[m[1]] = m[2];
  return re.lastIndex === body.length ? out : null;
}

(async () => {
  console.log('== the cue a break carries ==');
  const day = [{ id: 'p1', title: 'Match', startsAt: T('18:00'), endsAt: T('20:00') }];
  const all = buildTriggers(day, DEFAULT_GRAPHICS, [
    { id: 'b-1', start: T('18:30'), durationSec: 90, source: 'manual' },
    { id: 'b-2', start: T('19:10'), durationSec: 60, source: 'scte35', scteEventId: 777 },
  ]);
  const b1 = all.find((t) => t.id === 'brk:b-1')!;
  const b2 = all.find((t) => t.id === 'brk:b-2')!;
  check('a break trigger carries a SCTE-35 pair', !!b1.scte35 && /^0x[0-9A-F]+$/.test(b1.scte35.out) && /^0x[0-9A-F]+$/.test(b1.scte35.in), true);
  const out = decode(b1.scte35!.out);
  check('the out is a valid splice_info_section (CRC-32 checks)', out.crcOk, true);
  check('a splice_insert', out.command, 'splice_insert');
  check('out of network', out.out, true);
  check('splice immediate: the carrier gives the moment, no guessed PTS', [out.immediate, out.pts], [true, null]);
  check('with the break length', out.durationSec, 90);
  check('and auto return', out.autoReturn, true);
  check('its splice_event_id is stable for the break (the same hash FAST uses)', out.eventId, eventIdFor('b-1'));
  check('a break that came with its own event id keeps it', decode(b2.scte35!.out).eventId, 777);
  const back = decode(b1.scte35!.in);
  check('the in is valid too, back to the network, same event', [back.crcOk, back.out, back.immediate, back.eventId], [true, false, true, eventIdFor('b-1')]);
  check('the same break gives the same bytes every poll (players dedupe on them)', breakCue('b-1', 90).out, b1.scte35!.out);
  check('programme and graphic triggers carry none', all.filter((t) => t.graphic !== 'ad-break').every((t) => !t.scte35), true);

  console.log('\n== HLS: the DATERANGE ==');
  const line = hlsTag(b1);
  const a = attrs(line);
  check('the tag still parses by the attribute grammar', a != null, true);
  check('SCTE35-OUT as an unquoted hex sequence (the RFC type)', a?.['SCTE35-OUT'], b1.scte35!.out);
  check('PLANNED-DURATION beside DURATION', [a?.['PLANNED-DURATION'], a?.DURATION], ['90.000', '90.000']);
  check('class and start unchanged', [a?.CLASS, a?.['START-DATE']], ['"com.boomlabs.volt.ad"', '"2026-10-20T18:30:00.000Z"']);
  check('no SCTE35-IN on the same tag (the out returns by itself; one tag per break)', 'SCTE35-IN' in (a ?? {}), false);
  check('a programme tag has no SCTE35 attribute', /SCTE35/.test(hlsTag(all.find((t) => t.id === 'p1')!)), false);

  console.log('\n== DASH: the event ==');
  const d = dashScte35(b1)!;
  check('the scte35 binary scheme', d.schemeIdUri, SCHEME_SCTE35);
  check('Event@id is the splice_event_id', d.id, out.eventId);
  check('the break window', [d.start, d.durationMs], ['2026-10-20T18:30:00.000Z', 90000]);
  const b64 = /<Binary>([^<]+)<\/Binary>/.exec(d.xml)?.[1] ?? '';
  check('Signal/Binary holds the same bytes, base64', '0x' + Buffer.from(b64, 'base64').toString('hex').toUpperCase(), b1.scte35!.out);
  check('a non-break trigger has no SCTE-35 event', dashScte35(all.find((t) => t.id === 'p1')!), null);
  const wf: any = wireFormat(b1);
  check('the encoder is handed the pair and the DASH event', [wf.scte35?.out, wf.scte35?.in, wf.scte35?.dash?.schemeIdUri], [b1.scte35!.out, b1.scte35!.in, SCHEME_SCTE35]);
  check('a programme on the wire has no scte35 key', 'scte35' in wireFormat(all.find((t) => t.id === 'p1')!), false);

  console.log('\n== players: the Volt SDK still sees one ad break ==');
  // Shaka splits a DATERANGE into a region per attribute (player-triggers.check.ts).
  const regions = Object.entries(a!).filter(([k]) => !['ID', 'CLASS', 'START-DATE', 'DURATION'].includes(k))
    .map(([key, v]) => ({ startTime: 10, endTime: 100, metadataType: 'com.boomlabs.volt.ad', payload: { key, data: v.replace(/^"|"$/g, '') } }));
  const g = fromHlsRegions(regions);
  check('the new attributes regroup into the same single graphic', g.length, 1);
  check('still an ad break that hides graphics', [g[0]?.graphic, g[0]?.data.hide_graphics], ['ad-break', 'all']);
  check('the SDK does not mistake the SCTE-35 event for one of ours', fromDashRegion({ schemeIdUri: SCHEME_SCTE35, startTime: 10, endTime: 100 }), null);

  console.log('\n== end to end: a break row, the endpoint, the encoder ==');
  const A = '00000000-0000-0000-0000-0000000035a1', PR = '00000000-0000-0000-0000-0000000035a2';
  const G = '00000000-0000-0000-0000-0000000035a3', C = '00000000-0000-0000-0000-0000000035a4';
  await query(`DELETE FROM accounts WHERE id = $1`, [A]);
  await query(`INSERT INTO accounts(id,name) VALUES ($1,'CueCo')`, [A]);
  await query(`INSERT INTO output_profiles(id,account_id,name,rungs,workflow_type) VALUES ($1,$2,'p','[{"height":720,"bitrate_kbps":2500}]','transcode')`, [PR, A]);
  await query(`INSERT INTO groups(id,account_id,name,output_profile_id,max_channels,max_concurrent) VALUES ($1,$2,'g',$3,5,5)`, [G, A, PR]);
  await query(`INSERT INTO channels(id,group_id,name,status,kind) VALUES ($1,$2,'Cue TV','live','tv')`, [C, G]);
  // Segments of 4 s on a clock that starts on a whole 4 s, so the break edges
  // fall at known points: 20 s in, 30 s long.
  const t0 = Math.floor((Date.now() - 60_000) / 4000) * 4000;
  const bStart = new Date(t0 + 20_000);
  const brk = await query<any>(
    `INSERT INTO stream_breaks (channel_id, source, starts_at, duration_ms, position, hide_graphics, meta)
     VALUES ($1, 'manual', $2, 30000, 'live', true, '{}') RETURNING id`, [C, bStart.toISOString()]);
  const bid = String(brk[0].id);
  await query(`INSERT INTO stream_breaks (channel_id, source, starts_at, duration_ms, position, hide_graphics, meta, status)
     VALUES ($1, 'manual', $2, 30000, 'live', true, '{}', 'cancelled')`, [C, new Date(t0 + 40_000).toISOString()]);

  const { createServer } = await import('../src/server');
  const { config } = await import('../src/config');
  const app: any = createServer();
  const srv = app.listen(0);
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const r = await fetch(`${base}/api/streams/${C}/timed-events?kind=channel&from=${new Date(t0).toISOString()}&to=${new Date(t0 + 64_000).toISOString()}`,
    { headers: { 'X-Volt-Ingest-Token': config.ingestToken } });
  check('the encoder poll answers', r.status, 200);
  const body: any = await r.json();
  srv.close();
  const wb = body.triggers.filter((t: any) => t.graphic === 'ad-break');
  check('one break (the cancelled one is not cued)', wb.length, 1);
  check('it carries its SCTE-35 on the wire', !!wb[0]?.scte35?.out && decode(wb[0].scte35.out).crcOk, true);
  check('for this break', decode(wb[0]?.scte35?.out ?? '0xFC').eventId, eventIdFor(bid));

  // The real placement code, on a live playlist and MPD written around t0.
  const iso = (ms: number) => new Date(ms).toISOString();
  const segs = Array.from({ length: 16 }, (_, i) => `#EXT-X-PROGRAM-DATE-TIME:${iso(t0 + i * 4000)}\n#EXTINF:4.000,\nseg_${i}.m4s`).join('\n');
  const playlist = `#EXTM3U\n#EXT-X-VERSION:6\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-MAP:URI="init.mp4"\n${segs}\n`;
  const mpd = `<?xml version="1.0" encoding="UTF-8"?>\n<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="dynamic" availabilityStartTime="${iso(t0)}" timeShiftBufferDepth="PT120S" minimumUpdatePeriod="PT4S" profiles="urn:mpeg:dash:profile:isoff-live:2011"><Period id="0" start="PT0S"><AdaptationSet mimeType="video/mp4" segmentAlignment="true"><SegmentTemplate timescale="1000" duration="4000" initialization="init.mp4" media="seg_$Number$.m4s" startNumber="0"/><Representation id="v" bandwidth="1000000" codecs="avc1.64001f" width="1280" height="720"/></AdaptationSet></Period></MPD>`;
  const py = `
import json, sys
sys.path.insert(0, sys.argv[1])
import timed_events as te
inp = json.load(sys.stdin)
items = []
for t in inp["triggers"]:
    s = te._parse_iso(t["start"]); d = t.get("duration")
    items.append({**t, "_start": s, "_end": s + float(d) if d is not None else float("inf")})
print(json.dumps({"hls": te.inject_hls(inp["playlist"], items), "mpd": te.inject_mpd(inp["mpd"], items, now=inp["now"])}))
`;
  const run = spawnSync('python3', ['-c', py, join(__dirname, '..', '..', 'volt-encoder', 'bin')],
    { input: JSON.stringify({ triggers: body.triggers, playlist, mpd, now: (t0 + 60_000) / 1000 }), encoding: 'utf8' });
  let placed: any = null;
  try { placed = JSON.parse(run.stdout); } catch { /* reported below */ }
  check('the encoder placement ran', placed != null, true);
  if (!placed) console.log(run.stderr);
  const hl = String(placed?.hls ?? '').split('\n');
  const before = (uri: string) => { const i = hl.indexOf(uri); const o: string[] = []; for (let j = i - 1; j >= 0 && !(hl[j] && !hl[j].startsWith('#')); j--) if (hl[j].startsWith('#EXT-X-CUE')) o.unshift(hl[j]); return o; };
  const dr = hl.find((l) => l.startsWith('#EXT-X-DATERANGE:') && l.includes(`brk:${bid}`)) ?? '';
  check('the delivered playlist has the break DATERANGE at the break time', attrs(dr)?.['START-DATE'], `"${bStart.toISOString()}"`);
  check('its SCTE35-OUT decodes to this break, 30 s, auto return', (() => { const c = decode(attrs(dr)?.['SCTE35-OUT'] ?? '0xFC'); return [c.crcOk, c.out, c.durationSec, c.autoReturn, c.eventId]; })(), [true, true, 30, true, eventIdFor(bid)]);
  check('CUE-OUT on the segment that starts at the break (seg_5, 20 s)', before('seg_5.m4s'), ['#EXT-X-CUE-OUT:DURATION=30.000']);
  check('CUE-OUT-CONT through it', [before('seg_6.m4s'), before('seg_11.m4s')], [['#EXT-X-CUE-OUT-CONT:ElapsedTime=4.000,Duration=30.000'], ['#EXT-X-CUE-OUT-CONT:ElapsedTime=24.000,Duration=30.000']]);
  // 20 s + 30 s = 50 s: seg_12 (48..52 s) has its midpoint on the edge, so it is back.
  check('CUE-IN at the end (seg_12, midpoint at the break end)', before('seg_12.m4s'), ['#EXT-X-CUE-IN']);
  check('one out, one in, no cue for the cancelled break', [hl.filter((l) => l.startsWith('#EXT-X-CUE-OUT:')).length, hl.filter((l) => l === '#EXT-X-CUE-IN').length], [1, 1]);
  const ev = /<EventStream schemeIdUri="urn:scte:scte35:2014:xml\+bin" value="com\.boomlabs\.volt" timescale="1000"><Event id="(\d+)" presentationTime="(\d+)" duration="(\d+)"><Signal xmlns="http:\/\/www\.scte\.org\/schemas\/35\/2016"><Binary>([^<]+)<\/Binary><\/Signal><\/Event><\/EventStream>/.exec(String(placed?.mpd ?? ''));
  check('the delivered MPD has a SCTE-35 EventStream', ev != null, true);
  check('at 20 s into the Period, 30 s long, Event@id the splice_event_id', ev ? [Number(ev[2]), Number(ev[3]), Number(ev[1])] : null, [20000, 30000, eventIdFor(bid)]);
  check('its Binary decodes to the same cue', ev ? decode(ev[4]).eventId === eventIdFor(bid) && decode(ev[4]).crcOk : false, true);
  check('placed before the AdaptationSet (schema order)', String(placed?.mpd ?? '').indexOf('urn:scte:scte35') < String(placed?.mpd ?? '').indexOf('<AdaptationSet'), true);

  await query(`DELETE FROM accounts WHERE id = $1`, [A]);
  console.log(`\n${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error(e); await pool.end().catch(() => {}); process.exit(1); });
