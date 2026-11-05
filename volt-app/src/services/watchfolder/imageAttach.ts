// ============================================================================
//  TYPED IMAGES TO THEIR ASSET (build queue H2b-3, Christian 5 Nov).
//
//  An image the Image Library took in with a type (`Scrubs-s1-e1_poster.png`,
//  or a rule's `imageType`) is in the library at once, whatever happens next:
//  a picture is useful on its own. This pass then makes it that asset's image
//  of that type, exactly as choosing it on the asset page does
//  (assetImageSet.setTypeImage: the Thumbnail is the main image and sets
//  poster_key; the other types are vod_asset_images rows).
//
//  MATCHED LIKE A CAPTION (companionIngest.bestMatch): the video of this
//  folder whose file name the image's name starts with at a word break,
//  longest first, the same subfolder first. One that arrives before its video
//  waits up to 24 hours. After that it stays in the Image Library on its own,
//  with the library kind of its type (poster, keyframe), and the item says no
//  asset matched.
//
//  NEVER REFUSED FOR ITS SHAPE. A poster that is not 2:3 is still the poster
//  someone delivered; the fit warnings the asset page shows (aspect, minimum
//  size) are written on the item too, so the operator sees them where the
//  file was dropped.
// ============================================================================
import { bestMatch, WAIT_MS, type Candidate } from './companionIngest';

export interface WaitingImage {
  id: string | number;
  objectKey: string;
  imageType: string;
  /** The type's name in this account (Poster, Hero backdrop). */
  typeLabel?: string;
  storeKey: string;
  libraryKind: string;
  width: number | null;
  height: number | null;
  seenAt: number;
}

export interface ImageAttachStore {
  candidates(folderId: string): Promise<Candidate[]>;
  /** Set the image as the asset's image of the type. Throws with a status when the type does not fit. */
  setType(a: { assetId: string; accountId: string; typeKey: string; storeKey: string; by: string }): Promise<{ assetTitle: string; typeLabel: string; warnings: string[] }>;
  note(itemId: string | number, state: 'waiting' | 'attached' | 'unmatched', reason: string, assetId?: string | null): Promise<void>;
}

export type ImageAttachOutcome =
  | { result: 'typed'; itemId: string | number; assetId: string }
  | { result: 'waiting'; itemId: string | number; why: string }
  | { result: 'unmatched'; itemId: string | number; why: string };

const base = (key: string) => key.split('/').pop() ?? key;
const KIND_WORDS: Record<string, string> = { poster: 'a poster', keyframe: 'a keyframe', brand: 'a brand image', other: 'an image', slate: 'a slate', watermark: 'a watermark' };

export async function attachTypedImages(
  f: { id: string; accountId: string }, items: WaitingImage[], store: ImageAttachStore, now = Date.now(),
): Promise<ImageAttachOutcome[]> {
  if (!items.length) return [];
  const candidates = await store.candidates(f.id);
  const out: ImageAttachOutcome[] = [];
  for (const it of items) {
    const match = bestMatch(it.objectKey, candidates);
    const stays = `It stays in the Image Library as ${KIND_WORDS[it.libraryKind] ?? 'an image'}.`;
    if (match?.assetId) {
      try {
        const r = await store.setType({ assetId: match.assetId, accountId: f.accountId, typeKey: it.imageType, storeKey: it.storeKey, by: `watchfolder:${f.id}` });
        const warn = r.warnings.length ? ` ${r.warnings.join(' ')}` : '';
        await store.note(it.id, 'attached', `In the Image Library and set as the ${r.typeLabel} of "${r.assetTitle}".${warn}`, match.assetId);
        out.push({ result: 'typed', itemId: it.id, assetId: match.assetId });
      } catch (e: any) {
        // The type is off, or not for this asset's media: said, not retried.
        const why = `Not set on ${base(match.objectKey)}: ${String(e?.message ?? e)}. ${stays}`;
        await store.note(it.id, 'unmatched', why, match.assetId);
        out.push({ result: 'unmatched', itemId: it.id, why });
      }
      continue;
    }
    if (now - it.seenAt >= WAIT_MS) {
      const why = match
        ? `Its video ${base(match.objectKey)} was not taken in within 24 hours, so no asset was matched. ${stays}`
        : `No asset in this folder is named like it after 24 hours, so no asset was matched. ${stays}`;
      await store.note(it.id, 'unmatched', why);
      out.push({ result: 'unmatched', itemId: it.id, why });
      continue;
    }
    const why = match
      ? `In the Image Library; waiting for its video ${base(match.objectKey)} to be taken in, to set it as its ${it.typeLabel ?? it.imageType}`
      : `In the Image Library; waiting for a video named like it (up to 24 hours), to set it as its ${it.typeLabel ?? it.imageType}`;
    await store.note(it.id, 'waiting', why);
    out.push({ result: 'waiting', itemId: it.id, why });
  }
  return out;
}
