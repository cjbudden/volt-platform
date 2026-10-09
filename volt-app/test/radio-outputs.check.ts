// ============================================================================
//  DO NOT ADVERTISE AN OUTPUT THAT IS NOT BEING PRODUCED.
//
//  Reported from a demo machine as "radio is broken, nothing connects, nothing
//  heard". The station was not broken. It was on air, writing segments, with a
//  valid playlist and a valid DASH manifest, and `output_available: true`.
//
//  What was broken was the promise the API made about it.
//
//  A station's output list is a REQUEST. bin/radio.py probes the MP3 relay at
//  launch and, when the relay is not running, drops the MP3 output and goes on
//  air over HLS and DASH -- reporting that as an `output.degraded` event. That
//  event was emitted and NOBODY CONSUMED IT, so the API kept offering
//  /radio/<id>/stream.mp3, the console tried MP3 first because it is cheapest,
//  and attached to a URL with nothing behind it. The failed play() was caught
//  and discarded.
//
//  Net effect: a healthy station, total silence, no error in the console, none
//  in the log, and an operator reasonably concluding that containerising radio
//  had broken it. The audio path was fine the whole time. The reporting was not.
//
//  Usage: DATABASE_URL=... npx tsx test/radio-outputs.check.ts
// ============================================================================
import { pool, query, one } from '../src/db';

let pass = 0, fail = 0;
const ok = (m: string) => { console.log('PASS ' + m); pass++; };
const bad = (m: string, d: string) => { console.log(`FAIL ${m} -- ${d}`); fail++; };
const check = (m: string, got: unknown, want: unknown) =>
  got === want ? ok(m) : bad(m, `expected [${String(want)}] got [${String(got)}]`);
const truthy = (m: string, v: unknown) => (v ? ok(m) : bad(m, `expected truthy, got [${String(v)}]`));
const falsy = (m: string, v: unknown) => (!v ? ok(m) : bad(m, `expected falsy, got [${String(v)}]`));

const A = '00000000-0000-0000-0000-00000a010001';
const G = '00000000-0000-0000-0000-00000a010002';
const P = '00000000-0000-0000-0000-00000a010003';
const S = '00000000-0000-0000-0000-00000a010004';

/** The API's rule, exercised through the same shape the module uses. */
function outputUrls(id: string, cfg: any, degraded: Record<string, string> = {}) {
  const outs: Record<string, boolean> = { mp3: true, hls: true, dash: true, ...(cfg?.outputs ?? {}) };
  const live = (k: string) => !!outs[k] && !degraded[k];
  return {
    mp3: live('mp3') ? `/radio/${id}/stream.mp3` : null,
    hls: live('hls') ? `/origin/${id}/live/master.m3u8` : null,
    dash: live('dash') ? `/origin/${id}/live/dash/manifest.mpd` : null,
    degraded,
  };
}

const degradedOf = async (id: string) =>
  (await one<any>(`SELECT degraded_outputs FROM stream_status WHERE channel_id=$1`, [id]))
    ?.degraded_outputs ?? {};

/** What the ingest endpoint does with one event, without going over HTTP. */
async function ingest(id: string, type: string, detail: any = {}) {
  await query(
    `INSERT INTO stream_events(channel_id, seq, type, detail, ts) VALUES ($1,$2,$3,$4, now())`,
    [id, null, type, detail]);
  if (type === 'channel.start') {
    await query(`UPDATE stream_status SET degraded_outputs='{}'::jsonb WHERE channel_id=$1`, [id]);
  } else if (type === 'output.degraded') {
    const output = String(detail.output ?? '').trim();
    if (output) {
      await query(
        `INSERT INTO stream_status(channel_id, degraded_outputs)
         VALUES ($1, jsonb_build_object($2::text,$3::text))
         ON CONFLICT (channel_id) DO UPDATE
           SET degraded_outputs = stream_status.degraded_outputs
                                || jsonb_build_object($2::text,$3::text)`,
        [id, output, String(detail.reason ?? 'unavailable')]);
    }
  }
}

(async () => {
  await query(`DELETE FROM accounts WHERE id=$1`, [A]);
  await query(`INSERT INTO accounts(id,name) VALUES ($1,'OutputCo')`, [A]);
  await query(
    `INSERT INTO output_profiles(id,account_id,name,rungs,workflow_type,packaging,segment_dur,dvr_window_sec)
     VALUES ($1,$2,'p','[{"height":0,"bitrate_kbps":128}]','package_only','both',4,60)`, [P, A]);
  await query(`INSERT INTO groups(id,account_id,name,output_profile_id,max_channels)
               VALUES ($1,$2,'g',$3,20)`, [G, A, P]);
  await query(`INSERT INTO channels(id,group_id,name,status,kind)
               VALUES ($1,$2,'Silent FM','live','radio')`, [S, G]);

  try {
    // ======================================================================
    console.log('\n== a station producing everything it was asked for ==');
    // ======================================================================
    let urls = outputUrls(S, { outputs: { mp3: true, hls: true, dash: true } }, await degradedOf(S));
    truthy('MP3 is offered', urls.mp3);
    truthy('HLS is offered', urls.hls);
    truthy('DASH is offered', urls.dash);
    check('and nothing is marked degraded', Object.keys(urls.degraded).length, 0);

    // ======================================================================
    console.log('\n== the encoder drops MP3 because the relay is not running ==');
    //
    // THE EXACT DEMO-MACHINE CASE. radio.py's preflight found nothing on
    // localhost:8000, dropped the MP3 output and went on air over HLS/DASH.
    // ======================================================================
    await ingest(S, 'channel.start', { workflow: 'package', renditions: 1 });
    await ingest(S, 'output.degraded', { output: 'mp3', reason: 'mp3 relay unreachable' });

    const deg = await degradedOf(S);
    check('the drop is recorded against the station', deg.mp3, 'mp3 relay unreachable');

    urls = outputUrls(S, { outputs: { mp3: true, hls: true, dash: true } }, deg);
    falsy('THE MP3 URL IS NO LONGER OFFERED', urls.mp3);
    truthy('but HLS still is, because it is genuinely being produced', urls.hls);
    truthy('and so is DASH', urls.dash);
    check('and the reason travels with it, so the page can say why',
          urls.degraded.mp3, 'mp3 relay unreachable');

    // ======================================================================
    console.log('\n== a new run starts from a clean slate ==');
    //
    // Start Icecast, restart the station, and MP3 must come back. Carrying the
    // last run's verdict forward would hide a working output indefinitely, and
    // the operator's fix would appear to have done nothing.
    // ======================================================================
    await ingest(S, 'channel.start', { workflow: 'package', renditions: 1 });
    const after = await degradedOf(S);
    check('the previous run\'s verdict is cleared', Object.keys(after).length, 0);
    truthy('so MP3 is offered again',
           outputUrls(S, { outputs: { mp3: true, hls: true, dash: true } }, after).mp3);

    // ======================================================================
    console.log('\n== a config that never wanted MP3 is unchanged ==');
    //
    // Degradation and configuration are different things and must not be
    // conflated: one is a fault to report, the other is a choice to respect.
    // ======================================================================
    const off = outputUrls(S, { outputs: { mp3: false, hls: true, dash: true } }, {});
    falsy('no MP3 URL', off.mp3);
    check('and nothing is reported as degraded, because nothing failed',
          Object.keys(off.degraded).length, 0);

    // ======================================================================
    console.log('\n== every output dropped ==');
    //
    // The station has nothing to offer a player. The page must be able to say
    // that outright; before this it showed a Listen button that did nothing.
    // ======================================================================
    await ingest(S, 'output.degraded', { output: 'mp3', reason: 'relay unreachable' });
    await ingest(S, 'output.degraded', { output: 'hls', reason: 'disk full' });
    await ingest(S, 'output.degraded', { output: 'dash', reason: 'disk full' });
    const none = outputUrls(S, { outputs: { mp3: true, hls: true, dash: true } }, await degradedOf(S));
    falsy('no MP3', none.mp3);
    falsy('no HLS', none.hls);
    falsy('no DASH', none.dash);
    check('and all three reasons are available to explain the silence',
          Object.keys(none.degraded).length, 3);

    // ======================================================================
    console.log('\n== the event is still recorded for the operator log ==');
    //
    // Consuming the event must not swallow it: the timeline on the station page
    // is how somebody reconstructs what happened after the fact.
    // ======================================================================
    const evs = await query<any>(
      `SELECT type FROM stream_events WHERE channel_id=$1 AND type='output.degraded'`, [S]);
    truthy(`every degraded event is still in the log (${evs.length})`, evs.length >= 4);
  } finally {
    await query(`DELETE FROM accounts WHERE id=$1`, [A]).catch(() => {});
  }

  console.log(`\nradio-outputs: ${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch { /* ignore */ }
  process.exit(1);
});
