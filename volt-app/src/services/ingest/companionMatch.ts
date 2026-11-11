// ============================================================================
//  COMPANIONS IN AN UPLOAD (Christian 8 Nov).
//
//  The Media Library uploader took every file as a programme, so twelve
//  Elephants Dream subtitle files became twelve "videos", each queued to
//  encode. A caption or a metadata sidecar is not an asset of its own: it
//  belongs to a video, exactly as in a watchfolder (watchfolder/
//  companionIngest.ts). This is the uploader's side of the same rule, using
//  the watchfolder's own pieces so the two cannot drift:
//
//    WHAT IS A COMPANION   the watchfolder's extension list (defaults.ts
//                          TYPE_EXTENSIONS: caption and sidecar).
//    WHICH VIDEO           the watchfolder's name rule (prefixFits): the
//                          video's file name without its extension starts the
//                          companion's, ending at a word break, and the
//                          longest such name wins. `Elephants_Dream_zh_tw.vtt`
//                          goes with `Elephants_Dream.mp4`.
//    WHERE IT LOOKS        the videos in the same drop first (same folder
//                          first, when a folder was dropped), then the Media
//                          Library. A companion never matches another
//                          caption or sidecar, and never a library record made
//                          from one (the records the old behaviour created).
//
//  No match is said plainly, never guessed: the panel shows it and the
//  operator attaches it on the asset's Files tab.
// ============================================================================
import { query } from '../../db';
import { typeOfName } from '../watchfolder/defaults';
import { prefixFits, stemOf, COMPANION_MAX_BYTES } from '../watchfolder/companionIngest';

export type CompanionType = 'caption' | 'sidecar';

export interface CompanionPlan {
  type: CompanionType;
  /** Over the companion store's limit: it cannot be attached anywhere. */
  tooBig: boolean;
  /** The video it goes with: one in this same request (by index), or a library asset. */
  match:
    | { in: 'batch'; index: number; name: string }
    | { in: 'library'; assetId: string; title: string | null; originalName: string }
    | null;
  /** Why there is no match, in words for the panel. */
  why: string | null;
}

export interface MatchFile { name: string; bytes?: number | null; relativePath?: string | null }

export function companionType(name: string): CompanionType | null {
  const t = typeOfName(name);
  return t === 'caption' || t === 'sidecar' ? t : null;
}

const dirOf = (p: string) => p.split('/').slice(0, -1).join('/');
const keyOf = (f: MatchFile) => f.relativePath || f.name;

/** Library videos whose file name (without extension) starts this stem. Pure SQL prefix, no LIKE wildcards. */
async function libraryCandidates(accountId: string, stem: string) {
  return query<any>(
    `SELECT id, title, original_filename, created_at
       FROM (SELECT id, title, original_filename, created_at,
                    lower(regexp_replace(regexp_replace(original_filename, '^.*/', ''), '\\.[^.]+$', '')) AS vstem
               FROM vod_assets
              WHERE account_id = $1 AND original_filename IS NOT NULL) v
      WHERE vstem <> '' AND left($2, length(vstem)) = vstem
      ORDER BY length(vstem) DESC, created_at DESC
      LIMIT 25`,
    [accountId, stem.toLowerCase()]);
}

/**
 * One plan per file: null for a file that is not a companion. A pure decision
 * over the batch plus one library lookup per companion.
 */
export async function planCompanions(accountId: string, files: MatchFile[],
  lib: (acct: string, stem: string) => Promise<any[]> = libraryCandidates): Promise<(CompanionPlan | null)[]> {
  const videos = files.map((f, i) => ({ f, i })).filter(({ f }) => !companionType(f.name));
  const out: (CompanionPlan | null)[] = [];
  for (const f of files) {
    const type = companionType(f.name);
    if (!type) { out.push(null); continue; }
    const tooBig = (f.bytes ?? 0) > COMPANION_MAX_BYTES;
    const stem = stemOf(f.name), d = dirOf(keyOf(f));

    // In this drop: longest fitting name, then the same folder.
    const inBatch = videos
      .filter(({ f: v }) => prefixFits(stemOf(v.name), stem))
      .sort((a, b) => stemOf(b.f.name).length - stemOf(a.f.name).length
        || Number(dirOf(keyOf(b.f)) === d) - Number(dirOf(keyOf(a.f)) === d))[0];

    // In the library: never a record made from a caption or sidecar.
    const fromLib = (await lib(accountId, stem))
      .filter((r) => !companionType(String(r.original_filename)) && prefixFits(stemOf(String(r.original_filename)), stem))[0];

    // A longer (more specific) name wins wherever it is; on a tie, this drop
    // wins: the operator is uploading that video now.
    let match: CompanionPlan['match'] = null;
    const bLen = inBatch ? stemOf(inBatch.f.name).length : -1;
    const lLen = fromLib ? stemOf(String(fromLib.original_filename)).length : -1;
    if (inBatch && bLen >= lLen) match = { in: 'batch', index: inBatch.i, name: inBatch.f.name };
    else if (fromLib) match = { in: 'library', assetId: fromLib.id, title: fromLib.title ?? null, originalName: String(fromLib.original_filename) };

    const why = tooBig ? `over the ${COMPANION_MAX_BYTES / 1024 / 1024} MB limit for companion files`
      : match ? null
      : `no video named like it (${stem}) in this upload or the Media Library. Name it after its video (Video_en.vtt for Video.mp4), or attach it on the asset's Files tab.`;
    out.push({ type, tooBig, match: tooBig ? null : match, why });
  }
  return out;
}
