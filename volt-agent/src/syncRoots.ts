// ============================================================================
//  SYNC ROOTS — is this path inside a cloud drive, and which one?
//
//  The browser cannot see a dropped file's real path; the agent can. If the
//  file lives under a Google Drive, OneDrive or Dropbox sync root, Volt can
//  fetch it provider to cloud instead of pulling it through this machine's
//  connection. Pure: takes the path, the home directory and the platform.
// ============================================================================
export type Provider = 'gdrive' | 'onedrive' | 'dropbox';

export interface SyncHit { provider: Provider; root: string; relativePath: string; account?: string | null }

const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');

/** Candidate roots for a platform, most specific first. Patterns are prefixes of the normalised path. */
export function candidateRoots(home: string, platform: NodeJS.Platform, extra: { path: string; provider: Provider }[] = []): { provider: Provider; prefix: RegExp; stripSegments: number }[] {
  const h = norm(home).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const out: { provider: Provider; prefix: RegExp; stripSegments: number }[] = extra.map((e) => ({ provider: e.provider, prefix: new RegExp('^' + norm(e.path).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(/|$)', 'i'), stripSegments: 0 }));
  if (platform === 'darwin') {
    out.push(
      // ~/Library/CloudStorage/GoogleDrive-name@x.com/My Drive/... (the "My Drive" segment is not part of the Drive path)
      { provider: 'gdrive', prefix: new RegExp(`^${h}/Library/CloudStorage/GoogleDrive-[^/]+/(My Drive|Shared drives)(/|$)`, 'i'), stripSegments: 0 },
      { provider: 'onedrive', prefix: new RegExp(`^${h}/Library/CloudStorage/OneDrive-[^/]+(/|$)`, 'i'), stripSegments: 0 },
      { provider: 'dropbox', prefix: new RegExp(`^${h}/Library/CloudStorage/Dropbox-[^/]+(/|$)`, 'i'), stripSegments: 0 },
      { provider: 'dropbox', prefix: new RegExp(`^${h}/Dropbox(/|$)`, 'i'), stripSegments: 0 },
      { provider: 'gdrive', prefix: new RegExp(`^${h}/Google Drive/(My Drive|Shared drives)(/|$)`, 'i'), stripSegments: 0 },
    );
  } else if (platform === 'win32') {
    out.push(
      { provider: 'onedrive', prefix: new RegExp(`^${h}/OneDrive[^/]*(/|$)`, 'i'), stripSegments: 0 },
      { provider: 'dropbox', prefix: new RegExp(`^${h}/Dropbox[^/]*(/|$)`, 'i'), stripSegments: 0 },
      { provider: 'gdrive', prefix: /^[A-Z]:\/(My Drive|Shared drives)(\/|$)/i, stripSegments: 0 },
      { provider: 'gdrive', prefix: new RegExp(`^${h}/Google Drive/(My Drive|Shared drives)(/|$)`, 'i'), stripSegments: 0 },
    );
  } else {
    out.push({ provider: 'dropbox', prefix: new RegExp(`^${h}/Dropbox(/|$)`, 'i'), stripSegments: 0 });
  }
  return out;
}

/** Which cloud drive, if any, a path sits in. The relative path is the provider's own path for the file. */
export function syncRootFor(absPath: string, home: string, platform: NodeJS.Platform, extra: { path: string; provider: Provider }[] = []): SyncHit | null {
  const p = norm(absPath);
  for (const c of candidateRoots(home, platform, extra)) {
    const m = c.prefix.exec(p);
    if (!m) continue;
    const root = m[0].replace(/\/$/, '');
    const rel = p.slice(root.length).replace(/^\/+/, '');
    const accountMatch = /(GoogleDrive|OneDrive|Dropbox)-([^/]+)/i.exec(root);
    return { provider: c.provider, root, relativePath: rel, account: accountMatch ? accountMatch[2] : null };
  }
  return null;
}

/**
 * Is the file a placeholder whose bytes are still in the cloud? Files On
 * Demand (OneDrive), Drive "streaming" and Dropbox online-only files all
 * report a size with no blocks allocated. Node exposes `blocks` on macOS and
 * Linux; on Windows it is undefined, so the answer there is "unknown" and
 * the caller treats unknown as "ask Volt to look in the cloud first".
 */
export function isCloudOnly(st: { size: number; blocks?: number | null }): boolean | null {
  if (st.blocks == null) return null;
  return st.size > 0 && st.blocks === 0;
}
