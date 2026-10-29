// ============================================================================
//  STORAGE DRIVERS — the only thing that knows where bytes actually live.
//
//  Two drivers, and the difference between them is not a detail:
//
//    LOCAL   this box's disk. There is exactly one tier and it is always
//            readable. Cold and archive tiers DO NOT EXIST here, and pretending
//            otherwise by moving files into a subdirectory would be theatre: it
//            would save nothing, and it would let a deployment believe it had an
//            archive when it had a folder.
//
//    S3      standard, IA, Glacier Instant Retrieval, Glacier Flexible, Deep
//            Archive. The first three serve a byte range immediately; the last
//            two need a restore request and a wait measured in minutes to hours.
//
//  So archiving is OFFERED ONLY when the deployment is on S3 (or an
//  S3-compatible object service) AND archiving is explicitly enabled. On a local
//  deployment the retention ladder is limited to `keep` and `delete`, and a rule
//  that names an archive action is refused at write time with the reason, rather
//  than accepted and silently ignored until the day it should have fired.
//
//  `capabilities()` is the single place that answers what this deployment can
//  do, so the API, the rule validator and the UI all agree.
// ============================================================================
import { config } from '../../config';

export type StorageTier =
  | 'local' | 's3_standard' | 's3_ia' | 's3_glacier_ir'
  | 's3_glacier_flexible' | 's3_deep_archive';

/** Tiers that serve a byte range with no restore step. The line the whole
 *  lifecycle turns on: everything above it is readable, everything below it is
 *  a request and a wait. */
export const IMMEDIATE_TIERS: readonly StorageTier[] =
  ['local', 's3_standard', 's3_ia', 's3_glacier_ir'] as const;

export const ARCHIVE_TIERS: readonly StorageTier[] =
  ['s3_glacier_flexible', 's3_deep_archive'] as const;

export function isImmediate(tier: StorageTier): boolean {
  return IMMEDIATE_TIERS.includes(tier);
}

export type RestoreSpeed = 'expedited' | 'standard' | 'bulk';

/**
 * What a restore of this tier at this speed is expected to take.
 *
 * These are AWS's published windows, and they are expectations rather than
 * guarantees — which is exactly why the object stores `restore_expected_by` and
 * the API says "expected by", never "ready at". Expedited is not offered for
 * Deep Archive because AWS does not offer it.
 */
export function restoreWindowMs(tier: StorageTier, speed: RestoreSpeed): number | null {
  const MIN = 60_000, HOUR = 3_600_000;
  if (tier === 's3_glacier_flexible') {
    if (speed === 'expedited') return 5 * MIN;
    if (speed === 'standard') return 5 * HOUR;
    return 12 * HOUR;                     // bulk
  }
  if (tier === 's3_deep_archive') {
    if (speed === 'expedited') return null;   // not offered by the tier
    if (speed === 'standard') return 12 * HOUR;
    return 48 * HOUR;                     // bulk
  }
  return 0;                               // immediate tiers need no restore
}

export interface StorageCapabilities {
  driver: 'local' | 's3';
  /** Tiers this deployment can actually place bytes on. */
  tiers: StorageTier[];
  /** Whether the archive workflow, and the waiting that comes with it, exists. */
  archiveEnabled: boolean;
  /** Retention actions a rule is allowed to name here. */
  actions: ('keep' | 'to_cold' | 'to_archive' | 'delete')[];
  defaultColdTier: StorageTier | null;
  defaultArchiveTier: StorageTier | null;
  /** Why archiving is unavailable, when it is. Shown to the operator rather than
   *  leaving them to guess why the option is missing. In the customer's words:
   *  account users see it (build queue 1.14-G3a-2). */
  archiveUnavailableReason: string | null;
  /** The server setting behind it, for whoever runs the deployment only
   *  (modules/storage.ts strips it unless seesServerSetup). */
  archiveSetupHint?: string | null;
}

export function capabilities(): StorageCapabilities {
  const driver = config.mediaStore.driver;
  const wanted = config.mediaStore.archiveEnabled;

  if (driver !== 's3') {
    return {
      driver,
      tiers: ['local'],
      archiveEnabled: false,
      actions: ['keep', 'delete'],
      defaultColdTier: null,
      defaultArchiveTier: null,
      archiveUnavailableReason:
        'This Volt service keeps media on a single tier of storage, so a rule can keep or delete. ' +
        'Cheaper storage and archive are not offered here.',
      archiveSetupHint: wanted
        ? 'Archiving is enabled but this deployment stores media on local disk. ' +
          'Cold and archive tiers exist only on S3 or an S3-compatible object service.'
        : 'This deployment stores media on local disk. Cold and archive tiers ' +
          'require S3 or an S3-compatible object service.',
    };
  }

  if (!wanted) {
    return {
      driver, tiers: ['s3_standard'], archiveEnabled: false,
      actions: ['keep', 'delete'],
      defaultColdTier: null, defaultArchiveTier: null,
      archiveUnavailableReason:
        'Cheaper storage and archive are not turned on for this Volt service, so a rule can keep or delete. ' +
        'Your Volt provider can turn them on.',
      archiveSetupHint:
        'Archiving is turned off for this deployment. Set MEDIA_ARCHIVE_ENABLED=true ' +
        'to offer cold and archive tiers, and the restore waiting they involve.',
    };
  }

  return {
    driver,
    tiers: ['s3_standard', 's3_ia', 's3_glacier_ir', 's3_glacier_flexible', 's3_deep_archive'],
    archiveEnabled: true,
    actions: ['keep', 'to_cold', 'to_archive', 'delete'],
    defaultColdTier: config.mediaStore.coldTier,
    defaultArchiveTier: config.mediaStore.archiveTier,
    archiveUnavailableReason: null,
    archiveSetupHint: null,
  };
}

// TIERS AND ACTIONS IN THE CUSTOMER'S WORDS (build queue 1.14-G3a-2). The
// stored names are the cloud provider's storage classes and the API's action
// keys; a message a person reads names what the storage does instead, the same
// words the Storage page uses (volt-web/src/pages/Storage.tsx TIER_LABEL).
export const TIER_WORDS: Record<StorageTier, string> = {
  local: 'Server disk',
  s3_standard: 'Standard',
  s3_ia: 'Infrequent access',
  s3_glacier_ir: 'Archive, instant read',
  s3_glacier_flexible: 'Archive, restore in hours',
  s3_deep_archive: 'Deep archive, restore within two days',
};
export const tierWords = (t: string | null | undefined): string => TIER_WORDS[t as StorageTier] ?? String(t ?? '');
export const ACTION_WORDS: Record<string, string> = {
  keep: 'Keep', to_cold: 'Move to cheaper storage', to_archive: 'Archive', delete: 'Delete',
};
export const actionWords = (a: string): string => ACTION_WORDS[a] ?? a;

// ---------------------------------------------------------------------------
//  The driver interface
// ---------------------------------------------------------------------------
export interface StoredObject {
  uri: string;
  bytes: number;
  tier: StorageTier;
}

export interface RestoreStatus {
  /** True once the bytes can be read without waiting. */
  ready: boolean;
  /** When the tier expects to be ready, if it has not landed yet. */
  expectedBy: Date | null;
  /** When a restored copy lapses back to being archived. */
  expiresAt: Date | null;
}

export interface StorageDriver {
  readonly kind: 'local' | 's3';
  /** Bytes currently at this uri, or null if it is not there. */
  stat(uri: string): Promise<{ bytes: number } | null>;
  /** Move a copy to another tier. Returns where it landed. */
  transition(uri: string, to: StorageTier): Promise<StoredObject>;
  /** Ask for an archived object to be made readable. */
  requestRestore(uri: string, speed: RestoreSpeed): Promise<RestoreStatus>;
  /** Has a requested restore landed? */
  restoreStatus(uri: string): Promise<RestoreStatus>;
  /** Remove the bytes. Idempotent: deleting what is already gone succeeds. */
  remove(uri: string): Promise<void>;
}

// ---------------------------------------------------------------------------
//  Local driver
// ---------------------------------------------------------------------------
import { existsSync, statSync, rmSync } from 'node:fs';

class LocalDriver implements StorageDriver {
  readonly kind = 'local' as const;

  async stat(uri: string) {
    try {
      if (!existsSync(uri)) return null;
      const s = statSync(uri);
      // A run's rendition is a DIRECTORY of segments, not a file. Sizing it is
      // the sum of what is in it, which is what a retention decision is about.
      if (s.isDirectory()) return { bytes: dirBytes(uri) };
      return { bytes: s.size };
    } catch { return null; }
  }

  async transition(_uri: string, to: StorageTier): Promise<StoredObject> {
    throw new Error(
      `Local storage has one tier. Moving media to ${to} needs S3 or an ` +
      `S3-compatible object service.`
    );
  }

  async requestRestore(): Promise<RestoreStatus> {
    // Nothing on local disk is ever archived, so nothing ever needs restoring.
    return { ready: true, expectedBy: null, expiresAt: null };
  }
  async restoreStatus(): Promise<RestoreStatus> {
    return { ready: true, expectedBy: null, expiresAt: null };
  }

  async remove(uri: string): Promise<void> {
    try { rmSync(uri, { recursive: true, force: true }); } catch { /* already gone */ }
  }
}

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
function dirBytes(dir: string): number {
  let total = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    try {
      total += e.isDirectory() ? dirBytes(p) : statSync(p).size;
    } catch { /* a segment can vanish mid-walk on a live run */ }
  }
  return total;
}

// ---------------------------------------------------------------------------
//  Driver selection, and the seam tests use.
// ---------------------------------------------------------------------------
let override: StorageDriver | null = null;

/**
 * Replace the driver, for tests.
 *
 * A test double for S3 is not a fake feature: it stands in for a service that
 * is genuinely external, so the state machine, the ladder and the latency model
 * can all be exercised for real without an AWS account. What it must NOT do is
 * make `capabilities()` claim an archive that a deployment does not have — that
 * comes from configuration, and the double does not touch it.
 */
export function setStorageDriver(d: StorageDriver | null): void { override = d; }

const local = new LocalDriver();
let s3: StorageDriver | null = null;

/**
 * The deployment's driver. On MEDIA_STORE_DRIVER=s3 that is a router: s3://
 * locations go to S3 (services/media/s3Driver.ts), local paths stay local.
 * Until 20 Oct 2026 this returned the local driver whatever the setting, so an
 * S3 deployment's sweep "deleted" s3:// locations with rmSync, which removed
 * nothing.
 */
export function storageDriver(): StorageDriver {
  if (override) return override;
  if (config.mediaStore.driver === 's3') {
    if (!s3) s3 = new RoutingDriver(new S3Driver(() => mediaS3Client(config.aws.region)), local);
    return s3;
  }
  return local;
}

/** The local-disk driver on its own (tests, and the router's fallback). */
export function localDriver(): StorageDriver { return local; }
import { RoutingDriver, S3Driver, mediaS3Client } from './s3Driver';
