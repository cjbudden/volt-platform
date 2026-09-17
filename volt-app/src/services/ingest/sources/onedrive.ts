import { type RemoteSource, type RemoteRef, type RemoteDescription, type Fetch, type Auth, type LocateQuery, type LocateHit, RemoteError } from './types';

const GRAPH = 'https://graph.microsoft.com/v1.0';

/** OneDrive through Microsoft Graph: items carry a pre-authenticated download URL that honours Range. */
export class OneDriveSource implements RemoteSource {
  readonly provider = 'onedrive' as const;
  constructor(private fetch: Fetch, private api = GRAPH) {}
  private async get(auth: Auth | null, path: string) {
    if (!auth) throw new RemoteError('OneDrive is not linked to this account', 401, false);
    const res = await this.fetch(`${this.api}${path}`, { headers: { authorization: `Bearer ${auth.accessToken}` } });
    if (res.status === 404) return null;
    if (!res.ok) throw new RemoteError(`OneDrive answered HTTP ${res.status}`, res.status, res.status >= 500 || res.status === 429);
    return res.json();
  }
  async describe(ref: RemoteRef, auth: Auth | null): Promise<RemoteDescription> {
    const a = ref.token ? { accessToken: ref.token } : auth;
    const j: any = await this.get(a, `/me/drive/items/${encodeURIComponent(ref.ref)}?select=id,name,size,file,lastModifiedDateTime,@microsoft.graph.downloadUrl`);
    if (!j) throw new RemoteError('that OneDrive item does not exist', 404, false);
    return { name: j.name, bytes: Number(j.size) || null, mime: j.file?.mimeType ?? null, ranges: true, modified: j.lastModifiedDateTime ?? null, downloadUrl: j['@microsoft.graph.downloadUrl'] };
  }
  async locate(q: LocateQuery, auth: Auth): Promise<LocateHit | null> {
    if (q.relativePath) {
      const j: any = await this.get(auth, `/me/drive/root:/${q.relativePath.split('/').map(encodeURIComponent).join('/')}?select=id,name,size,parentReference`);
      if (j?.id && (q.bytes == null || Number(j.size) === q.bytes)) return { ref: { provider: 'onedrive', ref: j.id }, name: j.name, bytes: Number(j.size), path: `${j.parentReference?.path ?? ''}/${j.name}`, strength: 'path' };
    }
    const s: any = await this.get(auth, `/me/drive/root/search(q='${encodeURIComponent(q.name.replace(/'/g, "''"))}')?select=id,name,size,file,parentReference&$top=20`);
    const files = (s?.value ?? []).filter((x: any) => x.file && x.name.toLowerCase() === q.name.toLowerCase());
    const exact = q.bytes != null ? files.find((x: any) => Number(x.size) === q.bytes) : null;
    const m = exact ?? (files.length === 1 ? files[0] : null);
    if (!m) return null;
    return { ref: { provider: 'onedrive', ref: m.id }, name: m.name, bytes: Number(m.size), path: `${m.parentReference?.path ?? ''}/${m.name}`, strength: exact ? 'name_and_size' : 'name' };
  }
}
