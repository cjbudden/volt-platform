// ============================================================================
//  WATCHFOLDER INGEST — TURNING AN ACCEPTED FILE INTO A LIBRARY RECORD.
//
//  The scan decides WHAT a file is and writes a row saying so. Nothing has been
//  ingested at that point: the file is still sitting in the drop folder and the
//  row says `seen`. This is the step that reads the bytes, puts them in the
//  image store, writes the `media_files` row, and closes the item as `ingested`.
//
//  FIVE THINGS SHAPE IT, and four of them are about the gap between the scan and
//  now, because that gap is where a drop folder does its damage.
//
//  1. THE CHECKSUM ON THE ROW IS A CLAIM ABOUT THE PAST. It was true when the
//     scanner hashed the file. Between that scan and this ingest, the operator
//     can drop a corrected version over the top, under the same name. Reading
//     the bytes now and storing them against a row that describes the OLD file
//     means the library holds content that was never classified. So the file is
//     re-hashed here, and a file that has moved is not ingested: the row is
//     closed as `failed` with the two checksums in the reason, and the next scan
//     records the new content as a new item, because the unique index is keyed
//     on content. Closing it matters as much as refusing it. A row left at
//     `seen` over a file that will never match is retried by every pass forever.
//
//  2. THE BYTES GO IN BEFORE THE ROW DOES. If the row were written first and the
//     store write then failed, the library would show an asset whose bytes do not
//     exist: a broken thumbnail nobody can explain, and a record that looks
//     authoritative. In this order the failure mode is an orphaned object in the
//     store, which costs disk and nothing else, and which the store's own sweep
//     can find. When the row insert fails after a successful put, the object is
//     removed again on a best-effort basis.
//
//  3. A NAME COLLISION MUST NOT LOSE A FILE. `media_files` is UNIQUE on
//     (account_id, path), and two folders dropping `slate_open.png` is not a
//     rare event, it is Tuesday. Failing the second one leaves a file that will
//     never ingest no matter how many times it is retried. It is suffixed
//     instead, the same shape as the quarantine collision handling, and the row
//     records where it actually landed.
//
//  4. NOT EVERY TARGET KIND IS A LIBRARY IMAGE. The rules can name any target
//     an operator likes, and `vod` and `loop` are real answers that belong to
//     their own workflows. Those are DEFERRED, not failed and not forced into
//     `other`: the item stays `seen` with its target recorded, waiting for the
//     workflow that owns it. Coercing them into `other` is exactly the "library
//     full of unidentifiable junk" outcome the quarantine exists to prevent.
//
//  4b. TWO PASSES CAN REACH THE SAME ROW. The sixty-second tick and the
//     operator's Scan button are two callers over one queue, and both read
//     `status = 'seen'` before either writes. Guarding only the closing UPDATE is
//     not enough: by then both have already put bytes in the store and created a
//     library record, the second one suffixed, which looks exactly like the
//     operator dropped the file twice. So the item is CLAIMED first, atomically,
//     and a pass that does not win the claim does nothing at all.
//
//  5. THE WHOLE FILE IS READ INTO MEMORY, because that is what `ImageStore.put`
//     takes. That is fine for a slate and fatal for a programme, so there is a
//     hard byte ceiling and crossing it is a recorded failure rather than an
//     out-of-memory that takes the orchestrator with it. This is the reason the
//     ceiling exists even though only image-ish kinds reach here today.
//
//  SCOPE: this is the IMAGE library path (slates, posters, watermarks, brand,
//  keyframes). Video assets — VOD and filler loops — are a different target with
//  a different store and a probe that costs an ffprobe, and they are deliberately
//  left to their own workflow rather than half-handled here.
// ============================================================================
import { readFile, stat, unlink } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { checksumFile } from './scanner';
import { probeImage } from '../imageDims';

/** The kinds `media_files.kind` accepts. Anything else is not a library image. */
export type MediaKind = 'watermark' | 'slate' | 'poster' | 'brand' | 'keyframe' | 'other';

/**
 * Rule target kind -> library kind.
 *
 * Deliberately NOT a catch-all. An unlisted target is deferred to its own
 * workflow, never mapped to `other`: see note 4 in the header. `image` and
 * `logo` are here because they are the two names operators reach for that mean
 * something this library can actually hold.
 */
const KIND_MAP: Record<string, MediaKind> = {
  watermark: 'watermark',
  slate: 'slate',
  poster: 'poster',
  brand: 'brand',
  logo: 'brand',
  keyframe: 'keyframe',
  thumbnail: 'keyframe',
  image: 'other',
  still: 'other',
};

/** The library kind for a rule's target, or null if this is somebody else's job. */
export function libraryKindFor(targetKind?: string | null): MediaKind | null {
  if (!targetKind) return null;
  return KIND_MAP[String(targetKind).toLowerCase().trim()] ?? null;
}

/** Targets this pass can actually handle, for narrowing the query. */
export function ingestableTargetKinds(): string[] {
  return Object.keys(KIND_MAP);
}

export interface NewMediaFile {
  accountId: string;
  kind: MediaKind;
  path: string;
  folder: string;
  name: string;
  contentType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  tags: string[];
  storeKey: string;
  userId?: string | null;
}

/** Everything this needs from the store and the database, and nothing more. */
export interface IngestStore {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  /** Best effort: used only to clean up after a failed row insert. */
  removeObject(key: string): Promise<void>;
  pathInUse(accountId: string, path: string): Promise<boolean>;
  createMediaFile(m: NewMediaFile): Promise<{ id: string }>;
  /**
   * Take exclusive ownership of an item, atomically. False means another pass
   * has it, and the caller must not touch the file. See note 4b.
   */
  claim(itemId: string | number): Promise<boolean>;
  markIngested(itemId: string | number, mediaFileId: string, path: string): Promise<void>;
  markFailed(itemId: string | number, reason: string): Promise<void>;
}

export interface PendingItem {
  id: string | number;
  objectKey: string;
  checksum: string | null;
  targetKind: string | null;
  workflow: string | null;
}

export interface IngestFolder {
  id: string;
  accountId: string;
  /** Absolute path of the watched root. */
  path: string;
  /** Library folder the ingested files land under. Defaults to the target kind. */
  libraryFolder?: string | null;
  /** Remove the source file once it is safely in the library. Off by default. */
  deleteAfterIngest?: boolean;
  /** Hard ceiling on a file read into memory. See note 5. */
  maxBytes?: number;
  userId?: string | null;
}

export type IngestOutcome =
  | { result: 'ingested'; itemId: string | number; mediaFileId: string; path: string }
  | { result: 'deferred'; itemId: string | number; why: string }
  | { result: 'skipped'; itemId: string | number; why: string }
  | { result: 'failed'; itemId: string | number; why: string };

/** 64 MiB. A slate is under one; a programme is thousands. */
export const DEFAULT_MAX_INGEST_BYTES = 64 * 1024 * 1024;

/** Strip anything that would make a library path awkward, keeping the shape. */
function cleanSegment(s: string): string {
  return s.replace(/[\\/]+/g, '_').replace(/^\.+/, '').trim() || 'file';
}

/**
 * Where in the library an object lands.
 *
 * The object's own sub-structure is preserved beneath the library folder, so a
 * drop folder organised into `nested/` stays organised. The default library
 * folder is the target kind, which is what makes the library browsable by what
 * things ARE rather than by which folder happened to catch them.
 */
export function libraryPathFor(objectKey: string, kind: MediaKind, libraryFolder?: string | null) {
  const parts = objectKey.split('/').filter(Boolean).map(cleanSegment);
  const name = parts.pop() || 'file';
  const base = (libraryFolder ?? kind).replace(/^\/+|\/+$/g, '');
  const folder = [base, ...parts].filter(Boolean).join('/');
  return { folder, name, path: folder ? `${folder}/${name}` : name };
}

/**
 * A path nobody is using yet.
 *
 * See note 3: the alternative to suffixing is a file that can never ingest. The
 * suffix goes before the extension so the file is still recognisably an image to
 * everything downstream.
 */
export async function freePath(
  accountId: string,
  wanted: { folder: string; name: string; path: string },
  taken: (accountId: string, path: string) => Promise<boolean>,
  limit = 50
): Promise<{ folder: string; name: string; path: string }> {
  if (!(await taken(accountId, wanted.path))) return wanted;
  const dot = wanted.name.lastIndexOf('.');
  const stem = dot > 0 ? wanted.name.slice(0, dot) : wanted.name;
  const ext = dot > 0 ? wanted.name.slice(dot) : '';
  for (let n = 2; n <= limit; n++) {
    const name = `${stem}-${n}${ext}`;
    const path = wanted.folder ? `${wanted.folder}/${name}` : name;
    if (!(await taken(accountId, path))) return { folder: wanted.folder, name, path };
  }
  throw new Error(`could not find a free library path near ${wanted.path} after ${limit} tries`);
}

function storeKeyFor(accountId: string, path: string): string {
  return `library/${accountId}/${path}`;
}

/**
 * One item. Never throws: every outcome is a recorded state, because an
 * exception escaping here would abort the pass and leave the rest of the queue
 * unprocessed for the sake of one bad file.
 */
export async function ingestItem(
  f: IngestFolder,
  item: PendingItem,
  store: IngestStore
): Promise<IngestOutcome> {
  const kind = libraryKindFor(item.targetKind);
  if (!kind) {
    // NOT A FAILURE. See note 4: this belongs to another workflow, and the row
    // stays `seen` so that workflow can still find it.
    return {
      result: 'deferred',
      itemId: item.id,
      why: `target kind '${item.targetKind ?? 'none'}' is not a library image; left for its own workflow`,
    };
  }

  // AFTER the kind check on purpose: a deferred item must be left completely
  // untouched for the workflow that owns it, claim included.
  if (!(await store.claim(item.id))) {
    return { result: 'skipped', itemId: item.id, why: 'another pass is already handling this item' };
  }

  const abs = join(f.path, item.objectKey.split('/').join(sep));
  const max = f.maxBytes ?? DEFAULT_MAX_INGEST_BYTES;

  try {
    let size: number;
    try {
      size = (await stat(abs)).size;
    } catch {
      // The file has been moved or deleted since the scan. Closing the row is
      // the point: leaving it `seen` is a retry on every pass, forever.
      await store.markFailed(item.id, `file is no longer at ${item.objectKey}`);
      return { result: 'failed', itemId: item.id, why: 'source file is gone' };
    }

    if (size > max) {
      const why = `file is ${size} bytes, over the ${max} byte ingest ceiling for this folder`;
      await store.markFailed(item.id, why);
      return { result: 'failed', itemId: item.id, why };
    }

    // NOTE 1. The row's checksum describes the file as it was when it was
    // classified. Verify that is still the file we are about to store.
    if (item.checksum) {
      const now = await checksumFile(abs);
      if (now !== item.checksum) {
        const why =
          `file changed on disk after it was scanned (was ${item.checksum.slice(0, 12)}, ` +
          `now ${now.slice(0, 12)}); the new content will be picked up as a new item`;
        await store.markFailed(item.id, why);
        return { result: 'failed', itemId: item.id, why };
      }
    }

    const buf = await readFile(abs);
    const info = probeImage(buf);
    const wanted = libraryPathFor(item.objectKey, kind, f.libraryFolder);
    const place = await freePath(f.accountId, wanted, (a, p) => store.pathInUse(a, p));
    const storeKey = storeKeyFor(f.accountId, place.path);
    const contentType = info.contentType || 'application/octet-stream';

    // NOTE 2. Bytes first. An orphaned object is recoverable; a row pointing at
    // nothing is a broken asset that looks real.
    await store.put(storeKey, buf, contentType);

    let created: { id: string };
    try {
      created = await store.createMediaFile({
        accountId: f.accountId,
        kind,
        path: place.path,
        folder: place.folder,
        name: place.name,
        contentType,
        sizeBytes: buf.length,
        width: info.width,
        height: info.height,
        tags: ['watchfolder', ...(item.workflow ? [item.workflow] : [])],
        storeKey,
        userId: f.userId ?? null,
      });
    } catch (e: any) {
      await store.removeObject(storeKey).catch(() => { /* an orphan is the cheap failure */ });
      const why = `could not index the file: ${String(e?.message ?? e)}`;
      await store.markFailed(item.id, why);
      return { result: 'failed', itemId: item.id, why };
    }

    await store.markIngested(item.id, created.id, place.path);

    // Only once the library owns it, and never fatal: the file is already safe,
    // and a source left behind is skipped by the next scan on its checksum.
    if (f.deleteAfterIngest) {
      await unlink(abs).catch(() => { /* the library has it; a leftover is harmless */ });
    }

    return { result: 'ingested', itemId: item.id, mediaFileId: created.id, path: place.path };
  } catch (e: any) {
    const why = String(e?.message ?? e).slice(0, 500);
    await store.markFailed(item.id, why).catch(() => { /* nothing left to try */ });
    return { result: 'failed', itemId: item.id, why };
  }
}

export interface IngestSummary {
  ingested: number;
  deferred: number;
  /** Claimed by a concurrent pass. Not an error and not work left undone. */
  skipped: number;
  failed: number;
  /**
   * Video assets accepted and handed to an encode job.
   *
   * COUNTED SEPARATELY FROM `ingested` ON PURPOSE. An image is in the library
   * when this returns; a video has been accepted and will be playable when its
   * encode finishes, minutes later. One counter for both would report work as
   * finished that has not started.
   */
  queued?: number;
  outcomes: IngestOutcome[];
}

/** Every pending item in one folder, one at a time so memory stays bounded. */
export async function ingestPending(
  f: IngestFolder,
  items: PendingItem[],
  store: IngestStore
): Promise<IngestSummary> {
  const out: IngestSummary = { ingested: 0, deferred: 0, skipped: 0, failed: 0, outcomes: [] };
  for (const item of items) {
    const o = await ingestItem(f, item, store);
    out.outcomes.push(o);
    out[o.result]++;
  }
  return out;
}
