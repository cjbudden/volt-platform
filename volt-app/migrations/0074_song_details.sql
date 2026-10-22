-- Song details a person chose ("Find song details" in the asset panel): the
-- album, date, label, cover and where they came from, for this account. Used
-- before any automatic lookup, for every later play of the same song.
CREATE TABLE IF NOT EXISTS song_details (
  account_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  norm_key    text NOT NULL,                 -- normalised artist|title (radio/trackMeta.ts normKey)
  artist      text NOT NULL,
  title       text NOT NULL,
  album       text,
  released    text,
  label       text,
  isrc        text,
  genres      text[] NOT NULL DEFAULT '{}',
  image_key   text,                          -- library/<account>/media/<artist>/<album>/<song>/cover.jpg
  provider    text NOT NULL,                 -- musicbrainz | deezer | apple | page | typed
  link        text,                          -- the page it came from
  terms       text,                          -- what that source's terms allow, as shown when chosen
  chosen_by   text,
  chosen_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, norm_key)
);
