// ============================================================================
//  FAILURE DIAGNOSIS — what the platform THINKS went wrong, in one sentence.
//
//  The gates say WHERE a pipeline broke (input, encoder, output). The event
//  log and the encoder log say what the processes printed. Neither says WHY
//  in words an operator can act on: "exited rc=1" and "Connection refused"
//  are symptoms, and a person reading them at 3am has to know that the second
//  one means "nothing is listening at the source address" before they know
//  which phone to pick up.
//
//  This is a classifier over that evidence. It is deliberately a table of
//  patterns, each carrying a plain-language verdict and the next thing to
//  check, ordered from most to least specific, and the first match wins. The
//  raw lines it matched are returned as evidence so the verdict is never a
//  bare assertion: the operator can see the words it was built from.
//
//  It is PURE. It reads only what it is given, so it can be pinned with a
//  fixture per cause, and it never guesses harder than the evidence allows:
//  with no matching pattern the verdict is the gate's own detail and the
//  confidence is low.
// ============================================================================
import type { Gate, GateName } from './pipelineHealth';

export interface FailureDiagnosis {
  /** Which stage the fault belongs to. */
  gate: GateName;
  /** A short name for the cause, e.g. "Source refused the connection". */
  verdict: string;
  /** One or two sentences: what that means. */
  reason: string;
  /** The first thing to check or do. */
  nextStep: string;
  /** How sure the classifier is: high = a specific pattern matched more than once. */
  confidence: 'high' | 'medium' | 'low';
  /** The raw lines the verdict was built from (newest first, at most 5). */
  evidence: string[];
  /** Whether auto connect is going to retry this, and why or why not. */
  retry: { willRetry: boolean; note: string };
}

interface Rule {
  rx: RegExp;
  gate: GateName;
  verdict: string;
  reason: string;
  nextStep: string;
}

// Most specific first. A rule's gate overrides the gate the health model
// chose only when the evidence is unambiguous about where the fault lives.
const RULES: Rule[] = [
  { rx: /no source configured|no primary source|has no source|NotStartable/i, gate: 'input',
    verdict: 'No input source is configured',
    reason: 'The stream was asked to start with nowhere to pull from. This is a configuration gap, not a fault, and it cannot fix itself.',
    nextStep: 'Open Settings and set the primary input, then press Start.' },
  { rx: /ECONNREFUSED|connection refused/i, gate: 'input',
    verdict: 'Source refused the connection',
    reason: 'The source host answered, but nothing is listening on that port. Typically the encoder, relay or Icecast mount at the source is not running, or the port is wrong.',
    nextStep: 'Check the source is actually running and the port in the source URL matches it.' },
  { rx: /ENOTFOUND|getaddrinfo|name or service not known|could not resolve|Name does not resolve/i, gate: 'input',
    verdict: 'Source hostname does not resolve',
    reason: 'DNS could not turn the source hostname into an address, so the connection was never attempted.',
    nextStep: 'Check the hostname in the source URL for a typo, and that this server can resolve it.' },
  { rx: /ETIMEDOUT|timed? ?out|EHOSTUNREACH|ENETUNREACH|no route to host/i, gate: 'input',
    verdict: 'Source is unreachable',
    reason: 'The connection attempt got no answer at all. The host is down, or a firewall or network path is blocking it from here.',
    nextStep: 'Confirm the source is up and reachable from this server (ping or curl the URL from the box).' },
  { rx: /\b(401|403)\b|unauthori[sz]ed|forbidden|authentication|bad credentials|invalid (user|password|token)/i, gate: 'input',
    verdict: 'Source rejected the credentials',
    reason: 'The source answered but refused access. The stream key, username or password in the source configuration is wrong or has expired.',
    nextStep: 'Re-enter the source credentials or stream key in Settings.' },
  { rx: /\b404\b|not found|no such file or directory|NoSuchKey/i, gate: 'input',
    verdict: 'Source path was not found',
    reason: 'The host is reachable but the path or mount in the source URL does not exist there (HTTP 404, or a missing file).',
    nextStep: 'Check the path or mount name in the source URL against what the source is publishing.' },
  { rx: /Server returned 5\d\d|\b50[0-4]\b|bad gateway|service unavailable/i, gate: 'input',
    verdict: 'Source returned a server error',
    reason: 'The source host is up but its service is failing (HTTP 5xx). That is a problem at the source end.',
    nextStep: 'Check the source service itself; retry once it reports healthy.' },
  { rx: /Invalid data found|could not find codec|moov atom not found|Unsupported codec|Unable to find a suitable output|invalid stream|non-monotonous/i, gate: 'input',
    verdict: 'Source is reachable but not decodable',
    reason: 'Bytes arrived but ffmpeg could not make sense of them: the URL points at something that is not a media stream, or at a codec or container this pipeline does not accept.',
    nextStep: 'Open the source URL in a player to confirm it is a live media stream, and check its format against the supported inputs.' },
  { rx: /EADDRINUSE|address already in use|bind(ing)? (failed|error)|failed to bind/i, gate: 'encoder',
    verdict: 'A port the encoder needs is already in use',
    reason: 'The encoder could not open a listening port because another process (often a previous run that did not exit) still holds it.',
    nextStep: 'Look for a leftover encoder or relay process on this host and stop it, then start again.' },
  { rx: /ENOSPC|no space left|disk full|read-only file system|EROFS|EACCES|permission denied|file_failure/i, gate: 'encoder',
    verdict: 'The encoder could not write its output',
    reason: 'Segments could not be written to disk: the volume is full, read-only, or not writable by the encoder.',
    nextStep: 'Check free space and permissions on the origin directory.' },
  { rx: /packager|shaka/i, gate: 'encoder',
    verdict: 'The packager failed',
    reason: 'The encoder was producing media but the packager that turns it into HLS and DASH stopped.',
    nextStep: 'Read the packager lines in the encoder log below; a restart usually clears a one-off packager crash.' },
  { rx: /rc=-9|rc=137|SIGKILL|out of memory|OOM/i, gate: 'server',
    verdict: 'The encoder process was killed',
    reason: 'The process was terminated from outside rather than exiting on its own: most often the host ran out of memory, or the launcher stopped it.',
    nextStep: 'Check memory on the host and whether the container was stopped or replaced.' },
  { rx: /exited rc=\d+|exit(ed)? code/i, gate: 'encoder',
    verdict: 'The encoder exited with an error',
    reason: 'ffmpeg or the encoder wrapper ended with a non-zero exit code shortly after starting. The lines around it in the encoder log say why.',
    nextStep: 'Read the encoder log tail below for the last error before the exit.' },
  { rx: /output stalled|no new segments|stall/i, gate: 'output',
    verdict: 'Output stopped advancing',
    reason: 'The encoder is up but no new segments are being produced, which usually means the input froze or stopped delivering frames.',
    nextStep: 'Check the source is still sending; if it is, restart the stream.' },
  { rx: /source down|source\.down|no signal|dead air|silence/i, gate: 'input',
    verdict: 'The source stopped delivering',
    reason: 'The connection was made and then went quiet: the source stopped sending media.',
    nextStep: 'Check the source end; the stream recovers on its own once it resumes, if auto connect is armed.' },
];

export interface DiagnosisInput {
  gates: Gate[];
  primaryError: { gate: GateName; label: string; message: string } | null;
  settlingReason?: string | null;
  /** Newest first: the event log entries' messages and reasons, as strings. */
  eventLines: string[];
  /** Newest first: error lines from the encoder log. */
  logLines: string[];
  recovery?: {
    autoConnect?: boolean;
    armed?: boolean;
    attempts?: number;
    maxAttempts?: number;
    gaveUp?: boolean;
    lastError?: string | null;
  } | null;
}

/** Pull the text out of an event's detail, whatever shape it came in. */
export function eventLine(e: { type: string; detail: any }): string {
  let det = e.detail;
  if (typeof det === 'string') { try { det = JSON.parse(det); } catch { /* keep the string */ } }
  const bits = [e.type];
  if (det && typeof det === 'object') {
    for (const k of ['reason', 'message', 'error', 'text']) if (det[k]) bits.push(String(det[k]));
  } else if (det) bits.push(String(det));
  return bits.join(': ');
}

export function diagnoseFailure(inp: DiagnosisInput): FailureDiagnosis | null {
  const failed = inp.gates.find((g) => g.status === 'failed');
  const primary = inp.primaryError;
  // Nothing is wrong. A settling fault still counts: it is held back from the
  // badge, not from the person reading a QC report.
  if (!failed && !primary && !inp.settlingReason) return null;

  const lines = [
    ...(inp.recovery?.lastError ? [inp.recovery.lastError] : []),
    ...(inp.settlingReason ? [inp.settlingReason] : []),
    ...(primary ? [primary.message] : []),
    ...inp.gates.filter((g) => g.status === 'failed' || g.status === 'degraded').map((g) => g.detail),
    ...inp.eventLines,
    ...inp.logLines,
  ].map((l) => String(l ?? '').trim()).filter(Boolean);
  const seen = new Set<string>();
  const uniq = lines.filter((l) => (seen.has(l) ? false : (seen.add(l), true)));

  let match: { rule: Rule; hits: string[] } | null = null;
  for (const rule of RULES) {
    const hits = uniq.filter((l) => rule.rx.test(l));
    if (hits.length) { match = { rule, hits }; break; }
  }

  const gate: GateName = match?.rule.gate ?? primary?.gate ?? failed?.gate ?? 'server';
  const retry = retryNote(inp.recovery);
  if (match) {
    return {
      gate,
      verdict: match.rule.verdict,
      reason: match.rule.reason,
      nextStep: match.rule.nextStep,
      confidence: match.hits.length > 1 ? 'high' : 'medium',
      evidence: match.hits.slice(0, 5),
      retry,
    };
  }
  const label = inp.gates.find((g) => g.gate === gate)?.label ?? gate;
  return {
    gate,
    verdict: `${label} failed`,
    reason: primary?.message || failed?.detail || inp.settlingReason || 'The pipeline reported a fault without a recognisable cause.',
    nextStep: 'Read the events and the encoder log below; the last lines before the stop are the reason.',
    confidence: 'low',
    evidence: uniq.slice(0, 5),
    retry,
  };
}

function retryNote(r: DiagnosisInput['recovery']): FailureDiagnosis['retry'] {
  if (!r) return { willRetry: false, note: '' };
  if (r.autoConnect === false) return { willRetry: false, note: 'Auto connect is switched off for this stream: nothing will restart it.' };
  if (r.gaveUp) return { willRetry: false, note: `Auto connect gave up after ${r.attempts ?? '?'} attempt(s). Pressing Start clears this.` };
  if (r.armed === false) return { willRetry: false, note: 'This run never reached a healthy pipeline, so auto connect is not armed: the failure is left as it is for you to read. Fix the cause and press Start.' };
  return { willRetry: true, note: `Auto connect will retry (attempt ${(r.attempts ?? 0) + 1} of ${r.maxAttempts ?? 5}).` };
}
