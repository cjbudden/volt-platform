// ============================================================================
//  MEDIA LIBRARY VIEWS against Postgres and the real HTTP app: the new list
//  filters (content type, origin, completeness, missing required metadata,
//  resolution, codec, duration, date, search) and how they combine, the
//  facet counts, the encode facts the trigger keeps, the target metadata and
//  encode routes, and EPG auto-fill (preview, apply, never overwrite,
//  provenance, audit, bulk, ambiguous and no-guide cases, tenancy).
//
//  Usage: DATABASE_URL=... npx tsx test/vod-library.check.ts   (a migrated, disposable database)
// ============================================================================
let pass = 0, fail = 0;
const ok = (c: boolean, m: string, d = '') => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log(`FAIL ${m}${d ? ' -- ' + d : ''}`); } };

(async () => {
  // The encode and recording fixtures below write media; keep it out of the repo's own folders.
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  process.env.CLIPS_DIR ??= mkdtempSync(`${tmpdir()}/vodlib-clips-`);
  process.env.ORIGIN_DIR ??= mkdtempSync(`${tmpdir()}/vodlib-origin-`);
  const { createServer } = await import('../src/server');
  const { pool, one, query } = await import('../src/db');
  const { signAccess } = await import('../src/auth/jwt');
  const { ensureStandardTypes } = await import('../src/services/contentTypes');

  const tag = Date.now().toString(36);
  const acct = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`lib-${tag}`]))!.id;
  const other = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`lib-other-${tag}`]))!.id;
  const user = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [acct, `lib-${tag}@volt.test`]))!.id;
  const otherUser = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [other, `lib-o-${tag}@volt.test`]))!.id;
  await ensureStandardTypes(acct); await ensureStandardTypes(other);
  const T = async (k: string, a = acct) => (await one<any>(`SELECT id FROM metadata_schemas WHERE account_id=$1 AND standard_key=$2`, [a, k]))!.id;
  const [tEpisode, tMovie, tMatch, tClip] = [await T('episode'), await T('movie'), await T('sports-match'), await T('clip')];

  const prof = (await one<any>(`INSERT INTO output_profiles(account_id, name, rungs, workflow_type, codec_backend, packaging, drm_enabled, captions_enabled, caption_source_lang)
      VALUES ($1,'Live HD','[{"height":1080,"bitrate_kbps":5000},{"height":720,"bitrate_kbps":3000},{"height":540,"bitrate_kbps":1500}]','transcode','nvenc','both',false,true,'en') RETURNING id`, [acct]))!.id;
  const g = (await one<any>(`INSERT INTO groups(account_id, name, output_profile_id) VALUES ($1,'G',$2) RETURNING id`, [acct, prof]))!.id;
  const ch = (await one<any>(`INSERT INTO channels(group_id, name) VALUES ($1,'Harbour TV') RETURNING id`, [g]))!.id;
  const H = 3600_000, T0 = Date.parse('2026-10-18T18:00:00Z');
  const ev = (await one<any>(`INSERT INTO events(group_id, name, scheduled_start, scheduled_end) VALUES ($1,'Roosters v Storm',$2,$3) RETURNING id`, [g, new Date(T0), new Date(T0 + 3 * H)]))!.id;
  const og = (await one<any>(`INSERT INTO groups(account_id, name) VALUES ($1,'OG') RETURNING id`, [other]))!.id;
  const och = (await one<any>(`INSERT INTO channels(group_id, name) VALUES ($1,'Other TV') RETURNING id`, [og]))!.id;

  const asset = async (o: Record<string, any>) => (await one<any>(
    `INSERT INTO vod_assets(channel_id, event_id, account_id, source_kind, kind, title, master_key, start_epoch_ms, end_epoch_ms, duration_ms, schema_id, metadata, encode_result, availability_state, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,'m.m3u8',$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13,$14) RETURNING id`,
    [o.channel_id ?? null, o.event_id ?? null, o.account_id ?? null, o.source_kind ?? 'recording', o.kind ?? 'clip', o.title ?? null,
     o.start ?? 0, o.end ?? 60000, (o.end ?? 60000) - (o.start ?? 0), o.schema_id ?? null, JSON.stringify(o.metadata ?? {}),
     o.encode_result ? JSON.stringify(o.encode_result) : null, o.state ?? 'draft', o.created_at ?? new Date()]))!.id;
  // A1: a clip inside one programme. A2: a clip across two programmes. A3: an uploaded movie, fully described.
  // A4: a clip where the guide has nothing. A5: an event clip, a sports match missing its teams. X: another account.
  const A1 = await asset({ channel_id: ch, title: 'Harbour clip', start: T0 + 10 * 60_000, end: T0 + 40 * 60_000, schema_id: tEpisode, metadata: { title: 'Typed by hand' }, created_at: new Date('2026-10-18T19:00:00Z') });
  const A2 = await asset({ channel_id: ch, title: 'Straddle', start: T0 + 0.5 * H, end: T0 + 1.5 * H, schema_id: tEpisode, created_at: new Date('2026-10-18T20:00:00Z') });
  const A3 = await asset({ account_id: acct, source_kind: 'upload', kind: 'export', title: 'Feature', end: 5400_000, schema_id: tMovie, state: 'available',
    metadata: { title: 'Feature', description: 'A film.', year: 1994, genre: ['Drama'], cast: ['A'], director: 'D', rating: 'M', image: 'https://x.example/p.jpg' },
    encode_result: { ladder: { name: 'Std' }, segmentSeconds: 4, kept: [{ height: 1080, bitrate_kbps: 6000 }, { height: 720, bitrate_kbps: 3000 }], probe: { height: 1080, hasAudio: true } }, created_at: new Date('2026-10-01T10:00:00Z') });
  const A4 = await asset({ channel_id: ch, title: 'Quiet hour', start: T0 + 30 * H, end: T0 + 30.5 * H, schema_id: tClip, metadata: { headline: 'h' }, created_at: new Date('2026-10-19T08:00:00Z') });
  const A5 = await asset({ event_id: ev, title: 'Second half', start: T0 + H, end: T0 + 2 * H, schema_id: tMatch, metadata: { name: 'Roosters v Storm', sport: 'Rugby league' }, created_at: new Date('2026-10-18T21:00:00Z') });
  const X = await asset({ channel_id: och, title: 'Harbour clip elsewhere', start: T0, end: T0 + H });

  const prog = async (title: string, a: number, b: number, md: any, extra = '') => (await one<any>(
    `INSERT INTO programmes(channel_id, title, starts_at, ends_at, metadata${extra ? ', ' + extra.split('=')[0] : ''}) VALUES ($1,$2,$3,$4,$5::jsonb${extra ? `,'${extra.split('=')[1]}'` : ''}) RETURNING id`,
    [ch, title, new Date(T0 + a * H), new Date(T0 + b * H), JSON.stringify(md)]))!.id;
  const pHarbour = await prog('Harbour', 0, 1, { subTitle: 'The Pilot', description: 'It begins.', genre: 'Drama', season: 2, episodeNumber: 5, rating: 'M', icon: 'https://img.example/ep.jpg' });
  await prog('Late News', 1, 2, { description: 'The day in review.', genre: 'News' });

  const app: any = createServer();
  const srv = app.listen(0); const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const tok = signAccess({ sub: user, account_id: acct, role: 'owner' } as any);
  const tokOther = signAccess({ sub: otherUser, account_id: other, role: 'owner' } as any);
  const api = async (method: string, path: string, body?: any, token = tok) => {
    const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const t = await r.text(); let j: any = null; try { j = t ? JSON.parse(t) : null; } catch { j = t; }
    return { status: r.status, j, h: r.headers };
  };
  const ids = (j: any) => (Array.isArray(j) ? j : []).map((r: any) => r.id);
  const has = (j: any, want: string[], m: string) => { const got = ids(j).sort(); ok(JSON.stringify(got) === JSON.stringify([...want].sort()), m, `got ${got.length}: ${JSON.stringify(got)}`); };

  try {
    console.log('== encode facts kept by the trigger ==');
    const f1 = await one<any>(`SELECT top_height, video_codec FROM vod_assets WHERE id=$1`, [A1]);
    ok(f1.top_height === 1080 && f1.video_codec === 'h264', `recording clip takes the live profile's top rung (${JSON.stringify(f1)})`);
    const f3 = await one<any>(`SELECT top_height, video_codec FROM vod_assets WHERE id=$1`, [A3]);
    ok(f3.top_height === 1080 && f3.video_codec === 'h264', 'file encode takes encode_result.kept');
    await query(`UPDATE vod_assets SET encode_result = $2::jsonb WHERE id=$1`, [A3, JSON.stringify({ kept: [{ height: 2160, bitrate_kbps: 15000 }], codec: 'hevc' })]);
    ok((await one<any>(`SELECT top_height, video_codec FROM vod_assets WHERE id=$1`, [A3])).top_height === 2160, 're-encode updates the facts');
    await query(`UPDATE vod_assets SET encode_result = $2::jsonb WHERE id=$1`, [A3, JSON.stringify({ ladder: { name: 'Std' }, segmentSeconds: 4, kept: [{ height: 1080, bitrate_kbps: 6000 }, { height: 720, bitrate_kbps: 3000 }], probe: { height: 1080, hasAudio: true } })]);

    console.log('\n== list: new fields and filters ==');
    let r = await api('GET', '/api/vod?limit=50&count=true');
    const row1 = r.j.find((x: any) => x.id === A1);
    ok(r.status === 200 && r.j.length === 5 && r.h.get('x-total-count') === '5', `own account only: 5 assets (${r.status} ${r.j.length})`);
    ok(row1.schema_key === 'episode' && row1.schema_org_type === 'Episode' && row1.origin === 'clip' && row1.rendition_count === 3, `row carries type, origin and renditions (${JSON.stringify({ k: row1.schema_key, o: row1.origin, n: row1.rendition_count })})`);
    ok(row1.metadata_completeness === 13 && row1.metadata_missing_required === true, `completeness 1 of 8 = 13%, required missing (${row1.metadata_completeness})`);
    const row3 = r.j.find((x: any) => x.id === A3);
    ok(row3.metadata_completeness === 100 && row3.metadata_missing_required === false && row3.origin === 'upload', `fully described movie: 100%, nothing missing (${row3.metadata_completeness})`);
    has((await api('GET', '/api/vod?schema_key=episode')).j, [A1, A2], 'type filter: Episode');
    has((await api('GET', '/api/vod?schema_key=episode,movie')).j, [A1, A2, A3], 'type filter is multi-select (any of)');
    has((await api('GET', `/api/vod?schema_id=${tMatch}`)).j, [A5], 'type filter by schema id');
    has((await api('GET', '/api/vod?schema_org_type=SportsEvent')).j, [A5], 'type filter by schema.org type');
    has((await api('GET', '/api/vod?metadata_missing_required=true')).j, [A1, A2, A4, A5], 'missing required metadata (the clip has no description)');
    has((await api('GET', '/api/vod?metadata_completeness[lt]=50')).j, [A1, A2, A4, A5], 'completeness below 50%');
    has((await api('GET', '/api/vod?origin=upload')).j, [A3], 'origin: upload');
    has((await api('GET', '/api/vod?origin=clip&availability_state=draft')).j, [A1, A2, A4, A5], 'origin and availability combine');
    has((await api('GET', '/api/vod?availability_state=available')).j, [A3], 'availability: available');
    has((await api('GET', '/api/vod?top_height[gte]=1080&video_codec=h264')).j, [A1, A2, A3, A4, A5], 'resolution and codec');
    has((await api('GET', '/api/vod?duration_ms[gte]=3600000')).j, [A2, A3, A5], 'duration range: an hour or more');
    has((await api('GET', '/api/vod?duration_ms[gte]=1800000&duration_ms[lte]=3600000')).j, [A1, A2, A4, A5], 'duration range: between 30 and 60 minutes');
    has((await api('GET', '/api/vod?created_at[gte]=2026-10-18&created_at[lt]=2026-10-19')).j, [A1, A2, A5], 'date range');
    has((await api('GET', '/api/vod?q=harbour')).j, [A1, A2, A4], 'text search over title and source (and never another account\'s asset)');
    has((await api('GET', '/api/vod?q=feature')).j, [A3], 'text search by title');
    has((await api('GET', '/api/vod?schema_key=episode&metadata_missing_required=true&q=straddle&created_at[gte]=2026-10-18')).j, [A2], 'four filters combine');
    r = await api('GET', '/api/vod?sort=-metadata_completeness&limit=2');
    ok(r.j[0]?.id === A3 && /rel="next"/.test(r.h.get('link') ?? ''), 'sort by completeness, paged with a next link');
    r = await api('GET', '/api/vod?top_height=abc');
    ok(r.status === 400, 'a bad filter value is refused with 400');
    has((await api('GET', '/api/vod', undefined, tokOther)).j, [X], 'tenancy: the other account sees only its own asset');

    console.log('\n== facets ==');
    r = await api('GET', '/api/vod/facets?schema_key=episode');
    const types = Object.fromEntries((r.j.facets?.types ?? []).map((t: any) => [t.key, t.n]));
    ok(r.status === 200 && r.j.total === 2, `total respects the filter (${r.j.total})`);
    ok(types.episode === 2 && types.movie === 1 && types['sports-match'] === 1 && types.clip === 1, `type counts leave their own filter out (${JSON.stringify(types)})`);
    const orig = Object.fromEntries((r.j.facets?.origins ?? []).map((t: any) => [t.value, t.n]));
    ok(orig.clip === 2 && !orig.upload, `origin counts apply the type filter (${JSON.stringify(orig)})`);
    const md = Object.fromEntries((r.j.facets?.metadata ?? []).map((t: any) => [String(t.value), t.n]));
    ok(md.true === 2, `missing-required count (${JSON.stringify(md)})`);
    ok((r.j.facets?.resolutions ?? []).some((x: any) => x.value === 1080 && x.n === 2), 'resolution counts');
    ok((await api('GET', '/api/vod/facets', undefined, tokOther)).j.total === 1, 'facets are per account');

    console.log('\n== target metadata and encode routes ==');
    r = await api('GET', `/api/vod/${A5}/target-metadata`);
    ok(r.status === 200 && r.j.type?.key === 'sports-match' && r.j.completeness.missingRequired.join(',') === 'competition,homeTeam,awayTeam', `sports match: competition and teams missing (${JSON.stringify(r.j.completeness?.missingRequired)})`);
    ok(r.j.fields.some((f: any) => f.key === 'name' && f.required), 'inherited event fields are part of the target');
    r = await api('GET', `/api/vod/${A1}/encode`);
    ok(r.status === 200 && r.j.summary.label === '1080p · H.264 · 3 renditions' && r.j.captions.value[0]?.language === 'en', `recording clip encode from the live profile (${r.j.summary?.label})`);
    r = await api('GET', `/api/vod/${A3}/encode`);
    ok(r.j.renditions.source === 'stored' && r.j.ladder.value === 'Std' && r.j.segmentSeconds.value === 4, 'file encode from encode_result');
    ok((await api('GET', `/api/vod/${A1}/encode`, undefined, tokOther)).status === 404, 'encode route is tenant-scoped');
    ok((await one<any>(`SELECT media_facts FROM vod_assets WHERE id=$1`, [A1])).media_facts === null, 'no recording on disk: nothing is stored as if it had been read');

    console.log('\n== encode facts read from the files (build queue 1.4) ==');
    const { spawnSync } = await import('node:child_process');
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const have = (b: string) => spawnSync(b, ['-version'], { stdio: 'ignore' }).status === 0;
    const packager = process.env.PACKAGER_BIN || 'packager';
    const hasPackager = spawnSync(packager, ['--version'], { stdio: 'ignore' }).status === 0;
    if (!have('ffmpeg') || !have('ffprobe')) {
      console.log('SKIP media facts: ffmpeg and ffprobe are needed (brew install ffmpeg)');
    } else {
      const ff = (args: string[]) => { const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]); if (r.status !== 0) throw new Error(String(r.stderr)); };
      const work = mkdtempSync(`${tmpdir()}/vodlib-media-`);

      // A package-only channel: the contributor's own encode (H.264 Main, Spanish AAC), as the recording keeps it.
      const pprof = (await one<any>(`INSERT INTO output_profiles(account_id, name, rungs, workflow_type, packaging) VALUES ($1,'Passthrough','[]','package_only','both') RETURNING id`, [acct]))!.id;
      const pg = (await one<any>(`INSERT INTO groups(account_id, name, output_profile_id) VALUES ($1,'PG',$2) RETURNING id`, [acct, pprof]))!.id;
      const pch = (await one<any>(`INSERT INTO channels(group_id, name) VALUES ($1,'Contributor feed') RETURNING id`, [pg]))!.id;
      const { config } = await import('../src/config');
      const run = join(config.testStream.originDir, pch, 'runs', 'r-1');
      const hlsOut = (dir: string) => { mkdirSync(dir, { recursive: true }); return ['-f', 'hls', '-hls_time', '1', '-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4', '-hls_segment_filename', join(dir, 'seg_%d.m4s'), join(dir, 'index.m3u8')]; };
      ff(['-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=25:d=3', '-c:v', 'libx264', '-profile:v', 'main', '-g', '25', '-pix_fmt', 'yuv420p', ...hlsOut(join(run, '360p'))]);
      ff(['-f', 'lavfi', '-i', 'sine=f=440:d=3', '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-metadata:s:a:0', 'language=spa', ...hlsOut(join(run, 'audio'))]);
      const now = Date.now();
      const P = await asset({ channel_id: pch, title: 'Feed clip', start: now - 3600_000, end: now + 3600_000 });
      r = await api('GET', `/api/vod/${P}/encode`);
      ok(r.status === 200 && r.j.workflow.value === 'package_only', `package-only clip (${r.status})`);
      ok(r.j.renditions.source === 'stored' && r.j.renditions.value[0]?.height === 360 && r.j.renditions.value[0]?.codec === 'H.264' && r.j.renditions.value[0]?.profile === 'Main',
        `package-only: codec and profile read from the recording (${JSON.stringify(r.j.renditions.value)})`);
      ok(r.j.audio.source === 'stored' && r.j.audio.value[0]?.codec === 'AAC' && r.j.audio.value[0]?.channels === 2 && r.j.audio.value[0]?.sampleRate === 48000 && r.j.audio.value[0]?.language === 'spa',
        `package-only: the passed-through audio, stored, with its language (${JSON.stringify(r.j.audio)})`);
      ok(r.j.source.videoCodec === 'H.264' && r.j.source.videoProfile === 'Main' && r.j.source.audioTracks?.[0]?.codec === 'AAC', 'package-only: the source codec and audio on the Source panel');
      ok(!r.j.gaps.some((g: string) => /package-only|Video profile|Renditions/.test(g)), `package-only: no "not recorded" left for them (${JSON.stringify(r.j.gaps)})`);
      const pf = (await one<any>(`SELECT media_facts FROM vod_assets WHERE id=$1`, [P])).media_facts;
      ok(pf?.how === 'recording' && pf.run === 'r-1' && pf.video?.[0]?.level === '3', `stored on the asset once read (${JSON.stringify(pf?.video)})`);
      await query(`UPDATE vod_assets SET media_facts = jsonb_set(media_facts, '{audio,0,language}', '"cat"') WHERE id=$1`, [P]);
      r = await api('GET', `/api/vod/${P}/encode`);
      ok(r.j.audio.value[0]?.language === 'cat', 'read once: a second visit uses what is stored, it does not probe again');
      ok((await api('GET', `/api/vod/${P}/encode`, undefined, tokOther)).status === 404, 'still tenant-scoped');

      // The source file's own probe: every audio and subtitle track, with languages.
      const srt = join(work, 'subs.srt');
      writeFileSync(srt, '1\n00:00:00,000 --> 00:00:01,500\nHello\n');
      const src = join(work, 'feature.mkv');
      ff(['-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=25:d=2', '-f', 'lavfi', '-i', 'sine=f=440:d=2', '-f', 'lavfi', '-i', 'sine=f=660:d=2', '-i', srt,
        '-map', '0:v', '-map', '1:a', '-map', '2:a', '-map', '3:s', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-c:s', 'srt',
        '-metadata:s:a:0', 'language=eng', '-metadata:s:a:1', 'language=fra', '-metadata:s:s:0', 'language=eng', src]);
      const pr = spawnSync(config.testStream.pythonBin, [join(config.testStream.encoderBin, 'vod_encoder.py'), (() => { const j = join(work, 'probe.json'); writeFileSync(j, JSON.stringify({ input: src, out_dir: work, probe_only: true })); return j; })()]);
      const probed = JSON.parse(String(pr.stdout).trim().split('\n').pop() || '{}');
      ok(probed.audioTracks?.map((t: any) => t.language).join(',') === 'eng,fra' && probed.subtitleTracks?.[0]?.language === 'eng' && probed.videoProfile === 'High',
        `vod_encoder.py probe lists every audio and subtitle track (${JSON.stringify({ a: probed.audioTracks, s: probed.subtitleTracks, p: probed.videoProfile })})`);

      if (!hasPackager) {
        console.log(`SKIP file encode end to end: the packager is needed (${packager}); on the Mac PACKAGER_BIN=../packager-osx-arm64/packager`);
      } else {
        // A real file encode, through the job handler: what it stores is what the Encode tab shows.
        const { ensureTrackingGroup } = await import('../src/services/encode/store');
        await ensureTrackingGroup(acct, prof, 'Same as live', { makeDefault: true });
        const F = await asset({ account_id: acct, source_kind: 'upload', kind: 'export', title: 'Two languages', end: 2000 });
        const { handleVodEncode } = await import('../src/services/jobs/handlers/vodEncode');
        await handleVodEncode({ job: { payload: { vodAssetId: F, accountId: acct, sourcePath: src } } as any, progress: async () => {}, isCancelled: () => false });
        const fr = await one<any>(`SELECT encode_result, media_facts FROM vod_assets WHERE id=$1`, [F]);
        ok(fr.media_facts?.how === 'encode' && fr.media_facts.video?.length >= 1 && fr.media_facts.audio?.length === 1, `the encode stores what its renditions carry (${JSON.stringify(fr.media_facts?.video)})`);
        ok(fr.encode_result?.drm === 'clear' && Array.isArray(fr.encode_result?.captions) && fr.encode_result.audio?.[0]?.language === 'eng', 'the encode records DRM, captions and the audio track it took');
        r = await api('GET', `/api/vod/${F}/encode`);
        const rd = r.j.renditions.value[0];
        ok(r.status === 200 && rd?.profile === 'High' && !!rd?.level, `file encode: video profile and level stored (${JSON.stringify(rd)})`);
        ok(r.j.audio.source === 'stored' && r.j.audio.value.length === 1 && r.j.audio.value[0].codec === 'AAC' && r.j.audio.value[0].language === 'eng' && r.j.audio.value[0].bitrateKbps === 128 && r.j.audio.value[0].sampleRate === 48000,
          `file encode: the audio track stored, with its language (${JSON.stringify(r.j.audio)})`);
        ok(r.j.captions.source === 'stored' && r.j.captions.value.length === 0, 'file encode: caption tracks stored (none carried)');
        ok(r.j.drm.source === 'stored' && r.j.drm.value.length === 0, 'file encode: DRM stored as clear');
        ok(r.j.source.audioTracks?.length === 2 && r.j.source.subtitleTracks?.length === 1 && r.j.source.videoCodec === 'H.264', 'file encode: the source tracks listed');
        ok(!r.j.gaps.some((g: string) => /Audio tracks|Video profile|Caption|DRM/.test(g)), `file encode: none of them "not recorded" (${JSON.stringify(r.j.gaps)})`);
        ok(r.j.notes.some((n: string) => /2 audio tracks/.test(n)) && r.j.notes.some((n: string) => /subtitle track/.test(n)) && r.j.notes.some((n: string) => /in the clear/.test(n)), `file encode: the notes say what was taken and what was not (${JSON.stringify(r.j.notes)})`);
      }
    }

    console.log('\n== EPG auto-fill ==');
    r = await api('GET', `/api/vod/${A1}/epg-fill`);
    const s = Object.fromEntries((r.j.suggestions ?? []).map((x: any) => [x.field, x]));
    ok(r.status === 200 && r.j.programme?.id === pHarbour && r.j.match.confident, 'preview finds the programme the clip sits in');
    ok(s.title?.action === 'conflict' && s.series?.value === 'Harbour' && s.episodeNumber?.value === 5, 'suggestions: typed title is a conflict, series and episode are fills');
    ok((await one<any>(`SELECT metadata FROM vod_assets WHERE id=$1`, [A1])).metadata.title === 'Typed by hand', 'preview wrote nothing');
    r = await api('POST', `/api/vod/${A1}/epg-fill`, { fields: ['title', 'series', 'season', 'episodeNumber', 'description', 'rating'] });
    let a1 = await one<any>(`SELECT metadata, metadata_provenance FROM vod_assets WHERE id=$1`, [A1]);
    ok(r.status === 200 && a1.metadata.title === 'Typed by hand' && a1.metadata.series === 'Harbour' && a1.metadata.episodeNumber === 5, 'apply fills the empties and keeps the typed title');
    ok(r.j.skipped.some((x: any) => x.field === 'title'), 'the kept title is reported as skipped');
    ok(a1.metadata_provenance.series?.programmeId === pHarbour && !a1.metadata_provenance.title, 'provenance recorded per filled field, not for the kept one');
    const aud = await one<any>(`SELECT detail FROM audit_log WHERE entity_id=$1 AND entity_type='vod_asset' ORDER BY created_at DESC LIMIT 1`, [A1]);
    ok(aud?.detail?.snapshot?.source === 'epg' && aud.detail.snapshot.programmeId === pHarbour && !!aud.detail.changes?.['metadata.series'], 'audit log names the programme and the fields');
    r = await api('POST', `/api/vod/${A1}/epg-fill`, { fields: ['title'], overwrite: ['title'] });
    a1 = await one<any>(`SELECT metadata, metadata_provenance FROM vod_assets WHERE id=$1`, [A1]);
    ok(a1.metadata.title === 'The Pilot' && a1.metadata_provenance.title?.programmeId === pHarbour, 'overwrite only when named, then with provenance');
    r = await api('PUT', `/api/vod/${A1}`, { metadata: { ...a1.metadata, series: 'Harbour (edited)' } });
    a1 = await one<any>(`SELECT metadata_provenance FROM vod_assets WHERE id=$1`, [A1]);
    ok(r.status === 200 && !a1.metadata_provenance.series && !!a1.metadata_provenance.season, `a hand edit drops that field's provenance only (${r.status})`);
    r = await api('GET', `/api/vod/${A2}/epg-fill`);
    ok(r.j.match.candidates.length === 2 && !r.j.match.confident, 'straddling clip: both programmes offered, not confident');
    const late = r.j.match.candidates.find((c: any) => c.title === 'Late News');
    r = await api('GET', `/api/vod/${A2}/epg-fill?programmeId=${late.programmeId}`);
    ok(r.j.programme?.title === 'Late News', 'the operator can pick the other programme');
    r = await api('GET', `/api/vod/${A4}/epg-fill`);
    ok(r.status === 200 && !r.j.programme && /No programme/.test(r.j.match.reason), 'no guide for that time: says so');
    r = await api('GET', `/api/vod/${A3}/epg-fill`);
    ok(!r.j.programme && /time window/.test(r.j.match.reason), 'uploaded file: no window, says why');
    ok((await api('POST', `/api/vod/${A4}/epg-fill`, {})).status === 400, 'apply with nothing to fill from is a 400 with the reason');
    ok((await api('GET', `/api/vod/${A1}/epg-fill`, undefined, tokOther)).status === 404, 'EPG fill is tenant-scoped');

    console.log('\n== bulk ==');
    const before2 = (await one<any>(`SELECT metadata FROM vod_assets WHERE id=$1`, [A2])).metadata;
    r = await api('POST', '/api/vod/epg-fill', { ids: [A1, A2, A4, X] });
    const by = Object.fromEntries(r.j.results.map((x: any) => [x.assetId, x]));
    ok(r.status === 200 && by[A2].applied.length === 0 && /More than one/.test(by[A2].reason), 'bulk skips an ambiguous match');
    ok(JSON.stringify((await one<any>(`SELECT metadata FROM vod_assets WHERE id=$1`, [A2])).metadata) === JSON.stringify(before2), 'and leaves it untouched');
    const a1b = await one<any>(`SELECT metadata FROM vod_assets WHERE id=$1`, [A1]);
    ok(!by[A1].applied.includes('series') && !by[A1].applied.includes('title') && a1b.metadata.series === 'Harbour (edited)' && a1b.metadata.title === 'The Pilot',
      `bulk never overwrites: the hand-edited series stays, only empty fields filled (${JSON.stringify(by[A1].applied)})`);
    ok(/No programme/.test(by[A4].reason) && by[X].reason === 'not found', 'no guide, and another account\'s asset, are reported');
    // a fresh clip in the Harbour slot: bulk fills it
    const A6 = await asset({ channel_id: ch, title: null, start: T0 + 5 * 60_000, end: T0 + 15 * 60_000, schema_id: tEpisode });
    r = await api('POST', '/api/vod/epg-fill', { ids: [A6], title: true });
    const a6 = await one<any>(`SELECT title, metadata FROM vod_assets WHERE id=$1`, [A6]);
    ok(r.j.filled === 1 && a6.title === 'The Pilot' && a6.metadata.series === 'Harbour' && a6.metadata.description === 'It begins.', `bulk fills a new clip, title included when empty (${JSON.stringify(a6)})`);
    // type change only on request
    const A7 = await asset({ channel_id: ch, title: 'c', start: T0 + 5 * 60_000, end: T0 + 15 * 60_000, schema_id: tClip, metadata: { headline: 'Kept headline' } });
    r = await api('GET', `/api/vod/${A7}/epg-fill`);
    ok(r.j.suggestedType?.key === 'episode' && r.j.suggestedType.dropsFields.join(',') === 'headline', 'suggests the Episode type and says which values would not carry over');
    await api('POST', '/api/vod/epg-fill', { ids: [A7] });
    ok((await one<any>(`SELECT schema_id FROM vod_assets WHERE id=$1`, [A7])).schema_id === tClip, 'bulk does not change the type unless asked');
    r = await api('POST', `/api/vod/${A7}/epg-fill`, { applyType: true });
    const a7 = await one<any>(`SELECT schema_id, metadata FROM vod_assets WHERE id=$1`, [A7]);
    ok(r.j.typeChanged && a7.schema_id === tEpisode && a7.metadata.series === 'Harbour', 'asked: type switched, then filled for the new type');
  } catch (e: any) {
    fail++; console.log('FAIL threw: ' + (e?.stack ?? e));
  } finally {
    srv.close();
    await pool.end();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
