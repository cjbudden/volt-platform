// ============================================================================
//  SLATES TO LOOPS & FILLERS (build queue H2b-3, Christian 5 Nov).
//
//  A rule may send an image to Loops & Fillers as a SLATE: the still a channel
//  or event shows when its input drops. The `slate` target files an image in
//  the Image Library (kind slate), which is where it has always gone and stays;
//  `filler-slate` puts it straight into Loops & Fillers, laid out exactly as an
//  uploaded slate or one copied from the library (modules/fillerAssets.ts
//  copy-from-library), so a stream can pick it as its fallback at once.
//
//  Same contract as the other passes: claimed first, the checksum checked
//  again, bytes into the filler store before the row says ready, every
//  outcome a recorded state.
// ============================================================================
import { readFile, stat, unlink } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { checksumFile } from './scanner';
import { probeImage } from '../imageDims';
import type { PendingItem } from './ingest';

const SLATE_KINDS = new Set(['filler-slate']);

export function slateTargetKinds(): string[] { return [...SLATE_KINDS]; }
export function isSlateTarget(kind?: string | null): boolean {
  return !!kind && SLATE_KINDS.has(String(kind).toLowerCase().trim());
}

/** 64 MiB, as the Image Library path: a slate is a still. */
export const SLATE_MAX_BYTES = 64 * 1024 * 1024;

export interface SlateFolder { id: string; accountId: string; path: string; deleteAfterIngest?: boolean }

export interface SlateStore {
  claim(itemId: string | number): Promise<boolean>;
  /** Write the bytes and the filler_assets row (kind slate, ready). */
  createSlate(a: { accountId: string; name: string; filename: string; contentType: string; width: number | null; height: number | null; body: Buffer }): Promise<{ id: string }>;
  markLanded(itemId: string | number, note: string): Promise<void>;
  markFailed(itemId: string | number, reason: string): Promise<void>;
}

export type SlateOutcome =
  | { result: 'slate'; itemId: string | number; fillerAssetId: string }
  | { result: 'skipped'; itemId: string | number; why: string }
  | { result: 'failed'; itemId: string | number; why: string };

/** One image into Loops & Fillers. Never throws. */
export async function ingestSlateItem(f: SlateFolder, item: PendingItem, store: SlateStore): Promise<SlateOutcome> {
  if (!(await store.claim(item.id))) return { result: 'skipped', itemId: item.id, why: 'another pass is already handling this item' };
  const abs = join(f.path, item.objectKey.split('/').join(sep));
  const filename = item.objectKey.split('/').pop() || item.objectKey;
  try {
    let size: number;
    try { size = (await stat(abs)).size; }
    catch { await store.markFailed(item.id, `file is no longer at ${item.objectKey}`); return { result: 'failed', itemId: item.id, why: 'source file is gone' }; }
    if (size > SLATE_MAX_BYTES) {
      const why = `file is ${size} bytes, over the ${SLATE_MAX_BYTES} byte limit for a slate`;
      await store.markFailed(item.id, why);
      return { result: 'failed', itemId: item.id, why };
    }
    if (item.checksum) {
      const now = await checksumFile(abs);
      if (now !== item.checksum) {
        const why = `file changed on disk after it was scanned (was ${item.checksum.slice(0, 12)}, now ${now.slice(0, 12)}); the new content will be picked up as a new item`;
        await store.markFailed(item.id, why);
        return { result: 'failed', itemId: item.id, why };
      }
    }
    const buf = await readFile(abs);
    const info = probeImage(buf);
    // A slate an encoder cannot show is worse than none: it is chosen as a
    // fallback and fails exactly when the input has already failed.
    if (!info.contentType) {
      const why = `${filename} is not an image Volt can read (PNG, JPEG, WebP or GIF), so it was not made a slate`;
      await store.markFailed(item.id, why);
      return { result: 'failed', itemId: item.id, why };
    }
    const name = filename.replace(/\.[^.]+$/, '');
    const made = await store.createSlate({ accountId: f.accountId, name, filename, contentType: info.contentType, width: info.width, height: info.height, body: buf });
    await store.markLanded(item.id, `in Loops & Fillers as the slate "${name}"`);
    if (f.deleteAfterIngest) await unlink(abs).catch(() => { /* it is in Loops & Fillers; a leftover is harmless */ });
    return { result: 'slate', itemId: item.id, fillerAssetId: made.id };
  } catch (e: any) {
    const why = String(e?.message ?? e).slice(0, 500);
    await store.markFailed(item.id, why).catch(() => { /* nothing left to try */ });
    return { result: 'failed', itemId: item.id, why };
  }
}
