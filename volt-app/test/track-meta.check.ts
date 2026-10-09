// ============================================================================
//  ICY STRING -> ALBUM COVER, AND THE RATE LIMIT THAT GOVERNS IT.
//
//  MusicBrainz permits ONE request per second per application and enforces it
//  by blocking the IP. That is a shared fate: exceed it for one tenant and
//  every tenant's artwork stops at once. So the parts of this that are about
//  restraint are not optimisations, they are the terms of use, and they are
//  tested as such.
//
//  THE FOUR THINGS THAT MUST HOLD.
//
//  1. PARSING REFUSES WHAT IS NOT A TRACK. "NPO Radio 1 - De Ochtend" is a
//     programme, not a song. Guessing an artist out of it spends a rate-limit
//     slot on a lookup that cannot succeed, and would put a wrong album cover
//     on screen if it accidentally did.
//
//  2. NORMALISATION MAKES THE CACHE HIT. The same song arrives as "Fleetwood
//     Mac - Dreams", "FLEETWOOD MAC - DREAMS (2004 Remaster)" and with double
//     spaces, from three stations. Three keys for one track is three times the
//     budget spent to learn the same fact.
//
//  3. A MISS IS REMEMBERED. The failure that would quietly eat the entire
//     budget is a track MusicBrainz has never heard of, retried on every poll
//     for the twenty minutes it is on air — never succeeding, never stopping.
//
//  4. A LOW-SCORING MATCH IS A MISS, NOT A RESULT. MusicBrainz always returns
//     its best effort. Without a floor, an unknown track silently acquires the
//     cover of whatever it half-matched. Wrong artwork is worse than none,
//     because nobody reports it.
//
//  The network is stubbed throughout. A suite that really called MusicBrainz
//  would be slow, flaky, dependent on somebody else's uptime, and would itself
//  be the rate-limit violation it is meant to prevent.
//
//  Usage: DATABASE_URL=... npx tsx test/track-meta.check.ts
// ============================================================================
import { pool, query, one } from '../src/db';

let pass = 0, fail = 0;
const ok = (m: string) => { console.log('PASS ' + m); pass++; };
const bad = (m: string, d: string) => { console.log(`FAIL ${m} -- ${d}`); fail++; };
const check = (m: string, got: unknown, want: unknown) =>
  got === want ? ok(m) : bad(m, `expected [${String(want)}] got [${String(got)}]`);
const truthy = (m: string, v: unknown) => (v ? ok(m) : bad(m, `expected truthy, got [${String(v)}]`));
const falsy = (m: string, v: unknown) => (!v ? ok(m) : bad(m, `expected falsy, got [${String(v)}]`));

// ---------------------------------------------------------------------------
//  A stub MusicBrainz. Counts calls, so restraint is measurable.
// ---------------------------------------------------------------------------
let calls: string[] = [];
let respond: (url: string) => { status: number; body: any } = () => ({ status: 200, body: { recordings: [] } });

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, _init?: any) => {
  const url = String(input);
  calls.push(url);
  const r = respond(url);
  return {
    ok: r.status >= 200 && r.status < 300,
    status: r.status,
    json: async () => r.body,
    text: async () => JSON.stringify(r.body),
  } as any;
}) as any;

function recording(score: number, opts: Partial<{ title: string; artist: string; album: string; rgMbid: string; date: string; type: string }> = {}) {
  return {
    id: 'rec-1', score, title: opts.title ?? 'Dreams',
    'artist-credit': [{ name: opts.artist ?? 'Fleetwood Mac' }],
    'first-release-date': opts.date ?? '1977-02-04',
    releases: [{
      title: opts.album ?? 'Rumours', date: opts.date ?? '1977-02-04',
      'release-group': { id: opts.rgMbid ?? 'rg-abc', title: opts.album ?? 'Rumours', 'primary-type': opts.type ?? 'Album' },
    }],
  };
}

(async () => {
  // Import AFTER the fetch stub is installed, and with a tiny gap so the suite
  // is not itself paced at one second per lookup.
  process.env.TRACK_META_MIN_GAP_MS = '5';
  process.env.TRACK_META_MIN_SCORE = '85';
  const tm = await import('../src/services/radio/trackMeta');

  try {
    await query(`DELETE FROM track_metadata`);

    // ======================================================================
    console.log('\n== parsing an ICY line ==');
    // ======================================================================
    check('the usual shape', JSON.stringify(tm.parseIcyTitle('Fleetwood Mac - Dreams')),
          JSON.stringify({ artist: 'Fleetwood Mac', title: 'Dreams' }));
    check('a double dash, which some automation emits',
          tm.parseIcyTitle('Alex Cortiz -- Funked up flow')?.artist, 'Alex Cortiz');
    check('and the "Title by Artist" shape WFMU uses',
          tm.parseIcyTitle('"Wonderful Thing" by Ralfi Pagan on WFMU')?.artist, 'Ralfi Pagan');
    check('taking the title from the quotes, not the station',
          tm.parseIcyTitle('"Wonderful Thing" by Ralfi Pagan on WFMU')?.title, 'Wonderful Thing');

    // The refusals. Each of these would otherwise spend a rate-limit slot.
    falsy('an empty title is not a track', tm.parseIcyTitle(''));
    falsy('nor is null', tm.parseIcyTitle(null));
    falsy('a bare string with no separator is not enough to search on',
          tm.parseIcyTitle('Morning Show'));
    // This one DOES have a dash, so it parses; the value is that it is only
    // ever looked up when the classifier already said "song", which is why
    // ensureTrackMeta is called from that branch and not from every title.
    truthy('a programme name with a dash still parses, and is filtered upstream by class',
           tm.parseIcyTitle('NPO Radio 1 - De Ochtend'));

    // ======================================================================
    console.log('\n== normalisation is what makes the cache hit ==');
    // ======================================================================
    const k = tm.normKey('Fleetwood Mac', 'Dreams');
    check('case does not matter', tm.normKey('FLEETWOOD MAC', 'DREAMS'), k);
    check('nor does extra whitespace', tm.normKey('Fleetwood  Mac', ' Dreams '), k);
    check('a bracketed suffix is stripped', tm.normKey('Fleetwood Mac', 'Dreams (2004 Remaster)'), k);
    check('and a dashed one', tm.normKey('Fleetwood Mac', 'Dreams - Remastered'), k);
    check('punctuation is ignored', tm.normKey("Fleetwood Mac", "Dreams!"), k);
    check('a featured artist does not fork the key',
          tm.normKey('Fleetwood Mac feat. Somebody', 'Dreams'), k);
    truthy('but a different song is a different key',
           tm.normKey('Fleetwood Mac', 'Go Your Own Way') !== k);

    // ======================================================================
    console.log('\n== a hit is looked up once and then never again ==');
    // ======================================================================
    calls = [];
    respond = () => ({ status: 200, body: { recordings: [recording(100)] } });
    const first = await tm.ensureTrackMeta('Fleetwood Mac - Dreams');
    check('it resolved', first.state, 'hit');
    check('with the album', first.album, 'Rumours');
    check('and the year', first.year, 1977);
    truthy('and artwork from the Cover Art Archive release-group endpoint',
           first.artworkUrl?.includes('/release-group/rg-abc/front-500'));
    check('one network call', calls.length, 1);
    truthy('to MusicBrainz, with a fielded query',
           calls[0].includes('/recording?query=') && calls[0].includes('artist'));

    calls = [];
    await tm.ensureTrackMeta('Fleetwood Mac - Dreams');
    check('asking again makes NO call', calls.length, 0);
    // The variant spellings must land on the same cached row.
    await tm.ensureTrackMeta('FLEETWOOD MAC - Dreams (2004 Remaster)');
    check('and neither does a differently-spelled variant', calls.length, 0);
    check('the cache holds exactly one row for the track',
          (await query(`SELECT id FROM track_metadata WHERE norm_key=$1`, [k])).length, 1);

    // ======================================================================
    console.log('\n== a low score is a MISS, not a wrong cover ==');
    //
    // MusicBrainz always answers with its best effort. Without a floor, an
    // unknown track silently acquires the artwork of whatever it half-matched,
    // and a station shows the wrong album with complete confidence.
    // ======================================================================
    calls = [];
    respond = () => ({ status: 200, body: { recordings: [recording(40, { title: 'Something Else', album: 'Wrong Album' })] } });
    const weak = await tm.ensureTrackMeta('Unknown Artist - Untraceable Song');
    check('the state is miss', weak.state, 'miss');
    falsy('and no artwork was taken from the weak match', weak.artworkUrl);
    falsy('nor an album', weak.album);

    // ======================================================================
    console.log('\n== a miss is remembered, which is what protects the budget ==');
    // ======================================================================
    calls = [];
    for (let i = 0; i < 5; i++) await tm.ensureTrackMeta('Unknown Artist - Untraceable Song');
    check('five more polls make zero calls', calls.length, 0);

    // ======================================================================
    console.log('\n== a transient failure IS retried, unlike a miss ==');
    //
    // The distinction earns its place: a 503 from a service having a bad
    // minute must not permanently blacklist a track that does exist.
    // ======================================================================
    await query(`DELETE FROM track_metadata WHERE norm_key LIKE '%throttled%'`);
    calls = [];
    respond = () => ({ status: 503, body: {} });
    const errored = await tm.ensureTrackMeta('Throttled Band - Throttled Song');
    check('it records an error rather than a miss', errored.state, 'error');
    const row = await one<any>(`SELECT state, attempts FROM track_metadata WHERE norm_key=$1`,
                               [tm.normKey('Throttled Band', 'Throttled Song')]);
    check('the row says error', row.state, 'error');
    truthy('and counts the attempt', Number(row.attempts) >= 1);
    // Not retried immediately: the backoff is hours, so an outage does not
    // become a tight loop against a service that is already struggling.
    calls = [];
    await tm.ensureTrackMeta('Throttled Band - Throttled Song');
    check('and is not retried straight away', calls.length, 0);

    // ======================================================================
    console.log('\n== a known track with no uploaded cover is still a hit ==');
    //
    // The Cover Art Archive is contributed, so a real release can simply have
    // no picture. That is a hit with a null artwork url, NOT a miss: the album
    // name and the correct title are worth having on their own.
    // ======================================================================
    respond = () => ({ status: 200, body: { recordings: [{ ...recording(98, { album: 'Obscure LP' }), releases: [{ title: 'Obscure LP', 'release-group': { title: 'Obscure LP', 'primary-type': 'Album' } }] }] } });
    const noArt = await tm.ensureTrackMeta('Obscure Band - Obscure Track');
    check('the state is hit', noArt.state, 'hit');
    check('the album is known', noArt.album, 'Obscure LP');
    falsy('and there is simply no artwork', noArt.artworkUrl);

    // ======================================================================
    console.log('\n== the fallback is the normal case, not the error case ==');
    // ======================================================================
    const station = { name: 'Jazz FM', description: 'Smooth all night', artworkUrl: 'https://cdn/logo.png' };

    const unparsed = tm.buildCard(tm.NO_META, station);
    check('an ident or a news bulletin shows the station', unparsed.primary, 'Jazz FM');
    check('with its description underneath', unparsed.secondary, 'Smooth all night');
    check('and the station logo', unparsed.artworkUrl, 'https://cdn/logo.png');
    check('flagged as coming from the station', unparsed.source, 'station');

    const track = tm.buildCard(
      { artist: 'Fleetwood Mac', title: 'Dreams', album: 'Rumours', artworkUrl: 'https://caa/x', year: 1977, provider: 'musicbrainz', state: 'hit' },
      station);
    check('a known track shows the title large', track.primary, 'Dreams');
    check('the artist under it', track.secondary, 'Fleetwood Mac');
    check('its own cover', track.artworkUrl, 'https://caa/x');
    check('and is flagged as a track', track.source, 'track');

    // The mixed case: we know the song, nobody has uploaded a cover. The
    // station's logo beats an empty square.
    const partial = tm.buildCard(
      { artist: 'Obscure Band', title: 'Obscure Track', album: 'Obscure LP', artworkUrl: null, year: null, provider: 'musicbrainz', state: 'hit' },
      station);
    check('a track with no cover falls back to the station image', partial.artworkUrl, 'https://cdn/logo.png');
    check('while still showing the track', partial.primary, 'Obscure Track');

    // ======================================================================
    console.log('\n== the read path never calls the network ==');
    //
    // The rule that keeps the rate limit survivable. Players poll; if the
    // read path could trigger a lookup, a hundred players on one station
    // would queue a hundred one-per-second calls for a single track change.
    // ======================================================================
    calls = [];
    await tm.cachedTrackMeta('Fleetwood Mac - Dreams');
    await tm.cachedTrackMeta('Never Seen - Before Now');
    check('two cache reads, zero calls', calls.length, 0);
    const unseen = await tm.cachedTrackMeta('Never Seen - Before Now');
    check('an unlooked-up track still returns what was parsed', unseen.artist, 'Never Seen');
    check('so the player shows text immediately', unseen.title, 'Before Now');
  } finally {
    await query(`DELETE FROM track_metadata`).catch(() => {});
    globalThis.fetch = realFetch;
  }

  console.log(`\ntrack-meta: ${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch { /* ignore */ }
  process.exit(1);
});
