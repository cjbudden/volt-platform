-- ============================================================================
--  THE STAGE LAYOUT, and why the layout list had to change shape.
--
--  The first three layouts were all audio: a card, a bar, a hero. An EVENT is
--  video, and a video player is not an audio player with a picture added. It
--  has a stage the picture occupies, controls that sit ON the picture rather
--  than beside it, and a box whose size is reserved before there is anything to
--  put in it.
--
--  So `stage` is added rather than one of the others being stretched to cover
--  it. A CHECK constraint rather than an enum was the right call originally and
--  still is: adding a value is one ALTER, and nothing has to be recreated.
-- ============================================================================

ALTER TABLE player_configs DROP CONSTRAINT IF EXISTS player_configs_layout_check;
ALTER TABLE player_configs
  ADD CONSTRAINT player_configs_layout_check
  CHECK (layout IN ('card', 'bar', 'hero', 'stage'));
