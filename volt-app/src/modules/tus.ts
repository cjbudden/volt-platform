// ============================================================================
//  /api/tus — the tus endpoint, backed by upload_sessions.
//
//  A tus upload IS an upload session (purpose 'vod', chunk_count 0, the bytes
//  appended in order to one file). Authentication is the console JWT or an
//  account secret key on every request; a tus client has no chunk token.
//  Upload-Metadata carries the ingest inputs: filename, filetype,
//  relativePath, schemaId, source, metadata (JSON).
// ============================================================================
import { join } from 'node:path';
import { mkdirSync, renameSync } from 'node:fs';
import { query, one } from '../db';
import { requireAuth, accountId } from '../auth/middleware';
import { actorId } from '../util/actor';
import { config } from '../config';
import { createTusRouter, type TusStore, type TusInfo } from '../services/ingest/tus';
import { openSession, sessionDir, destinationFor, completeLanded, MAX_UPLOAD_BYTES, type UploadSession } from '../services/uploads';

interface Who { accountId: string; userId: string | null }

class PgTusStore implements TusStore {
  async create(who: Who, length: number, md: Record<string, string>): Promise<TusInfo> {
    let metadata: Record<string, any> | null = null;
    try { metadata = md.metadata ? JSON.parse(md.metadata) : null; } catch { metadata = null; }
    const filename = md.filename || md.name || 'upload.bin';
    const { session } = await openSession({
      accountId: who.accountId, openedBy: who.userId, purpose: 'vod',
      name: (md.name || filename).replace(/\.[^.]+$/, '').slice(0, 200), filename,
      contentType: md.filetype || md.type || 'application/octet-stream', totalBytes: Math.max(1, length),
      ladderGroupId: md.ladderGroupId || null, relativePath: md.relativePath || null,
      schemaId: md.schemaId || null, metadata, source: md.source || 'tus',
    });
    await query(`UPDATE upload_sessions SET chunk_count = 0, updated_at = now() WHERE id = $1`, [session.id]);
    return toInfo(session, md);
  }
  async get(who: Who, id: string): Promise<TusInfo | null> {
    const s = await one<UploadSession>(`SELECT * FROM upload_sessions WHERE id = $1 AND account_id = $2`, [id, who.accountId]);
    if (!s) return null;
    return toInfo(s, { filename: s.filename, filetype: s.content_type, ...(s.relative_path ? { relativePath: s.relative_path } : {}) });
  }
  async setOffset(id: string, offset: number) {
    await query(`UPDATE upload_sessions SET received_bytes = $2, updated_at = now() WHERE id = $1`, [id, offset]);
  }
  async remove(id: string) {
    await query(`UPDATE upload_sessions SET state = 'aborted', updated_at = now() WHERE id = $1`, [id]);
    await query(`DELETE FROM vod_assets WHERE id = (SELECT vod_asset_id FROM upload_sessions WHERE id = $1) AND source_key IS NULL`, [id]).catch(() => {});
  }
  dataPath(info: TusInfo) { return join(sessionDir(info.id), 'upload.tus'); }
}

function toInfo(s: UploadSession, md: Record<string, string>): TusInfo {
  return {
    id: s.id, length: Number(s.total_bytes), offset: Number(s.received_bytes ?? 0), metadata: md,
    expiresAt: s.expires_at, extra: { state: s.state },
  };
}

export const tusRouter = createTusRouter({
  store: new PgTusStore(),
  basePath: '/api/tus',
  maxBytes: MAX_UPLOAD_BYTES,
  authorise: async (req) => {
    await new Promise<void>((resolve, reject) => requireAuth(req as any, {} as any, (e?: any) => (e ? reject(e) : resolve())));
    return { accountId: accountId(req as any), userId: actorId(req as any) } as Who;
  },
  onComplete: async (info, _who, sha) => {
    const s = await one<UploadSession>(`SELECT * FROM upload_sessions WHERE id = $1`, [info.id]);
    if (!s || s.state === 'complete') return;
    const dest = destinationFor(s);
    mkdirSync(join(dest, '..'), { recursive: true });
    renameSync(join(sessionDir(s.id), 'upload.tus'), dest);
    await completeLanded(s, dest, info.length, sha);
  },
});
