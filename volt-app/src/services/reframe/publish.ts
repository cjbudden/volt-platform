// ============================================================================
//  REFRAME ON PUBLISH: the file a social platform receives.
//
//  Admin > Formats and reframing maps each platform to a format (TikTok to
//  9:16, Facebook to 1:1 ...). When a publication goes out, the upload is that
//  format's file, rendered there and then if it is missing or stale. A format
//  that must be approved and is not stops the publication with a reason that
//  says where to approve it, rather than quietly sending the 16:9 picture to a
//  vertical platform.
// ============================================================================
import { existsSync } from 'node:fs';
import { FORMATS, type FormatKey } from './formats';
import { assetWithAccount, formatRow, localPath, settingsFor, tracksRow } from './store';

export class ReframeNotReady extends Error {
  constructor(message: string) { super(message); this.name = 'ReframeNotReady'; }
}

const PLATFORM_LABEL: Record<string, string> = { youtube: 'YouTube', tiktok: 'TikTok', facebook: 'Facebook', x: 'X', dailymotion: 'Dailymotion' };

/**
 * The local path of the file to upload for this platform, or null when the
 * platform takes the source framing (the caller then uses the asset's own MP4).
 */
export async function formatMediaFor(asset: any, platform: string, progress: (pct: number, stage: string) => Promise<void> | void): Promise<string | null> {
  // The owner through the channel or event, or the asset's own account for an
  // upload: the caller's row may carry either, so ask once, properly.
  const owner = (await assetWithAccount(asset.id))?.owner_account ?? null;
  const settings = await settingsFor(owner);
  const fmt = settings.targets[platform];
  if (!settings.renderOnPublish || !fmt || fmt === '16x9') return null;
  const f = fmt as FormatKey;
  const ratio = FORMATS[f].ratio;
  const who = PLATFORM_LABEL[platform] ?? platform;
  const { analyseAsset, renderFormat, ReframeError } = await import('../jobs/handlers/reframe');
  try {
    let row = await formatRow(asset.id, f);
    if (!row) {
      if (settings.requireApproval) {
        throw new ReframeNotReady(`${who} receives the ${ratio} version, and this asset has none yet. Open its Formats tab to analyse and approve it, or send ${who} the 16:9 version in Admin > Formats and reframing.`);
      }
      const tr = await tracksRow(asset.id);
      if (!tr || tr.state !== 'ready') {
        await progress(3, `analysing the picture for ${ratio}`);
        await analyseAsset(asset.id);
      }
      row = await formatRow(asset.id, f);
      if (!row) throw new ReframeNotReady(`The ${ratio} framing could not be made for this asset.`);
    }
    if (settings.requireApproval && row.review !== 'approved') {
      throw new ReframeNotReady(`The ${ratio} framing for ${who} has not been approved. Approve it in the asset's Formats tab, then publish again.`);
    }
    const ready = row.render_state === 'ready' ? localPath(row.output_key) : null;
    if (ready && existsSync(ready)) return ready;
    await progress(5, `rendering ${ratio}`);
    const r = await renderFormat(asset.id, f, (pct) => { void progress(5 + Math.round(pct * 0.4), `rendering ${ratio}`); });
    return r.path;
  } catch (e: any) {
    if (e instanceof ReframeNotReady) throw e;
    if (e instanceof ReframeError) throw new ReframeNotReady(e.message);
    throw e;
  }
}
