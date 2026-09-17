// ============================================================================
//  DUPLICATES — two checks, one decision function.
//
//  BY NAME at pick time: cheap, before any byte moves, while the operator is
//  still looking at the list. It matches the sanitised name AND the original
//  name behind a GUID, otherwise renaming would hide every repeat.
//
//  BY CONTENT at verify time: the SHA-256 the assembly already computed. This
//  is the one that is actually true; a name match is a hint and a size match
//  is a weaker hint. The panel words them differently for that reason.
//
//  The decision is pure so the panel, the watchfolder and the API preview all
//  reach the same answer from the same inputs.
// ============================================================================
import type { DuplicateAction } from './rules';
import { splitExt } from './naming';

export interface ExistingAsset {
  id: string;
  name: string | null;            // current object name
  originalName?: string | null;
  bytes?: number | null;
  sha256?: string | null;
}

export type MatchStrength = 'content' | 'name_and_size' | 'name' | 'size';

export interface Match {
  strength: MatchStrength;
  asset: ExistingAsset;
}

/** Find the strongest match for a candidate among existing assets. */
export function findMatch(
  cand: { name: string; sanitisedName?: string | null; bytes?: number | null; sha256?: string | null },
  existing: ExistingAsset[]
): Match | null {
  const names = new Set([cand.name, cand.sanitisedName ?? ''].filter(Boolean).map((n) => n.toLowerCase()));
  let best: Match | null = null;
  const rank: Record<MatchStrength, number> = { content: 4, name_and_size: 3, name: 2, size: 1 };
  for (const a of existing) {
    let s: MatchStrength | null = null;
    if (cand.sha256 && a.sha256 && cand.sha256 === a.sha256) s = 'content';
    else {
      const nameHit = [a.name, a.originalName].some((n) => n && names.has(n.toLowerCase()));
      const sizeHit = cand.bytes != null && a.bytes != null && cand.bytes === a.bytes;
      if (nameHit && sizeHit) s = 'name_and_size';
      else if (nameHit) s = 'name';
      else if (sizeHit && cand.bytes != null && cand.bytes > 64 * 1024 * 1024) s = 'size';  // only large files, a 3 KB match means nothing
    }
    if (s && (!best || rank[s] > rank[best.strength])) best = { strength: s, asset: a };
  }
  return best;
}

export type Decision =
  | { outcome: 'proceed'; match: Match | null }
  | { outcome: 'skip'; match: Match }
  | { outcome: 'replace'; match: Match }
  | { outcome: 'version'; match: Match; name: string }
  | { outcome: 'rename'; match: Match; name: string }
  | { outcome: 'ask'; match: Match };

/**
 * Turn a match into what happens. Only a CONTENT match, or a name-and-size
 * match at pick time (when no content hash exists yet), is treated as a
 * duplicate. A bare name or size match is reported but proceeds: it is a
 * hint for the panel, not proof.
 */
export function decideDuplicate(
  action: DuplicateAction,
  match: Match | null,
  candidateName: string,
  taken: Set<string> = new Set()
): Decision {
  if (!match) return { outcome: 'proceed', match: null };
  const certain = match.strength === 'content' || match.strength === 'name_and_size';
  if (!certain) return { outcome: 'proceed', match };
  switch (action) {
    case 'skip': return { outcome: 'skip', match };
    case 'replace': return { outcome: 'replace', match };
    case 'version': return { outcome: 'version', match, name: nextFree(candidateName, taken, '_v') };
    case 'rename': return { outcome: 'rename', match, name: nextFree(candidateName, taken, '_') };
    case 'ask':
    default: return { outcome: 'ask', match };
  }
}

/** first free of name_v2, name_v3 ... (or name_2 ...) against a set of taken names. */
export function nextFree(name: string, taken: Set<string>, sep: string): string {
  const { base, ext } = splitExt(name);
  const stripped = base.replace(new RegExp(`${sep}\\d+$`), '');
  for (let n = 2; n < 10_000; n++) {
    const c = `${stripped}${sep}${n}${ext}`;
    if (!taken.has(c) && c !== name) return c;
  }
  return `${stripped}${sep}${Date.now()}${ext}`;
}
