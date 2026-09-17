// IBM Aspera through the Node API. Volt asks the customer's node for a
// transfer spec with a one-time token for the destination path; the
// operator's IBM Aspera desktop client (via the browser SDK handoff) runs
// FASP. Landing is reported by the node's post-transfer hook or the poll.
//
// Request shapes follow the Aspera Node API (files/upload_setup,
// ops/transfers). Verify against the node's version before going live.
import { type TransferProvider, type TransferFile, type TransferDestination, type ProviderCredentials, type CreatedTransfer, type TransferEvent, type Fetch, ProviderError } from './types';

export class AsperaProvider implements TransferProvider {
  readonly key = 'aspera' as const;
  constructor(private fetch: Fetch) {}
  private auth(c: ProviderCredentials): string {
    if (c.config.bearer) return `Bearer ${c.config.bearer}`;
    return 'Basic ' + Buffer.from(`${c.config.user ?? ''}:${c.config.password ?? ''}`).toString('base64');
  }
  private url(c: ProviderCredentials, p: string) { return String(c.config.nodeUrl ?? '').replace(/\/$/, '') + p; }

  async createTransfer(files: TransferFile[], dest: TransferDestination, creds: ProviderCredentials, ctx: { transferId: string; callbackUrl: string }): Promise<CreatedTransfer> {
    if (!creds.config.nodeUrl) throw new ProviderError('Aspera node URL is not configured', 400);
    const destinationRoot = `${String(dest.root).replace(/\/$/, '')}/${dest.folder}`;
    const body = {
      transfer_requests: [{ transfer_request: {
        paths: files.map((f) => ({ destination: f.relativePath || f.name })),
        destination_root: destinationRoot,
        // Carried through to the transfer's tags so a post-transfer hook can call us back with it.
        tags: { volt: { transferId: ctx.transferId, callbackUrl: ctx.callbackUrl } },
      } }],
    };
    const res = await this.fetch(this.url(creds, '/files/upload_setup'), { method: 'POST', headers: { authorization: this.auth(creds), 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) throw new ProviderError(`Aspera node answered HTTP ${res.status}`, res.status >= 500 ? 502 : 400);
    const j: any = await res.json();
    const spec = j.transfer_specs?.[0]?.transfer_spec;
    if (!spec) throw new ProviderError(`Aspera node returned no transfer spec${j.transfer_specs?.[0]?.error ? ': ' + JSON.stringify(j.transfer_specs[0].error) : ''}`, 502);
    return {
      externalId: null, // the transfer id exists once the client starts it; the hook and poll report it
      destination: { ...dest, root: destinationRoot },
      launch: { kind: 'aspera_spec', transferSpec: { ...spec, direction: 'send', tags: body.transfer_requests[0].transfer_request.tags }, note: 'Handed to the IBM Aspera desktop client through the browser SDK. FASP moves the files.' },
      spec: { destinationRoot },
    };
  }

  parseEvent(body: any): TransferEvent | null {
    // Node API transfer object (ops/transfers) or a post-transfer hook posting the same shape.
    const t = body?.transfer ?? body;
    if (!t || (!t.id && !t.uuid)) return null;
    const status = String(t.status ?? '').toLowerCase();
    const state: TransferEvent['state'] = status === 'completed' ? 'landed' : status === 'failed' || status === 'error' ? 'failed' : status === 'cancelled' ? 'cancelled' : 'running';
    return {
      externalId: String(t.id ?? t.uuid), state,
      progress: { bytes: Number(t.bytes_transferred ?? t.bytes_written ?? 0) || undefined, pct: t.percentage != null ? Math.round(Number(t.percentage) * (Number(t.percentage) <= 1 ? 100 : 1)) : undefined },
      files: Array.isArray(t.files) ? t.files.map((f: any) => ({ name: String(f.path ?? f.destination ?? '').split('/').pop() ?? '', path: f.path ?? f.destination ?? null, bytes: Number(f.bytes_written ?? f.size ?? 0) || null })) : undefined,
      error: t.error_desc ?? t.error ?? null,
    };
  }

  async poll(externalId: string, creds: ProviderCredentials): Promise<TransferEvent> {
    const res = await this.fetch(this.url(creds, `/ops/transfers/${encodeURIComponent(externalId)}`), { headers: { authorization: this.auth(creds), accept: 'application/json' } });
    if (!res.ok) throw new ProviderError(`Aspera node answered HTTP ${res.status}`, 502);
    return this.parseEvent(await res.json()) ?? { externalId, state: 'running' };
  }
}
