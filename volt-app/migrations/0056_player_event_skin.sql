-- ============================================================================
--  0056  THE EVENT SKIN CAN BE SAVED (docs/PLAYER_SDK.md).
--
--  `event`: the video player plus an event's life around it (countdown,
--  postponed / cancelled, replay, and the paywall's offers). Embeds from the
--  channel and event pages carry their own settings in the snippet; this lets
--  a saved config name it too. test/player-layouts.check.ts keeps this list
--  equal to what the bundle builds.
-- ============================================================================

ALTER TABLE player_configs DROP CONSTRAINT IF EXISTS player_configs_layout_check;
ALTER TABLE player_configs
  ADD CONSTRAINT player_configs_layout_check
  CHECK (layout IN ('card', 'bar', 'hero', 'stage', 'video', 'event', 'audio_square', 'audio_wave', 'audio_nowplaying'));
