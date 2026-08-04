import { Router } from 'express';
import { query } from '../db';
import { requireAuth, accountId } from '../auth/middleware';
import { asyncHandler } from '../util/http';

/**
 * Groups: a group ties channels/events to an output profile (which carries the
 * workflow type: transcode vs package_only). The channel-create UI reads this to
 * offer "Transcode" vs "Packaging" and to show the rendition ladder + captions state.
 */
export const groupsRouter = Router();
groupsRouter.use(requireAuth);

groupsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const rows = await query(
      `SELECT g.id, g.name, g.max_channels, g.max_concurrent, g.output_profile_id,
              p.name AS profile_name, p.workflow_type, p.packaging, p.rungs,
              p.codec_backend, p.captions_enabled, p.caption_targets, p.caption_source_lang,
              a.captions_provider,
              (SELECT count(*)::int FROM channels c WHERE c.group_id = g.id) AS channel_count
         FROM groups g
         JOIN accounts a ON a.id = g.account_id
         LEFT JOIN output_profiles p ON p.id = g.output_profile_id
        WHERE g.account_id = $1
        ORDER BY g.name`,
      [accountId(req)]
    );
    res.json(rows);
  })
);
