-- GUIDE ICON. The image a channel or station carries in the guide (XMLTV
-- <icon>, the JSON guide, partner feeds). NULL means "use the channel's own
-- brand image", which is what nearly every channel wants: one logo, set once.
-- Set it only when the guide needs something different, e.g. a square icon
-- for a partner whose grid crops a wide logo.
--
-- Order the guide uses, first that exists:
--   guide_icon_ref  ->  brand_ref  ->  the icon of a linked imported feed
--   channel (epg_channel_aliases.icon)  ->  metadata logo
ALTER TABLE channels ADD COLUMN IF NOT EXISTS guide_icon_ref TEXT;
