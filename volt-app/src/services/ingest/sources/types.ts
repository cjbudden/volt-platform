// ============================================================================
//  REMOTE SOURCES — a file that lives somewhere else, described uniformly.
//
//  Four adapters (URL, Dropbox, OneDrive, Google Drive) answer the same three
//  questions: what is this file, give me bytes from here to there, and (for
//  linked accounts) do you have a file that looks like this one. The fetcher
//  turns "bytes from here to there" into parallel ranges, which is the whole
//  reason cloud to cloud is fast.
//
//  `fetch` is injected so every adapter is tested against a fake provider
//  without network, and so an account can point Dropbox at a proxy.
// ============================================================================
export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface RemoteRef {
  provider: 'url' | 'dropbox' | 'onedrive' | 'gdrive';
  /** URL for 'url'; Dropbox path or id; OneDrive item id; Drive file id. */
  ref: string;
  /** Per-request auth for the picker flows (Drive picker token), else the linked account is used. */
  token?: string | null;
  /** Extra request headers for 'url' (signed URLs, basic auth). */
  headers?: Record<string, string>;
}

export interface RemoteDescription {
  name: string;
  bytes: number | null;
  mime: string | null;
  /** Server honours Range; without it the fetch is a single stream. */
  ranges: boolean;
  modified?: string | null;
  /** Direct download URL (temporary) when the provider hands one out; the fetcher prefers it. */
  downloadUrl?: string | null;
  downloadHeaders?: Record<string, string>;
}

export interface LocateQuery { name: string; bytes?: number | null; relativePath?: string | null }
export interface LocateHit { ref: RemoteRef; name: string; bytes: number | null; path?: string | null; strength: 'path' | 'name_and_size' | 'name' }

export interface RemoteSource {
  readonly provider: RemoteRef['provider'];
  describe(ref: RemoteRef, auth: Auth | null): Promise<RemoteDescription>;
  /** Only needed when describe() gave no downloadUrl. */
  openRange?(ref: RemoteRef, auth: Auth | null, start: number, endInclusive: number): Promise<Response>;
  /** Linked-account lookup. Absent for 'url'. */
  locate?(q: LocateQuery, auth: Auth): Promise<LocateHit | null>;
}

export interface Auth { accessToken: string }

export class RemoteError extends Error { constructor(msg: string, public status = 502, public retryable = true) { super(msg); } }

export function filenameFromDisposition(cd: string | null, fallback: string): string {
  if (!cd) return fallback;
  const star = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(cd);
  if (star) { try { return decodeURIComponent(star[1].replace(/^"|"$/g, '')); } catch { /* */ } }
  const plain = /filename="?([^";]+)"?/i.exec(cd);
  return plain ? plain[1] : fallback;
}
