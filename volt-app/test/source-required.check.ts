// ============================================================================
//  A STREAM WITH NO SOURCE MUST NOT START.
//
//  It did. Create a channel, leave the source blank, press Start: it launched
//  an encoder, went to STARTING, showed its source card as RECEIVING, opened a
//  recording and ran the billable clock. Observed at 1:14 of billing against
//  nothing at all.
//
//  IT DID NOT FAIL BECAUSE A DEFAULT MADE THE MISSING VALUE PLAUSIBLE.
//  buildEncoderJobConfig read the source as
//
//      i.ingest_url ?? `srt://0.0.0.0:9000?streamid=${i.stream_key ?? ''}`
//
//  which for an empty row is a valid SRT listener on every interface with an
//  EMPTY streamid. ffmpeg binds it and waits, and there is nothing to report,
//  because a listener with no caller is precisely what a correctly configured
//  push channel looks like in the seconds before its encoder dials in. The
//  broken case and the healthy case were the same observation.
//
//  So the assertions come in three layers, and all three matter:
//
//    1. the RULE, as a pure function, per protocol — a pull source needs a URL,
//       a push source needs a URL or a stream key, and the difference is not a
//       special case, it is the descriptor registry doing its job
//    2. the REFUSAL, through the real orchestrator: a 400-shaped error, and
//       NOTHING launched, NO instance row, NO recording, NO billing
//    3. the RECOVERY: fill the source in, press Start, and it works — because a
//       guard that cannot be got out of is a worse bug than the one it fixed
//
//  Usage: DATABASE_URL=... npx tsx test/source-required.check.ts
// ============================================================================
process.env.ORCH_LAUNCHER = 'mock';

import { pool, query, one } from '../src/db';
import { sourceProblem, NotStartable } from '../src/services/sourceReadiness';
import { buildEncoderJobConfig } from '../src/services/jobConfig';

let pass = 0, fail = 0;
const ok = (m: string) => { console.log('PASS ' + m); pass++; };
const bad = (m: string, d: string) => { console.log(`FAIL ${m} -- ${d}`); fail++; };
const truthy = (m: string, v: unknown) => (v ? ok(m) : bad(m, `expected something, got [${String(v)}]`));
const falsy = (m: string, v: unknown) => (!v ? ok(m) : bad(m, `expected nothing, got [${String(v)}]`));
const check = (m: string, got: unknown, want: unknown) =>
  got === want ? ok(m) : bad(m, `expected [${String(want)}] got [${String(got)}]`);

// ---------------------------------------------------------------------------
//  1. THE RULE
// ---------------------------------------------------------------------------
console.log('== the rule, per protocol ==');

truthy('no source rows at all is refused', sourceProblem([]));
truthy('only a backup row is refused: nothing to fail over FROM',
  sourceProblem([{ role: 'backup', protocol: 'srt', ingest_url: 'srt://h:9000' }]));

// PULL — we go and fetch it, so the URL is the entire address.
truthy('an HLS source with no URL is refused',
  sourceProblem([{ role: 'primary', protocol: 'hls', ingest_url: null }]));
truthy('an Icecast source with no URL is refused',
  sourceProblem([{ role: 'primary', protocol: 'icecast', ingest_url: null }]));
falsy('an HLS source WITH a URL is fine',
  sourceProblem([{ role: 'primary', protocol: 'hls', ingest_url: 'https://x/y.m3u8' }]));
truthy('a URL of only whitespace is not a URL',
  sourceProblem([{ role: 'primary', protocol: 'hls', ingest_url: '   ' }]));

// PUSH — they send to us, so a stream key is enough: the endpoint is ours to
// issue and the key is what selects the channel. This is the distinction the
// original default was reaching for, and got right for the wrong rows.
truthy('an SRT source with neither URL nor stream key is refused',
  sourceProblem([{ role: 'primary', protocol: 'srt', ingest_url: null, stream_key: null }]));
falsy('an SRT source with a STREAM KEY and no URL is fine: we issue the endpoint',
  sourceProblem([{ role: 'primary', protocol: 'srt', ingest_url: null, stream_key: 'abc123' }]));
falsy('an RTMP source with a stream key is fine for the same reason',
  sourceProblem([{ role: 'primary', protocol: 'rtmp', ingest_url: null, stream_key: 'k' }]));
falsy('an SRT source with an explicit URL is fine',
  sourceProblem([{ role: 'primary', protocol: 'srt', ingest_url: 'srt://h:9000?streamid=a' }]));

// A package_only channel carries one primary row per rendition. Any usable one
// is enough; refusing because the third rung is blank would be wrong.
falsy('several primaries, one usable, is startable',
  sourceProblem([
    { role: 'primary', protocol: 'hls', ingest_url: null },
    { role: 'primary', protocol: 'hls', ingest_url: 'https://x/720.m3u8' },
  ]));

// The message is read by a person who has to go and fix something.
const msg = sourceProblem([{ role: 'primary', protocol: 'hls', ingest_url: null }]) ?? '';
truthy('the message names the protocol, so it is obvious which row is meant', /HLS/.test(msg));
truthy('and says where to go', /Settings/i.test(msg));
falsy('and does not leak an internal field name', /ingest_url|inputs\[/.test(msg));

// ---------------------------------------------------------------------------
//  2. THE BACKSTOP — the config builder cannot invent an address
// ---------------------------------------------------------------------------
console.log('\n== the builder that caused it ==');
const ctxFor = (inputs: any[]) => ({
  kind: 'channel' as const,
  owner: { id: 'ch', recording_enabled: false } as any,
  profile: { rungs: [{ height: 720, bitrate_kbps: 2500 }], packaging: 'both', workflow_type: 'transcode',
             codec_backend: 'x264', segment_dur: 4, dvr_window_sec: 60 } as any,
  inputs,
});
let threw = false;
try { buildEncoderJobConfig(ctxFor([{ role: 'primary', protocol: 'srt', ingest_url: null, stream_key: null, rendition_label: null, rendition_bitrate_kbps: null }])); }
catch { threw = true; }
truthy('an empty input no longer becomes srt://0.0.0.0:9000?streamid= ', threw);

let url = '';
try {
  const job: any = buildEncoderJobConfig(ctxFor([{ role: 'primary', protocol: 'srt', ingest_url: null, stream_key: 'key1', rendition_label: null, rendition_bitrate_kbps: null }]));
  url = job.inputs?.[0]?.url ?? '';
} catch (e) { url = `threw: ${(e as any).message}`; }
check('but a stream key still issues the endpoint it always did',
  url, 'srt://0.0.0.0:9000?streamid=key1');

// ---------------------------------------------------------------------------
//  3. THE REFUSAL, through the real orchestrator
// ---------------------------------------------------------------------------
const A = '00000000-0000-0000-0000-00000d810001';
const P = '00000000-0000-0000-0000-00000d810002';
const G = '00000000-0000-0000-0000-00000d810003';
const EMPTY = '00000000-0000-0000-0000-00000d810010';
const NOROWS = '00000000-0000-0000-0000-00000d810011';

(async () => {
  await query(`DELETE FROM accounts WHERE id=$1`, [A]);
  await query(`INSERT INTO accounts(id,name) VALUES ($1,'SourceCo')`, [A]);
  await query(
    `INSERT INTO output_profiles(id,account_id,name,rungs,workflow_type,packaging,segment_dur,dvr_window_sec)
     VALUES ($1,$2,'p','[{"height":720,"bitrate_kbps":2500}]','transcode','both',4,60)`, [P, A]);
  await query(`INSERT INTO groups(id,account_id,name,output_profile_id,max_channels)
               VALUES ($1,$2,'g',$3,10)`, [G, A, P]);
  await query(
    `INSERT INTO channels(id,group_id,name,status,kind,recording_enabled) VALUES
       ($1,$3,'No URL','ended','tv',true),
       ($2,$3,'No Source Rows','ended','tv',true)`, [EMPTY, NOROWS, G]);
  // The exact shape the console produces: the row exists, the protocol is set
  // from the dropdown's default, and the URL box was never filled in.
  await query(
    `INSERT INTO stream_inputs(channel_id,role,protocol,ingest_url,stream_key)
     VALUES ($1,'primary','srt',NULL,NULL)`, [EMPTY]);

  const { orchestrator } = await import('../src/services/orchestrator');

  console.log('\n== pressing start on a channel with an empty source ==');
  let err: any = null;
  try { await orchestrator.startStream('channel', EMPTY); } catch (e) { err = e; }
  truthy('it is refused', err);
  check('as a 400, so the console shows the reason instead of "Internal error"',
    err?.status, 400);
  truthy('it is a NotStartable', err instanceof NotStartable);
  truthy('the reason mentions the source', /source/i.test(String(err?.message)));

  // THE POINT OF THE WHOLE CHANGE. Refusing loudly is not enough; the refusal
  // has to happen before anything is spent.
  const inst = await one<any>(`SELECT count(*)::int n FROM instances WHERE channel_id=$1`, [EMPTY]);
  check('NOTHING was launched', inst?.n, 0);
  const rec = await one<any>(`SELECT count(*)::int n FROM recordings WHERE channel_id=$1`, [EMPTY]);
  check('no recording was opened', rec?.n, 0);
  const ch = await one<any>(`SELECT status, desired_state FROM channels WHERE id=$1`, [EMPTY]);
  check('and the channel did not claim to be live', ch?.status, 'ended');
  truthy('nor was it left intending to run, which auto-connect would act on',
    ch?.desired_state !== 'running');

  console.log('\n== and with no source row at all ==');
  err = null;
  try { await orchestrator.startStream('channel', NOROWS); } catch (e) { err = e; }
  truthy('also refused', err);
  check('also a 400', err?.status, 400);

  console.log('\n== auto-connect does not spend five attempts on it ==');
  //
  // The recovery budget is for faults that can come right on their own: a
  // source that dropped, a task that died, a host that went away. A missing
  // source is not one of those. Retrying it five times over ten minutes changes
  // nothing, buries the real reason under four identical failures, and spends
  // the budget of a channel that will need it for a real fault later.
  await query(`UPDATE channels SET auto_connect=true, desired_state='running',
                      status='ended', resume_attempts=0, resume_last_attempt_at=NULL,
                      resume_gave_up_at=NULL, stop_requested_at=NULL,
                      -- armed: only a stream that once ran healthy is resumed (db5c6f0)
                      resume_armed_at=now() WHERE id=$1`, [EMPTY]);
  const { resumeOnce } = await import('../src/services/orchestrator/resume');
  const pass1 = await resumeOnce(orchestrator as any);
  const outcome = pass1.outcomes.find((o: any) => o.id === EMPTY);
  check('the first pass gives up rather than scheduling a retry', outcome?.result, 'gave_up');
  const gave = await one<any>(
    `SELECT resume_attempts, resume_gave_up_at, resume_last_error FROM channels WHERE id=$1`, [EMPTY]);
  check('after ONE attempt, not five', gave?.resume_attempts, 1);
  truthy('the give-up is stamped', gave?.resume_gave_up_at);
  truthy('and the recorded reason is the one an operator can act on',
    /source/i.test(String(gave?.resume_last_error)));

  console.log('\n== fill the source in, and it starts ==');
  // A guard you cannot get out of is worse than the bug it fixed.
  await query(`UPDATE stream_inputs SET ingest_url='srt://127.0.0.1:9999?streamid=x'
                WHERE channel_id=$1 AND role='primary'`, [EMPTY]);
  err = null;
  let res: any = null;
  try { res = await orchestrator.startStream('channel', EMPTY); } catch (e) { err = e; }
  falsy('no longer refused', err);
  truthy('and a task was launched', res?.taskArn);
  await orchestrator.stopStream('channel', EMPTY, 'test', 'internal').catch(() => {});

  await query(`DELETE FROM accounts WHERE id=$1`, [A]);
  console.log(`\nsource-required: ${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error('FATAL', e);
  await pool.end().catch(() => {});
  process.exit(1);
});
