// ============================================================================
//  LIBRARY SEARCH: files and folders, one query each.
//
//  Words match as prefixes against the search vector (names, tags, titles,
//  keywords, places, programme names, descriptions, cameras, the path), so
//  "gra fin" finds "Grand Final". Anything the vector cannot see (a fragment
//  in the middle of a file name) is still found by a substring match on the
//  name and path. Results with a vector match rank first.
// ============================================================================

export interface FileFilters {
  q?: string;
  folder?: string;
  recursive?: boolean;
  kind?: string;
  tag?: string;
  source?: string;
  channel?: string;
  /** ISO instants: on captured_at (encoder) or taken_at (photos). */
  from?: string;
  to?: string;
  hasLocation?: boolean;
  near?: { lat: number; lng: number; km: number };
  sort?: 'name' | 'newest' | 'oldest' | 'taken' | 'relevance';
  limit?: number;
  offset?: number;
}

/** Search words -> a prefix tsquery ("grand:* & final:*"), or null. */
export function prefixQuery(q: string): string | null {
  const words = q.toLowerCase().normalize('NFKC').split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 0).slice(0, 12);
  return words.length ? words.map((w) => `${w}:*`).join(' & ') : null;
}

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => '\\' + c);

export interface Built { where: string; params: unknown[]; order: string; limit: number; offset: number }

/** WHERE / ORDER for media_files. $1 is always the account. */
export function buildFileSearch(account: string, f: FileFilters): Built {
  const params: unknown[] = [account];
  const where = ['account_id = $1'];
  const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
  let rank: string | null = null;

  if (f.folder !== undefined) {
    if (f.recursive) {
      if (f.folder) where.push(`(folder = ${p(f.folder)} OR folder LIKE ${p(likeEscape(f.folder) + '/%')})`);
    } else where.push(`folder = ${p(f.folder)}`);
  }
  const term = (f.q ?? '').trim();
  if (term) {
    const tsq = prefixQuery(term);
    const like = p(`%${likeEscape(term)}%`);
    if (tsq) {
      const tq = p(tsq);
      where.push(`(search @@ to_tsquery('simple', ${tq}) OR name ILIKE ${like} OR path ILIKE ${like})`);
      rank = `ts_rank(search, to_tsquery('simple', ${tq}))`;
    } else {
      where.push(`(name ILIKE ${like} OR path ILIKE ${like})`);
    }
  }
  if (f.kind) where.push(`kind = ${p(f.kind)}`);
  if (f.tag) where.push(`(${p(f.tag)} = ANY(tags) OR $${params.length} = ANY(keywords))`);
  // 'library' = everything people put there (uploads + watchfolders), not encoder output
  if (f.source === 'library') where.push(`source <> 'encoder'`);
  else if (f.source) where.push(`source = ${p(f.source)}`);
  if (f.channel) where.push(`channel_id = ${p(f.channel)}`);
  if (f.from) where.push(`COALESCE(captured_at, taken_at, created_at) >= ${p(f.from)}`);
  if (f.to) where.push(`COALESCE(captured_at, taken_at, created_at) < ${p(f.to)}`);
  if (f.hasLocation) where.push(`(gps_lat IS NOT NULL OR location IS NOT NULL)`);
  if (f.near) {
    // bounding box first (index), then the true distance
    const dLat = f.near.km / 111.32;
    const dLng = f.near.km / (111.32 * Math.max(0.01, Math.cos((f.near.lat * Math.PI) / 180)));
    where.push(`gps_lat BETWEEN ${p(f.near.lat - dLat)} AND ${p(f.near.lat + dLat)}`);
    where.push(`gps_lng BETWEEN ${p(f.near.lng - dLng)} AND ${p(f.near.lng + dLng)}`);
    where.push(`6371 * 2 * asin(sqrt(power(sin(radians(gps_lat - ${p(f.near.lat)}) / 2), 2) +
      cos(radians($${params.length})) * cos(radians(gps_lat)) * power(sin(radians(gps_lng - ${p(f.near.lng)}) / 2), 2))) <= ${p(f.near.km)}`);
  }

  const order =
    f.sort === 'newest' ? 'COALESCE(captured_at, taken_at, created_at) DESC, name'
    : f.sort === 'oldest' ? 'COALESCE(captured_at, taken_at, created_at), name'
    : f.sort === 'taken' ? 'taken_at DESC NULLS LAST, name'
    : (f.sort === 'relevance' || (!f.sort && rank)) && rank ? `${rank} DESC, folder, name`
    : 'folder, name';
  const limit = Math.min(Math.max(1, f.limit ?? 500), 2000);
  const offset = Math.max(0, f.offset ?? 0);
  return { where: where.join(' AND '), params, order, limit, offset };
}

/** Folder paths matching `q` (any segment), with every ancestor kept for context. */
export function matchFolders(paths: string[], q: string, max = 200): string[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const hits = paths.filter((p) => { const l = p.toLowerCase(); return words.every((w) => l.includes(w)); });
  return hits.sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b)).slice(0, max);
}

/** Immediate children of `parent` ('' = root) from a set of folder paths. */
export function childFolders(paths: string[], parent: string): string[] {
  const pre = parent ? parent + '/' : '';
  const out = new Set<string>();
  for (const p of paths) {
    if (parent && !p.startsWith(pre)) continue;
    const rest = p.slice(pre.length);
    if (!rest) continue;
    out.add(pre + rest.split('/')[0]);
  }
  return [...out].sort();
}
