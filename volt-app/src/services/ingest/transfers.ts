// ============================================================================
//  ACCELERATED TRANSFERS, database-backed: create with a provider, record,
//  and when the provider says the files landed, ingest each one exactly as
//  an upload: an upload session per file, completeLanded() with the local
//  path (or the S3 object mirrored to staging), the rules ladder afterwards.
// ============================================================================
import { randomUUID, createHash } from 'node:crypto';
import { existsSync, statSync, createReadStream, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { query, one } from '../../db';
import { config } from '../../config';
import { providersFor, S3AccelProvider, type TransferProvider, type TransferFile, type TransferEvent, type TransferDestination } from './providers';
import { providerAccounts, accessTokenFor } from './providerAccounts';
import { openSession, destinationFor, completeLanded, sessionDir, type UploadSession } from '../uploads';
import { realS3 } from './s3';

export interface TransferRow {
  id: string; account_id: string; provider: string; provider_account_id: string | null; external_id: string | null; state: string;
  files: TransferFile[]; destination: TransferDestination; spec: any; progress: any; error: string | null; landed_paths: any; created_by: string | null; created_at: string;
}

function providerFor(key: string, fetchImpl = fetch): TransferProvider {
  if (key === 's3accel') {
    return new S3AccelProvider({ bucket: config.ingest.s3Bucket, region: config.aws.region, accelerate: config.ingest.s3Accelerate,
      credentials: async () => { const { defaultProvider } = await import('@aws-sdk/credential-provider-node'); return defaultProvider()(); } });
  }
  const p = (providersFor(fetchImpl) as any)[key];
  if (!p) throw Object.assign(new Error(`unknown transfer provider ${key}`), { status: 400 });
  return p;
}

/** Where a provider is told to put files. Aspera nodes use their own docroot; MASV/Signiant deliver to portal storage; S3 to the ingest bucket. */
function destinationFor2(provider: string, cfg: Record<string, any>, transferId: string): TransferDestination {
  const folder = `volt-${transferId.slice(0, 8)}`;
  if (provider === 'aspera') return { kind: 'node_path', root: String(cfg.destinationRoot ?? '/volt/inbox'), folder };
  if (provider === 's3accel') return { kind: 's3', root: `${config.ingest.s3Prefix}/inbox`, folder };
  return { kind: 'portal', root: String(cfg.destinationRoot ?? 'inbox'), folder };
}

export async function createTransfer(accountId: string, userId: string | null, provider: string, files: TransferFile[], providerAccountId: string | null, fetchImpl = fetch): Promise<TransferRow> {
  const id = randomUUID();
  let creds = { config: {} as Record<string, any>, accessToken: null as string | null };
  let pa: any = null;
  if (provider !== 's3accel') {
    const accts = await providerAccounts(accountId, provider);
    pa = providerAccountId ? accts.find((a) => a.id === providerAccountId) : accts[0];
    if (!pa) throw Object.assign(new Error(`${provider} is not configured for this account`), { status: 409 });
    creds = { config: pa.config ?? {}, accessToken: pa.access_token ? await accessTokenFor(pa, fetchImpl) : null };
  }
  const dest = destinationFor2(provider, creds.config, id);
  const callbackUrl = `${config.publicBaseUrl}/api/ingest/transfers/${id}/events`;
  const created = await providerFor(provider, fetchImpl).createTransfer(files, dest, creds, { transferId: id, accountId, callbackUrl });
  const row = await one<TransferRow>(
    `INSERT INTO ingest_transfers (id, account_id, provider, provider_account_id, external_id, state, files, destination, spec, created_by)
     VALUES ($1,$2,$3,$4,$5,'created',$6,$7,$8,$9) RETURNING *`,
    [id, accountId, provider, pa?.id ?? null, created.externalId, JSON.stringify(files), JSON.stringify(created.destination), JSON.stringify({ launch: created.launch, ...(created.spec ?? {}) }), userId]);
  return row!;
}

/** A provider event (webhook body) or a poll result for a transfer. Returns what changed. */
export async function applyTransferEvent(transferId: string, body: any, headers: Record<string, string>, fetchImpl = fetch): Promise<{ state: string; ingested: string[] }> {
  const t = await one<TransferRow>(`SELECT * FROM ingest_transfers WHERE id = $1`, [transferId]);
  if (!t) throw Object.assign(new Error('transfer not found'), { status: 404 });
  const pa = t.provider_account_id ? await one<any>(`SELECT * FROM ingest_provider_accounts WHERE id = $1`, [t.provider_account_id]) : null;
  const ev = providerFor(t.provider, fetchImpl).parseEvent(body, headers, { config: pa?.config ?? {}, accessToken: pa?.access_token ?? null });
  if (!ev) return { state: t.state, ingested: [] };
  return applyEvent(t, ev);
}

export async function applyEvent(t: TransferRow, ev: TransferEvent): Promise<{ state: string; ingested: string[] }> {
  if (t.state === 'landed') return { state: 'landed', ingested: [] };
  const patch: any = { state: ev.state === 'running' ? 'running' : ev.state, external_id: ev.externalId ?? t.external_id, progress: ev.progress ?? t.progress, error: ev.error ?? null };
  await query(`UPDATE ingest_transfers SET state = $2, external_id = $3, progress = $4, error = $5, updated_at = now() WHERE id = $1`, [t.id, patch.state, patch.external_id, JSON.stringify(patch.progress ?? null), patch.error]);
  if (ev.state !== 'landed') return { state: patch.state, ingested: [] };

  // Landed: every file the provider names (or every file we asked for) becomes an upload session and goes through completeLanded().
  const named = ev.files?.length ? ev.files : t.files.map((f) => ({ name: f.name, path: f.relativePath ?? f.name, bytes: f.bytes ?? null }));
  const ingested: string[] = [];
  const paths: Record<string, string> = {};
  for (const f of named) {
    try {
      const local = await localiseLanded(t, f);
      const { session } = await openSession({ accountId: t.account_id, openedBy: t.created_by, purpose: 'vod', name: f.name.replace(/\.[^.]+$/, '').slice(0, 200), filename: f.name,
        totalBytes: Math.max(1, f.bytes ?? statSync(local).size), relativePath: f.path ?? null, source: t.provider });
      await query(`UPDATE upload_sessions SET chunk_count = 0 WHERE id = $1`, [session.id]);
      const dest = destinationFor(session);
      mkdirSync(dirname(dest), { recursive: true });
      require('node:fs').renameSync(local, dest);
      const size = statSync(dest).size;
      const h = createHash('sha256'); await pipeline(createReadStream(dest), new Transform({ transform(c, _e, cb) { h.update(c); cb(); } }));
      const out = await completeLanded((await one<UploadSession>(`SELECT * FROM upload_sessions WHERE id = $1`, [session.id]))!, dest, size, h.digest('hex'));
      if (out.assetId) ingested.push(out.assetId);
      paths[f.name] = dest;
    } catch (e: any) {
      paths[f.name] = `error: ${String(e?.message ?? e).slice(0, 300)}`;
    }
  }
  await query(`UPDATE ingest_transfers SET landed_paths = $2, updated_at = now() WHERE id = $1`, [t.id, JSON.stringify(paths)]);
  return { state: 'landed', ingested };
}

/** Bring a landed file to local disk: already local for a node path we can see, downloaded from S3 for the accelerate route. */
async function localiseLanded(t: TransferRow, f: { name: string; path?: string | null }): Promise<string> {
  const d = t.destination;
  const rel = (f.path && f.path.startsWith(d.folder) ? f.path.slice(d.folder.length + 1) : f.path) || f.name;
  if (d.kind === 's3') {
    const s3 = await realS3({ region: config.aws.region, endpoint: config.ingest.s3Endpoint });
    const key = f.path && f.path.includes(d.folder) ? f.path : `${d.root}/${d.folder}/${rel}`;
    const local = join(config.uploads.dir, 'transfers', t.id, rel);
    mkdirSync(dirname(local), { recursive: true });
    await pipeline(await s3.getStream(config.ingest.s3Bucket, key), require('node:fs').createWriteStream(local));
    return local;
  }
  // node_path / portal: the destination root is a path this server can read (an Aspera node docroot or portal storage mounted here).
  const candidates = [join(d.root, d.folder, rel), join(d.root, rel), f.path ?? ''].filter(Boolean);
  const hit = candidates.find((p) => existsSync(p));
  if (!hit) throw new Error(`landed file not found under ${join(d.root, d.folder)} (looked for ${rel})`);
  return hit;
}

export async function listTransfers(accountId: string): Promise<TransferRow[]> {
  return query<TransferRow>(`SELECT * FROM ingest_transfers WHERE account_id = $1 ORDER BY created_at DESC LIMIT 100`, [accountId]);
}

/** Poll every running transfer whose provider supports it. Called by the scheduler. */
export async function pollTransfers(fetchImpl = fetch): Promise<number> {
  const rows = await query<TransferRow>(`SELECT * FROM ingest_transfers WHERE state IN ('created', 'running') AND external_id IS NOT NULL AND created_at > now() - interval '7 days'`);
  let n = 0;
  for (const t of rows) {
    const p = providerFor(t.provider, fetchImpl);
    if (!p.poll) continue;
    const pa = t.provider_account_id ? await one<any>(`SELECT * FROM ingest_provider_accounts WHERE id = $1`, [t.provider_account_id]) : null;
    try { const ev = await p.poll(t.external_id!, { config: pa?.config ?? {}, accessToken: pa?.access_token ?? null }); await applyEvent(t, ev); n++; } catch (e) { /* next tick */ }
  }
  return n;
}
