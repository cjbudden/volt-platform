import { query } from '../db';

/* ============================================================================
   WHICH IMAGE A CHANNEL CARRIES IN THE GUIDE.

   One logo set once should be enough, so the guide uses the channel's (or
   station's) own brand image unless someone has set a guide icon on purpose.
   An imported feed's icon only fills in when we have no image of our own: once
   a feed channel is linked to a Volt channel, the guide shows OUR brand, not
   the feed provider's copy of it.

     1. guide_icon_ref   set by hand for the guide only
     2. brand_ref        the channel / station image
     3. feed icon        the <icon> of a linked, imported XMLTV channel
     4. metadata logo    a logo in the content type's metadata
   ========================================================================== */
export type GuideIconFrom = 'guide' | 'brand' | 'feed' | 'metadata';

export interface GuideIconInputs {
  guideIconRef?: string | null;
  brandRef?: string | null;
  feedIcon?: string | null;
  metadataIcon?: string | null;
}

export function pickGuideIcon(i: GuideIconInputs): { ref: string; from: GuideIconFrom } | null {
  const order: [GuideIconFrom, string | null | undefined][] = [
    ['guide', i.guideIconRef], ['brand', i.brandRef], ['feed', i.feedIcon], ['metadata', i.metadataIcon],
  ];
  for (const [from, ref] of order) {
    const r = typeof ref === 'string' ? ref.trim() : '';
    if (r) return { ref: r, from };
  }
  return null;
}

/** The most recently seen feed icon of each channel's linked import aliases. */
export async function feedIconsFor(channelIds: string[]): Promise<Map<string, string>> {
  if (!channelIds.length) return new Map();
  const rows = await query<{ channel_id: string; icon: string }>(
    `SELECT DISTINCT ON (channel_id) channel_id, icon
       FROM epg_channel_aliases
      WHERE channel_id = ANY($1::uuid[]) AND icon IS NOT NULL AND icon <> ''
      ORDER BY channel_id, last_seen_at DESC NULLS LAST`,
    [channelIds],
  );
  return new Map(rows.map((r) => [r.channel_id, r.icon]));
}
