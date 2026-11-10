// ============================================================================
//  FAST GEO RIGHTS (services/fast/rights.ts, docs-site guides/fast.md
//  "Rights and where viewers can watch").
//
//  1. A title's rights on a FAST channel: the FAST use, the territories, the
//     blocked territories and the publishing plan's geo, combined to the
//     strictest; access removed airs nowhere.
//  2. The guide becomes programme rights: a window per restricted programme,
//     split at the rights window's edges, replaced with the geo replacement
//     (or blocked without one).
//  3. Through the shared edge decision: a viewer in each country gets the
//     channel, the replacement, or a refusal, at the right times.
//  4. The variant playlist of a FAST-shaped output (a new init at every part,
//     titles' own root-relative segments) swaps exactly the restricted
//     programme for the replacement's segments.
//    npx tsx test/fast-geo-rights.check.ts      (no database needed)
// ============================================================================
let pass = 0, fail = 0;
const check = (m: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { console.log('PASS ' + m); pass++ } else { console.log(`FAIL ${m} -- expected ${w} got ${g}`); fail++ }
};

(async () => {
  const fr = await import('../src/services/fast/rights');
  const er = await import('../src/services/edgeRights');
  const vm = await import('../src/services/variantManifest');
  const { OPEN } = await import('../src/services/rightsProfiles');

  // ---- 1. a title's restriction ----------------------------------------------------------------
  check('allow lists intersect, block lists are taken out',
    fr.combineGeo([{ mode: 'allow', countries: ['AU', 'NZ', 'GB'] }, { mode: 'allow', countries: ['NZ', 'AU'] }, { mode: 'block', countries: ['NZ'] }]),
    { mode: 'allow', countries: ['AU'] });
  check('block lists only: their union', fr.combineGeo([{ mode: 'block', countries: ['US'] }, null, { mode: 'block', countries: ['GB'] }]), { mode: 'block', countries: ['GB', 'US'] });
  check('nothing: open', fr.combineGeo([null, undefined]), null);
  const R = (x: Partial<typeof OPEN>) => ({ ...OPEN, ...x });
  check('open rights, no plan geo: everywhere', fr.fastRestriction(R({}), {}).geo, null);
  check('rights not cleared for FAST: nowhere', !!fr.fastRestriction(R({ uses: ['on_demand'] }), {}).nowhere, true);
  check('access removed: nowhere', !!fr.fastRestriction(R({}), { availability_state: 'withdrawn' }).nowhere, true);
  const r1 = fr.fastRestriction(R({ territoryMode: 'allow', territories: ['AU', 'NZ'], blockTerritories: ['NZ'] }), { availability: { geo: { mode: 'block', countries: ['FJ'] } } });
  check('territories AU, NZ, NZ blocked, plan blocks FJ: only AU', [r1.geo, r1.why], [{ mode: 'allow', countries: ['AU'] }, 'only in AU']);

  // ---- 2. the guide as programme rights --------------------------------------------------------
  const T0 = Date.UTC(2027, 0, 1, 20, 0, 0) / 1000;   // 20:00 UTC
  const H = 3600;
  const iso = (s: number) => new Date(s * 1000).toISOString();
  const GEO = '99999999-9999-9999-9999-999999999999';
  const prog = (id: string, from: number, to: number, assetId: string) => ({ id, title: id, starts_at: iso(from), ends_at: iso(to), assetId });
  const guide = [prog('film-au', T0, T0 + H, 'A'), prog('open', T0 + H, T0 + 2 * H, 'B'), prog('ends-mid', T0 + 2 * H, T0 + 3 * H, 'C')];
  const rs = new Map<string, any>([
    ['A', fr.fastRestriction(R({ territoryMode: 'allow', territories: ['AU', 'NZ'] }), {})],
    ['C', fr.fastRestriction(R({ until: new Date((T0 + 2.5 * H) * 1000) }), {})],
  ]);
  const pr = fr.fastProgrammeRights(guide, rs, GEO);
  check('one window for the AU/NZ film, none for the open title, one after the rights end mid-programme',
    pr.map((p) => [p.id, (new Date(p.starts_at).getTime() / 1000 - T0) / 60, (new Date(p.ends_at).getTime() / 1000 - T0) / 60, p.geo_mode, p.geo_countries]),
    [['film-au', 0, 60, 'allow', ['AU', 'NZ']], ['ends-mid:after', 150, 180, 'allow', []]]);
  check('...each replaced with the geo replacement', pr.every((p) => p.replacement_asset_id === GEO), true);
  check('without a geo replacement: windows with nothing to replace with (enforced as a block)', fr.fastProgrammeRights(guide, rs, null).every((p) => !p.replacement_asset_id && !p.replacement_kind), true);

  // ---- 3. the shared edge decision -------------------------------------------------------------
  const rules = er.compileEdgeRules({ account: null, channel: null, programmes: pr, variantService: true, nowSec: T0 - 60 });
  const at = (cc: string, min: number) => er.edgeDecision(rules, cc, '', T0 + min * 60).split(':')[0];
  check('20:30 the AU/NZ film: AU and NZ watch it, GB gets the replacement',
    [at('AU', 30), at('NZ', 30), at('GB', 30)], ['allow', 'allow', 'replace']);
  check('21:30 the open title: everyone', [at('AU', 90), at('GB', 90)], ['allow', 'allow']);
  check('22:15 the title still inside its rights: everyone; 22:45 after they end: everyone replaced',
    [at('AU', 135), at('AU', 165), at('GB', 165)], ['allow', 'replace', 'replace']);
  const noGeo = er.compileEdgeRules({ account: null, channel: null, programmes: fr.fastProgrammeRights(guide, rs, null), variantService: true, nowSec: T0 - 60 });
  check('no geo replacement: GB is refused for the film', er.edgeDecision(noGeo, 'GB', '', T0 + 1800), 'block');

  // ---- 4. a FAST-shaped variant ----------------------------------------------------------------
  // Two parts, 6 s segments: the restricted film (asset A) then the open title (asset B).
  const L = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:6', '#EXT-X-MEDIA-SEQUENCE:100', '#EXT-X-DISCONTINUITY-SEQUENCE:4'];
  let t = T0 + H - 60;          // the last minute of the film, then the open title
  L.push('#EXT-X-MAP:URI="/clips/vod/A/720p/init.mp4"');
  for (let i = 0; i < 10; i++) { L.push(`#EXT-X-PROGRAM-DATE-TIME:${iso(t)}`, '#EXTINF:6.000,', `/clips/vod/A/720p/seg_${i + 590}.m4s`); t += 6; }
  L.push('#EXT-X-DISCONTINUITY', '#EXT-X-MAP:URI="/clips/vod/B/720p/init.mp4"');
  for (let i = 0; i < 10; i++) { L.push(`#EXT-X-PROGRAM-DATE-TIME:${iso(t)}`, '#EXTINF:6.000,', `/clips/vod/B/720p/seg_${i + 1}.m4s`); t += 6; }
  const src = L.join('\n') + '\n';
  const loop = { segmentSeconds: 6, base: '', tracks: { '720p': { kind: 'video', init: '/clips/vod/G/ladders/g/6s-loud/720p/init.mp4', segments: Array.from({ length: 5 }, (_, k) => ({ uri: `/clips/vod/G/ladders/g/6s-loud/720p/seg_${k + 1}.m4s`, dur: 6 })) } } };
  const vars = er.streamVariants(pr, T0 - 60);
  const gb = vars.variants.find((v) => v.key === er.variantFor(rules?.vm, 'GB', ''))!;
  const out = vm.renderVariantMedia(src, { timeline: gb.timeline, loop, base: '/origin/F/fast/', emptyVtt: 'empty.vtt' });
  const uris = out.split('\n').filter((l) => l && !l.startsWith('#'));
  check('GB: the film\'s last minute is the replacement, the open title follows untouched',
    [uris.slice(0, 10).every((u) => u.includes('/G/')), uris.slice(10).every((u) => u.includes('/vod/B/'))], [true, true]);
  check('...the replacement loops in order (5 segments, twice)', uris.slice(0, 10).map((u) => Number(u.match(/seg_(\d+)/)![1])), [1, 2, 3, 4, 5, 1, 2, 3, 4, 5]);
  check('...same number of segments and media sequence', [uris.length, /#EXT-X-MEDIA-SEQUENCE:100/.test(out)], [20, true]);
  check('...the replacement\'s init inside the window, the title\'s own after it',
    [out.includes('#EXT-X-MAP:URI="/clips/vod/G/ladders/g/6s-loud/720p/init.mp4"'), out.includes('#EXT-X-MAP:URI="/clips/vod/B/720p/init.mp4"')], [true, true]);
  const au = vm.renderVariantMedia(src, { timeline: [], loop: null, base: '/origin/F/fast/', emptyVtt: 'empty.vtt' });
  check('AU (no window): the channel as it is', au.split('\n').filter((l) => l && !l.startsWith('#')), src.split('\n').filter((l) => l && !l.startsWith('#')));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
