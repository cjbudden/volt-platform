// ============================================================================
//  TRANSFER PROVIDERS — accelerated and secure file movers as plugins.
//
//  A provider replaces the TRANSFER stage only. It is asked to set up a
//  transfer to a destination Volt controls, hands back what the operator's
//  side needs to launch it (an Aspera transfer spec for the desktop client, a
//  MASV or Signiant portal link, presigned S3 URLs), and later tells Volt the
//  files have landed. From there the ingest pipeline runs unchanged: rules,
//  naming, duplicates, metadata, sidecar, webhooks.
//
//  Every provider takes an injected fetch and is tested against a fake, so
//  the request shapes are pinned even where a live account is not to hand.
// ============================================================================
export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface TransferFile { name: string; bytes?: number | null; relativePath?: string | null }

export interface TransferDestination {
  /** Where the provider is told to put the files: a path on an Aspera node, an S3 prefix, a portal. */
  kind: 'node_path' | 's3' | 'portal';
  root: string;
  /** Sub-folder for this transfer so landed files are unambiguous. */
  folder: string;
}

export type Launch =
  | { kind: 'aspera_spec'; transferSpec: Record<string, any>; note: string }
  | { kind: 'portal'; url: string; note: string }
  | { kind: 'presigned'; uploads: { name: string; url: string; method: 'PUT'; headers?: Record<string, string> }[]; note: string }
  | { kind: 'none'; note: string };

export interface CreatedTransfer {
  externalId: string | null;
  destination: TransferDestination;
  launch: Launch;
  /** Provider-specific state worth keeping (upload ids, package ids). */
  spec?: Record<string, any>;
}

export interface TransferEvent {
  externalId: string | null;
  state: 'running' | 'landed' | 'failed' | 'cancelled';
  progress?: { bytes?: number; pct?: number } | null;
  /** Paths as the provider reports them, relative to the destination folder. */
  files?: { name: string; path?: string | null; bytes?: number | null }[];
  error?: string | null;
}

export interface ProviderCredentials { config: Record<string, any>; accessToken?: string | null }

export interface TransferProvider {
  readonly key: 'aspera' | 'masv' | 'signiant' | 's3accel';
  createTransfer(files: TransferFile[], dest: TransferDestination, creds: ProviderCredentials, ctx: { transferId: string; accountId: string; callbackUrl: string }): Promise<CreatedTransfer>;
  /** Interpret the provider's webhook body (or a poll result) into a TransferEvent. Return null if it is not about a transfer. */
  parseEvent(body: any, headers: Record<string, string>, creds: ProviderCredentials): TransferEvent | null;
  /** Optional: ask the provider where a transfer is. */
  poll?(externalId: string, creds: ProviderCredentials): Promise<TransferEvent>;
}

export class ProviderError extends Error { constructor(msg: string, public status = 502) { super(msg); } }
