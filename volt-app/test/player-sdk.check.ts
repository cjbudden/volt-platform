// ============================================================================
//  THE PLAYER SDK'S RULES, without a browser (docs/PLAYER_SDK.md).
//
//  Up next, start over, the programme at the playhead, the quality menu,
//  playlists and theme tokens are pure functions in volt-player/src/sdk, so
//  they are checked here, and the native SDKs port these exact cases.
//
//  Usage: npx tsx test/player-sdk.check.ts
// ============================================================================
import {
  upNextFor, startOverTarget, canStartOver, programmeAt, programmeAfter, cleanSchedule,
  qualityList, normalizePlaylist, sourceKind, fmtTime,
} from '../../volt-player/src/sdk/schedule';
import { resolveTheme, inkFor, contrast, themeFromConfig, themeVars } from '../../volt-player/src/sdk/theme';
import { splitCountdown, eventIcs } from '../../volt-player/src/sdk/skins/event';
import { fmtPrice, fmtTerm, fillUrl } from '../../volt-player/src/sdk/resolver';

let pass = 0, fail = 0;
const ok = (c: unknown, m: string, d?: unknown) => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log('FAIL ' + m + (d !== undefined ? ` -- ${JSON.stringify(d)}` : '')); } };

const H = 3600_000;
const T = Date.UTC(2026, 9, 17, 12, 0, 0);
const sched = cleanSchedule([
  { id: 'b', title: 'Science Hour', startsAt: T + H, endsAt: T + 2 * H },
  { id: 'a', title: 'News', startsAt: T, endsAt: T + H },
  { id: 'x', title: 'bad', startsAt: T + 5 * H, endsAt: T + 4 * H },
  { id: 'a', title: 'dupe', startsAt: T, endsAt: T + H },
  { id: 'c', title: 'Film', startsAt: T + 3 * H, endsAt: T + 5 * H },
]);

// --- schedule ---
ok(sched.map((p) => p.id).join() === 'a,b,c', 'the guide is sorted, de-duplicated and invalid rows dropped', sched.map((p) => p.id));
ok(programmeAt(sched, T + 30 * 60_000)?.id === 'a', 'the programme at an instant');
ok(programmeAt(sched, T + 2.5 * H) === null, 'a gap in the guide is no programme');
ok(programmeAfter(sched, T + H - 1)?.id === 'b', 'the next programme');

// --- up next: VOD ---
const vod = (currentTime: number, extra: Partial<Parameters<typeof upNextFor>[0]> = {}) => upNextFor({
  hasNextItem: true, nextItem: { id: 'n', title: 'Episode 2' }, currentTime, duration: 600, live: false,
  programme: null, nextProgramme: null, playheadClock: null, seconds: 15, autoAdvance: true, dismissed: false, ...extra,
});
ok(vod(500) === null, 'no up-next card well before the end');
const u = vod(590);
ok(u?.kind === 'item' && u.title === 'Episode 2' && u.inMs === 10_000 && u.autoAdvance && u.totalMs === 15_000, 'the card shows in the last 15 s with the countdown', u);
ok(vod(590, { dismissed: true }) === null, 'cancelled stays cancelled');
ok(vod(590, { hasNextItem: false }) === null, 'nothing next, no card');
ok(vod(20, { duration: 25 }) === null, 'an item shorter than twice the window gets no card');
ok(vod(590, { autoAdvance: false })?.autoAdvance === false, 'auto-advance off is carried to the card');

// --- up next: live programme ---
const live = (clock: number, next = sched[1]) => upNextFor({
  hasNextItem: false, currentTime: 0, duration: NaN, live: true, programme: sched[0], nextProgramme: next,
  playheadClock: clock, seconds: 60, autoAdvance: true, dismissed: false,
});
ok(live(T + H - 30_000)?.title === 'Science Hour' && live(T + H - 30_000)?.kind === 'programme', 'live: the next programme is announced in the last minute');
ok(live(T + H - 30_000)?.autoAdvance === false, 'live: a programme never "auto-advances" (the channel moves on by itself)');
ok(live(T + 10 * 60_000) === null, 'live: not before the window');
ok(live(T + H - 30_000, { ...sched[2] }) === null, 'live: a programme that starts hours later is not "up next"');

// --- start over ---
const PS = T - 10 * 60_000; // media time 0 is ten minutes before the programme
ok(JSON.stringify(startOverTarget(T, PS, { start: 0, end: 1200 })) === JSON.stringify({ seconds: 600, clippedMs: 0 }), 'start over seeks to the programme start');
const clipped = startOverTarget(T, PS, { start: 700, end: 1900 });
ok(clipped?.seconds === 701 && clipped.clippedMs === 101_000, 'start older than the DVR window: the oldest point, and how much is missing', clipped);
ok(startOverTarget(T, null, { start: 0, end: 100 }) === null, 'no wall clock in the stream: no start over');
ok(canStartOver(sched[0], PS, { start: 0, end: 1200 }, true) === true, 'Start over is offered when the window reaches the start');
ok(canStartOver(sched[0], PS, { start: 700, end: 1900 }, true) === false, 'and not when it does not');
ok(canStartOver(sched[0], PS, { start: 0, end: 1200 }, false) === false, 'never for VOD');

// --- qualities ---
const q = qualityList([
  { id: 1, height: 720, width: 1280, bandwidth: 3_000_000 },
  { id: 2, height: 720, width: 1280, bandwidth: 2_500_000 },
  { id: 3, height: 1080, width: 1920, bandwidth: 6_000_000 },
  { id: 4, height: 360, width: 640, bandwidth: 800_000 },
  { id: 5, height: 2160, width: 3840, bandwidth: 15_000_000 },
]);
ok(q.map((x) => x.label).join() === '4K,1080p,720p,360p', 'one entry per height, highest first, 4K named', q.map((x) => x.label));
ok(q.find((x) => x.label === '720p')?.id === '1', 'the higher bitrate wins for a repeated height');
const aq = qualityList([{ id: 7, bandwidth: 128_000 }, { id: 8, bandwidth: 64_000 }]);
ok(aq.map((x) => x.label).join() === '128 kbps,64 kbps', 'an audio-only ladder is listed by bitrate');

// --- playlists ---
const pl = normalizePlaylist(['c6ffb359-4ce7-4e79-9817-778f69d418ba', 'https://cdn.example.com/show/ep1/master.m3u8', '', { id: 'x', title: 'X' }, { id: 'y', source: { mp3: 'https://r.example.com/live.mp3' } }]);
ok(pl.length === 4, 'ids, URLs, items with a source and titled items are kept; empties are not', pl);
ok(normalizePlaylist([{ id: 'z' } as any]).length === 0, 'an item with nothing to play and no title is dropped');
ok(pl[0].assetId === 'c6ffb359-4ce7-4e79-9817-778f69d418ba', 'a uuid is an asset id');
ok(pl[1].source?.url && pl[1].title === 'ep1', 'a URL is a source, titled from its path');
ok(sourceKind('https://x/a.m3u8?t=1') === 'hls' && sourceKind('https://x/a.mpd') === 'dash' && sourceKind('https://x/a.mp3') === 'mp3' && sourceKind('https://x/a.mp4') === 'mp4', 'source kind from the URL');
ok(fmtTime(65) === '1:05' && fmtTime(3725) === '1:02:05' && fmtTime(NaN) === '0:00', 'time formatting');

// --- theme ---
ok(inkFor('#ffffff') === '#0b0e13' && inkFor('#000000') === '#ffffff' && inkFor('#e11d48') === '#ffffff', 'text on a colour is black or white for contrast');
const th = resolveTheme({ primary: '#e11d48', secondary: '#f5f5f4', text: '#f6f6f6', radius: 99, upNextSeconds: 2, controls: { cast: false } });
ok(th.text === '#0b0e13', 'an unreadable text colour is replaced (light text on a light background)', th.text);
ok(contrast(th.text, th.background) >= 4.5, 'the chosen text is readable on the background');
ok(th.radius === 28 && th.upNextSeconds === 5, 'radius and up-next timing are clamped');
ok(th.controls.cast === false && th.controls.quality === true, 'control toggles merge over the defaults');
ok(resolveTheme({ primary: 'red' }).primary === '#3f7bff', 'a non-hex colour falls back to the default');
ok(resolveTheme({ logoUrl: 'javascript:alert(1)' }).logoUrl === null && resolveTheme({ logoUrl: '//evil.example/x.png' }).logoUrl === null, 'a logo must be http(s) or a path on this site');
ok(resolveTheme({ logoUrl: 'https://cdn.example.com/l.png' }).logoUrl === 'https://cdn.example.com/l.png', 'an https logo is kept');
ok(resolveTheme({ logoUrl: 'https://a/b.png' }, { logoUrl: null }).logoUrl === null, 'a later layer can clear the logo');
const fromCfg = resolveTheme(themeFromConfig({ primaryColor: '#112233', secondaryColor: '#ffffff', options: { theme: { radius: 4, controls: { schedule: false } } } }));
ok(fromCfg.primary === '#112233' && fromCfg.radius === 4 && fromCfg.controls.schedule === false, 'a saved player config resolves (colour columns + options.theme)');
ok(themeVars(fromCfg)['--vp-primary'] === '#112233' && themeVars(fromCfg)['--vp-radius'] === '4px', 'the theme becomes CSS variables');

// --- events: countdown, calendar, prices ---
const cd = splitCountdown(2 * 86400_000 + 3 * 3600_000 + 4 * 60_000 + 5_500);
ok(cd.d === 2 && cd.h === 3 && cd.m === 4 && cd.s === 5, 'the countdown splits into days, hours, minutes, seconds', cd);
ok(JSON.stringify(splitCountdown(-5)) === JSON.stringify({ d: 0, h: 0, m: 0, s: 0 }), 'a passed start counts zero, never negative');
const ics = eventIcs({ id: 'e1', title: 'Final; Lions, Tigers', startsAt: Date.UTC(2026, 9, 18, 9, 30), endsAt: null }, 'https://x.example/watch');
ok(ics.includes('DTSTART:20261018T093000Z') && ics.includes('DTEND:20261018T113000Z'), 'Add to calendar: UTC start, two hours when the end is unknown');
ok(ics.includes('SUMMARY:Final\\; Lions\\, Tigers') && ics.split('\r\n')[0] === 'BEGIN:VCALENDAR', 'calendar text is escaped and lines end CRLF');
ok(fmtTerm({ productKey: 'a', kind: 'period', count: 1, unit: 'day', priceCents: 0, currency: 'AUD' }) === '24 hours'
  && fmtTerm({ productKey: 'b', kind: 'period', count: 3, unit: 'month', priceCents: 0, currency: 'AUD' }) === '3 months'
  && fmtTerm({ productKey: 'c', kind: 'published_dates', priceCents: 0, currency: 'AUD' }) === 'This event', 'what a pass covers, in words');
ok(/14[.,]99/.test(fmtPrice(1499, 'AUD')), 'prices in the currency, from cents', fmtPrice(1499, 'AUD'));
ok(fillUrl('https://shop.example/buy?p={productKey}&a={assetId}&x={nope}', { productKey: 'final pass', assetId: 'e1' }) === 'https://shop.example/buy?p=final%20pass&a=e1&x=', 'the checkout URL template is filled and encoded');

console.log(`\nplayer-sdk: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
