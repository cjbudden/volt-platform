// ============================================================================
//  IMAGES INTO THE IMAGE LIBRARY: from a web address, or bytes Volt fetched.
//
//  Image fields in metadata (type `image`) hold an Image Library reference,
//  /library/<account>/<path>. A person may paste a web address instead; on
//  save it is downloaded into the library (libraryPaths.ts decides where) and
//  the field keeps the library reference, so the image is served, resized and
//  kept like any other and never breaks when the other site changes.
//
//  Public addresses only (the same SSRF guard the graphics data feeds use),
//  images only (jpeg, png, webp, gif, svg), at most 8 MB, ten seconds, no
//  redirects to elsewhere. The same address is downloaded once per account.
// ============================================================================
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { one } from '../../db';
import { imageStore } from '../imageStore';
import { upsertMediaRow } from '../mediaLibrary';
import { ApiError } from '../../util/http';
import { fileName, slug } from './libraryPaths';
import type { SchemaField } from '../metadataValidator';

export const LIBRARY_REF = /^\/library\/([0-9a-f-]{36})\/(.+)$/i;
export const IMAGE_KEYS = /^(logo|image|thumbnail|artwork|poster|cover|picture|photo|icon)$/i;

/** Save bytes to the library at folder/file (replacing a file already there) and index them. */
export async function saveToLibrary(acct: string, folder: string, file: string, buf: Buffer, ct: string, kind: string, extra: Record<string, unknown>, title?: string): Promise<string> {
  const path = `${folder}/${file}`;
  const key = `library/${acct}/${path}`;
  // NO COPIES. The same bytes already in the library are used where they are (the same
  // album cover for every song on it, the same frame chosen twice): one image, many uses.
  const sum = createHash('sha256').update(buf).digest('hex');
  const same = await (await import('./libraryMoves')).existingCopy(acct, sum);
  if (same) return same;
  await imageStore().put(key, buf, ct);
  // Replaced at the same path: the image service must not render the old bytes it holds in memory.
  try { (await import('../../modules/images')).imageService().forgetSource(key); } catch { /* service not set up here */ }
  let width: number | null = null, height: number | null = null;
  try { const m = await sharp(buf).metadata(); width = m.width ?? null; height = m.height ?? null; } catch { /* svg or odd */ }
  await upsertMediaRow({
    accountId: acct, kind, path, folder, name: file, storeKey: key, sizeBytes: buf.length, contentType: ct,
    tags: ['auto', kind], source: 'auto',
    facts: { width, height, checksum: createHash('sha256').update(buf).digest('hex'), ...(title ? { title } : {}) } as any, extra,
  });
  return key;
}

/** Fetch an image from a public web address. Null when it is not an image. */
export async function fetchPublicImage(url: string): Promise<{ data: Buffer; contentType: string } | null> {
  const { assertPublicUrl } = await import('../graphics/runtime');
  await assertPublicUrl(url);
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 10_000);
  try {
    const res = await fetch(url, { signal: ac.signal, redirect: 'follow' });
    const ct = String(res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (!res.ok || !/^image\/(jpeg|png|webp|gif|svg\+xml)$/.test(ct)) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 8 * 1024 * 1024 || buf.length < 16) return null;
    return { data: buf, contentType: ct };
  } finally { clearTimeout(t); }
}

/**
 * An image at a web address into the account's library, in `folder`, named
 * `name` (else after the file in the address). Downloaded once: the same
 * address already in the library answers with that copy. Returns the store key.
 */
export async function importImageUrl(acct: string, url: string, folder: string, name?: string, kind = 'imported'): Promise<string | null> {
  const existing = await one<any>(`SELECT store_key FROM media_files WHERE account_id = $1 AND metadata->>'sourceUrl' = $2 ORDER BY created_at LIMIT 1`, [acct, url]);
  if (existing) return existing.store_key;
  const img = await fetchPublicImage(url);
  if (!img) return null;
  const fromUrl = (() => { try { return decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '').replace(/\.[a-z0-9]{2,5}$/i, ''); } catch { return ''; } })();
  const base = name || fromUrl || createHash('sha1').update(url).digest('hex').slice(0, 12);
  return saveToLibrary(acct, folder, fileName(base, img.contentType), img.data, img.contentType, kind, { sourceUrl: url });
}

/**
 * Before metadata is validated and saved: every `image` field holding a web
 * address is downloaded into the library and replaced by its reference; a
 * reference to ANOTHER account's library is refused. Returns new values.
 */
export async function internaliseImages(acct: string, fields: SchemaField[], values: Record<string, any>, folder: string): Promise<Record<string, any>> {
  const out = { ...values };
  for (const f of fields) {
    if (f.type !== 'image') continue;
    const v = out[f.key];
    if (typeof v !== 'string' || !v.trim()) continue;
    const s = v.trim();
    const lib = LIBRARY_REF.exec(s);
    if (lib) {
      if (lib[1].toLowerCase() !== acct.toLowerCase()) throw new ApiError(422, `${f.key}: that image is in another account's library`);
      continue;
    }
    if (!/^https?:\/\//i.test(s)) throw new ApiError(422, `${f.key} must be an image from the Image Library or a web address`);
    let key: string | null = null;
    try { key = await importImageUrl(acct, s, folder, f.key); }
    catch (e: any) { throw new ApiError(422, `${f.key}: the image at that address could not be added (${String(e?.message ?? e).slice(0, 120)})`); }
    if (!key) throw new ApiError(422, `${f.key}: the address did not return an image (JPEG, PNG, WebP, GIF or SVG, up to 8 MB)`);
    out[f.key] = `/${key}`;
  }
  return out;
}

/** The default folder for an owner's images when nothing better is known. */
export const ownerFolder = (kind: string, name: unknown) => `media/${slug(name, kind)}`;
