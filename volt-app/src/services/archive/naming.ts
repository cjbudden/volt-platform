// ============================================================================
//  FILE NAMES FOR ARCHIVE COPIES (build queue H3-2, HYBRID_SITES.md "Copy
//  rules": names are `Title-Channel-YYYYMMDD-HHMM`).
//
//  Shared, not copied: the site agent compiles this file from here (its
//  tsconfig rootDir is the repo), so the name the cloud expects and the name
//  the agent writes come from the same code. No imports for that reason.
//
//  The rules, as Christian set them:
//    - values separated by `-`; spaces removed; any character a target might
//      not store dropped (only letters, digits, `.`, `_` and `-` survive, so
//      the name is safe on SMB, NFS, local disks and S3 keys alike);
//    - recordings: one file per programme when the channel has an EPG
//      (`MorningNews-Channel1-20261103-0600.mp4`), one per hour without (no
//      title: `Channel1-20261103-0600.mp4`), in the channel's time zone;
//    - a name already taken gets `-2`, `-3` added before the extension.
// ============================================================================

/** One value of a name: spaces and anything a target may not store removed. */
export function nameValue(s: string | null | undefined): string {
  return String(s ?? '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')   // accents off, so "Café" is "Cafe", not "Caf"
    .replace(/[^A-Za-z0-9._-]+/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '');
}

/**
 * A whole file name made safe: the base cleaned like a value, the extension
 * kept (lower-cased, letters and digits only). Never empty, never `.` or
 * `..`, never a path: a name can only ever land in the target's own folder.
 */
export function safeFileName(name: string | null | undefined, fallback = 'file'): string {
  const raw = String(name ?? '').split(/[\\/]/).pop() ?? '';
  const dot = raw.lastIndexOf('.');
  const ext = dot > 0 ? raw.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 10) : '';
  const base = nameValue(dot > 0 ? raw.slice(0, dot) : raw).slice(0, 180) || nameValue(fallback) || 'file';
  return ext ? `${base}.${ext}` : base;
}

/** `name.ext`, then `name-2.ext`, `name-3.ext`: the first one `taken` says is free. */
export function freeName(name: string, taken: (candidate: string) => boolean, max = 1000): string {
  if (!taken(name)) return name;
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let n = 2; n <= max; n++) {
    const c = `${base}-${n}${ext}`;
    if (!taken(c)) return c;
  }
  throw new Error(`no free name for ${name} after ${max} tries`);
}

/** YYYYMMDD-HHMM of an instant, in an IANA time zone (the channel's broadcast zone). */
export function stampIn(at: Date | number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(at));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  return `${get('year')}${get('month')}${get('day')}-${get('hour')}${get('minute')}`;
}

/**
 * The name of a consolidated recording file. With a programme title (the
 * channel has an EPG) `Title-Channel-YYYYMMDD-HHMM`; without one (an hourly
 * file) `Channel-YYYYMMDD-HHMM`. A value that cleans to nothing is left out
 * rather than leaving a stray `-`.
 */
export function recordingFileName(o: { title?: string | null; channel: string; start: Date | number; timeZone?: string | null; ext?: string }): string {
  const values = [o.title ? nameValue(o.title) : '', nameValue(o.channel), stampIn(o.start, o.timeZone || 'UTC')].filter(Boolean);
  return `${values.join('-')}.${(o.ext ?? 'mp4').replace(/^\./, '')}`;
}
