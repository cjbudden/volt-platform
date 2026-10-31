// ============================================================================
//  RESUMABLE UPLOADS — the server half.
//
//  A file arrives as independently-addressed chunks. The server records which
//  indices have landed, assembles them when the set is complete, and moves the
//  result into the media store. Nothing here assumes the chunks arrive in order,
//  or on one connection, or even in one sitting.
//
//  WHY CHUNKS LAND AS FILES AND ARE ASSEMBLED AT THE END, rather than being
//  appended to one growing file: appending requires ordering, ordering requires
//  a single writer, and a single writer rules out both parallel chunks and the
//  Background Fetch API. A directory of numbered parts costs one extra pass over
//  the data at the end and buys order-independence for everything else.
//
//  Every write is verified against the length the session declared. A chunk that
//  is the wrong size is rejected rather than stored, because a wrong-sized chunk
//  in the middle of an assembly is a corrupt file that looks complete.
// ============================================================================
import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { one, query } from '../db';
import { config } from '../config';
import { sessionDir, putChunk, openChunk, removeStaged, dirBytes, stagingDriver } from './uploadStaging';

// Callers (tus, transfers, tests) keep importing the session folder from here.
export { sessionDir };

export type UploadState = 'open' | 'assembling' | 'complete' | 'aborted' | 'expired';

export interface UploadSession {
  id: string;
  account_id: string;
  opened_by: string | null;
  token: string;
  purpose: string;
  filler_kind: 'slate' | 'loop' | null;
  filler_asset_id: string | null;
  vod_asset_id: string | null;
  ladder_group_id: string | null;
  filename: string;
  content_type: string;
  total_bytes: string | number;
  chunk_size: number;
  chunk_count: number;
  received: number[];
  received_bytes: string | number;
  state: UploadState;
  error: string | null;
  expires_at: string;
  relative_path?: string | null;
  schema_id?: string | null;
  metadata?: Record<string, any> | null;
  source?: string | null;
  retry_of?: RetryOf | null;
}

/**
 * Chunk size.
 *
 * Eight megabytes: large enough that a big file is not thousands of requests
 * (Background Fetch is handed one request per chunk, and a list of ten thousand
 * is its own problem), small enough that losing one to a dropped connection is
 * a couple of seconds of work rather than a minute.
 */
export const CHUNK_SIZE = 8 * 1024 * 1024;

/** Nothing larger than this is accepted, so a typo cannot fill the disk. */
export const MAX_UPLOAD_BYTES = 16 * 1024 * 1024 * 1024;   // 16 GB

// Where partial chunks live while a session is open: services/uploadStaging.ts
// (this server's disk on the Mac, the bucket on AWS, build queue 2.1a-2).

/**
 * Where a finished filler asset's bytes live.
 *
 * The asset id is the filename, so a re-upload is a new id rather than a new
 * version of the same URL — which is what makes the served bytes safely
 * immutable and cacheable forever.
 *
 * THE EXTENSION IS KEPT, and it is not cosmetic. The bytes are served by a
 * static mount that infers Content-Type from the path, so an extensionless file
 * goes out as application/octet-stream and a <video> element refuses to play it.
 * The type is a property of the file; putting it in the name is how the file
 * carries it.
 */
export function fillerPath(accountId: string, assetId: string, filename?: string): string {
  return join(config.uploads.fillerDir, accountId, assetId + safeExt(filename));
}

/** The extension of an uploaded filename, if it is one we are willing to write. */
export function safeExt(filename?: string | null): string {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(filename ?? '');
  if (!m) return '';
  const ext = m[1].toLowerCase();
  // An allow-list rather than a sanitiser: these are the containers a slate or a
  // loop can plausibly be, and anything else is written without an extension
  // rather than trusted.
  const allowed = new Set([
    'mp4', 'mov', 'm4v', 'webm', 'mkv', 'ts', 'mpg', 'mpeg', 'avi',
    'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tif', 'tiff',
    'mp3', 'aac', 'wav', 'flac', 'ogg', 'opus', 'm4a',
  ]);
  return allowed.has(ext) ? `.${ext}` : '';
}

export function openSessionToken(): string {
  return 'upl_' + randomBytes(24).toString('base64url');
}

// ---------------------------------------------------------------------------
//  Opening
// ---------------------------------------------------------------------------
export interface OpenRequest {
  accountId: string;
  openedBy?: string | null;
  purpose?: string;
  fillerKind?: 'slate' | 'loop';
  name: string;
  filename: string;
  contentType?: string;
  totalBytes: number;
  /** 'vod' only: the ladder the finished file is encoded to. Null takes the
   *  account default at encode time rather than here, so a default changed
   *  during a long upload is still the one that applies. */
  ladderGroupId?: string | null;
  /** Ingest framework inputs ('vod' only): where the file came from within the
   *  drop, the content type chosen up front, metadata typed before upload, and
   *  which source rung applies ('panel', 'api', a watchfolder id, a provider). */
  relativePath?: string | null;
  schemaId?: string | null;
  metadata?: Record<string, any> | null;
  source?: string;
  /** 'vod' only: this file is a retry of a record whose encode failed (migration 0082). */
  retryOf?: RetryOf | null;
}

export interface RetryOf { assetId: string; action: 'reattach' | 'replace' | 'new' }

export async function openSession(req: OpenRequest): Promise<{ session: UploadSession; assetId: string | null }> {
  if (!Number.isFinite(req.totalBytes) || req.totalBytes <= 0) {
    throw Object.assign(new Error('An upload needs a positive size.'), { status: 400 });
  }
  if (req.retryOf && req.retryOf.action !== 'new') {
    const failed = await one<any>(`SELECT v.id FROM vod_assets v JOIN jobs j ON j.id = v.encode_job_id
       WHERE v.id = $1 AND v.account_id = $2 AND v.master_key IS NULL AND j.state = 'failed'`, [req.retryOf.assetId, req.accountId]);
    if (!failed) throw Object.assign(new Error('That record is not a failed encode in this account, so the new file cannot replace or become its source.'), { status: 409 });
  }
  if (req.totalBytes > MAX_UPLOAD_BYTES) {
    throw Object.assign(
      new Error(`That file is ${(req.totalBytes / 1e9).toFixed(1)} GB. The limit is ` +
                `${MAX_UPLOAD_BYTES / 1e9} GB.`),
      { status: 400 }
    );
  }

  const chunkCount = Math.ceil(req.totalBytes / CHUNK_SIZE);

  // The asset row exists from the START of the upload, in 'uploading'. It is
  // what the list shows while bytes are in flight: an upload that is only
  // visible once it finishes is an upload nobody can see fail.
  const purpose = req.purpose ?? 'filler';
  let assetId: string | null = null;
  let vodAssetId: string | null = null;
  if (purpose === 'filler') {
    const asset = await one<{ id: string }>(
      `INSERT INTO filler_assets (account_id, kind, name, status, bytes, content_type, filename)
       VALUES ($1, $2::filler_kind, $3, 'uploading', $4, $5, $6)
       RETURNING id`,
      [req.accountId, req.fillerKind ?? 'loop', req.name,
       req.totalBytes, req.contentType ?? 'application/octet-stream', req.filename]
    );
    assetId = asset?.id ?? null;
  } else if (purpose === 'vod') {
    // SAME REASONING AS THE FILLER ROW ABOVE, and it matters more here: a filler
    // loop is seconds and a programme is an hour, so an asset that only appears
    // when the upload finishes is one the operator cannot watch fail for the
    // whole afternoon. thumb_status 'processing' is what makes it read as not
    // yet playable rather than as broken.
    const asset = await one<{ id: string }>(
      `INSERT INTO vod_assets
         (account_id, source_kind, kind, title, source_bytes, ladder_group_id,
          start_epoch_ms, end_epoch_ms, duration_ms, thumb_status)
       VALUES ($1,'upload','clip',$2,$3,$4,0,0,0,'processing')
       RETURNING id`,
      [req.accountId, req.name, req.totalBytes, req.ladderGroupId ?? null]
    );
    vodAssetId = asset?.id ?? null;
  }

  const session = await one<UploadSession>(
    `INSERT INTO upload_sessions
       (account_id, opened_by, token, purpose, filler_kind, filler_asset_id, vod_asset_id,
        ladder_group_id, filename, content_type, total_bytes, chunk_size, chunk_count,
        relative_path, schema_id, metadata, source, retry_of)
     VALUES ($1,$2,$3,$4,$5::filler_kind,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     RETURNING *`,
    [req.accountId, req.openedBy ?? null, openSessionToken(),
     purpose, req.fillerKind ?? null, assetId, vodAssetId, req.ladderGroupId ?? null,
     req.filename, req.contentType ?? 'application/octet-stream',
     req.totalBytes, CHUNK_SIZE, chunkCount,
     req.relativePath ?? null, req.schemaId ?? null, JSON.stringify(req.metadata ?? {}), req.source ?? 'panel',
     purpose === 'vod' && req.retryOf ? JSON.stringify(req.retryOf) : null]
  );
  if (!session) throw new Error('failed to open an upload session');

  // On the Mac the parts wait in this folder. On AWS they wait in the bucket and
  // the task that opened the upload may never see it again, so it keeps none.
  if (stagingDriver() === 'local') mkdirSync(sessionDir(session.id), { recursive: true });
  return { session, assetId: assetId ?? vodAssetId };
}

/** A session by its capability token. The only way a chunk request authenticates. */
export async function sessionByToken(token: string): Promise<UploadSession | null> {
  if (!token || !token.startsWith('upl_')) return null;
  return one<UploadSession>(`SELECT * FROM upload_sessions WHERE token = $1`, [token]);
}

export async function sessionById(
  id: string, accountId: string, openedBy?: string | null
): Promise<UploadSession | null> {
  // `openedBy` narrows to the session's owner. Callers that RETURN the
  // capability token pass it; callers that only act on the session (abort)
  // may leave it out, since an operator clearing a colleague's stuck upload
  // is a reasonable thing to do and does not hand over a credential.
  return one<UploadSession>(
    `SELECT * FROM upload_sessions
      WHERE id = $1 AND account_id = $2 AND ($3::uuid IS NULL OR opened_by = $3)`,
    [id, accountId, openedBy ?? null]
  );
}

// ---------------------------------------------------------------------------
//  Receiving
// ---------------------------------------------------------------------------
export interface ChunkResult {
  received: number[];
  receivedBytes: number;
  complete: boolean;
  /** True when this exact chunk had already arrived. Not an error: a client that
   *  retries after a timeout it never saw the answer to is doing the right
   *  thing, and the second copy is identical. */
  duplicate: boolean;
}

/** How long a chunk of THIS session is expected to be. The last one is short. */
export function expectedChunkBytes(s: UploadSession, index: number): number {
  const total = Number(s.total_bytes);
  const start = index * s.chunk_size;
  return Math.min(s.chunk_size, total - start);
}

export async function receiveChunk(
  session: UploadSession, index: number, body: Buffer
): Promise<ChunkResult> {
  if (session.state !== 'open') {
    throw Object.assign(new Error(`This upload is ${session.state} and is not accepting chunks.`),
      { status: 409 });
  }
  if (!Number.isInteger(index) || index < 0 || index >= session.chunk_count) {
    throw Object.assign(new Error(`Chunk ${index} is outside this upload (0..${session.chunk_count - 1}).`),
      { status: 400 });
  }

  // A WRONG-SIZED CHUNK IS REJECTED, not stored. Stored, it makes an assembled
  // file that is the wrong length in the middle, which is a corrupt file that
  // looks complete — the worst possible outcome and the hardest to trace.
  const expect = expectedChunkBytes(session, index);
  if (body.length !== expect) {
    throw Object.assign(
      new Error(`Chunk ${index} should be ${expect} bytes and is ${body.length}.`),
      { status: 400 }
    );
  }

  const already = (session.received ?? []).includes(index);
  // Kept where every control-plane task can reach it before it is counted, so
  // a chunk the client was told arrived is never on one task only.
  await putChunk(session.id, index, body);

  // The array is the authority and is kept sorted and unique in SQL, so two
  // concurrent chunks cannot race each other into a duplicate entry or a lost
  // one. `received_bytes` only moves for a chunk that was not already there.
  const updated = await one<UploadSession>(
    `UPDATE upload_sessions
        SET received = (
              SELECT array_agg(DISTINCT x ORDER BY x)
                FROM unnest(received || $2::int[]) AS x
            ),
            received_bytes = received_bytes + $3,
            expires_at = now() + interval '7 days',
            updated_at = now()
      WHERE id = $1
      RETURNING *`,
    [session.id, [index], already ? 0 : body.length]
  );
  if (!updated) throw new Error('upload session vanished mid-chunk');

  return {
    received: updated.received ?? [],
    receivedBytes: Number(updated.received_bytes),
    complete: (updated.received ?? []).length === updated.chunk_count,
    duplicate: already,
  };
}

/** Which chunks are still missing. The only question resume needs answered. */
export function missingChunks(s: UploadSession): number[] {
  const have = new Set(s.received ?? []);
  const out: number[] = [];
  for (let i = 0; i < s.chunk_count; i++) if (!have.has(i)) out.push(i);
  return out;
}

// ---------------------------------------------------------------------------
//  Finishing
// ---------------------------------------------------------------------------
export interface FinishResult {
  session: UploadSession;
  assetId: string | null;
  bytes: number;
  sha256: string;
  path: string;
}

/**
 * Assemble the chunks into the finished file.
 *
 * Idempotent: finishing an already-complete session returns the same answer
 * rather than reassembling. A client that retries `finish` after a timeout it
 * never saw the answer to must not end up with two files.
 */
export async function finishSession(session: UploadSession): Promise<FinishResult> {
  if (session.state === 'complete') {
    const asset = session.filler_asset_id
      ? await one<any>(`SELECT * FROM filler_assets WHERE id = $1`, [session.filler_asset_id])
      : null;
    return {
      session, assetId: session.filler_asset_id,
      bytes: Number(asset?.bytes ?? session.total_bytes),
      sha256: '', path: asset?.source_key ?? '',
    };
  }
  const missing = missingChunks(session);
  if (missing.length) {
    throw Object.assign(
      new Error(`${missing.length} chunk(s) are still missing: ${missing.slice(0, 8).join(', ')}` +
                (missing.length > 8 ? '…' : '')),
      { status: 409, missing }
    );
  }

  // ONE ASSEMBLER. A service worker can call finish twice, and on AWS the two
  // calls can reach two tasks; both writing the destination made one file from
  // two writers. The first claims the session; a later call waits for it and
  // answers the same result. A claim older than 15 minutes is a task that died
  // mid-assembly and is taken over.
  const claimed = await one<{ id: string }>(
    `UPDATE upload_sessions SET state = 'assembling', updated_at = now()
      WHERE id = $1 AND (state = 'open' OR (state = 'assembling' AND updated_at < now() - interval '15 minutes'))
      RETURNING id`, [session.id]);
  if (!claimed) {
    for (let i = 0; i < 120; i++) {
      const now = await one<UploadSession>(`SELECT * FROM upload_sessions WHERE id = $1`, [session.id]);
      if (!now || now.state === 'complete') return finishSession(now ?? { ...session, state: 'complete' });
      if (now.state !== 'assembling') break;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw Object.assign(new Error('This upload is being assembled. Ask again in a moment.'), { status: 409 });
  }

  // A VOD upload's bytes go where a re-encode will still find them, keyed by the
  // asset — the same place the watchfolder preserves its sources, and NOT the
  // filler directory, whose contents are served publicly at /filler.
  const dest = destinationFor(session);
  mkdirSync(join(dest, '..'), { recursive: true });

  const hash = createHash('sha256');
  let written = 0;
  try {
    const out = createWriteStream(dest);
    for (let i = 0; i < session.chunk_count; i++) {
      const rs = await openChunk(session.id, i);
      await new Promise<void>((resolve, reject) => {
        rs.on('data', (b) => { hash.update(b as Buffer); written += (b as Buffer).length; });
        rs.on('error', reject);
        rs.on('end', () => resolve());
        rs.pipe(out, { end: false });
      });
    }
    await new Promise<void>((resolve, reject) => {
      out.on('error', reject);
      out.on('finish', () => resolve());
      out.end();
    });
  } catch (e: any) {
    // A partial destination file is worse than none: it would look like a
    // finished asset to anything that only checks for existence.
    try { rmSync(dest, { force: true }); } catch { /* */ }
    await query(
      `UPDATE upload_sessions SET state = 'open', error = $2, updated_at = now() WHERE id = $1`,
      [session.id, String(e?.message ?? e).slice(0, 500)]
    );
    throw e;
  }

  const total = Number(session.total_bytes);
  if (written !== total) {
    try { rmSync(dest, { force: true }); } catch { /* */ }
    await query(
      `UPDATE upload_sessions SET state = 'open', error = $2, updated_at = now() WHERE id = $1`,
      [session.id, `assembled ${written} bytes, expected ${total}`]
    );
    throw Object.assign(
      new Error(`The assembled file is ${written} bytes and should be ${total}.`),
      { status: 409 }
    );
  }

  const sha = hash.digest('hex');
  return completeLanded(session, dest, written, sha);
}

/**
 * Where a session's finished bytes belong. Shared by the chunk protocol and
 * the tus endpoint so both land in the same place with the same rules.
 */
export function destinationFor(session: UploadSession): string {
  const ext = safeExt(session.filename);
  return session.vod_asset_id
    ? join(config.clips.dir, 'vod-src', session.vod_asset_id + ext)
    : session.filler_asset_id
      ? fillerPath(session.account_id, session.filler_asset_id, session.filename)
      : join(config.uploads.fillerDir, session.account_id, session.id + ext);
}

/**
 * The bytes are complete and verified at `dest`: record them, run the ingest
 * framework, queue the encode, close the session. Called by finishSession
 * (chunk protocol) and by the tus endpoint when the offset reaches the length.
 */
export async function completeLanded(session: UploadSession, dest: string, written: number, sha: string): Promise<FinishResult> {
  const ext = safeExt(session.filename);
  const sourceKey = session.vod_asset_id
    ? dest
    : session.filler_asset_id
      ? `filler/${session.account_id}/${session.filler_asset_id}${ext}`
      : `uploads/${session.account_id}/${session.id}${ext}`;

  if (session.filler_asset_id) {
    // The bytes go to the filler store before the asset says ready: on AWS that
    // is the bucket, so every control-plane task can serve them (build queue 2.1a).
    const { landFile } = await import('./media/fillerStore');
    await landFile(dest, sourceKey);
    await query(
      `UPDATE filler_assets
          SET status = 'ready', source_key = $2, bytes = $3,
              uploaded_at = now(), error = NULL, updated_at = now()
        WHERE id = $1`,
      [session.filler_asset_id, sourceKey, written]
    );
  }
  let ingestStatus: string = 'ingested';
  let encodeSource = dest;
  // A RETRY OF A FAILED RECORD (the panel asked; migration 0082). 'reattach': the bytes
  // become the existing record's source, so its id, metadata and links stay and it is
  // encoded again; the placeholder made when the upload opened is dropped. 'replace': the
  // failed record goes once these bytes are safe. 'new': both stay.
  const retry = session.vod_asset_id ? session.retry_of ?? null : null;
  let operatorMetadata = session.metadata ?? null;
  // The name the upload was opened with is the placeholder asset's title (openSession);
  // read it before a reattach swaps the record, so the ingest can keep it as the title.
  const openedName = session.vod_asset_id
    ? (await one<{ title: string | null }>(`SELECT title FROM vod_assets WHERE id = $1`, [session.vod_asset_id]))?.title ?? null
    : null;
  let kept: { metadata: any; title: string | null } | null = null;
  if (retry?.action === 'reattach') {
    const old = await one<any>(`SELECT id, source_key, metadata, title FROM vod_assets WHERE id = $1 AND account_id = $2 AND master_key IS NULL`, [retry.assetId, session.account_id]);
    if (old) {
      const placeholder = session.vod_asset_id!;
      await query(`UPDATE upload_sessions SET vod_asset_id = $2 WHERE id = $1`, [session.id, old.id]);
      await query(`DELETE FROM vod_assets WHERE id = $1 AND source_kind = 'upload' AND master_key IS NULL`, [placeholder]);
      // The failed record's old original goes, on this disk or in the bucket (2.1a-2b).
      if (old.source_key && old.source_key !== dest) {
        const { deleteVodSource } = await import('./media/vodSource');
        await deleteVodSource(old.source_key);
      }
      await query(`UPDATE vod_assets SET encode_job_id = NULL, thumb_status = 'processing', updated_at = now() WHERE id = $1`, [old.id]);
      session = { ...session, vod_asset_id: old.id };
      // What was typed for the record before stays; anything typed with this upload wins.
      operatorMetadata = { ...(old.metadata ?? {}), ...(session.metadata ?? {}) };
      kept = { metadata: old.metadata ?? {}, title: old.title ?? null };
    }
  }
  if (session.vod_asset_id) {
    await query(
      `UPDATE vod_assets SET source_key = $2, source_bytes = $3, updated_at = now()
        WHERE id = $1`,
      [session.vod_asset_id, dest, written]
    );
    // THE INGEST FRAMEWORK RUNS HERE: rules ladder, naming, real type, checksum
    // duplicate check, metadata extraction and merge, sidecar, webhooks. It
    // never throws for a rule outcome; a duplicate or a metadata gate is a
    // status the asset carries, and the encode below only runs for 'ingested'.
    try {
      const { ingestLanded } = await import('./ingest/pipeline');
      const out = await ingestLanded({
        accountId: session.account_id, assetId: session.vod_asset_id, path: dest,
        originalName: session.filename, relativePath: session.relative_path ?? null,
        bytes: written, sha256: sha, declaredMime: session.content_type,
        source: session.source ?? 'panel', sessionId: session.id, uploadedBy: session.opened_by,
        contentTypeId: session.schema_id ?? null, operatorMetadata, givenName: openedName,
      });
      ingestStatus = out.status; encodeSource = out.path;
      // The ingest merge keeps only the fields of the record's content type; a reattached
      // record keeps everything it had (and its title), with this upload's values on top.
      if (kept) {
        await query(`UPDATE vod_assets SET metadata = $2::jsonb || COALESCE(metadata, '{}'::jsonb), title = COALESCE($3, title) WHERE id = $1`,
          [session.vod_asset_id, JSON.stringify(kept.metadata), kept.title]);
      }
      if (retry?.action === 'replace' && retry.assetId !== session.vod_asset_id) {
        const { removeVodAsset } = await import('./vodRemove');
        await removeVodAsset(retry.assetId).catch((e) => console.warn('[uploads] the failed record was not removed', e));
      }
    } catch (e: any) {
      // A probe that cannot read the file is worth recording, not worth losing
      // the bytes over. The asset keeps its original name and encodes as before.
      await query(`UPDATE upload_sessions SET error = $2 WHERE id = $1`,
        [session.id, `ingest rules could not run: ${String(e?.message ?? e)}`.slice(0, 500)]);
      // Still landed in the bucket on AWS (2.1a-2b), so another task can encode it.
      try {
        const { landVodSource, vodSourceDriver } = await import('./media/vodSource');
        if (vodSourceDriver() === 's3' && statSync(dest, { throwIfNoEntry: false })?.isFile()) {
          encodeSource = await landVodSource(dest);
          await query(`UPDATE vod_assets SET source_key = $2, updated_at = now() WHERE id = $1`, [session.vod_asset_id, encodeSource]);
        }
      } catch (le: any) { console.warn('[uploads] the original stays on this task:', le?.message ?? le); }
    }
  }
  // A METADATA GATE HOLDS THE INGEST, NOT THE MEDIA (27 Oct 2026). An upload
  // waiting for a required field (a bug's Advertiser, say) is still a good file:
  // it is encoded now, so it has renditions, an MP4, thumbnails and sprites
  // when the field is filled. The ingest stays "awaiting metadata" (held list,
  // no 'ingested' webhook) until then. Only a duplicate or a rejection waits.
  if (session.vod_asset_id && (ingestStatus === 'ingested' || ingestStatus === 'awaiting_metadata')) {
    // THE ENCODE IS QUEUED HERE, not by the route, because finishing is
    // idempotent by design (a service worker's backgroundfetchsuccess can fire
    // more than once) and the dedupe key makes a second call join the job in
    // flight rather than start a second encode into the same directory.
    try {
      const { enqueue } = await import('./jobs/queue');
      const { VOD_ENCODE } = await import('./jobs/handlers/vodEncode');
      const job = await enqueue({
        type: VOD_ENCODE,
        payload: {
          vodAssetId: session.vod_asset_id, accountId: session.account_id,
          sourcePath: encodeSource, ladderGroupId: session.ladder_group_id ?? null,
        },
        dedupeKey: `vod.encode:${session.vod_asset_id}`,
        maxAttempts: 2,
      });
      await query(`UPDATE vod_assets SET encode_job_id = $2 WHERE id = $1`,
        [session.vod_asset_id, job.id]);
    } catch (e: any) {
      // THE BYTES ARE SAFE EITHER WAY. A queue that is briefly unavailable must
      // not lose an hour-long upload, so the failure is recorded on the session
      // and the operator can retry the encode from the asset.
      await query(
        `UPDATE upload_sessions SET error = $2 WHERE id = $1`,
        [session.id, `uploaded, but the encode could not be queued: ${String(e?.message ?? e)}`.slice(0, 500)]
      );
    }
  }

  const done = await one<UploadSession>(
    `UPDATE upload_sessions SET state = 'complete', error = NULL, updated_at = now()
      WHERE id = $1 RETURNING *`,
    [session.id]
  );

  // The parts have served their purpose; keeping them doubles the disk cost of
  // every upload (and on AWS the bucket's).
  await removeStaged(session.id).catch((e) => console.warn('[uploads] could not remove the parts of', session.id, e?.message ?? e));

  return { session: done ?? session, assetId: session.filler_asset_id ?? session.vod_asset_id,
           bytes: written, sha256: sha, path: sourceKey };
}

export async function abortSession(session: UploadSession, reason = 'abandoned by the client'): Promise<void> {
  await query(
    `UPDATE upload_sessions SET state = 'aborted', error = $2, updated_at = now() WHERE id = $1`,
    [session.id, reason]
  );
  await removeStaged(session.id).catch(() => 0);
  // The asset row was created optimistically at the start of the upload. An
  // abandoned upload must not leave a permanently 'uploading' row in the list.
  if (session.filler_asset_id) {
    await query(
      `DELETE FROM filler_assets WHERE id = $1 AND status = 'uploading'`,
      [session.filler_asset_id]
    );
  }
  // THE SAME FOR A VIDEO UPLOAD, with one condition that matters: only when the
  // bytes never landed. `source_key` set means the file assembled and an encode
  // may already be running, and deleting THAT row would destroy a real asset
  // mid-encode. An abandoned upload has no source_key at all.
  if (session.vod_asset_id) {
    await query(
      `DELETE FROM vod_assets
        WHERE id = $1 AND source_kind = 'upload' AND source_key IS NULL AND master_key IS NULL`,
      [session.vod_asset_id]
    );
  }
}

// ---------------------------------------------------------------------------
//  Housekeeping
// ---------------------------------------------------------------------------
export interface SweepResult { expired: number; bytesFreed: number; orphanDirs: number }

/**
 * Expire sessions nobody came back for, and delete their parts.
 *
 * The expiry is extended by every chunk that arrives, so a genuinely slow upload
 * is never swept out from under itself; only one that has been silent for the
 * whole window is taken.
 */
export async function sweepUploads(): Promise<SweepResult> {
  const res: SweepResult = { expired: 0, bytesFreed: 0, orphanDirs: 0 };

  const stale = await query<UploadSession>(
    `SELECT * FROM upload_sessions
      WHERE state IN ('open', 'assembling') AND expires_at < now()
      LIMIT 200`
  );
  for (const s of stale) {
    await query(
      `UPDATE upload_sessions SET state = 'expired',
              error = 'no chunk arrived before the session expired', updated_at = now()
        WHERE id = $1`, [s.id]
    );
    res.bytesFreed += await removeStaged(s.id).catch(() => 0);
    if (s.filler_asset_id) {
      await query(`DELETE FROM filler_assets WHERE id = $1 AND status = 'uploading'`,
        [s.filler_asset_id]);
    }
    // Same condition as abortSession: only a row whose bytes never landed.
    if (s.vod_asset_id) {
      await query(
        `DELETE FROM vod_assets
          WHERE id = $1 AND source_kind = 'upload' AND source_key IS NULL AND master_key IS NULL`,
        [s.vod_asset_id]);
    }
    res.expired++;
  }

  // Directories with no session row at all: what a crash between mkdir and
  // INSERT leaves behind, and what nothing else would ever look for.
  try {
    for (const name of readdirSync(config.uploads.dir)) {
      if (!/^[0-9a-f-]{36}$/.test(name)) continue;
      const row = await one<{ id: string }>(`SELECT id FROM upload_sessions WHERE id = $1`, [name]);
      if (row) continue;
      const dir = join(config.uploads.dir, name);
      // Only if it has been sitting untouched: a directory created seconds ago
      // belongs to a session whose INSERT is still in flight.
      if (Date.now() - statSync(dir).mtimeMs < 3_600_000) continue;
      res.bytesFreed += dirBytes(dir);
      rmSync(dir, { recursive: true, force: true });
      res.orphanDirs++;
    }
  } catch { /* the directory may not exist yet */ }

  if (res.expired || res.orphanDirs) {
    console.log(
      `[uploads] expired ${res.expired} session(s), removed ${res.orphanDirs} orphan dir(s), ` +
      `freed ${(res.bytesFreed / 1e6).toFixed(1)} MB`
    );
  }
  return res;
}

/** Sessions an account could still resume, newest first. */
export async function resumableSessions(accountId: string, openedBy?: string | null): Promise<UploadSession[]> {
  // Scoped to the USER when one is given, not just the account. Each session
  // carries its own capability token — the credential the chunk endpoint
  // accepts INSTEAD of a login — and the listing returns it. Account scope
  // alone meant any colleague could read a stranger's upload token and then
  // overwrite their chunks, finish their upload, or abort it.
  return query<UploadSession>(
    `SELECT * FROM upload_sessions
      WHERE account_id = $1 AND state = 'open' AND expires_at > now()
        AND ($2::uuid IS NULL OR opened_by = $2)
      ORDER BY created_at DESC LIMIT 50`,
    [accountId, openedBy ?? null]
  );
}
