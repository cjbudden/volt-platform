// ============================================================================
//  WATCHFOLDER COMPANIONS BY NAME (build queue H2b-2, Christian 5 Nov).
//
//  A caption or a metadata sidecar is not an asset of its own: it belongs to a
//  video. Drop folders say which video by NAME, the way subtitling houses and
//  playout systems have always named them: `Scrubs-s1-e1_en.vtt` goes with
//  `Scrubs-s1-e1.mp4`. So a file accepted as a `companion` is attached, through
//  the same companion store an upload on the asset page uses
//  (services/companions), to the asset whose source file name (without its
//  extension) its own name starts with. Language and flags come from the rest
//  of the name (`nameHints`: `_en`, `.fr`, `.sdh`, `.forced`).
//
//  THE PREFIX MUST END AT A WORD BREAK, and the longest one wins. `Show-e1` is
//  a prefix of `Show-e10_en`, character for character, and attaching episode
//  ten's subtitles to episode one is the mistake nobody notices until a viewer
//  does. So the name must continue with a separator (`_`, `.`, `-`, space) or
//  end, and when two videos both fit (`Show` and `Show-e1` for
//  `Show-e1_en.vtt`) the longer, more specific one is meant.
//
//  WHERE IT LOOKS: videos this folder took into the Media Library, in the
//  same subfolder first, then anywhere in the folder. A video of this folder
//  still waiting to be taken in that fits as well or better wins too: the
//  companion waits for it rather than settling on an older, vaguer match.
//
//  ONE THAT ARRIVES FIRST WAITS. Subtitles are often delivered before the
//  master, or the master is still copying. The item stays Waiting ("waiting
//  for its video") and is attached on the first pass after the video lands.
//  After 24 hours with no video it goes to Needs review with the reason, and
//  the file to the review folder, like any refused file: a person then drops
//  the video, or attaches the file on the asset page.
//
//  THE LIMIT IS THE COMPANION STORE'S (25 MB), checked before anything else,
//  so a file the asset page would refuse is refused here with the same words.
//
//  A sidecar is attached, never applied. What it would change is shown on the
//  asset page for a person to approve, as for an upload (COMPANION_FILES.md).
// ============================================================================
import { readFile, stat, unlink } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { checksumFile } from './scanner';
import type { PendingItem } from './ingest';

/** Rule targets this pass takes. One kind, `companion`, for captions and sidecars alike. */
const COMPANION_KINDS = new Set(['companion']);

export function companionTargetKinds(): string[] { return [...COMPANION_KINDS]; }
export function isCompanionTarget(kind?: string | null): boolean {
  return !!kind && COMPANION_KINDS.has(String(kind).toLowerCase().trim());
}

/** How long a companion waits for its video before it goes to review. */
export const WAIT_MS = 24 * 60 * 60 * 1000;
/** The companion store's limit (services/companions/store.ts MAX_BYTES). */
export const COMPANION_MAX_BYTES = 25 * 1024 * 1024;

const base = (key: string) => key.split('/').pop() ?? key;
const dir = (key: string) => key.split('/').slice(0, -1).join('/');
/** A file name without its extension. */
export const stemOf = (key: string) => base(key).replace(/\.[^.]+$/, '');

/**
 * Whether `videoStem` is a prefix of `companionStem` that ends at a word
 * break. Case is ignored: `scrubs-S1-E1_EN.srt` still goes with
 * `Scrubs-s1-e1.mp4`.
 */
export function prefixFits(videoStem: string, companionStem: string): boolean {
  const v = videoStem.toLowerCase(), c = companionStem.toLowerCase();
  if (!v || !c.startsWith(v)) return false;
  return c.length === v.length || /[._\-\s]/.test(c[v.length]);
}

export interface Candidate {
  /** The video's object key in this folder. */
  objectKey: string;
  /** Null while the video is still waiting to be taken in. */
  assetId: string | null;
  seenAt?: number;
}

/**
 * The video a companion belongs to, or null. Longest fitting stem first, then
 * the same subfolder, then the newest. A pure function, so the dry run and
 * the suite ask exactly what the pass does.
 */
export function bestMatch(companionKey: string, candidates: Candidate[]): Candidate | null {
  const stem = stemOf(companionKey), d = dir(companionKey);
  const fits = candidates.filter((c) => prefixFits(stemOf(c.objectKey), stem));
  if (!fits.length) return null;
  fits.sort((a, b) =>
    stemOf(b.objectKey).length - stemOf(a.objectKey).length
    || Number(dir(b.objectKey) === d) - Number(dir(a.objectKey) === d)
    // A waiting video beside a landed one of the same name: the landed one
    // is a re-drop of the same master, so attach now rather than wait.
    || Number(!!b.assetId) - Number(!!a.assetId)
    || (b.seenAt ?? 0) - (a.seenAt ?? 0));
  return fits[0];
}

export interface CompanionFolder {
  id: string;
  accountId: string;
  path: string;
  quarantinePath: string;
  deleteAfterIngest?: boolean;
}

export interface CompanionStore {
  /** Videos of this folder, landed (with their asset) or still waiting. */
  candidates(folderId: string): Promise<Candidate[]>;
  claim(itemId: string | number): Promise<boolean>;
  /** Say why it is still waiting; the item stays Waiting and unclaimed. */
  noteWaiting(itemId: string | number, reason: string): Promise<void>;
  attach(a: { assetId: string; accountId: string; name: string; buf: Buffer; by: string }):
    Promise<{ file: { id: string; kind: string; label: string; language: string | null; enabled: boolean; report?: any }; duplicate: boolean; assetTitle: string }>;
  markAttached(itemId: string | number, assetId: string, note: string): Promise<void>;
  /** Move the file to the review folder and close the item as Needs review. */
  toReview(f: CompanionFolder, item: PendingItem, reason: string): Promise<string>;
  markFailed(itemId: string | number, reason: string): Promise<void>;
}

export type CompanionOutcome =
  | { result: 'attached'; itemId: string | number; assetId: string; fileId: string }
  | { result: 'waiting'; itemId: string | number; why: string }
  | { result: 'review'; itemId: string | number; why: string; quarantineKey: string; objectKey: string }
  | { result: 'skipped'; itemId: string | number; why: string }
  | { result: 'failed'; itemId: string | number; why: string };

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;

/** One companion. Never throws: every outcome is a recorded state. */
export async function ingestCompanionItem(
  f: CompanionFolder, item: PendingItem & { seenAt?: number }, store: CompanionStore,
  candidates: Candidate[], now = Date.now(),
): Promise<CompanionOutcome> {
  const abs = join(f.path, item.objectKey.split('/').join(sep));
  const name = base(item.objectKey);
  let size: number;
  try { size = (await stat(abs)).size; }
  catch {
    if (!(await store.claim(item.id))) return { result: 'skipped', itemId: item.id, why: 'another pass is already handling this item' };
    await store.markFailed(item.id, `file is no longer at ${item.objectKey}`);
    return { result: 'failed', itemId: item.id, why: 'source file is gone' };
  }

  // The store's own limit, before any matching: waiting a day to refuse a
  // file for its size helps nobody.
  if (size > COMPANION_MAX_BYTES) {
    if (!(await store.claim(item.id))) return { result: 'skipped', itemId: item.id, why: 'another pass is already handling this item' };
    const why = `${name} is ${mb(size)}, over the ${COMPANION_MAX_BYTES / 1024 / 1024} MB limit for companion files`;
    const q = await store.toReview(f, item, why);
    return { result: 'review', itemId: item.id, why, quarantineKey: q, objectKey: item.objectKey };
  }

  const match = bestMatch(item.objectKey, candidates);
  if (!match || !match.assetId) {
    const waited = now - (item.seenAt ?? now);
    if (waited >= WAIT_MS) {
      if (!(await store.claim(item.id))) return { result: 'skipped', itemId: item.id, why: 'another pass is already handling this item' };
      const why = match
        ? `its video ${base(match.objectKey)} was not taken in within 24 hours, so nothing to attach it to. Attach it on the asset page once the video is in.`
        : `no video in this folder is named like it (${stemOf(item.objectKey)}) after 24 hours. Drop the video, or attach it on the asset page.`;
      const q = await store.toReview(f, item, why);
      return { result: 'review', itemId: item.id, why, quarantineKey: q, objectKey: item.objectKey };
    }
    const why = match
      ? `waiting for its video: ${base(match.objectKey)} is not in the Media Library yet`
      : `waiting for its video: none named like ${stemOf(item.objectKey)} yet (up to 24 hours)`;
    await store.noteWaiting(item.id, why);
    return { result: 'waiting', itemId: item.id, why };
  }

  if (!(await store.claim(item.id))) return { result: 'skipped', itemId: item.id, why: 'another pass is already handling this item' };
  try {
    // Same check as every other path: the row's checksum describes the file
    // as it was classified, and a corrected re-drop is a new item.
    if (item.checksum) {
      const now2 = await checksumFile(abs);
      if (now2 !== item.checksum) {
        const why = `file changed on disk after it was scanned (was ${item.checksum.slice(0, 12)}, now ${now2.slice(0, 12)}); the new content will be picked up as a new item`;
        await store.markFailed(item.id, why);
        return { result: 'failed', itemId: item.id, why };
      }
    }
    const buf = await readFile(abs);
    let out;
    try {
      out = await store.attach({ assetId: match.assetId, accountId: f.accountId, name, buf, by: `watchfolder:${f.id}` });
    } catch (e: any) {
      // The companion store refused it (not a caption Volt reads, empty):
      // a person has to look, so it goes to review with the store's words.
      if (e?.status && e.status < 500) {
        const why = `${String(e.message ?? e)} It was not attached to ${base(match.objectKey)}.`;
        const q = await store.toReview(f, item, why);
        return { result: 'review', itemId: item.id, why, quarantineKey: q, objectKey: item.objectKey };
      }
      throw e;
    }
    const what = out.file.kind === 'captions'
      ? `as ${out.file.label} subtitles${out.file.enabled ? '' : ', switched off because its check found problems (see the asset page)'}`
      : out.file.kind === 'metadata' ? 'as a metadata sidecar, waiting for a person to apply its fields on the asset page'
      : 'as a companion file';
    const note = out.duplicate
      ? `already attached to "${out.assetTitle}" (the same file)`
      : `attached to "${out.assetTitle}" ${what}`;
    await store.markAttached(item.id, match.assetId, note);
    if (f.deleteAfterIngest) await unlink(abs).catch(() => { /* attached; a leftover is harmless */ });
    return { result: 'attached', itemId: item.id, assetId: match.assetId, fileId: out.file.id };
  } catch (e: any) {
    const why = String(e?.message ?? e).slice(0, 500);
    await store.markFailed(item.id, why).catch(() => { /* nothing left to try */ });
    return { result: 'failed', itemId: item.id, why };
  }
}

/** Every waiting companion of one folder, against one read of its videos. */
export async function ingestCompanions(
  f: CompanionFolder, items: (PendingItem & { seenAt?: number })[], store: CompanionStore, now = Date.now(),
): Promise<CompanionOutcome[]> {
  if (!items.length) return [];
  const candidates = await store.candidates(f.id);
  const out: CompanionOutcome[] = [];
  for (const it of items) out.push(await ingestCompanionItem(f, it, store, candidates, now));
  return out;
}
