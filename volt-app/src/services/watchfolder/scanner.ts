// ============================================================================
//  WATCHFOLDER SCANNER — WALK, DECIDE, MOVE, RECORD.
//
//  The rules engine (rules.ts) answers "what is this file". This walks a folder
//  and acts on the answer. Everything it does is designed around the fact that a
//  drop folder is a place where OTHER PEOPLE'S PROCESSES are still writing.
//
//  A FILE THAT IS STILL ARRIVING MUST NOT BE INGESTED. `.part` and `.crdownload`
//  are caught by hygiene, but plenty of tools copy straight to the final name and
//  let the file grow: Finder does, `cp` does, an FTP client often does. Such a
//  file is briefly zero bytes and then briefly half a programme, and it has the
//  right name the whole time. So a file is only considered once it has been
//  QUIET for `minAgeMs` — its mtime has stopped moving. That is the difference
//  between a library of assets and a library of truncated ones.
//
//  THE QUARANTINE FOLDER IS NOT SCANNED. It lives inside the watched root so an
//  operator finds it beside the drop rather than somewhere central, which means
//  the walk would otherwise find every rejected file again on the next pass,
//  refuse it again, and try to move it onto itself. Skipped explicitly.
//
//  THE MOVE HAPPENS BEFORE THE ROW IS WRITTEN, and that order is deliberate. If
//  the move succeeds and the write fails, the next scan finds the file in the
//  review folder and no longer in the drop: nothing is lost and nothing is
//  double-handled. The other order can leave a row saying a file was quarantined
//  while the file is still sitting in the drop folder waiting to be found again.
//
//  RECORDING IS AN INTERFACE, not a database call. The scan is the part with
//  filesystem behaviour worth testing against real files in a real directory;
//  the persistence is one small adapter. `MemoryStore` in the suite is the same
//  contract as the Postgres one.
// ============================================================================
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, stat, rename, mkdir, copyFile, unlink } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { classify, quarantineKey, type WatchRule, type FolderPolicy } from './rules';

export interface ScanFolder {
  id: string;
  accountId: string;
  /** Absolute path of the watched root. */
  path: string;
  /** Relative to the root. Never scanned; refused files are moved here. */
  quarantinePath: string;
  rules: WatchRule[];
  policy: FolderPolicy;
  /** A file must have been untouched this long before it is considered. */
  minAgeMs?: number;
  /** Safety valve so one enormous folder cannot monopolise a scan. */
  maxFiles?: number;
}

export interface SeenItem {
  objectKey: string;
  checksum: string;
  sizeBytes: number;
}

export interface RecordedItem extends SeenItem {
  status: 'seen' | 'quarantined';
  targetKind?: string | null;
  workflow?: string | null;
  matchedRuleId?: string | null;
  reason?: string | null;
  quarantineKey?: string | null;
}

/** What the scanner needs from persistence, and nothing more. */
export interface ItemStore {
  /** Has this exact content at this exact key already been dealt with? */
  isKnown(folderId: string, objectKey: string, checksum: string): Promise<boolean>;
  record(folderId: string, accountId: string, item: RecordedItem): Promise<void>;
  /** Keys already used in the quarantine folder, so a move cannot overwrite. */
  quarantineKeysInUse(folderId: string): Promise<Set<string>>;
}

export interface ScanResult {
  scanned: number;
  accepted: RecordedItem[];
  quarantined: RecordedItem[];
  skippedTooNew: string[];
  skippedKnown: number;
  errors: { objectKey: string; error: string }[];
}

/** SHA-256 of a file, streamed so a large asset does not land in memory. */
export async function checksumFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    const s = createReadStream(path);
    s.on('error', reject);
    s.on('data', (c) => h.update(c));
    s.on('end', () => resolve(h.digest('hex')));
  });
}

/** Every file under a root, as paths relative to it, skipping what it must. */
export async function walk(root: string, skipDirs: Set<string>, max = 5000): Promise<string[]> {
  const out: string[] = [];
  const stack: string[] = [''];
  while (stack.length && out.length < max) {
    const rel = stack.pop()!;
    let entries;
    try { entries = await readdir(join(root, rel), { withFileTypes: true }); }
    catch { continue; }   // a folder that vanished mid-walk is not an error
    for (const e of entries) {
      const childRel = rel ? `${rel}${sep}${e.name}` : e.name;
      if (e.isDirectory()) {
        // THE QUARANTINE FOLDER, and anything an operator has marked private.
        if (skipDirs.has(childRel) || e.name.startsWith('.')) continue;
        stack.push(childRel);
      } else if (e.isFile()) {
        out.push(childRel.split(sep).join('/'));
      }
    }
  }
  return out.sort();
}

/**
 * Move a refused file into the review folder.
 *
 * `rename` first because it is atomic within a filesystem; copy-then-delete is
 * the fallback for the case that matters in production, a watched folder that is
 * a mount and a quarantine folder that is not. A copy whose delete fails leaves
 * the file in BOTH places, which is recoverable; a delete before a successful
 * copy is not, so the order is fixed.
 */
export async function moveToQuarantine(root: string, fromKey: string, toKey: string): Promise<void> {
  const from = join(root, fromKey.split('/').join(sep));
  const to = join(root, toKey.split('/').join(sep));
  await mkdir(join(to, '..'), { recursive: true });
  try {
    await rename(from, to);
  } catch {
    await copyFile(from, to);
    await unlink(from);
  }
}

/**
 * One pass over one folder.
 *
 * Never throws for a single bad file: a folder with one unreadable object still
 * ingests the other ninety-nine, and the failure is reported per file. A scan
 * that aborts on the first problem is a scan that stops working the week
 * somebody drops something odd in.
 */
export async function scanFolder(f: ScanFolder, store: ItemStore, now = Date.now()): Promise<ScanResult> {
  const minAge = f.minAgeMs ?? 5000;
  const quarantineRoot = (f.quarantinePath || '_review').replace(/^\/+|\/+$/g, '');
  const res: ScanResult = {
    scanned: 0, accepted: [], quarantined: [], skippedTooNew: [], skippedKnown: 0, errors: [],
  };

  const files = await walk(f.path, new Set([quarantineRoot]), f.maxFiles ?? 5000);
  const inUse = await store.quarantineKeysInUse(f.id);

  for (const objectKey of files) {
    res.scanned++;
    try {
      const st = await stat(join(f.path, objectKey.split('/').join(sep)));

      // STILL ARRIVING. See the header: a file copied under its final name is
      // briefly a truncated file with a perfectly good name.
      if (now - st.mtimeMs < minAge) { res.skippedTooNew.push(objectKey); continue; }

      const checksum = await checksumFile(join(f.path, objectKey.split('/').join(sep)));
      // IDEMPOTENCE. Keyed on content as well as name, so a corrected re-drop
      // under the same filename is a new item rather than a silent no-op.
      if (await store.isKnown(f.id, objectKey, checksum)) { res.skippedKnown++; continue; }

      const decision = classify(objectKey, st.size, f.rules, f.policy);

      if (decision.decision === 'accept') {
        const item: RecordedItem = {
          objectKey, checksum, sizeBytes: st.size, status: 'seen',
          targetKind: decision.targetKind, workflow: decision.workflow,
          matchedRuleId: decision.ruleId,
        };
        await store.record(f.id, f.accountId, item);
        res.accepted.push(item);
        continue;
      }

      // REFUSED. Move first, then record. See the header on why that order.
      const qKey = quarantineKey(quarantineRoot, objectKey, inUse);
      inUse.add(qKey);
      await moveToQuarantine(f.path, objectKey, qKey);
      const item: RecordedItem = {
        objectKey, checksum, sizeBytes: st.size, status: 'quarantined',
        reason: decision.reason, matchedRuleId: decision.ruleId, quarantineKey: qKey,
      };
      await store.record(f.id, f.accountId, item);
      res.quarantined.push(item);
    } catch (e: any) {
      res.errors.push({ objectKey, error: String(e?.message ?? e) });
    }
  }
  return res;
}
