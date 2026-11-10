-- ============================================================================
--  0157: a channel with recording off has no recordings.
--
--  Two paths opened the day's recording row without asking whether the
--  channel records (the start path and the midnight roll-over, fixed in
--  services/orchestrator/service.ts). A channel with recording off that stayed
--  on air collected one empty "closed, kept" row per day: nothing recorded,
--  nothing to open, clip or expire.
--
--  Remove those rows. Only rows that hold nothing at all are touched: the
--  channel records nothing now, AND no media object was ever registered for
--  the row, AND no asset or clip was cut from it, AND the segment index has no
--  segment for the channel inside the row's window. A day recorded before
--  recording was turned off keeps its row, its media and its retention.
--  There is no media to remove, so nothing goes in the removal log.
-- ============================================================================
DELETE FROM recordings r
 USING channels ch
 WHERE r.kind = 'channel_day'
   AND ch.id = r.channel_id
   AND ch.recording_enabled = false
   AND NOT EXISTS (SELECT 1 FROM media_objects mo WHERE mo.recording_id = r.id)
   AND NOT EXISTS (SELECT 1 FROM vod_assets v WHERE v.recording_id = r.id)
   AND NOT EXISTS (SELECT 1 FROM clip_segments cs WHERE cs.recording_id = r.id)
   AND NOT EXISTS (SELECT 1 FROM segments s
                    WHERE s.channel_id = r.channel_id
                      AND s.start_epoch_ms >= r.start_epoch_ms
                      AND s.start_epoch_ms < COALESCE(r.end_epoch_ms, (extract(epoch from now()) * 1000)::bigint));
