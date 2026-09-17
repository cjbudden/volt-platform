// ============================================================================
//  INGEST NAMING — what a file is called once it is ours.
//
//  Every file that lands, from any source, passes through sanitise(). It is
//  the one function that makes S3, ffmpeg, NTFS shares, CDNs and the shell
//  indifferent to what an edit suite called something. The original name is
//  never lost: it is returned beside the new one and the ingest writes it into
//  metadata and the asset title.
//
//  THE CHARSET IS DELIBERATELY SMALL. S3 keys allow almost anything, but a key
//  with a space or a '+' is a different key depending on which client encoded
//  it, and an encoder invoked with a name containing '$(' is a security
//  report. [A-Za-z0-9._-] is the set every tool in the chain agrees on.
//
//  GUID IS THE RECOMMENDED DEFAULT because two shoots called final.mxf are a
//  problem the day after ingest, not the day of. The readable modes exist for
//  accounts whose people browse the bucket by hand.
// ============================================================================
import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';

export type NamingMode = 'honour' | 'guid' | 'guid_prefixed' | 'template';
export type StructureMode = 'flat' | 'honour' | 'minimal' | 'template';

export interface NamingPolicy {
  naming: NamingMode;
  structure: StructureMode;
  /** For naming 'template': tokens {name} {ext} {guid} {yyyy} {mm} {dd} {type} {kind}. */
  nameTemplate?: string | null;
  /** For structure 'template': same tokens plus {account} {path}. */
  pathTemplate?: string | null;
  lowercase?: boolean;
  /** Bytes. Default 200, the sanitised base name is truncated to fit with its extension. */
  maxNameBytes?: number;
}

export const DEFAULT_NAMING: Required<Pick<NamingPolicy, 'naming' | 'structure' | 'lowercase' | 'maxNameBytes'>> = {
  naming: 'guid', structure: 'flat', lowercase: false, maxNameBytes: 200,
};

/** Windows reserved device names. A file called CON.mp4 cannot be written on a share. */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export interface Sanitised {
  /** Base name without extension, safe. */
  base: string;
  /** Lower-cased extension including the dot, or '' if none was recognisable. */
  ext: string;
  /** base + ext. */
  name: string;
  /** True if anything was changed. */
  changed: boolean;
}

/** Split on the last dot, but only if what follows looks like an extension. */
export function splitExt(name: string): { base: string; ext: string } {
  const m = /^(.*?)(\.[A-Za-z0-9]{1,8})$/.exec(name);
  if (!m || !m[1]) return { base: name, ext: '' };
  return { base: m[1], ext: m[2].toLowerCase() };
}

function truncateUtf8(s: string, maxBytes: number): string {
  let out = s;
  while (Buffer.byteLength(out, 'utf8') > maxBytes) out = out.slice(0, -1);
  return out;
}

/**
 * Make one file name safe for every tool downstream.
 * Pure, deterministic, idempotent: sanitise(sanitise(x)) === sanitise(x).
 */
export function sanitise(original: string, opts: { lowercase?: boolean; maxNameBytes?: number } = {}): Sanitised {
  const maxBytes = opts.maxNameBytes ?? DEFAULT_NAMING.maxNameBytes;
  // Only the last path segment; a name is not a path.
  const leaf = original.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? '';
  const { base: rawBase, ext } = splitExt(leaf.trim());
  let base = rawBase
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')          // combining marks left by NFKD (é -> e)
    .replace(/[^A-Za-z0-9._-]+/g, '_')         // everything else
    .replace(/_+/g, '_')
    .replace(/-+/g, '-')
    .replace(/[._-]*\.+[._-]*/g, '.')          // no runs around dots, no '..'
    .replace(/^[._-]+|[._-]+$/g, '');          // no leading/trailing punctuation
  if (opts.lowercase) base = base.toLowerCase();
  if (!base || RESERVED.test(base)) base = base ? `${base}_file` : 'file';
  base = truncateUtf8(base, Math.max(8, maxBytes - ext.length));
  const name = base + ext;
  return { base, ext, name, changed: name !== leaf };
}

export interface NamingInput {
  originalName: string;
  /** Relative path from the drop root or folder pick, forward slashes, no leading slash. */
  relativePath?: string | null;
  accountId: string;
  contentTypeKey?: string | null;
  kind?: string | null;          // video | audio | image | other
  now?: Date;
  guid?: string;
}

export interface NamingResult {
  /** The object key, relative to the account's store root. */
  key: string;
  /** Directory part of the key ('' for flat). */
  dir: string;
  /** File name part. */
  filename: string;
  guid: string;
  originalName: string;
  originalPath: string | null;
  sanitised: Sanitised;
}

function tokens(p: NamingPolicy, i: NamingInput, s: Sanitised, guid: string): Record<string, string> {
  const d = i.now ?? new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    name: s.base, ext: s.ext.replace(/^\./, ''), guid,
    yyyy: String(d.getUTCFullYear()), mm: pad(d.getUTCMonth() + 1), dd: pad(d.getUTCDate()),
    type: sanitise(i.contentTypeKey ?? 'untyped').base, kind: i.kind ?? 'other',
    account: i.accountId, path: sanitisePath(i.relativePath ?? ''),
  };
}

function fill(tpl: string, t: Record<string, string>): string {
  return tpl.replace(/\{(\w+)\}/g, (_, k) => (k in t ? t[k] : ''));
}

/** Sanitise each segment of a relative path and drop empties and dot segments. */
export function sanitisePath(rel: string): string {
  return rel.replace(/\\/g, '/').split('/')
    .filter((seg) => seg && seg !== '.' && seg !== '..')
    .map((seg) => sanitise(seg).name)
    .join('/');
}

/** Apply a policy to one file. Pure apart from the guid, which can be injected. */
export function applyNaming(policy: Partial<NamingPolicy>, input: NamingInput): NamingResult {
  const p: NamingPolicy = { ...DEFAULT_NAMING, ...policy };
  const s = sanitise(input.originalName, { lowercase: p.lowercase, maxNameBytes: p.maxNameBytes });
  const guid = input.guid ?? randomUUID();
  const t = tokens(p, input, s, guid);

  let filename: string;
  switch (p.naming) {
    case 'honour': filename = s.name; break;
    case 'guid_prefixed': filename = `${guid}_${s.name}`; break;
    case 'template': filename = sanitise(fill(p.nameTemplate || '{name}.{ext}', t)).name; break;
    case 'guid':
    default: filename = guid + s.ext;
  }

  // The directory the original sat in, relative to the drop, without its leaf.
  const relDir = input.relativePath
    ? sanitisePath(posix.dirname(input.relativePath.replace(/\\/g, '/')).replace(/^\.$/, ''))
    : '';
  let dir: string;
  switch (p.structure) {
    case 'honour': dir = relDir; break;
    case 'minimal': dir = `${t.kind}/${t.yyyy}/${t.mm}`; break;
    case 'template': dir = sanitisePath(fill(p.pathTemplate || '{kind}/{yyyy}/{mm}', { ...t, path: relDir })); break;
    case 'flat':
    default: dir = '';
  }
  const key = dir ? `${dir}/${filename}` : filename;
  return {
    key, dir, filename, guid,
    originalName: input.originalName,
    originalPath: input.relativePath ?? null,
    sanitised: s,
  };
}
