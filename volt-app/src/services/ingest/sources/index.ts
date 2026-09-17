import type { RemoteSource, RemoteRef, Fetch, Auth } from './types';
import { UrlSource } from './url';
import { DropboxSource } from './dropbox';
import { OneDriveSource } from './onedrive';
import { GoogleDriveSource } from './gdrive';
import { fetchToFile, type FetchOptions, type FetchResult } from './fetcher';

export * from './types';
export { fetchToFile } from './fetcher';

export function sourcesFor(fetchImpl: Fetch = fetch): Record<RemoteRef['provider'], RemoteSource> {
  return { url: new UrlSource(fetchImpl), dropbox: new DropboxSource(fetchImpl), onedrive: new OneDriveSource(fetchImpl), gdrive: new GoogleDriveSource(fetchImpl) };
}

/** Describe then fetch, with parallel ranges when the provider allows. */
export async function fetchRemote(src: RemoteSource, ref: RemoteRef, auth: Auth | null, path: string, fetchImpl: Fetch, o: FetchOptions = {}): Promise<FetchResult & { name: string; mime: string | null }> {
  const d = await src.describe(ref, auth);
  const open = async (start: number | null, end: number | null) => {
    const headers: Record<string, string> = { ...(d.downloadHeaders ?? {}) };
    if (start != null) headers.Range = `bytes=${start}-${end}`;
    if (d.downloadUrl) return fetchImpl(d.downloadUrl, { headers, redirect: 'follow' });
    if (src.openRange && start != null) return src.openRange(ref, auth, start, end!);
    throw new Error('source has no download URL and no range opener');
  };
  const r = await fetchToFile({ bytes: d.bytes, ranges: d.ranges, open }, path, o);
  return { ...r, name: d.name, mime: d.mime };
}
