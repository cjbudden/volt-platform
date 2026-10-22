// ============================================================================
//  MEDIA LIBRARY ROWS: the one way an image becomes a media_files row.
//
//  Uploads, watchfolders and the encoder's thumbnails all land here, so every
//  image in the library carries the same facts: dimensions, checksum, the
//  metadata the file holds (EXIF, GPS, IPTC, XMP) and where it came from.
//  The search vector is kept by a database trigger (migration 0049).
// ============================================================================
import { one, query } from '../db';
import type { ImageFacts } from './images/metadata';

/** auto: chosen or fetched by Volt for an asset (posters, album covers, imported station icons). */
export type MediaSource = 'upload' | 'watchfolder' | 'encoder' | 'auto';

export interface MediaRowInput {
  accountId: string;
  kind: string;
  path: string;
  folder: string;
  name: string;
  storeKey: string;
  sizeBytes: number;
  contentType: string | null;
  tags?: string[];
  userId?: string | null;
  source: MediaSource;
  channelId?: string | null;
  capturedAt?: Date | null;
  /** Extracted facts; encoder frames pass the few they know. */
  facts?: Partial<ImageFacts>;
  /** Merged into metadata (e.g. { channel, programme } for encoder frames). */
  extra?: Record<string, unknown>;
}

const COLS = `account_id, kind, path, folder, name, content_type, size_bytes, width, height, tags, store_key,
  created_by, updated_by, source, channel_id, captured_at, taken_at, gps_lat, gps_lng, gps_alt, location,
  camera, title, description, keywords, creator, copyright, checksum, metadata`;

function values(m: MediaRowInput): unknown[] {
  const f = m.facts ?? {};
  return [
    m.accountId, m.kind, m.path, m.folder, m.name, f.contentType ?? m.contentType, m.sizeBytes,
    f.width ?? null, f.height ?? null, m.tags ?? [], m.storeKey, m.userId ?? null,
    m.source, m.channelId ?? null, m.capturedAt ?? null, f.takenAt ?? null,
    f.gpsLat ?? null, f.gpsLng ?? null, f.gpsAlt ?? null, f.location ?? null,
    f.camera ?? null, f.title ?? null, f.description ?? null, f.keywords ?? [], f.creator ?? null,
    f.copyright ?? null, f.checksum ?? null, JSON.stringify({ ...(f.metadata ?? {}), ...(m.extra ?? {}) }),
  ];
}
const PLACEHOLDERS = '$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28::jsonb';

/** Insert a row. Throws on a path clash (unique account_id + path). */
export async function insertMediaRow(m: MediaRowInput): Promise<any> {
  return one(`INSERT INTO media_files (${COLS}) VALUES (${PLACEHOLDERS}) RETURNING *`, values(m));
}

/** Insert, or replace the row at the same path (encoder outputs are re-written). */
export async function upsertMediaRow(m: MediaRowInput): Promise<any> {
  return one(
    `INSERT INTO media_files (${COLS}) VALUES (${PLACEHOLDERS})
     ON CONFLICT (account_id, path) DO UPDATE SET
       content_type = EXCLUDED.content_type, size_bytes = EXCLUDED.size_bytes,
       width = EXCLUDED.width, height = EXCLUDED.height, store_key = EXCLUDED.store_key,
       captured_at = EXCLUDED.captured_at, checksum = EXCLUDED.checksum,
       metadata = EXCLUDED.metadata, version = media_files.version + 1, updated_at = now()
     RETURNING *`, values(m));
}

/** Re-read a stored file's metadata (backfill, or after a better extractor). */
export async function refreshMediaFacts(id: string, facts: ImageFacts): Promise<any> {
  return one(
    `UPDATE media_files SET
       content_type = COALESCE($2, content_type), width = COALESCE($3, width), height = COALESCE($4, height),
       taken_at = $5, gps_lat = $6, gps_lng = $7, gps_alt = $8, location = $9, camera = $10,
       title = COALESCE(title, $11), description = COALESCE(description, $12),
       keywords = CASE WHEN cardinality(keywords) = 0 THEN $13 ELSE keywords END,
       creator = $14, copyright = $15, checksum = $16,
       metadata = metadata || $17::jsonb, updated_at = now()
     WHERE id = $1 RETURNING *`,
    [id, facts.contentType, facts.width, facts.height, facts.takenAt, facts.gpsLat, facts.gpsLng, facts.gpsAlt,
     facts.location, facts.camera, facts.title, facts.description, facts.keywords, facts.creator,
     facts.copyright, facts.checksum, JSON.stringify(facts.metadata)]);
}

/** Rows still missing extracted metadata (no checksum yet), oldest first. */
export async function rowsNeedingFacts(accountId: string, limit: number): Promise<{ id: string; store_key: string }[]> {
  return query(`SELECT id, store_key FROM media_files WHERE account_id = $1 AND checksum IS NULL AND source <> 'encoder'
                 ORDER BY created_at LIMIT $2`, [accountId, limit]);
}
