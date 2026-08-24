// ============================================================================
//  UPLOAD API — open a session, send chunks, finish.
//
//  TWO DIFFERENT AUTHENTICATIONS, on purpose.
//
//  Opening, listing and abandoning a session are ordinary tenant operations and
//  use the user's access token. Sending a CHUNK does not, and cannot: the chunks
//  may be sent by a service worker that never sees the user's token, and a
//  fifteen-minute JWT would expire in the middle of a large file regardless.
//
//  So a session carries its own capability token. It authorises exactly one
//  session, only chunk and finish, and it dies with the session. That is what a
//  presigned URL is; this one is just written down instead of signed.
//
//  Chunk bodies bypass the JSON parser entirely — they are raw octets, and
//  running eight megabytes of video through a body parser that is looking for
//  JSON is neither correct nor cheap.
// ============================================================================
import { Router, raw } from 'express';
import { z } from 'zod';
import { requireAuth, accountId } from '../auth/middleware';
import { asyncHandler, notFound, badRequest, ApiError } from '../util/http';
import { actorId } from '../util/actor';
import {
  CHUNK_SIZE, MAX_UPLOAD_BYTES, abortSession, expectedChunkBytes, finishSession,
  missingChunks, openSession, receiveChunk, resumableSessions, sessionById,
  sessionByToken, type UploadSession,
} from '../services/uploads';

/** What the client is told about a session. The token is included ONLY when the
 *  session is opened or resumed by an authenticated user. */
function view(s: UploadSession, withToken: boolean) {
  return {
    id: s.id,
    state: s.state,
    purpose: s.purpose,
    fillerKind: s.filler_kind,
    assetId: s.filler_asset_id,
    filename: s.filename,
    contentType: s.content_type,
    totalBytes: Number(s.total_bytes),
    chunkSize: s.chunk_size,
    chunkCount: s.chunk_count,
    received: s.received ?? [],
    receivedBytes: Number(s.received_bytes),
    missing: missingChunks(s),
    error: s.error,
    expiresAt: s.expires_at,
    ...(withToken ? { token: s.token } : {}),
  };
}

// ---------------------------------------------------------------------------
//  Tenant-authenticated: open, list, inspect, abandon
// ---------------------------------------------------------------------------
export const uploadsRouter = Router();
uploadsRouter.use(requireAuth);

const openBody = z.object({
  purpose: z.enum(['filler']).default('filler'),
  fillerKind: z.enum(['slate', 'loop']).optional(),
  name: z.string().min(1).max(200),
  filename: z.string().min(1).max(400),
  contentType: z.string().max(200).optional(),
  totalBytes: z.number().int().positive(),
});

uploadsRouter.post('/', asyncHandler(async (req, res) => {
  const b = openBody.parse(req.body);
  const { session } = await openSession({
    accountId: accountId(req),
    openedBy: actorId(req),
    purpose: b.purpose,
    fillerKind: b.fillerKind ?? 'loop',
    name: b.name,
    filename: b.filename,
    contentType: b.contentType,
    totalBytes: b.totalBytes,
  });
  res.status(201).json(view(session, true));
}));

/** Sessions this account could still resume. What a returning tab asks for. */
uploadsRouter.get('/', asyncHandler(async (req, res) => {
  const rows = await resumableSessions(accountId(req));
  res.json({
    sessions: rows.map((s) => view(s, true)),
    chunkSize: CHUNK_SIZE,
    maxBytes: MAX_UPLOAD_BYTES,
  });
}));

uploadsRouter.get('/:id', asyncHandler(async (req, res) => {
  const s = await sessionById(req.params.id, accountId(req));
  if (!s) throw notFound('Upload session not found');
  res.json(view(s, true));
}));

uploadsRouter.delete('/:id', asyncHandler(async (req, res) => {
  const s = await sessionById(req.params.id, accountId(req));
  if (!s) throw notFound('Upload session not found');
  await abortSession(s);
  res.status(204).end();
}));

// ---------------------------------------------------------------------------
//  Token-authenticated: the chunks themselves
//
//  Mounted separately and WITHOUT requireAuth, because the caller may be a
//  service worker holding only the session's capability token.
// ---------------------------------------------------------------------------
export const uploadChunksRouter = Router();

function bearer(req: any): string {
  const h = String(req.headers.authorization ?? '');
  return h.startsWith('Bearer ') ? h.slice(7) : '';
}

async function authorisedSession(req: any): Promise<UploadSession> {
  const s = await sessionByToken(bearer(req));
  if (!s) throw new ApiError(401, 'That upload token is not valid.');
  if (s.id !== req.params.id) {
    // The token names its own session. A token for one upload must not be able
    // to write into another, even for the same account.
    throw new ApiError(403, 'That token does not belong to this upload.');
  }
  return s;
}

/**
 * One chunk.
 *
 * `raw` with a limit one byte over the chunk size: the limit is a guard against
 * a client streaming forever, not a correctness check. The real length check is
 * in receiveChunk, which knows how long THIS chunk of THIS session should be —
 * including the short last one.
 */
uploadChunksRouter.put(
  '/:id/chunks/:index',
  raw({ type: '*/*', limit: CHUNK_SIZE + 1024 }),
  asyncHandler(async (req, res) => {
    const s = await authorisedSession(req);
    const index = Number(req.params.index);
    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      throw badRequest('A chunk needs a body.');
    }
    const out = await receiveChunk(s, index, body);
    res.json({
      id: s.id,
      index,
      duplicate: out.duplicate,
      received: out.received.length,
      chunkCount: s.chunk_count,
      receivedBytes: out.receivedBytes,
      complete: out.complete,
    });
  })
);

/**
 * Assemble.
 *
 * Idempotent, and it has to be: this is the call a service worker makes from its
 * `backgroundfetchsuccess` handler, which can fire more than once if the worker
 * is restarted mid-event.
 */
uploadChunksRouter.post('/:id/finish', asyncHandler(async (req, res) => {
  const s = await authorisedSession(req);
  try {
    const out = await finishSession(s);
    res.json({
      id: s.id, assetId: out.assetId, bytes: out.bytes,
      sha256: out.sha256, state: 'complete',
    });
  } catch (e: any) {
    if (e?.status === 409 && Array.isArray(e.missing)) {
      // Not an error the client should retry blindly: it says exactly which
      // chunks to send.
      return res.status(409).json({ error: e.message, missing: e.missing });
    }
    throw e;
  }
}));

/** What is still missing, for a client that lost track. Token-authenticated so a
 *  service worker can ask it too. */
uploadChunksRouter.get('/:id/state', asyncHandler(async (req, res) => {
  const s = await authorisedSession(req);
  res.json({
    id: s.id, state: s.state, chunkCount: s.chunk_count,
    chunkSize: s.chunk_size, totalBytes: Number(s.total_bytes),
    received: s.received ?? [], missing: missingChunks(s),
    receivedBytes: Number(s.received_bytes),
    expectedLast: expectedChunkBytes(s, s.chunk_count - 1),
  });
}));
