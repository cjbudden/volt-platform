// MASV: API-created packages and a portal for the sender; delivery is
// announced by MASV's webhook. The pragmatic choice for a customer without
// an Aspera licence. Shapes follow the MASV API v1 (teams/{id}/packages,
// packages/{id}/finalize); verify against the account's plan.
import { type TransferProvider, type TransferFile, type TransferDestination, type ProviderCredentials, type CreatedTransfer, type TransferEvent, type Fetch, ProviderError } from './types';

const API = 'https://api.massive.io/v1';

export class MasvProvider implements TransferProvider {
  readonly key = 'masv' as const;
  constructor(private fetch: Fetch, private api = API) {}
  async createTransfer(files: TransferFile[], dest: TransferDestination, creds: ProviderCredentials, ctx: { transferId: string; callbackUrl: string }): Promise<CreatedTransfer> {
    if (!creds.config.apiKey || !creds.config.teamId) throw new ProviderError('MASV api key and team id are not configured', 400);
    const H = { 'X-API-KEY': String(creds.config.apiKey), 'content-type': 'application/json' };
    const res = await this.fetch(`${this.api}/teams/${encodeURIComponent(creds.config.teamId)}/packages`, { method: 'POST', headers: H, body: JSON.stringify({
      name: `Volt ${ctx.transferId.slice(0, 8)}`, description: `Volt ingest ${ctx.transferId}`, sender: 'volt', recipients: [], metadata: { voltTransferId: ctx.transferId, callbackUrl: ctx.callbackUrl, destination: `${dest.root}/${dest.folder}` },
    }) });
    if (!res.ok) throw new ProviderError(`MASV answered HTTP ${res.status}`, res.status >= 500 ? 502 : 400);
    const j: any = await res.json();
    const portal = creds.config.portalSubdomain ? `https://${creds.config.portalSubdomain}.portal.massive.io/?package=${encodeURIComponent(j.id)}` : `https://app.massive.io/packages/${encodeURIComponent(j.id)}`;
    return { externalId: String(j.id), destination: dest, launch: { kind: 'portal', url: portal, note: 'The sender uploads in the MASV portal; MASV delivers to the configured destination and calls back when done.' }, spec: { packageId: j.id, files: files.map((f) => f.name) } };
  }
  parseEvent(body: any): TransferEvent | null {
    const ev = String(body?.event ?? body?.type ?? '');
    const pkg = body?.package ?? body?.data ?? body;
    if (!pkg?.id && !pkg?.package_id) return null;
    const id = String(pkg.id ?? pkg.package_id);
    if (/delivered|finalized|complete/i.test(ev) || pkg.state === 'delivered') return { externalId: id, state: 'landed', files: (pkg.files ?? []).map((f: any) => ({ name: f.name ?? f.filename, path: f.path ?? f.name ?? null, bytes: Number(f.size ?? 0) || null })) };
    if (/fail|error|expired/i.test(ev)) return { externalId: id, state: 'failed', error: pkg.error ?? ev };
    return { externalId: id, state: 'running', progress: { bytes: Number(pkg.bytes_uploaded ?? 0) || undefined } };
  }
}
