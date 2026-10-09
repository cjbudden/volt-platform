-- ===========================================================================
--  WHAT THE STATION IS ACTUALLY PRODUCING, as opposed to what it was asked to.
--
--  The station's output list is a REQUEST. The encoder can refuse part of it at
--  runtime and still go on air: bin/radio.py probes the MP3 relay before it
--  starts, and when the relay is not running it drops the MP3 output and serves
--  HLS and DASH instead. It reports that as an `output.degraded` event.
--
--  Nothing consumed that event, so the API went on advertising an MP3 URL for
--  an output that did not exist. The console tries MP3 first, got a URL with no
--  audio behind it, and a failed play() was swallowed. The result on a machine
--  with no Icecast: a station visibly on air, producing perfectly good HLS,
--  playing nothing at all when you press Listen, and reporting no error
--  anywhere. That is the whole bug, and it is a reporting bug rather than an
--  audio one.
--
--  Kept on stream_status rather than derived from stream_events on every read:
--  status is already fetched once per stream on the pages that need this, and
--  the alternative is an event scan per output per request.
--
--  Empty means nothing is degraded, which is also the right answer for a
--  station that has never run.
-- ===========================================================================
ALTER TABLE stream_status
  ADD COLUMN IF NOT EXISTS degraded_outputs JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN stream_status.degraded_outputs IS
  'Outputs the RUNNING encoder dropped, as {output: reason}. Cleared on channel.start: a new run makes its own decisions and must not inherit the last one''s.';
