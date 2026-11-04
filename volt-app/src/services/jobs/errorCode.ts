// ============================================================================
//  A SHORT CODE FOR EVERY FAILURE (build queue W1).
//
//  The workflow report counts failures per stage by code, so "QC failed 14
//  times" can say "9 source_missing, 5 timeout". Until W1 only PermanentError
//  carried a code; a handler that simply threw left jobs.error_code empty and
//  the report could only say "error". This picks a code for any thrown value,
//  in order:
//
//    1. the error's own `code`, when it is a short identifier (PermanentError,
//       Node's ENOENT / ECONNREFUSED, pg's 23505, an AWS SDK name),
//    2. a few shapes of message every handler produces (a timeout, a missing
//       file, a tool that exited non-zero, a refused or failed HTTP call),
//    3. `error`, so a failure is never counted without a code.
//
//  Codes are lower case with underscores, at most 40 characters, so they group
//  cleanly however a library spelled them.
// ============================================================================

const SHAPES: Array<[RegExp, string]> = [
  [/timed?[ -]?out|timeout|deadline exceeded|ETIMEDOUT/i, 'timeout'],
  [/ENOENT|no such file|not found|does not exist|missing source|source (?:is )?missing/i, 'source_missing'],
  [/ECONNREFUSED|ECONNRESET|EAI_AGAIN|ENOTFOUND|socket hang up|network/i, 'network'],
  [/\b(?:HTTP|status)[ :]*(4\d\d)\b/i, 'http_$1'],
  [/\b(?:HTTP|status)[ :]*(5\d\d)\b/i, 'http_$1'],
  [/exit(?:ed)?(?: with)?(?: code| status)? \d+|non-?zero exit|killed by signal|SIGKILL|SIGTERM/i, 'tool_exit'],
  [/ENOSPC|no space left/i, 'disk_full'],
  [/permission denied|EACCES|access denied|forbidden/i, 'access_denied'],
  [/invalid|malformed|unsupported/i, 'invalid_input'],
];

/** Normalise a code to the report's shape, or null if it is not one. */
export function normaliseCode(c: unknown): string | null {
  if (typeof c !== 'string' && typeof c !== 'number') return null;
  const s = String(c).trim();
  if (!s || s.length > 40 || !/^[A-Za-z0-9_.:-]+$/.test(s)) return null;
  return s.replace(/[.:-]+/g, '_').replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

/** The code for a failure from its message alone (old rows, add-on errors). */
export function codeFromMessage(message: string | null | undefined): string {
  const m = String(message ?? '');
  for (const [re, code] of SHAPES) {
    const hit = re.exec(m);
    if (hit) return code.includes('$1') ? code.replace('$1', hit[1]) : code;
  }
  return 'error';
}

/** The code to store with a failed attempt of `e`. */
export function errorCodeOf(e: unknown): string {
  const own = normaliseCode((e as any)?.code);
  if (own) return own;
  return codeFromMessage(e instanceof Error ? e.message : String(e));
}
