// ============================================================================
//  /api/site-agent/tus: the site agent's resumable upload (build queue H2).
//
//  The same tus server and the same upload sessions as /api/tus, with three
//  differences that make it safe to hand to a machine on a customer's
//  network:
//    - the credential is a site HOST credential, which opens nothing else;
//      a host waiting for approval is refused;
//    - an upload is opened only FOR AN ACCEPTED ITEM of one of this site's
//      watchfolders (Upload-Metadata `itemId`), with the size the agent
//      reported when it was accepted; every name, path and source comes from
//      the item, never from the agent;
//    - the upload is kept on the item, so a second create for the same item
//      answers with the upload already open: an agent that restarts, or
//      loses its state, resumes from the offset the cloud holds instead of
//      sending the file again.
//  When the last byte lands the normal upload path runs (landTus), then the
//  item closes as a local drop does. An image, slate or companion (H2b-5) is
//  an upload with no asset of its own (purpose 'site_file'): its copy is put
//  where the folder's ingest reads it and taken in by the local-drop passes
//  (siteWatchfolders.ts landSiteFile).
// ============================================================================
import { one, query } from '../db';
import { createTusRouter, type TusInfo } from '../services/ingest/tus';
import { openSession, MAX_UPLOAD_BYTES, abortSession, type UploadSession } from '../services/uploads';
import { authenticateSite, type SitePrincipal } from '../services/sites/sites';
import { licenceRequired } from '../services/sites/licences';
import { itemForUpload, attachUpload, closeUploadedItem, requireApprovedHost, landSiteFile } from '../services/sites/siteWatchfolders';
import { fallbackItemForUpload, fallbackUploadOpened, isFallbackUpload, landFallbackSource } from '../services/sites/siteFallback';
import { PgTusStore, landTus, toInfo } from './tus';

interface SiteWho { accountId: string; userId: null; site: SitePrincipal }

class SiteTusStore extends PgTusStore {
  async create(who: SiteWho, length: number, md: Record<string, string>): Promise<TusInfo> {
    if (md.fallback === '1') return this.createFallback(who, length, md);
    const { item, target, existingUpload, contentType } = await itemForUpload(who.site, md.itemId, length);
    if (existingUpload) {
      const s = await one<UploadSession>(`SELECT * FROM upload_sessions WHERE id = $1`, [existingUpload]);
      if (s) return toInfo(s, { filename: s.filename, itemId: String(item.id) });
    }
    const base = String(item.object_key).split('/').pop() || 'upload.bin';
    const { session } = await openSession({
      accountId: who.accountId, openedBy: null,
      // 'site_file': no Media Library or Loops & Fillers record is opened;
      // the passes that take the file in make the record it becomes.
      purpose: target === 'loop' ? 'filler' : target === 'file' ? 'site_file' : 'vod', fillerKind: target === 'file' ? undefined : 'loop',
      name: base.replace(/\.[^.]+$/, '').slice(0, 200), filename: base, contentType,
      totalBytes: Math.max(1, length), ladderGroupId: item.ladder_group_id ?? null,
      // The folder is the source, as for a local drop, so a source-rung
      // ingest rule written for this folder applies to its files.
      relativePath: item.object_key, source: item.watchfolder_id, metadata: null,
    });
    await query(`UPDATE upload_sessions SET chunk_count = 0, updated_at = now() WHERE id = $1`, [session.id]);
    const kept = await attachUpload(Number(item.id), session.id);
    if (kept !== session.id) {
      // Another create for the same item got there first: use its upload.
      await abortSession(session, 'a second upload for the same watchfolder item').catch(() => {});
      const s = await one<UploadSession>(`SELECT * FROM upload_sessions WHERE id = $1`, [kept]);
      if (s) return toInfo(s, { filename: s.filename, itemId: String(item.id) });
    }
    return toInfo(session, { filename: base, itemId: String(item.id) });
  }

  /**
   * THE ORIGINAL OF AN ENCODE AT SITE FILE, sent because the site did not
   * encode it within the folder's fallback time (H5, siteFallback.ts). Opened
   * for the item like any site upload, as a 'site_file' session: no new
   * Media Library record, the asset the file was registered as gets it.
   */
  private async createFallback(who: SiteWho, length: number, md: Record<string, string>): Promise<TusInfo> {
    const { item, existingUpload, contentType } = await fallbackItemForUpload(who.site, md.itemId, length);
    if (existingUpload) {
      const s = await one<UploadSession>(`SELECT * FROM upload_sessions WHERE id = $1`, [existingUpload]);
      if (s) return toInfo(s, { filename: s.filename, itemId: String(item.id) });
    }
    const base = String(item.object_key).split('/').pop() || 'upload.bin';
    const { session } = await openSession({
      accountId: who.accountId, openedBy: null, purpose: 'site_file',
      name: base.replace(/\.[^.]+$/, '').slice(0, 200), filename: base, contentType,
      totalBytes: Math.max(1, length), ladderGroupId: item.ladder_group_id ?? null,
      relativePath: item.object_key, source: item.watchfolder_id, metadata: null,
    });
    await query(`UPDATE upload_sessions SET chunk_count = 0, updated_at = now() WHERE id = $1`, [session.id]);
    const kept = await attachUpload(Number(item.id), session.id);
    if (kept !== session.id) {
      await abortSession(session, 'a second upload for the same original').catch(() => {});
      const s = await one<UploadSession>(`SELECT * FROM upload_sessions WHERE id = $1`, [kept]);
      if (s) return toInfo(s, { filename: s.filename, itemId: String(item.id) });
    }
    await fallbackUploadOpened(Number(item.id));
    return toInfo(session, { filename: base, itemId: String(item.id) });
  }

  /** Only an upload opened for one of this site's items. */
  async get(who: SiteWho, id: string): Promise<TusInfo | null> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    const s = await one<UploadSession>(
      `SELECT u.* FROM upload_sessions u
         JOIN watchfolder_items i ON i.upload_session_id = u.id
         JOIN watchfolders w ON w.id = i.watchfolder_id
        WHERE u.id = $1 AND u.account_id = $2 AND w.kind = 'site' AND w.site_id = $3`,
      [id, who.accountId, who.site.siteId]);
    return s ? toInfo(s, { filename: s.filename }) : null;
  }
}

const siteTusStore = new SiteTusStore();

export const siteTusRouter = createTusRouter({
  store: siteTusStore,
  basePath: '/api/site-agent/tus',
  maxBytes: MAX_UPLOAD_BYTES,
  authorise: async (req) => {
    const p = await authenticateSite(req.headers.authorization);
    requireApprovedHost(p);
    // Uploads from a site are Hybrid Sites (on-prem watchfolders), not Mirror and Archive.
    if (!p.licences.includes('hybrid_sites')) throw licenceRequired('hybrid_sites');
    return { accountId: p.accountId, userId: null, site: p } as SiteWho;
  },
  onComplete: async (info, _who, sha) => {
    const s = await one<any>(`SELECT purpose FROM upload_sessions WHERE id = $1`, [info.id]);
    if (s?.purpose === 'site_file' && await isFallbackUpload(info.id)) {
      await landFallbackSource(info.id, siteTusStore.dataPath(info), sha);
      return;
    }
    if (s?.purpose === 'site_file') {
      await landSiteFile(info.id, siteTusStore.dataPath(info), sha);
      return;
    }
    await landTus(info, sha);
    await closeUploadedItem(info.id);
  },
});
