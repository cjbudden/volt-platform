// ============================================================================
//  REMOTE INGEST JOB — cloud to cloud, the worker half.
//
//  A job carries a RemoteRef. The worker (which runs in AWS, on datacentre
//  bandwidth) describes the file, fetches it as parallel ranges into the
//  upload session's destination, and hands it to completeLanded() exactly as
//  a browser upload would. The laptop was never involved.
// ============================================================================
import { one, query } from '../../../db';
import { registerHandler, PermanentError, type JobContext } from '../worker';
import { sourcesFor, fetchRemote, RemoteError, type RemoteRef } from '../../ingest/sources';
import { providerAccounts, accessTokenFor } from '../../ingest/providerAccounts';
import { destinationFor, completeLanded, type UploadSession } from '../../uploads';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const REMOTE_INGEST = 'ingest.remote';

export interface RemoteIngestPayload { sessionId: string; ref: RemoteRef; providerAccountId?: string | null }

export async function handleRemoteIngest(ctx: JobContext): Promise<Record<string, unknown>> {
  const p = ctx.job.payload as unknown as RemoteIngestPayload;
  const s = await one<UploadSession>(`SELECT * FROM upload_sessions WHERE id = $1`, [p.sessionId]);
  if (!s) throw new PermanentError('upload session is gone');
  if (s.state === 'complete') return { already: true };
  const src = sourcesFor()[p.ref.provider];
  let auth = null as { accessToken: string } | null;
  if (p.ref.provider !== 'url' && !p.ref.token) {
    const accts = await providerAccounts(s.account_id, p.ref.provider);
    const pa = p.providerAccountId ? accts.find((a) => a.id === p.providerAccountId) : accts[0];
    if (!pa) throw new PermanentError(`${p.ref.provider} is not linked to this account`);
    auth = { accessToken: await accessTokenFor(pa) };
  }
  const dest = destinationFor(s);
  mkdirSync(dirname(dest), { recursive: true });
  await query(`UPDATE upload_sessions SET state = 'open', error = NULL, updated_at = now() WHERE id = $1`, [s.id]);
  let last = 0;
  try {
    const r = await fetchRemote(src, p.ref, auth, dest, fetch, {
      onProgress: (done, total) => { const pct = total ? Math.round((done / total) * 90) : 50; if (pct - last >= 5) { last = pct; void ctx.progress(pct, `${(done / 1e9).toFixed(2)} GB`); void query(`UPDATE upload_sessions SET received_bytes = $2, updated_at = now() WHERE id = $1`, [s.id, done]); } },
    });
    await ctx.progress(92, 'landed, running ingest rules');
    // The session's declared size was a guess until now; record what arrived.
    await query(`UPDATE upload_sessions SET total_bytes = $2, received_bytes = $2, filename = COALESCE(NULLIF(filename, ''), $3), content_type = COALESCE($4, content_type) WHERE id = $1`, [s.id, r.bytes, r.name, r.mime]);
    const fresh = (await one<UploadSession>(`SELECT * FROM upload_sessions WHERE id = $1`, [s.id]))!;
    const out = await completeLanded(fresh, dest, r.bytes, r.sha256);
    return { assetId: out.assetId, bytes: r.bytes, sha256: r.sha256 };
  } catch (e: any) {
    await query(`UPDATE upload_sessions SET error = $2, updated_at = now() WHERE id = $1`, [s.id, String(e?.message ?? e).slice(0, 500)]);
    if (e instanceof RemoteError && !e.retryable) throw new PermanentError(e.message);
    throw e;
  }
}

export function registerRemoteIngestHandlers(): void { registerHandler(REMOTE_INGEST, handleRemoteIngest); }
