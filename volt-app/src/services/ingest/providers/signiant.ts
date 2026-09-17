// Signiant Media Shuttle: a submit portal creates a package the sender
// fills; Media Shuttle's notification API reports delivery. Shapes follow
// the Media Shuttle Management API v3; verify against the portal.
import { type TransferProvider, type TransferFile, type TransferDestination, type ProviderCredentials, type CreatedTransfer, type TransferEvent, type Fetch, ProviderError } from './types';

const API = 'https://api.mediashuttle.com/v3.1';

export class SigniantProvider implements TransferProvider {
  readonly key = 'signiant' as const;
  constructor(private fetch: Fetch, private api = API) {}
  private async token(c: ProviderCredentials): Promise<string> {
    if (c.accessToken) return c.accessToken;
    const res = await this.fetch(`${this.api.replace('/v3.1', '')}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials', client_id: String(c.config.clientId ?? ''), client_secret: String(c.config.clientSecret ?? '') }).toString() });
    if (!res.ok) throw new ProviderError(`Signiant token request answered HTTP ${res.status}`, 502);
    return String(((await res.json()) as any).access_token);
  }
  async createTransfer(files: TransferFile[], dest: TransferDestination, creds: ProviderCredentials, ctx: { transferId: string; callbackUrl: string }): Promise<CreatedTransfer> {
    if (!creds.config.portalId && !creds.config.portalUrl) throw new ProviderError('Signiant portal is not configured', 400);
    const tok = await this.token(creds);
    const portalId = creds.config.portalId ?? new URL(creds.config.portalUrl).hostname.split('.')[0];
    const res = await this.fetch(`${this.api}/portals/${encodeURIComponent(portalId)}/packages`, { method: 'POST', headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: JSON.stringify({
      name: `Volt ${ctx.transferId.slice(0, 8)}`, subject: `Volt ingest ${ctx.transferId}`, files: files.map((f) => ({ name: f.name, size: f.bytes ?? undefined })), metadata: { voltTransferId: ctx.transferId, callbackUrl: ctx.callbackUrl, destination: `${dest.root}/${dest.folder}` },
    }) });
    if (!res.ok) throw new ProviderError(`Signiant answered HTTP ${res.status}`, res.status >= 500 ? 502 : 400);
    const j: any = await res.json();
    const url = j.uploadUrl ?? j.url ?? `${creds.config.portalUrl ?? `https://${portalId}.mediashuttle.com`}/packages/${encodeURIComponent(j.id)}`;
    return { externalId: String(j.id), destination: dest, launch: { kind: 'portal', url, note: 'The sender uploads in the Media Shuttle portal; Signiant delivers to the portal storage and notifies on completion.' }, spec: { packageId: j.id } };
  }
  parseEvent(body: any): TransferEvent | null {
    const p = body?.package ?? body?.data ?? body;
    const id = p?.id ?? p?.packageId; if (!id) return null;
    const ev = String(body?.eventType ?? body?.event ?? p.status ?? '').toLowerCase();
    if (/complete|delivered|finished/.test(ev)) return { externalId: String(id), state: 'landed', files: (p.files ?? []).map((f: any) => ({ name: f.name, path: f.path ?? f.name ?? null, bytes: Number(f.size ?? 0) || null })) };
    if (/fail|error|cancel/.test(ev)) return { externalId: String(id), state: /cancel/.test(ev) ? 'cancelled' : 'failed', error: p.error ?? ev };
    return { externalId: String(id), state: 'running', progress: { pct: p.percentComplete != null ? Number(p.percentComplete) : undefined } };
  }
}
