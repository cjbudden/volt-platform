// ============================================================================
//  CONTENT TYPES — the standard metadata schemas every client account has.
//
//  A content type is a row in metadata_schemas. The standard ones are seeded
//  per account from the table below, idempotently by `standard_key`, and are
//  based on the schema.org types Christian asked for: a radio station and a
//  TV channel get one each (RadioStation / TelevisionChannel, with the
//  BroadcastService fields), events get a family (BroadcastEvent as the base,
//  and a town hall, a worship service, a sports match and a multi-sport event
//  extending it), and on-demand assets get Clip and Episode.
//
//  RULES the rest of the platform leans on:
//   - a radio station, a TV channel and an event ALWAYS have a type. Create
//     defaults it from this table when none is given; PATCH refuses to clear
//     it. The type's metadata is the BASE ENTRY: what the public now/next and
//     the schema.org output fall back to when no EPG programme is on.
//   - a derived asset (clip, auto-VOD, export) INHERITS the owner's type and a
//     copy of its metadata, so the standard owner types bind with
//     target_kind 'any'.
//   - each field may carry `epg`, the EPG field its value lands in when a
//     programme is created from the owner (see DESIGN_epg_xmltv.md).
//
//  Standard types are editable (fields can be added, relabelled, made
//  required) and cloneable, and never deleted while anything is assigned to
//  them. The seed only ever INSERTS a missing standard; it never rewrites a
//  standard a client has changed.
// ============================================================================
import { query, one } from '../db';
import type { SchemaField } from './metadataValidator';

export type OwnerKind = 'radio' | 'tv' | 'event' | 'vod';

export interface StandardType {
  key: string;
  name: string;
  description: string;
  schemaOrgType: string;
  targetKind: 'vod' | 'event' | 'channel' | 'any';
  appliesTo: OwnerKind[];
  domain?: string;
  extendsKey?: string;
  fields: SchemaField[];
}

const f = (key: string, label: string, type: SchemaField['type'], extra: Partial<SchemaField> = {}): SchemaField =>
  ({ key, label, type, ...extra });

const GENRES = ['News', 'Talk', 'Sport', 'Music', 'Classical', 'Jazz', 'Rock', 'Pop', 'Dance', 'Community', 'Religious', 'Education', 'Entertainment', 'Drama', 'Documentary', 'Children', 'Other'];

/** Broadcast identity shared by a station and a channel (schema.org BroadcastService). */
const BROADCAST_SERVICE: SchemaField[] = [
  f('name', 'Name', 'string', { required: true, epg: 'title', schemaOrg: 'name' }),
  f('description', 'Description', 'text', { epg: 'description', schemaOrg: 'description' }),
  f('genre', 'Genre', 'enum', { options: GENRES, multiple: true, epg: 'category', schemaOrg: 'genre' }),
  f('language', 'Language', 'string', { epg: 'language', schemaOrg: 'inLanguage' }),
  f('broadcaster', 'Broadcaster', 'string', { schemaOrg: 'broadcaster' }),
  f('logo', 'Logo', 'url', { epg: 'icon', schemaOrg: 'logo' }),
  f('area', 'Broadcast area', 'string', { schemaOrg: 'areaServed' }),
  f('website', 'Website', 'url', { schemaOrg: 'url' }),
];

export const STANDARD_TYPES: StandardType[] = [
  {
    key: 'radio-station', name: 'Radio station',
    description: 'The base identity of a radio station: what the guide and the public now/next show when no programme is scheduled.',
    schemaOrgType: 'RadioStation', targetKind: 'any', appliesTo: ['radio'], domain: 'broadcast',
    fields: [...BROADCAST_SERVICE, f('frequency', 'Frequency / DAB', 'string', { schemaOrg: 'broadcastFrequency' }), f('format', 'Station format', 'string')],
  },
  {
    key: 'tv-channel', name: 'TV channel',
    description: 'The base identity of a television channel: what the guide and the public now/next show when no programme is scheduled.',
    schemaOrgType: 'TelevisionChannel', targetKind: 'any', appliesTo: ['tv'], domain: 'broadcast',
    fields: [...BROADCAST_SERVICE, f('channelNumber', 'Channel number', 'string', { schemaOrg: 'broadcastChannelId' })],
  },
  {
    key: 'broadcast-event', name: 'Broadcast event',
    description: 'A live event with no more specific type: name, what it is, who is putting it on and where.',
    schemaOrgType: 'BroadcastEvent', targetKind: 'any', appliesTo: ['event'], domain: 'events',
    fields: [
      f('name', 'Event name', 'string', { required: true, epg: 'title', schemaOrg: 'name' }),
      f('description', 'Description', 'text', { epg: 'description', schemaOrg: 'description' }),
      f('category', 'Category', 'enum', { options: GENRES, epg: 'category', schemaOrg: 'genre' }),
      f('organizer', 'Organiser', 'string', { epg: 'credits.producer', schemaOrg: 'organizer' }),
      f('location', 'Location', 'string', { schemaOrg: 'location' }),
      f('performers', 'Performers / presenters', 'tags', { epg: 'credits.presenter', schemaOrg: 'performer' }),
      f('language', 'Language', 'string', { epg: 'language', schemaOrg: 'inLanguage' }),
      f('image', 'Image', 'url', { epg: 'icon', schemaOrg: 'image' }),
    ],
  },
  {
    key: 'town-hall', name: 'Town hall / conference',
    description: 'A meeting or conference with named speakers and an agenda.',
    schemaOrgType: 'BusinessEvent', targetKind: 'any', appliesTo: ['event'], domain: 'civic', extendsKey: 'broadcast-event',
    fields: [
      f('speakers', 'Speakers', 'tags', { epg: 'credits.presenter', schemaOrg: 'performer' }),
      f('agenda', 'Agenda', 'text', { epg: 'description' }),
      f('host', 'Host organisation', 'string', { schemaOrg: 'organizer' }),
    ],
  },
  {
    key: 'worship-service', name: 'Worship service',
    description: 'A church or other religious service.',
    schemaOrgType: 'Event', targetKind: 'any', appliesTo: ['event'], domain: 'worship', extendsKey: 'broadcast-event',
    fields: [
      f('congregation', 'Congregation / church', 'string', { schemaOrg: 'organizer' }),
      f('officiant', 'Officiant', 'string', { epg: 'credits.presenter' }),
      f('readings', 'Readings', 'tags'),
      f('hymns', 'Hymns / music', 'tags'),
    ],
  },
  {
    key: 'sports-match', name: 'Sports match',
    description: 'A single fixture between two sides.',
    schemaOrgType: 'SportsEvent', targetKind: 'any', appliesTo: ['event'], domain: 'sports', extendsKey: 'broadcast-event',
    fields: [
      f('sport', 'Sport', 'string', { required: true, epg: 'category', schemaOrg: 'sport' }),
      f('competition', 'Competition', 'string', { epg: 'sub-title', schemaOrg: 'superEvent' }),
      f('homeTeam', 'Home team', 'reference', { refDomain: 'sports-team', epg: 'credits.actor', schemaOrg: 'homeTeam' }),
      f('awayTeam', 'Away team', 'reference', { refDomain: 'sports-team', epg: 'credits.actor', schemaOrg: 'awayTeam' }),
      f('venue', 'Venue', 'string', { schemaOrg: 'location' }),
      f('round', 'Round / matchday', 'string', { epg: 'episode' }),
      f('commentators', 'Commentators', 'tags', { epg: 'credits.commentator' }),
    ],
  },
  {
    key: 'multi-sport-event', name: 'Multi-sport event',
    description: 'A multi-day event with many sessions across sports; each session is its own match or programme.',
    schemaOrgType: 'SportsEvent', targetKind: 'any', appliesTo: ['event'], domain: 'sports', extendsKey: 'broadcast-event',
    fields: [
      f('sports', 'Sports', 'tags', { epg: 'category', schemaOrg: 'sport' }),
      f('edition', 'Edition', 'string', { epg: 'sub-title' }),
      f('venues', 'Venues', 'tags', { schemaOrg: 'location' }),
      f('days', 'Number of days', 'number'),
    ],
  },
  {
    key: 'clip', name: 'Clip / highlight',
    description: 'A short piece cut from a recording.',
    schemaOrgType: 'VideoObject', targetKind: 'vod', appliesTo: ['vod'], domain: 'ondemand',
    fields: [
      f('headline', 'Headline', 'string', { epg: 'title', schemaOrg: 'headline' }),
      f('description', 'Description', 'text', { epg: 'description', schemaOrg: 'description' }),
      f('keywords', 'Keywords', 'tags', { schemaOrg: 'keywords' }),
      f('thumbnail', 'Thumbnail', 'url', { epg: 'icon', schemaOrg: 'thumbnailUrl' }),
    ],
  },
  {
    key: 'episode', name: 'Programme / episode',
    description: 'An on-demand programme that belongs to a series.',
    schemaOrgType: 'Episode', targetKind: 'vod', appliesTo: ['vod'], domain: 'ondemand',
    fields: [
      f('title', 'Title', 'string', { required: true, epg: 'title', schemaOrg: 'name' }),
      f('series', 'Series', 'string', { epg: 'sub-title', schemaOrg: 'partOfSeries' }),
      f('season', 'Season', 'number', { schemaOrg: 'partOfSeason' }),
      f('episodeNumber', 'Episode number', 'number', { epg: 'episode', schemaOrg: 'episodeNumber' }),
      f('description', 'Description', 'text', { epg: 'description', schemaOrg: 'description' }),
      f('genre', 'Genre', 'enum', { options: GENRES, multiple: true, epg: 'category', schemaOrg: 'genre' }),
      f('image', 'Image', 'url', { epg: 'icon', schemaOrg: 'image' }),
    ],
  },
];

/** The standard type an owner gets when none is chosen. */
export const DEFAULT_TYPE_KEY: Record<OwnerKind, string> = {
  radio: 'radio-station', tv: 'tv-channel', event: 'broadcast-event', vod: 'clip',
};

/**
 * Make sure the account has every standard type, and that every owner that
 * must have a type has one. Idempotent and cheap once seeded (one SELECT).
 * Never rewrites a standard the client has edited.
 */
export async function ensureStandardTypes(accountId: string): Promise<void> {
  const have = await query<{ standard_key: string; id: string }>(
    `SELECT standard_key, id FROM metadata_schemas WHERE account_id = $1 AND standard_key IS NOT NULL`, [accountId]);
  const ids = new Map(have.map((r) => [r.standard_key, r.id]));
  if (ids.size < STANDARD_TYPES.length) {
    // parents before children so extends_id can be resolved in one pass
    for (const t of STANDARD_TYPES) {
      if (ids.has(t.key)) continue;
      const parent = t.extendsKey ? ids.get(t.extendsKey) ?? null : null;
      // A client may already have a schema of the same NAME: the unique is on
      // name, so the standard is suffixed rather than the seed failing.
      const clash = await one<any>(`SELECT id FROM metadata_schemas WHERE account_id = $1 AND name = $2`, [accountId, t.name]);
      const name = clash ? `${t.name} (standard)` : t.name;
      const row = await one<{ id: string }>(
        `INSERT INTO metadata_schemas(account_id, name, description, fields, target_kind, domain, extends_id,
                                      is_standard, standard_key, schema_org_type, applies_to)
         VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,true,$8,$9,$10)
         ON CONFLICT DO NOTHING RETURNING id`,
        [accountId, name, t.description, JSON.stringify(t.fields), t.targetKind, t.domain ?? null, parent,
         t.key, t.schemaOrgType, t.appliesTo]);
      if (row) ids.set(t.key, row.id);
    }
  }
  // Owners that predate the rule get the default for their kind.
  const radio = ids.get('radio-station'), tv = ids.get('tv-channel'), ev = ids.get('broadcast-event');
  if (radio) await query(
    `UPDATE channels c SET schema_id = $2 FROM groups g
      WHERE g.id = c.group_id AND g.account_id = $1 AND c.kind = 'radio' AND c.schema_id IS NULL`, [accountId, radio]);
  if (tv) await query(
    `UPDATE channels c SET schema_id = $2 FROM groups g
      WHERE g.id = c.group_id AND g.account_id = $1 AND c.kind IS DISTINCT FROM 'radio' AND c.schema_id IS NULL`, [accountId, tv]);
  if (ev) await query(
    `UPDATE events e SET schema_id = $2 FROM groups g
      WHERE g.id = e.group_id AND g.account_id = $1 AND e.schema_id IS NULL`, [accountId, ev]);
}

/** The id of a standard type for this account (seeding if needed). */
export async function standardTypeId(accountId: string, key: string): Promise<string | null> {
  await ensureStandardTypes(accountId);
  const row = await one<{ id: string }>(
    `SELECT id FROM metadata_schemas WHERE account_id = $1 AND standard_key = $2`, [accountId, key]);
  return row?.id ?? null;
}

export async function defaultTypeId(accountId: string, kind: OwnerKind): Promise<string | null> {
  return standardTypeId(accountId, DEFAULT_TYPE_KEY[kind]);
}

/**
 * The metadata an asset derived from an owner starts with: the owner's type
 * and a copy of its values. Copied, not referenced, so the asset can be edited
 * on its own and a later change to the owner does not rewrite history.
 */
export async function inheritedMetadata(ownerCol: 'channel_id' | 'event_id', ownerId: string):
  Promise<{ schemaId: string | null; metadata: Record<string, any> }> {
  const table = ownerCol === 'channel_id' ? 'channels' : 'events';
  const row = await one<any>(`SELECT schema_id, metadata FROM ${table} WHERE id = $1`, [ownerId]);
  return { schemaId: row?.schema_id ?? null, metadata: (row?.metadata && typeof row.metadata === 'object') ? row.metadata : {} };
}

// ---- EPG field mapping ------------------------------------------------------
//
//  A field's `epg` names the EPG slot its value lands in when a programme is
//  made from the owner: title | sub-title | description | category | episode
//  | language | icon | credits.<role> | custom:<name>. `programmeFieldsFrom`
//  turns an owner's metadata into the programme columns + metadata the EPG
//  stores, using the effective field list of its type.
export const EPG_SLOTS = ['title', 'sub-title', 'description', 'category', 'episode', 'language', 'icon'] as const;
export const EPG_SLOT_RX = /^(title|sub-title|description|category|episode|language|icon|credits\.[a-z-]+|custom:[a-zA-Z0-9_-]+)$/;

export interface ProgrammeFields {
  title?: string;
  subTitle?: string;
  description?: string;
  categories: string[];
  episode?: string;
  language?: string;
  icon?: string;
  credits: { role: string; name: string }[];
  custom: Record<string, any>;
}

export function programmeFieldsFrom(fields: SchemaField[], metadata: Record<string, any>): ProgrammeFields {
  const out: ProgrammeFields = { categories: [], credits: [], custom: {} };
  const str = (v: any) => Array.isArray(v) ? v.map(String).join(', ') : v == null ? undefined : String(typeof v === 'object' && v.name ? v.name : v);
  const list = (v: any) => (Array.isArray(v) ? v : v == null ? [] : [v]).map((x) => (typeof x === 'object' && x?.name) ? String(x.name) : String(x));
  for (const fld of fields) {
    const slot = fld.epg;
    if (!slot) continue;
    const v = metadata[fld.key];
    if (v == null || v === '' || (Array.isArray(v) && !v.length)) continue;
    if (slot === 'title') out.title = str(v);
    else if (slot === 'sub-title') out.subTitle = str(v);
    else if (slot === 'description') out.description = out.description ? `${out.description}\n${str(v)}` : str(v);
    else if (slot === 'category') out.categories.push(...list(v));
    else if (slot === 'episode') out.episode = str(v);
    else if (slot === 'language') out.language = str(v);
    else if (slot === 'icon') out.icon = str(v);
    else if (slot.startsWith('credits.')) for (const n of list(v)) out.credits.push({ role: slot.slice(8), name: n });
    else if (slot.startsWith('custom:')) out.custom[slot.slice(7)] = v;
  }
  return out;
}
