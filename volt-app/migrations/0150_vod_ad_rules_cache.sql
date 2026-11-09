-- ============================================================================
--  0150: the on-demand ad rule on the viewer path (build queue VA-cache).
--
--  The play gate now keeps an account's on-demand ad rules in the viewer-path
--  cache (services/vodAds adsForPlay), so a busy title no longer reads
--  vod_ad_rules on every play start. A saved, added or removed rule announces
--  'vodads:<account_id>' on the volt_cache channel, the same way the other
--  viewer-path tables do (0046), so every process drops that account's cached
--  rules at once instead of waiting for the TTL.
--
--  Add only: a new trigger on an existing table, nothing old tasks read.
-- ============================================================================
DROP TRIGGER IF EXISTS trg_cache_vod_ad_rules ON vod_ad_rules;
CREATE TRIGGER trg_cache_vod_ad_rules
  AFTER INSERT OR UPDATE OR DELETE ON vod_ad_rules
  FOR EACH ROW EXECUTE FUNCTION volt_cache_notify('vodads', 'account_id');
