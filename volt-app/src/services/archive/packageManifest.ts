// ============================================================================
//  WHAT A PACKAGED-OUTPUT COPY IS CHECKED AGAINST (build queue H3-11).
//
//  A package (an asset's HLS and DASH folder: playlists, manifest, init and
//  media segments) is copied as ONE copy of many files. Shared, not copied:
//  the site agent compiles this file from here (as it does naming.ts), so the
//  cloud and the agent fold the same files into the same two checksums:
//
//    layout    sha256 over "path<TAB>bytes" per file, sorted by path: which
//              files there are and how big. The cloud always knows this,
//              even for a package in a bucket whose files it never hashed,
//              so a package missing a file never counts as archived.
//    manifest  sha256 over "path<TAB>bytes<TAB>sha256" per file: every byte.
//              The cloud knows it when the package is on its own disk.
//
//  Only node:crypto is imported, so the agent needs nothing else.
// ============================================================================
import { createHash } from 'node:crypto';

export interface PackageFile { path: string; bytes: number; sha256?: string | null }

const sorted = (files: PackageFile[]) => [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

/** Which files and how big. */
export function packageLayout(files: PackageFile[]): string {
  const h = createHash('sha256');
  for (const f of sorted(files)) h.update(`${f.path}\t${f.bytes}\n`);
  return h.digest('hex');
}

/** Every file's bytes, through each file's own checksum. */
export function packageManifest(files: PackageFile[]): string {
  const h = createHash('sha256');
  for (const f of sorted(files)) h.update(`${f.path}\t${f.bytes}\t${String(f.sha256 ?? '').toLowerCase()}\n`);
  return h.digest('hex');
}

/**
 * A file's place inside the package folder: relative, `/` between parts,
 * each part only letters, digits, `.`, `_` and `-` and never `.` or `..`.
 * Anything else is refused (null), on both sides: a package can only ever
 * write inside its own folder at the target.
 */
export function cleanPackagePath(p: unknown): string | null {
  if (typeof p !== 'string' || !p || p.length > 512) return null;
  const parts = p.split('/');
  if (parts.length > 8 || parts.some((x) => !/^[A-Za-z0-9._-]{1,128}$/.test(x) || x === '.' || x === '..')) return null;
  return p;
}
