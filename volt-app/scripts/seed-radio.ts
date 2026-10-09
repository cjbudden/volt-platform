/**
 * SEED TEST RADIO STATIONS — an optional, manual post-build step.
 *
 *   npx tsx scripts/seed-radio.ts                 # the DEMO set: one of everything
 *   npx tsx scripts/seed-radio.ts --all           # every station below
 *   npx tsx scripts/seed-radio.ts --music         # Icecast MP3, metadata-rich
 *   npx tsx scripts/seed-radio.ts --speech        # Icecast MP3, talk and news
 *   npx tsx scripts/seed-radio.ts --aac           # Icecast AAC (forces a re-encode)
 *   npx tsx scripts/seed-radio.ts --hls           # HLS playlist sources
 *   npx tsx scripts/seed-radio.ts --srt           # SRT contribution (needs the fixture)
 *   npx tsx scripts/seed-radio.ts --list          # print, change nothing
 *   ... --account "RTM"                           # pick the account by name
 *   ... --group <uuid>                            # or the exact group
 *
 * Idempotent: a station whose name already exists on the account is skipped, so
 * this is safe to re-run after any build. Nothing here is created automatically
 * by the app.
 *
 * ---------------------------------------------------------------------------
 *  HOW RADIO IS ACTUALLY DISTRIBUTED, which is why the sets are split this way
 * ---------------------------------------------------------------------------
 *
 *  ICECAST / SHOUTCAST (plain HTTP audio) is what the overwhelming majority of
 *  stations publish. One endless HTTP response carrying MP3 or AAC, with
 *  now-playing text interleaved as ICY metadata. It is what every aggregator
 *  expects, what car heads and hardware receivers speak, and it is cheap: one
 *  socket per listener, no manifest, no segments. If a station has exactly one
 *  public URL, this is nearly always the one.
 *
 *  HLS is second, and growing, but it is mostly the BROADCASTER'S OWN APP
 *  rather than the station's public URL. Segments and a playlist buy adaptive
 *  bitrate, CDN caching, DRM, ad insertion and clean iOS support; they cost
 *  latency (an HLS listener is typically a segment or three behind an Icecast
 *  one) and they are useless to the long tail of players that only know how to
 *  open a stream URL. Public broadcasters with apps, such as the ABC set below,
 *  publish both.
 *
 *  SRT is NOT a listener protocol. It is CONTRIBUTION: getting audio from a
 *  studio, an outside broadcast or a remote presenter INTO the platform over
 *  the public internet, reliably, with retransmission and encryption. Nobody
 *  distributes to listeners over SRT and there is no public SRT radio source to
 *  point at, which is why the SRT entry here is backed by a local fixture
 *  rather than a URL on the internet.
 *
 *  So the honest shape of a station is: SRT (or RTMP) in, Icecast and HLS out.
 *  The sets below let one platform prove it ingests all three.
 *
 * ---------------------------------------------------------------------------
 *  WHAT EACH SET EXERCISES
 * ---------------------------------------------------------------------------
 *
 *  MUSIC   Dense, well-formed "Artist - Title" ICY metadata changing every few
 *          minutes. The metadata log, the song/ad/content classifier, and
 *          metadata-driven clipping.
 *  SPEECH  News and talk, where the content is people talking. Transcription
 *          (offered for Icecast sources only), the 'content' classification
 *          path, and the sparse or station-level metadata cases.
 *  AAC     Icecast mounts carrying AAC rather than MP3. These CANNOT be copied
 *          to the relay, so they take the re-encode branch of isMp3Copy() — the
 *          expensive path, and the one a demo machine notices.
 *  HLS     Playlist sources. Different ffmpeg input flags entirely (see
 *          inputArgs in services/radio/args.ts): a live edge to find, no ICY
 *          metadata to negotiate, and a CDN that serves segments from a
 *          different host than the manifest.
 *  SRT     Contribution in. Requires `bash scripts/srt-radio-source.sh` to be
 *          running: the station CALLS that fixture, it does not listen.
 *
 *  Every URL below was probed with ffprobe before being committed, and the
 *  codec and sample rate in each note is what the probe actually returned.
 */
import { query, one, pool } from '../src/db';

interface Seed {
  name: string;
  url: string;
  /** stream_inputs.protocol — 'icecast' | 'hls' | 'srt'. */
  protocol: 'icecast' | 'hls' | 'srt';
  note: string;
  /** Set false where the source carries no ICY metadata to capture. */
  metadata?: boolean;
}

const MUSIC: Seed[] = [
  { name: 'Groove Salad', protocol: 'icecast', url: 'https://ice5.somafm.com/groovesalad-128-mp3', note: 'Ambient/downtempo. mp3 44.1k stereo. Rich Artist - Title metadata; artwork via StreamUrl.' },
  { name: 'Secret Agent', protocol: 'icecast', url: 'https://ice5.somafm.com/secretagent-128-mp3', note: 'Spy-jazz. mp3 44.1k stereo. Frequent track changes: good for log density.' },
  { name: 'Drone Zone', protocol: 'icecast', url: 'https://ice5.somafm.com/dronezone-128-mp3', note: 'Long ambient pieces. mp3 44.1k stereo. Sparse title changes, long entries.' },
  { name: 'DEF CON Radio', protocol: 'icecast', url: 'https://ice5.somafm.com/defcon-128-mp3', note: 'Hacker-conference music. mp3 44.1k stereo.' },
  { name: 'KEXP Seattle', protocol: 'icecast', url: 'https://kexp-mp3-128.streamguys1.com/kexp128.mp3', note: 'Live DJ-hosted music radio. mp3 44.1k stereo. Real presenters between tracks, so metadata and speech both appear.' },
];

const SPEECH: Seed[] = [
  { name: 'NPO Radio 1', protocol: 'icecast', url: 'http://icecast.omroep.nl/radio1-bb-mp3', note: 'Dutch news/talk. mp3 48k stereo at 192k. Sends PROGRAMME + broadcaster, e.g. "NPO Radio 1 - De Ochtend - KRO-NCRV": the strongest test of programme-level metadata.' },
  { name: 'WPLN 90.3', protocol: 'icecast', url: 'https://wpln.streamguys1.com/wplnfm.mp3', note: 'NPR news/talk. mp3 24k stereo at 64k — deliberately the LOWEST-quality source here, which is what makes it a useful transcription and loudness test.' },
  { name: 'KPFA', protocol: 'icecast', url: 'https://streams.kpfa.org/kpfa_128', note: 'News, interviews, public affairs. mp3 48k stereo. Typically station/programme-level information only.' },
  { name: 'WFMU Freeform', protocol: 'icecast', url: 'https://stream0.wfmu.org/freeform-128k', note: 'Freeform shows, interviews, radio theatre. mp3 44.1k stereo. Alternates between programme and track metadata.' },
  { name: 'NA0D Baxter Stream', protocol: 'icecast', url: 'https://audio.na0d.com/BaxterStream', note: 'Ham/GMRS/weather feeds. mp3 8k MONO at 16k. Speech with sparse metadata and long silences: exercises the dead-air and static QC checks, and is the only mono, narrowband source here.' },
];

// AAC over Icecast. Same protocol, different codec, and that difference is the
// whole point: isMp3Copy() is false, so the relay output is RE-ENCODED rather
// than copied. A station that costs a rounding error of CPU and one that costs
// a core look identical in the UI, so having both seeded is how the difference
// becomes visible on the fleet page.
const AAC: Seed[] = [
  { name: 'Groove Salad AAC', protocol: 'icecast', url: 'https://ice5.somafm.com/groovesalad-128-aac', note: 'The same programme as Groove Salad, delivered as aac 44.1k stereo. Seed BOTH and compare: identical audio, one copied to the relay, one re-encoded.' },
  { name: 'Radio Paradise', protocol: 'icecast', url: 'https://stream.radioparadise.com/aac-128', note: 'Eclectic music. aac 44.1k stereo. Long, carefully sequenced sets.' },
  { name: 'Radio Paradise Mellow', protocol: 'icecast', url: 'https://stream.radioparadise.com/mellow-128', note: 'Quieter sibling mix. aac 44.1k stereo.' },
];

// HLS.
//
// ============================================================================
//  A URL IS NOT A STATION. THE FIRST VERSION OF THIS LIST GOT THAT WRONG.
//
//  These were originally the ABC's `mediaserviceslive.akamaized.net/hls/live/
//  <id>/<name>/masterhls.m3u8` URLs, and they were probed and confirmed working
//  before being committed. They were also wrong, and the probe could not have
//  found it, because the probe ran somewhere else.
//
//  Those URLs are a GEO-REDIRECTOR, and the station name in the path is
//  decorative. Followed from one network they resolve to the named station.
//  Followed from another they resolve to whatever the redirector thinks is
//  local, and the mapping is stable per location, so it does not even look
//  intermittent. Measured from one Australian connection:
//
//      .../2038311/abcjazz/masterhls.m3u8     ->  newsradio
//      .../2038308/triplej/masterhls.m3u8     ->  triplejnsw
//      .../2038310/doublej/masterhls.m3u8     ->  raeng
//      .../2038306/abcclassic/masterhls.m3u8  ->  localnewcastle
//      .../2038312/news/masterhls.m3u8        ->  itinerantthree
//
//  Four of the five served a different station than the one named. One of them
//  also failed outright on ffmpeg 7 with "Master Playlist tag found in a Media
//  Playlist", because the redirect chain hands the demuxer a master playlist
//  where it expected a variant. Older ffmpeg tolerated it. So the station was
//  simultaneously the wrong programme AND broken, from a URL that had been
//  verified.
//
//  THE LESSON, which is worth more than the URLs: a source was verified from a
//  cloud container and the result was recorded as a property of the URL. It was
//  a property of the URL and of where the prober was standing. Anything with a
//  redirector, a CDN or a rights boundary in front of it has to be probed FROM
//  THE MACHINE THAT WILL PLAY IT.
//
//  The URLs below are the ABC's DIRECT origin form, which does not redirect and
//  serves the station its slug names. Every one was probed from the demo
//  machine's own connection. They are Australian, and outside Australia they
//  may be blocked, which is a normal property of broadcast rights and not a
//  fault: `test/radio-ingest-protocols.check.sh` covers HLS ingest with a LOCAL
//  playlist for exactly that reason, and needs no public station at all.
// ============================================================================
const ABC = (slug: string) => `https://streaming.abc-cdn.net.au/audio/hls/${slug}.m3u8`;
const HLS: Seed[] = [
  { name: 'ABC News Radio (HLS)', protocol: 'hls', url: ABC('newsradio'), note: 'Rolling news. aac 44.1k MONO. Continuous speech with no music, so the best HLS source here for transcription work.', metadata: false },
  { name: 'triple j (HLS)', protocol: 'hls', url: ABC('triplejnsw'), note: 'Youth music and talk. aac 44.1k stereo. Music, presenters and news bulletins in one stream.', metadata: false },
  { name: 'triple j Unearthed (HLS)', protocol: 'hls', url: ABC('triplejunearthed'), note: 'Unsigned Australian music. aac 44.1k stereo. Continuous music with few announcements.', metadata: false },
  { name: 'ABC Sport (HLS)', protocol: 'hls', url: ABC('grandstand'), note: 'Live sport commentary. aac 44.1k mono. Long stretches of speech over crowd noise, and genuine dead air between events: the most demanding source here for the QC checks.', metadata: false },
  { name: 'ABC Radio Sydney (HLS)', protocol: 'hls', url: ABC('localsydney'), note: 'Local news and talk. aac 44.1k mono.', metadata: false },
];

// SRT is contribution, not distribution, so there is nothing public to point
// at. This entry is deliberately backed by a LOCAL fixture, and the station is
// the CALLER: scripts/srt-radio-source.sh runs the listener. That direction is
// not a detail of the fixture, it is the deployment rule — a container that
// accepts inbound connections cannot be scaled, moved or reaped with the fleet.
const SRT_PORT = process.env.SRT_FIXTURE_PORT || '9010';
const SRT_HOST = process.env.SRT_FIXTURE_HOST || '127.0.0.1';
const SRT: Seed[] = [
  {
    name: 'Studio SRT (fixture)',
    protocol: 'srt',
    url: `srt://${SRT_HOST}:${SRT_PORT}?mode=caller&latency=200`,
    note: `Contribution feed from a simulated studio. Start it first:\n       bash scripts/srt-radio-source.sh\n     Nothing public distributes radio over SRT, so this stands in for the real case: a studio, an OB truck or a remote presenter pushing INTO the platform. The station dials out to ${SRT_HOST}:${SRT_PORT}; it never listens.`,
    metadata: false,
  },
];

// One of everything, and the set to reach for when the question is "does the
// platform ingest what stations actually use". Two MP3 Icecast (one music with
// dense metadata, one speech), one AAC Icecast (the re-encode path), two HLS.
const DEMO: Seed[] = [
  MUSIC[0], MUSIC[4], SPEECH[0], AAC[0], HLS[0], HLS[1],
];

const SETS: Record<string, Seed[]> = { music: MUSIC, speech: SPEECH, aac: AAC, hls: HLS, srt: SRT };

const argv = process.argv.slice(2);
const listOnly = argv.includes('--list');
const picked = Object.keys(SETS).filter((k) => argv.includes(`--${k}`));
const chosen: Seed[] = argv.includes('--all')
  ? Object.values(SETS).flat()
  : picked.length
    ? picked.flatMap((k) => SETS[k])
    : DEMO;

(async () => {
  if (listOnly) {
    for (const s of chosen) console.log(`${s.name}  [${s.protocol}]\n    ${s.url}\n    ${s.note}`);
    console.log(`\n${chosen.length} station(s). Sets: --music --speech --aac --hls --srt --all (default: a mixed demo set)`);
    await pool.end();
    return;
  }
  const groupArg = argv[argv.indexOf('--group') + 1];
  const acctArg = argv[argv.indexOf('--account') + 1];
  const grp = argv.includes('--group')
    ? await one<any>(`SELECT id, account_id FROM groups WHERE id=$1`, [groupArg])
    : argv.includes('--account')
      ? await one<any>(`SELECT g.id, g.account_id FROM groups g JOIN accounts a ON a.id=g.account_id
                         WHERE a.name ILIKE $1 ORDER BY g.created_at LIMIT 1`, [acctArg])
      : await one<any>(`SELECT g.id, g.account_id FROM groups g ORDER BY g.created_at LIMIT 1`);
  if (!grp) { console.error('no matching group: create an account/group first, or pass --account/--group'); process.exit(1); }
  const acct = await one<any>(`SELECT name FROM accounts WHERE id=$1`, [grp.account_id]);
  console.log(`seeding into account "${acct?.name}" (group ${grp.id})\n`);

  let added = 0, skipped = 0, updated = 0;
  for (const s of chosen) {
    const dupe = await one<any>(`SELECT c.id FROM channels c JOIN groups g ON g.id=c.group_id
                             WHERE g.account_id=$1 AND c.name=$2 AND c.kind='radio'`, [grp.account_id, s.name]);
    if (dupe) {
      // SKIPPING BY NAME IS NOT ENOUGH WHEN A URL GOES BAD.
      //
      // The ABC HLS entries were seeded with a geo-redirecting URL that served
      // the wrong station. Re-running with the corrected list would have found
      // the name already present and skipped it, leaving the broken URL in
      // place forever and making the fix look like it had not been delivered.
      //
      // So a name match still checks the source. Same URL: genuinely nothing to
      // do. Different URL: the seed list is the newer information, so it wins,
      // and it says which URL it replaced rather than changing it quietly.
      // Nothing else about the station is touched -- name, outputs, recording
      // settings and any hand-editing survive.
      const cur = await one<any>(
        `SELECT id, ingest_url, protocol FROM stream_inputs
          WHERE channel_id=$1 AND role='primary' ORDER BY created_at LIMIT 1`, [dupe.id]);
      if (cur && (cur.ingest_url !== s.url || String(cur.protocol) !== s.protocol)) {
        await query(`UPDATE stream_inputs SET ingest_url=$2, protocol=$3::ingest_protocol WHERE id=$1`,
          [cur.id, s.url, s.protocol]);
        console.log(`~  ${s.name}  [${s.protocol}] source updated`);
        console.log(`     was ${cur.ingest_url}`);
        console.log(`     now ${s.url}`);
        updated++;
        continue;
      }
      console.log(`=  ${s.name} (already seeded)`); skipped++; continue;
    }

    // ICY metadata is an Icecast property. Asking for it on an HLS or SRT
    // source is not harmless: the capture loop opens a second connection to a
    // URL that will never send a metadata frame, and the station then shows an
    // empty now-playing log that looks like a fault rather than an absence.
    const metadataCapture = s.metadata ?? (s.protocol === 'icecast');
    const radioConfig = {
      outputs: { mp3: true, hls: true, dash: true },
      bitrateKbps: 128,
      metadataCapture,
    };
    const ch = await one<any>(
      `INSERT INTO channels(group_id, name, kind, radio_config, recording_enabled, metadata)
       VALUES ($1,$2,'radio',$3::jsonb, true, $4::jsonb)
       RETURNING id`,
      [grp.id, s.name, JSON.stringify(radioConfig),
       JSON.stringify({ seed_note: s.note, seed_protocol: s.protocol, seeded: 'scripts/seed-radio.ts' })]);
    await query(
      `INSERT INTO stream_inputs(channel_id, role, protocol, ingest_url) VALUES ($1,'primary',$2::ingest_protocol,$3)`,
      [ch.id, s.protocol, s.url]);
    console.log(`+  ${s.name}  [${s.protocol}] -> ${ch.id}`);
    console.log(`     ${s.note}`);
    added++;
  }
  console.log(`\n${added} added, ${updated} source(s) updated, ${skipped} already present.`);
  console.log('Stations are created STOPPED and OFF AIR: start one from Radio, then Go on air to publish it.');
  if (chosen.some((s) => s.protocol === 'srt')) {
    console.log('The SRT station needs its source running first:  bash scripts/srt-radio-source.sh');
  }
  await pool.end();
})();
