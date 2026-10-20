-- ============================================================================
--  0061  THE RADIO SKIN CAN BE SAVED (docs/PLAYER_SDK.md).
--
--  `audio_radio`: a station player with the programme on air, its progress, a
--  waveform and the Coming up banner raised by the stream's own Up next
--  trigger (docs/DESIGN_stream_graphics_triggers.md). test/player-layouts.check.ts
--  keeps this list equal to what the bundle builds.
-- ============================================================================

ALTER TABLE player_configs DROP CONSTRAINT IF EXISTS player_configs_layout_check;
ALTER TABLE player_configs
  ADD CONSTRAINT player_configs_layout_check
  CHECK (layout IN ('card', 'bar', 'hero', 'stage', 'video', 'event', 'audio_square', 'audio_wave', 'audio_nowplaying', 'audio_radio'));
