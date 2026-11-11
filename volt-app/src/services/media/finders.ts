// ============================================================================
//  Which "Find details" an asset gets (build queue F1).
//
//  ONE PLACE says which content type uses which finder. A specialist service
//  comes first for the types it knows (the song service for Songs and Music
//  videos: MusicBrainz, Apple, a pasted page). Every other type, including
//  any an account adds later, gets the general finder (Wikidata,
//  services/media/wikidataLookup.ts). A specialist built later for, say,
//  Movies is one line here and replaces the general finder for that type only.
// ============================================================================
import type { SchemaField } from '../metadataValidator';

export type FinderKind = 'song' | 'general';

/** By standard type key. A type copied from a standard keeps the general finder (it has no standard key). */
const SPECIALIST: Record<string, FinderKind> = {
  song: 'song',
  // A music video's details are the song's (album, release date, ISRC, label,
  // genre); its picture stays a frame of the video, the album cover only offered.
  'music-video': 'song',
};

export function finderFor(standardKey: string | null | undefined): FinderKind {
  return (standardKey && SPECIALIST[standardKey]) || 'general';
}

/**
 * What to search for by default: the value of the type's title field (the
 * field that becomes the guide title, or else schema.org `name`), else the
 * asset's title. The person can change it before searching.
 */
export function titleTerm(fields: SchemaField[], metadata: Record<string, any> | null | undefined, assetTitle: string | null | undefined): string {
  const m = metadata ?? {};
  const f = fields.find((x) => x.epg === 'title') ?? fields.find((x) => x.schemaOrg === 'name');
  const v = f ? m[f.key] : null;
  const s = typeof v === 'string' ? v.trim() : Array.isArray(v) ? v.join(' ').trim() : '';
  return s || String(assetTitle ?? '').trim();
}
