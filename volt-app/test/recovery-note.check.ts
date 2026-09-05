// ============================================================================
//  WHAT THE CONSOLE SAYS ABOUT RECOVERY, AND WHEN IT SAYS NOTHING.
//
//  This rule has been wrong twice, in opposite directions, and both times it
//  looked correct in the file it was written in:
//
//    1. It showed NOTHING while a stream was being retried. Recovery was
//       invisible, so "resume is not working" was the only conclusion available
//       from the console, and there was no way to tell whether it was true.
//
//    2. It then read `resume_attempts > 0` as "currently retrying". A fully
//       healthy station — every gate green, audio on the meter, eleven segments
//       live — announced that auto reconnect was retrying, attempt 1 of 5.
//
//  THE SECOND MISTAKE IS THE ONE WORTH PINNING. resume_attempts is a BUDGET
//  LEDGER, not a live activity flag. An attempt is spent at launch and
//  deliberately NOT cleared by a successful start, because a crash loop starts
//  successfully every single time and clearing it there would put the give-up
//  cap out of reach. The count comes back only when expireStaleBudgets sees the
//  run outlive the budget TTL, which is ten minutes of staying up. So for ten
//  minutes after every recovery, a healthy stream carries attempts=1. The
//  number was right; the sentence built from it was not.
//
//  A rule that is a one-line ternary inside a component is a rule nobody can
//  test, which is how it stayed wrong. It is a pure function now, and this is
//  what it must say.
//
//  Usage: npx tsx test/recovery-note.check.ts     (no database, no ffmpeg)
// ============================================================================
import { recoveryView, isUp, RESUME_MAX_ATTEMPTS } from '../../volt-web/src/recovery';

let pass = 0, fail = 0;
const ok = (m: string) => { console.log('PASS ' + m); pass++; };
const bad = (m: string, d: string) => { console.log(`FAIL ${m} -- ${d}`); fail++; };
const check = (m: string, got: unknown, want: unknown) =>
  got === want ? ok(m) : bad(m, `expected [${String(want)}] got [${String(got)}]`);
const truthy = (m: string, v: unknown) => (v ? ok(m) : bad(m, `expected something, got [${String(v)}]`));

/** A stream that is meant to be running, with auto-connect on. */
const row = (over: Record<string, any> = {}) => ({
  desired_state: 'running', auto_connect: true,
  resume_attempts: 0, resume_gave_up_at: null, resume_last_error: null, ...over,
});

console.log('== up means bytes are moving, not that a row says live ==');
check('on air is up', isUp('onair'), true);
check('ready is up: the pipeline is producing, it is just private', isUp('ready'), true);
check('degraded is up — imperfect is still running', isUp('degraded'), true);
check('idle is not', isUp('idle'), false);
check('error is not', isUp('error'), false);
check('stopped is not', isUp('stopped'), false);
// STARTING IS DELIBERATELY NOT UP. A stream starting after a failed attempt is
// exactly when the retry count is worth showing, and calling it up would hide
// the count at the one moment somebody is watching for it.
check('and STARTING is not, because that is when a retry is worth showing',
  isUp('starting'), false);
check('an absent state is not assumed to be up', isUp(undefined), false);

console.log('\n== a healthy stream says nothing, whatever the ledger holds ==');
// THE REGRESSION THIS SUITE EXISTS FOR.
check('a running stream with a spent attempt is SILENT',
  recoveryView(row({ resume_attempts: 1 }), 'onair').kind, 'none');
check('even with the full budget spent, if it is up it is up',
  recoveryView(row({ resume_attempts: 5 }), 'onair').kind, 'none');
check('and a ready (private) stream is silent too',
  recoveryView(row({ resume_attempts: 1 }), 'ready').kind, 'none');
check('a degraded stream is running, so still silent',
  recoveryView(row({ resume_attempts: 2 }), 'degraded').kind, 'none');
check('a healthy stream that never needed recovery says nothing',
  recoveryView(row(), 'onair').kind, 'none');

console.log('\n== a stream that is NOT up, and has spent attempts, is retrying ==');
const retrying = recoveryView(row({ resume_attempts: 2 }), 'error');
check('that is a retry', retrying.kind, 'retrying');
truthy('and it says which attempt, so the count means something',
  retrying.text.includes(`2 of ${RESUME_MAX_ATTEMPTS}`));
check('a stream STARTING after a failed attempt still shows the count',
  recoveryView(row({ resume_attempts: 3 }), 'starting').kind, 'retrying');
check('an idle stream with no attempts spent has nothing to report',
  recoveryView(row(), 'idle').kind, 'none');

console.log('\n== the reason travels with it ==');
const withErr = recoveryView(
  row({ resume_attempts: 1, resume_last_error: 'encoder exited rc=183: Master Playlist tag found in a Media Playlist' }),
  'error');
check('the encoder\'s own words are carried verbatim',
  withErr.lastError, 'encoder exited rc=183: Master Playlist tag found in a Media Playlist');

console.log('\n== gave up outranks everything ==');
// It means nothing will bring this back on its own, which stays true whatever
// else the pipeline is doing, and until a person presses Start.
const gone = recoveryView(row({ resume_attempts: 5, resume_gave_up_at: '2026-09-02T09:00:00Z' }), 'error');
check('a give-up is reported', gone.kind, 'gave_up');
truthy('it says a manual start clears it, or the only cure looks like a DB edit',
  /Starting it again clears this/.test(gone.text));
check('and it is reported even if the stream somehow reads as up',
  recoveryView(row({ resume_attempts: 5, resume_gave_up_at: '2026-09-02T09:00:00Z' }), 'onair').kind,
  'gave_up');

console.log('\n== auto-connect switched off is worth one sentence ==');
check('a stopped stream that is meant to run, with recovery off, says so',
  recoveryView(row({ auto_connect: false }), 'error').kind, 'auto_off');
check('but a stream nobody wants running is not nagged about it',
  recoveryView(row({ auto_connect: false, desired_state: 'stopped' }), 'idle').kind, 'none');
check('and a running stream is not nagged either',
  recoveryView(row({ auto_connect: false }), 'onair').kind, 'none');

console.log('\n== a start that never proved itself: not armed, nothing will retry ==');
//
// Auto connect only puts back a stream that has shown four healthy gates on
// this run. A first start that fails is therefore left where it fell, and
// the note has to say so, or the operator waits for a retry that is never
// coming. It is said only once there is a failure to read: a stream still
// coming up is starting, not abandoned.
check('failed, wants to run, never armed: the note says it is not armed',
  recoveryView(row({ resume_armed_at: null, resume_last_error: 'died after 3s: exited rc=1' }), 'error').kind, 'not_armed');
check('the same with no recorded error but an error state',
  recoveryView(row({ resume_armed_at: null }), 'error').kind, 'not_armed');
check('and it carries the encoder\'s words',
  recoveryView(row({ resume_armed_at: null, resume_last_error: 'died after 3s: exited rc=1' }), 'error').lastError, 'died after 3s: exited rc=1');
check('still starting: not yet a verdict',
  recoveryView(row({ resume_armed_at: null }), 'starting').kind, 'none');
check('idle with nothing recorded: nothing to say',
  recoveryView(row({ resume_armed_at: null }), 'idle').kind, 'none');
check('armed and failed with attempts spent reads as retrying, not as unarmed',
  recoveryView(row({ resume_armed_at: '2026-09-05T00:00:00Z', resume_attempts: 2 }), 'error').kind, 'retrying');
check('a stream the operator stopped is not called unarmed',
  recoveryView(row({ resume_armed_at: null, desired_state: 'stopped', resume_last_error: 'x' }), 'stopped').kind, 'none');
check('camelCase spelling of the stamp is understood',
  recoveryView(row({ resumeArmedAt: '2026-09-05T00:00:00Z', resume_attempts: 1 }), 'error').kind, 'retrying');

console.log('\n== both payload spellings, because the two pages differ ==');
// The channel detail maps to camelCase; the radio detail spreads the row.
check('camelCase (channel detail) is understood',
  recoveryView({ desiredState: 'running', autoConnect: true, resumeAttempts: 2 }, 'error').kind,
  'retrying');
check('snake_case (radio detail) is understood',
  recoveryView({ desired_state: 'running', auto_connect: true, resume_attempts: 2 }, 'error').kind,
  'retrying');
check('and a missing row is not a crash', recoveryView(null, 'onair').kind, 'none');

console.log(`\nrecovery-note: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
