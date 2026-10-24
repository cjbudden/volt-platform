// ============================================================================
//  READING A CMCD REPORT LINE (CTA-5004, version 2).
//
//  A CMCD payload is a Structured Field Dictionary (RFC 8941): keys in
//  lowercase, values that are integers, decimals, quoted strings, tokens,
//  booleans (a bare key is true) or inner lists `( ... )`. The collector reads
//  each line of an event-mode POST with this, so it holds no dependency on a
//  client library. Item parameters (`;v`, `;a` on inner list members) are
//  kept as `{ value, params }` only when present.
//
//  Strict on structure, forgiving on meaning: a malformed line is refused
//  (the caller counts it), unknown keys are kept (report 12 counts them).
// ============================================================================

export type CmcdBare = number | string | boolean | { token: string };
export type CmcdItem = CmcdBare | { value: CmcdBare; params: Record<string, CmcdBare> };
export type CmcdValue = CmcdItem | CmcdItem[];

export class CmcdParseError extends Error {}

export function parseCmcdLine(line: string): Record<string, CmcdValue> {
  const s = line.trim();
  const out: Record<string, CmcdValue> = {};
  let i = 0;
  const fail = (m: string): never => { throw new CmcdParseError(`${m} at ${i}`); };
  const ws = () => { while (s[i] === ' ' || s[i] === '\t') i++; };

  const key = (): string => {
    const m = /^[a-z*][a-z0-9_\-.*]*/.exec(s.slice(i));
    if (!m) fail('bad key');
    i += m![0].length;
    return m![0];
  };

  const bare = (): CmcdBare => {
    const c = s[i];
    if (c === '"') {
      i++;
      let v = '';
      while (i < s.length) {
        const ch = s[i++];
        if (ch === '\\') { const n = s[i++]; if (n !== '"' && n !== '\\') fail('bad escape'); v += n; continue; }
        if (ch === '"') return v;
        if (ch < ' ' || ch > '~') fail('bad character in string');
        v += ch;
      }
      return fail('unterminated string');
    }
    if (c === '?') { const b = s[i + 1]; i += 2; if (b === '1') return true; if (b === '0') return false; return fail('bad boolean'); }
    if (c === '-' || (c >= '0' && c <= '9')) {
      const m = /^-?\d{1,15}(\.\d{1,3})?/.exec(s.slice(i));
      if (!m) fail('bad number');
      i += m![0].length;
      return Number(m![0]);
    }
    if (c === '*' || /[A-Za-z]/.test(c ?? '')) {
      const m = /^[A-Za-z*][A-Za-z0-9:/!#$%&'*+\-.^_`|~]*/.exec(s.slice(i));
      i += m![0].length;
      return { token: m![0] };
    }
    if (c === ':') { // byte sequence: kept as its base64 text
      const end = s.indexOf(':', i + 1);
      if (end < 0) fail('bad byte sequence');
      const v = s.slice(i + 1, end); i = end + 1; return v;
    }
    return fail('bad value');
  };

  const params = (): Record<string, CmcdBare> | null => {
    let p: Record<string, CmcdBare> | null = null;
    while (s[i] === ';') {
      i++; ws();
      const k = key();
      let v: CmcdBare = true;
      if (s[i] === '=') { i++; v = bare(); }
      (p ??= {})[k] = v;
    }
    return p;
  };

  const item = (): CmcdItem => {
    const v = bare();
    const p = params();
    return p ? { value: v, params: p } : v;
  };

  while (i < s.length) {
    const k = key();
    let v: CmcdValue = true;
    if (s[i] === '=') {
      i++;
      if (s[i] === '(') {
        i++;
        const list: CmcdItem[] = [];
        for (;;) {
          while (s[i] === ' ') i++;
          if (s[i] === ')') { i++; break; }
          if (i >= s.length) fail('unterminated inner list');
          list.push(item());
          if (s[i] !== ' ' && s[i] !== ')') fail('bad inner list');
        }
        params();
        v = list;
      } else v = item();
    } else {
      const p = params();
      if (p) v = { value: true, params: p };
    }
    // Tokens (ot=v, sta=p, e=ps, custom ones too) are read as plain strings.
    if (typeof v === 'object' && v && 'token' in (v as any)) v = (v as any).token;
    out[k] = v;
    ws();
    if (i >= s.length) break;
    if (s[i] !== ',') fail('expected a comma');
    i++; ws();
  }
  return out;
}

export interface ReportCheck { ok: boolean; why?: string; report?: Record<string, CmcdValue> }

/**
 * An event-mode report as the collector accepts it: version 2, and the keys
 * every report must carry (v, ts, e, sid), plus our SDK's sn. A report from a
 * third-party player without sn is still accepted (report 12 counts it).
 */
export function checkEventReport(line: string, now = Date.now()): ReportCheck {
  let r: Record<string, CmcdValue>;
  try { r = parseCmcdLine(line); } catch (e) { return { ok: false, why: (e as Error).message }; }
  if (r.v !== 2) return { ok: false, why: 'v must be 2' };
  if (typeof r.e !== 'string' || !r.e) return { ok: false, why: 'e missing' };
  if (typeof r.ts !== 'number' || !Number.isInteger(r.ts)) return { ok: false, why: 'ts missing' };
  // A clock a day out is a broken device, not a late report: kept out of the reports.
  if (Math.abs(r.ts - now) > 86_400_000) return { ok: false, why: 'ts out of range' };
  if (typeof r.sid !== 'string' || !r.sid || r.sid.length > 64) return { ok: false, why: 'sid missing' };
  if (r.sn != null && (typeof r.sn !== 'number' || !Number.isInteger(r.sn) || r.sn < 0)) return { ok: false, why: 'bad sn' };
  if (r.e === 'ps' && typeof r.sta !== 'string') return { ok: false, why: 'ps without sta' };
  return { ok: true, report: r };
}
