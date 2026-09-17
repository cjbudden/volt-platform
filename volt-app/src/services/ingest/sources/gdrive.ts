import { type RemoteSource, type RemoteRef, type RemoteDescription, type Fetch, type Auth, RemoteError } from './types';

const API = 'https://www.googleapis.com/drive/v3';

/**
 * Google Drive. The token normally comes from the Picker (drive.file scope,
 * non-sensitive, no verification) and is passed per request. A linked
 * account token works too, but search needs restricted scopes, so locate()
 * is deliberately absent here: for Google the picker is the door.
 */
export class GoogleDriveSource implements RemoteSource {
  readonly provider = 'gdrive' as const;
  constructor(private fetch: Fetch, private api = API) {}
  async describe(ref: RemoteRef, auth: Auth | null): Promise<RemoteDescription> {
    const tok = ref.token ?? auth?.accessToken;
    if (!tok) throw new RemoteError('Google Drive needs a picker token or a linked account', 401, false);
    const res = await this.fetch(`${this.api}/files/${encodeURIComponent(ref.ref)}?fields=id,name,size,mimeType,modifiedTime&supportsAllDrives=true`, { headers: { authorization: `Bearer ${tok}` } });
    if (!res.ok) throw new RemoteError(`Google Drive answered HTTP ${res.status}`, res.status, res.status >= 500 || res.status === 429);
    const j: any = await res.json();
    if (String(j.mimeType ?? '').startsWith('application/vnd.google-apps.')) throw new RemoteError('that is a Google Docs file, not a media file', 400, false);
    return { name: j.name, bytes: Number(j.size) || null, mime: j.mimeType ?? null, ranges: true, modified: j.modifiedTime ?? null,
             downloadUrl: `${this.api}/files/${encodeURIComponent(ref.ref)}?alt=media&supportsAllDrives=true`, downloadHeaders: { authorization: `Bearer ${tok}` } };
  }
}
