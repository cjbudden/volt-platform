-- ============================================================================
--  0055  THE PLAYER SDK'S SKINS CAN BE SAVED (docs/PLAYER_SDK.md).
--
--  player_configs.layout picks what a station's embed looks like. The four
--  original layouts stay; the SDK adds a video skin and three audio skins.
--  The console's own `admin` skin is never saved in a config, so it is not
--  allowed here.
--
--  The theme beyond the two colour columns (logo, radius, font, text colour,
--  control toggles, up next timing, Chromecast receiver) lives in
--  options.theme, so nothing else changes shape and an old config still
--  resolves.
--
--  test/player-layouts.check.ts asserts this list equals what the bundle can
--  build: the legacy registry plus the SDK skins.
-- ============================================================================

ALTER TABLE player_configs DROP CONSTRAINT IF EXISTS player_configs_layout_check;
ALTER TABLE player_configs
  ADD CONSTRAINT player_configs_layout_check
  CHECK (layout IN ('card', 'bar', 'hero', 'stage', 'video', 'audio_square', 'audio_wave', 'audio_nowplaying'));
